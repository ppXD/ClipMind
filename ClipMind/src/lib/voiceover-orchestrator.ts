import {
  blobToDataUrl,
  dataUrlToUint8Array,
  execFfmpeg,
  generateAudiodubTts,
  generateAzureSpeechTts,
  generateCantoneseAiTts,
  generateOpenAiTts,
  loadVideoFfmpeg,
  readMediaDurationFromBlob,
  readThrownMessage,
  toUint8Array,
  uint8ArrayToDataAsset,
} from './video-orchestrator';
import type {
  ProviderKeys,
  ProviderRegions,
  SourceMediaAsset,
  VideoBinaryAsset,
  VoiceoverProjectRecord,
  VoiceoverProjectStatus,
  VoiceoverSegment,
} from '../types/workspace';

export type VoiceoverGenerationUpdate = {
  status?: VoiceoverProjectStatus;
  currentMessage?: string;
  segments?: VoiceoverSegment[];
  narrationAudio?: VideoBinaryAsset;
  previewVideo?: VideoBinaryAsset;
  finalVideo?: VideoBinaryAsset;
  error?: string;
  log?: string;
};

export async function runVoiceoverProject({
  project,
  sourceAsset,
  providerKeys,
  providerRegions,
  onUpdate,
}: {
  project: VoiceoverProjectRecord;
  sourceAsset: SourceMediaAsset;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
  onUpdate?: (update: VoiceoverGenerationUpdate) => void;
}) {
  if (!project.segments.length) {
    throw new Error('Add at least one script segment before generating a voiceover.');
  }

  emitUpdate(onUpdate, {
    status: 'running',
    currentMessage: `Generating ${project.segments.length} narration clip${project.segments.length > 1 ? 's' : ''}.`,
    log: `Starting clip-based narration generation for ${project.title}.`,
  });

  try {
    let completedCount = 0;
    const generatedSegments: VoiceoverSegment[] = [];

    for (const segment of project.segments) {
      emitUpdate(onUpdate, {
        currentMessage: `Generating voice clip ${completedCount + 1} of ${project.segments.length}.`,
        log: `Generating audio for "${truncateText(segment.text, 80)}".`,
      });

      const blob = await synthesizeSegmentAudio({
        project,
        text: segment.text,
        providerKeys,
        providerRegions,
      });
      const dataUrl = await blobToDataUrl(blob);
      const audioDurationSec = await readMediaDurationFromBlob(blob, blob.type || 'audio/wav');

      generatedSegments.push({
        ...segment,
        audioClip: {
          mimeType: blob.type || 'audio/wav',
          dataUrl,
        },
        audioDurationSec,
      });
      completedCount += 1;

      emitUpdate(onUpdate, {
        segments: alignSegmentsToAudioDurations(generatedSegments, project.segments),
        currentMessage: `Narration clip ${completedCount} of ${project.segments.length} is ready.`,
        log: `Clip ${completedCount} ready at ${formatSeconds(audioDurationSec)}.`,
      });
    }

    const alignedSegments = alignSegmentsToAudioDurations(generatedSegments, project.segments);
    const narrationAudio = await composeNarrationTrack(alignedSegments, onUpdate);

    emitUpdate(onUpdate, {
      segments: alignedSegments,
      narrationAudio,
      currentMessage: 'Combining narration with the source video.',
      log: 'Narration timeline ready. Starting local video composition.',
    });

    const composition = await composeVoiceoverVideo({
      project: {
        ...project,
        segments: alignedSegments,
      },
      sourceAsset,
      narrationAudio,
      onUpdate,
    });

    emitUpdate(onUpdate, {
      status: 'ready',
      segments: alignedSegments,
      narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
      currentMessage: 'Voiceover video is ready.',
      log: 'Voiceover video export completed.',
    });

    return {
      segments: alignedSegments,
      narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
    };
  } catch (error) {
    const message = readThrownMessage(error, 'Voiceover generation failed.');
    emitUpdate(onUpdate, {
      status: 'failed',
      currentMessage: message,
      error: message,
      log: message,
    });
    throw error;
  }
}

export function createVoiceoverSegments(script: string, videoDurationSec: number): VoiceoverSegment[] {
  const cleanedScript = script.replace(/\s+/g, ' ').trim();

  if (!cleanedScript) {
    return [];
  }

  const segments = splitScriptIntoSentences(cleanedScript);
  const estimatedDurations = segments.map(estimateSegmentDuration);
  const totalEstimated = estimatedDurations.reduce((sum, value) => sum + value, 0);
  const durationScale = totalEstimated > videoDurationSec && videoDurationSec > 0 ? videoDurationSec / totalEstimated : 1;

  let currentStart = 0;

  return segments.map((text, index) => {
    const durationSec = roundSeconds(Math.max(1.2, estimatedDurations[index] * durationScale));
    const startSec = roundSeconds(currentStart);
    const endSec = roundSeconds(startSec + durationSec);
    currentStart = endSec;

    return {
      id: `voiceover-segment-${globalThis.crypto.randomUUID()}`,
      text,
      subtitleText: text,
      startSec,
      durationSec,
      endSec,
    };
  });
}

function alignSegmentsToAudioDurations(currentSegments: VoiceoverSegment[], originalSegments: VoiceoverSegment[]): VoiceoverSegment[] {
  const merged = originalSegments.map((originalSegment) => {
    const updatedSegment = currentSegments.find((segment) => segment.id === originalSegment.id);
    return updatedSegment ? { ...originalSegment, ...updatedSegment } : originalSegment;
  });

  let nextAvailableStart = 0;

  return merged.map((segment) => {
    const startSec = roundSeconds(Math.max(segment.startSec, nextAvailableStart));
    const durationSec = roundSeconds(Math.max(segment.durationSec, segment.audioDurationSec ?? 0, 1.2));
    const endSec = roundSeconds(startSec + durationSec);
    nextAvailableStart = endSec;

    return {
      ...segment,
      startSec,
      durationSec,
      endSec,
      subtitleText: segment.subtitleText || segment.text,
    };
  });
}

async function synthesizeSegmentAudio({
  project,
  text,
  providerKeys,
  providerRegions,
}: {
  project: VoiceoverProjectRecord;
  text: string;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
}) {
  if (project.ttsVendor === 'cantoneseai') {
    return generateCantoneseAiTts({
      apiKey: providerKeys.cantoneseai,
      text,
      language: project.language,
      voiceId: project.voice,
      useTurbo: project.ttsModel === 'cantoneseai-tts-turbo',
    });
  }

  if (project.ttsVendor === 'azure') {
    return generateAzureSpeechTts({
      apiKey: providerKeys.azure,
      region: providerRegions.azure ?? '',
      text,
      language: project.language,
      voice: project.voice,
    });
  }

  if (project.ttsVendor === 'audiodub') {
    return generateAudiodubTts({
      apiKey: providerKeys.audiodub,
      text,
      language: project.language,
      voiceId: project.voice,
    });
  }

  return generateOpenAiTts({
    apiKey: providerKeys.openai,
    model: project.ttsModel,
    text,
    voice: project.voice,
    language: project.language,
  });
}

async function composeNarrationTrack(segments: VoiceoverSegment[], onUpdate?: (update: VoiceoverGenerationUpdate) => void): Promise<VideoBinaryAsset> {
  const audioSegments = segments.filter((segment) => segment.audioClip);

  if (!audioSegments.length) {
    throw new Error('No narration clips were generated for this project.');
  }

  const ffmpeg = await loadVideoFfmpeg();
  const outputName = 'voiceover-narration.wav';
  const inputNames: string[] = [];

  try {
    for (const [index, segment] of audioSegments.entries()) {
      const extension = getAudioExtension(segment.audioClip?.mimeType);
      const fileName = `voiceover-segment-${index + 1}.${extension}`;
      inputNames.push(fileName);
      await ffmpeg.writeFile(fileName, dataUrlToUint8Array(segment.audioClip!.dataUrl));
    }

    const filterInputs = audioSegments
      .map((segment, index) => `[${index}:a]adelay=${Math.round(segment.startSec * 1000)}|${Math.round(segment.startSec * 1000)}[a${index}]`)
      .join(';');
    const amixInputs = audioSegments.map((_, index) => `[a${index}]`).join('');

    emitUpdate(onUpdate, {
      currentMessage: 'Building the combined narration track.',
      log: 'Applying timeline offsets to each generated narration clip.',
    });

    await execFfmpeg(
      ffmpeg,
      [
        ...inputNames.flatMap((fileName) => ['-i', fileName]),
        '-filter_complex',
        `${filterInputs};${amixInputs}amix=inputs=${audioSegments.length}:duration=longest:normalize=0[aout]`,
        '-map',
        '[aout]',
        '-c:a',
        'pcm_s16le',
        outputName,
      ],
      undefined,
      'compose',
      'Building voiceover narration track.',
      { start: 0, end: 100 },
    );

    const output = await ffmpeg.readFile(outputName);
    return uint8ArrayToDataAsset(toUint8Array(output), 'audio/wav');
  } finally {
    await cleanupFiles(ffmpeg, [outputName, ...inputNames]);
  }
}

async function composeVoiceoverVideo({
  project,
  sourceAsset,
  narrationAudio,
  onUpdate,
}: {
  project: VoiceoverProjectRecord;
  sourceAsset: SourceMediaAsset;
  narrationAudio: VideoBinaryAsset;
  onUpdate?: (update: VoiceoverGenerationUpdate) => void;
}) {
  const ffmpeg = await loadVideoFfmpeg();
  const inputVideoName = `voiceover-input.${getVideoExtension(sourceAsset.mimeType)}`;
  const narrationName = 'voiceover-narration-mix.wav';
  const previewName = 'voiceover-preview.webm';
  const outputName = 'voiceover-output.mp4';
  const subtitleName = 'voiceover-subtitles.vtt';

  try {
    emitUpdate(onUpdate, {
      currentMessage: 'Writing the source video and narration into the local editor runtime.',
      log: 'Preparing source video and narration for browser-side ffmpeg composition.',
    });

    await ffmpeg.writeFile(inputVideoName, dataUrlToUint8Array(sourceAsset.dataUrl));
    await ffmpeg.writeFile(narrationName, dataUrlToUint8Array(narrationAudio.dataUrl));

    const subtitlePayload = buildWebVtt(project.segments);
    await ffmpeg.writeFile(subtitleName, new TextEncoder().encode(subtitlePayload));

    emitUpdate(onUpdate, {
      currentMessage: 'Encoding browser preview video.',
      log: 'Encoding WebM preview with narration.',
    });

    let previewVideo: VideoBinaryAsset | undefined;

    try {
      await execFfmpeg(
        ffmpeg,
        ['-i', inputVideoName, '-i', narrationName, '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx', '-b:v', '2M', '-c:a', 'libvorbis', '-shortest', previewName],
        undefined,
        'compose',
        'Encoding voiceover preview video.',
        { start: 0, end: 50 },
      );
      const previewOutput = await ffmpeg.readFile(previewName);
      previewVideo = await uint8ArrayToDataAsset(toUint8Array(previewOutput), 'video/webm');
    } catch (error) {
      emitUpdate(onUpdate, {
        log: `Preview encoding failed and was skipped: ${readThrownMessage(error, 'Unknown preview encoding error.')}`,
      });
    }

    emitUpdate(onUpdate, {
      currentMessage: 'Composing the final MP4 with timeline-aligned narration.',
      log: 'Muxing narration track with the original video.',
    });

    await execFfmpeg(
      ffmpeg,
      ['-i', inputVideoName, '-i', narrationName, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', outputName],
      undefined,
      'compose',
      'Rendering voiceover MP4.',
      { start: 50, end: 100 },
    );

    const finalOutput = await ffmpeg.readFile(outputName);
    const finalVideo = await uint8ArrayToDataAsset(toUint8Array(finalOutput), 'video/mp4');

    return {
      previewVideo,
      finalVideo,
    };
  } finally {
    await cleanupFiles(ffmpeg, [inputVideoName, narrationName, previewName, outputName, subtitleName]);
  }
}

function splitScriptIntoSentences(script: string) {
  const parts = script
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts : [script];
}

function estimateSegmentDuration(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1.8, words / 2.6);
}

function roundSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

function formatSeconds(value: number) {
  return `${value.toFixed(2)}s`;
}

function truncateText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function getAudioExtension(mimeType = 'audio/wav') {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return 'mp3';
  }

  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) {
    return 'm4a';
  }

  return 'wav';
}

function getVideoExtension(mimeType = 'video/mp4') {
  if (mimeType.includes('quicktime')) {
    return 'mov';
  }

  if (mimeType.includes('webm')) {
    return 'webm';
  }

  return 'mp4';
}


function buildWebVtt(segments: VoiceoverSegment[]) {
  const body = segments.map((segment, index) => {
    return [
      `${index + 1}`,
      `${formatCueTime(segment.startSec)} --> ${formatCueTime(segment.endSec)}`,
      segment.subtitleText || segment.text,
      '',
    ].join('\n');
  });

  return `WEBVTT\n\n${body.join('\n')}`;
}

function formatCueTime(value: number) {
  const totalMs = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds
    .toString()
    .padStart(3, '0')}`;
}

function emitUpdate(onUpdate: ((update: VoiceoverGenerationUpdate) => void) | undefined, update: VoiceoverGenerationUpdate) {
  onUpdate?.(update);
}

async function cleanupFiles(ffmpeg: Awaited<ReturnType<typeof loadVideoFfmpeg>>, paths: string[]) {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await ffmpeg.deleteFile(path);
      } catch {
        // Ignore cleanup errors.
      }
    }),
  );
}
