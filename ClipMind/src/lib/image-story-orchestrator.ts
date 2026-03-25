import {
  blobToDataUrl,
  dataUrlToUint8Array,
  execFfmpeg,
  generateAudiodubTts,
  generateAzureSpeechTts,
  generateCantoneseAiTts,
  generateMiniMaxTts,
  generateOpenAiTts,
  loadVideoFfmpeg,
  readMediaDurationFromBlob,
  readThrownMessage,
  toUint8Array,
  uint8ArrayToDataAsset,
} from './video-orchestrator';
import { buildImageStoryTimelineFromText, estimateImageStoryNarrationDurationSec } from './image-story-timeline';
import { renderSubtitleBurnedImage } from './subtitle-theme';
import type {
  ImageStoryItem,
  ImageStoryProjectRecord,
  ImageStoryProjectStatus,
  ProviderKeys,
  ProviderRegions,
  VideoBinaryAsset,
} from '../types/workspace';

export type ImageStoryGenerationUpdate = {
  status?: ImageStoryProjectStatus;
  currentMessage?: string;
  items?: ImageStoryItem[];
  narrationAudio?: VideoBinaryAsset;
  previewVideo?: VideoBinaryAsset;
  finalVideo?: VideoBinaryAsset;
  error?: string;
  log?: string;
};

type ImageStoryClipPlan = {
  id: string;
  itemId: string;
  itemTitle: string;
  image: VideoBinaryAsset;
  text: string;
};

type ImageStoryTimelineSegment = ImageStoryClipPlan & {
  startSec: number;
  durationSec: number;
  endSec: number;
  audioClip?: VideoBinaryAsset;
  audioDurationSec?: number;
};

const h264Preset = 'veryfast';
const h264Crf = '21';
const h264MaxRate = '5M';
const h264BufSize = '10M';
const aacBitrate = '128k';

export function createImageStoryItems(
  entries: Array<{ title: string; text: string; dataUrl: string; mimeType: string }>,
): ImageStoryItem[] {
  const sanitizedEntries = entries
    .map((entry) => ({
      title: entry.title.trim(),
      text: entry.text.trim(),
      dataUrl: entry.dataUrl,
      mimeType: entry.mimeType,
    }))
    .filter((entry) => entry.dataUrl && entry.mimeType);

  if (!sanitizedEntries.length) {
    return [];
  }

  const initialItems = sanitizedEntries.map((entry, index) => {
    return {
      id: `imagestory-item-${globalThis.crypto.randomUUID()}`,
      title: entry.title || `Slide ${index + 1}`,
      image: {
        mimeType: entry.mimeType,
        dataUrl: entry.dataUrl,
      },
      text: entry.text,
      subtitleText: entry.text,
      startSec: 0,
      durationSec: 0,
      endSec: 0,
    };
  });

  return buildImageStoryTimelineFromText(initialItems);
}

export async function runImageStoryProject({
  project,
  providerKeys,
  providerRegions,
  onUpdate,
}: {
  project: ImageStoryProjectRecord;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
  onUpdate?: (update: ImageStoryGenerationUpdate) => void;
}) {
  if (!project.items.length) {
    throw new Error('Add at least one image before generating.');
  }

  const clipPlans = buildImageStoryClipPlans(project.items);

  if (!clipPlans.length) {
    throw new Error('Add narration text for at least one image before generating.');
  }

  emitUpdate(onUpdate, {
    status: 'running',
    currentMessage: `Generating narration for ${clipPlans.length} clip${clipPlans.length > 1 ? 's' : ''} across ${project.items.length} image${project.items.length > 1 ? 's' : ''}.`,
    log: `Starting image story generation for ${project.title}.`,
  });

  try {
    const generatedClipsByItemId = new Map<string, ImageStoryTimelineSegment[]>();
    let completedCount = 0;

    for (const clipPlan of clipPlans) {
      const clipNumber = completedCount + 1;
      const clipTimerStart = Date.now();
      let clipPhase = 'Submitting TTS request.';
      const emitClipProgress = (phase: string, includeLog = true) => {
        clipPhase = phase;
        emitUpdate(onUpdate, {
          currentMessage: `Generating voice clip ${clipNumber} of ${clipPlans.length}. ${phase}`,
          log: includeLog ? `Clip ${clipNumber}/${clipPlans.length}: ${phase}` : undefined,
        });
      };

      emitClipProgress(`Preparing text "${truncateText(clipPlan.text, 80)}".`);
      const heartbeatId = window.setInterval(() => {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - clipTimerStart) / 1000));
        emitUpdate(onUpdate, {
          currentMessage: `Generating voice clip ${clipNumber} of ${clipPlans.length}. ${clipPhase} (${elapsedSec}s)`,
        });
      }, 2000);

      let blob: Blob;

      try {
        emitClipProgress('Submitting request to TTS provider.');
        blob = await synthesizeItemAudio({
          project,
          text: clipPlan.text,
          providerKeys,
          providerRegions,
          onStatus: (status) => emitClipProgress(status),
        });
      } catch (error) {
        const detail = readThrownMessage(error, 'The TTS provider did not return audio.');
        throw new Error(
          `Narration clip ${clipNumber}/${clipPlans.length} failed with ${formatTtsVendorLabel(project.ttsVendor)} (${project.ttsModel}). ${detail}`,
        );
      } finally {
        window.clearInterval(heartbeatId);
      }

      emitClipProgress('Audio received. Inspecting clip duration.', false);
      const dataUrl = await blobToDataUrl(blob);
      const audioDurationSec = await readMediaDurationFromBlob(blob, blob.type || 'audio/wav');

      const generatedClip: ImageStoryTimelineSegment = {
        ...clipPlan,
        startSec: 0,
        durationSec: roundSeconds(Math.max(audioDurationSec, 0.2)),
        endSec: 0,
        audioClip: {
          mimeType: blob.type || 'audio/wav',
          dataUrl,
        },
        audioDurationSec,
      };
      appendGeneratedClip(generatedClipsByItemId, generatedClip);
      completedCount += 1;

      const alignedItems = alignItemsToAudioDurations(
        deriveItemsFromGeneratedClips(project.items, generatedClipsByItemId),
        project.items,
      );

      emitUpdate(onUpdate, {
        items: alignedItems,
        currentMessage: `Narration clip ${completedCount} of ${clipPlans.length} is ready. Timeline retimed from measured audio.`,
        log: `Clip ${completedCount} ready at ${formatSeconds(audioDurationSec)}. Slide timeline re-aligned to actual audio length.`,
      });
    }

    const alignedItems = alignItemsToAudioDurations(
      deriveItemsFromGeneratedClips(project.items, generatedClipsByItemId),
      project.items,
    );
    const timelineSegments = buildImageStoryTimelineSegments(alignedItems, generatedClipsByItemId);
    const narrationAudio = await composeNarrationTrack(timelineSegments, onUpdate);

    emitUpdate(onUpdate, {
      items: alignedItems,
      narrationAudio,
      currentMessage: 'Combining narration with image timeline.',
      log: 'Narration timeline ready. Composing image story video.',
    });

    const composition = await composeImageStoryVideo({
      project: {
        ...project,
        items: alignedItems,
      },
      timelineSegments,
      narrationAudio,
      onUpdate,
    });

    emitUpdate(onUpdate, {
      status: 'ready',
      items: alignedItems,
      narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
      currentMessage: 'Image story video is ready.',
      log: 'Image story export completed.',
    });

    return {
      items: alignedItems,
      narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
    };
  } catch (error) {
    const message = readThrownMessage(error, 'Image story generation failed.');
    emitUpdate(onUpdate, {
      status: 'failed',
      currentMessage: message,
      error: message,
      log: message,
    });
    throw error;
  }
}

function alignItemsToAudioDurations(currentItems: ImageStoryItem[], originalItems: ImageStoryItem[]): ImageStoryItem[] {
  const merged = originalItems.map((originalItem) => {
    const updatedItem = currentItems.find((item) => item.id === originalItem.id);
    return updatedItem ? { ...originalItem, ...updatedItem } : originalItem;
  });

  let nextStartSec = 0;

  return merged.map((item) => {
    const hasAudioDuration = typeof item.audioDurationSec === 'number' && Number.isFinite(item.audioDurationSec) && item.audioDurationSec > 0;
    const estimatedDurationSec = estimateImageStoryNarrationDurationSec(item.text);
    const startSec = roundSeconds(nextStartSec);
    const durationSec = hasAudioDuration
      ? roundSeconds(Math.max(item.audioDurationSec ?? 0, 0.2))
      : roundSeconds(Math.max(item.durationSec, estimatedDurationSec, 1.2));
    const endSec = roundSeconds(startSec + durationSec);
    nextStartSec = endSec;

    return {
      ...item,
      subtitleText: item.text,
      startSec,
      durationSec,
      endSec,
    };
  });
}

async function synthesizeItemAudio({
  project,
  text,
  providerKeys,
  providerRegions,
  onStatus,
}: {
  project: ImageStoryProjectRecord;
  text: string;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
  onStatus?: (status: string) => void;
}) {
  if (project.ttsVendor === 'cantoneseai') {
    onStatus?.('Running Cantonese.ai synthesis.');
    return generateCantoneseAiTts({
      apiKey: providerKeys.cantoneseai,
      text,
      language: project.language,
      voiceId: project.voice,
      useTurbo: project.ttsModel === 'cantoneseai-tts-turbo',
    });
  }

  if (project.ttsVendor === 'azure') {
    onStatus?.('Running Azure Speech synthesis.');
    return generateAzureSpeechTts({
      apiKey: providerKeys.azure,
      region: providerRegions.azure ?? '',
      text,
      language: project.language,
      voice: project.voice,
    });
  }

  if (project.ttsVendor === 'audiodub') {
    onStatus?.('Sending request to Audiodub.');
    return generateAudiodubTts({
      apiKey: providerKeys.audiodub,
      text,
      language: project.language,
      voiceId: project.voice,
      onProgress: onStatus,
    });
  }

  if (project.ttsVendor === 'minimax') {
    onStatus?.('Sending request to MiniMax.');
    return generateMiniMaxTts({
      apiKey: providerKeys.minimax,
      text,
      language: project.language,
      voiceId: project.voice,
      model: project.ttsModel,
      onProgress: onStatus,
    });
  }

  onStatus?.('Running OpenAI TTS synthesis.');
  return generateOpenAiTts({
    apiKey: providerKeys.openai,
    model: project.ttsModel,
    text,
    voice: project.voice,
    language: project.language,
  });
}

async function composeNarrationTrack(timelineSegments: ImageStoryTimelineSegment[], onUpdate?: (update: ImageStoryGenerationUpdate) => void): Promise<VideoBinaryAsset> {
  const audioSegments = timelineSegments.filter((segment) => segment.audioClip);

  if (!audioSegments.length) {
    throw new Error('No narration clips were generated for this project.');
  }

  const ffmpeg = await loadVideoFfmpeg();
  const outputName = 'imagestory-narration.wav';
  const inputNames: string[] = [];

  try {
    for (const [index, segment] of audioSegments.entries()) {
      const extension = getAudioExtension(segment.audioClip?.mimeType);
      const fileName = `imagestory-audio-${index + 1}.${extension}`;
      inputNames.push(fileName);
      await ffmpeg.writeFile(fileName, dataUrlToUint8Array(segment.audioClip!.dataUrl));
    }

    const filterInputs = audioSegments
      .map((segment, index) => `[${index}:a]adelay=${Math.round(segment.startSec * 1000)}|${Math.round(segment.startSec * 1000)}[a${index}]`)
      .join(';');
    const amixInputs = audioSegments.map((_, index) => `[a${index}]`).join('');

    emitUpdate(onUpdate, {
      currentMessage: 'Building the combined narration track.',
      log: 'Applying timeline offsets to generated image-story narration clips.',
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
      'Building image story narration track.',
      { start: 0, end: 100 },
    );

    const output = await ffmpeg.readFile(outputName);
    return uint8ArrayToDataAsset(toUint8Array(output), 'audio/wav');
  } finally {
    await cleanupFiles(ffmpeg, [outputName, ...inputNames]);
  }
}

async function composeImageStoryVideo({
  project,
  timelineSegments,
  narrationAudio,
  onUpdate,
}: {
  project: ImageStoryProjectRecord;
  timelineSegments: ImageStoryTimelineSegment[];
  narrationAudio: VideoBinaryAsset;
  onUpdate?: (update: ImageStoryGenerationUpdate) => void;
}) {
  const ffmpeg = await loadVideoFfmpeg();
  const narrationName = 'imagestory-narration.wav';
  const slideshowName = 'imagestory-slideshow.mp4';
  const previewName = 'imagestory-preview.webm';
  const outputName = 'imagestory-output.mp4';
  const inputImageNames: string[] = [];

  try {
    emitUpdate(onUpdate, {
      currentMessage: 'Preparing image timeline and narration in the local editor runtime.',
      log: 'Preparing still-image timeline for ffmpeg composition.',
    });

    await ffmpeg.writeFile(narrationName, dataUrlToUint8Array(narrationAudio.dataUrl));

    const imageInputArgs: string[] = [];
    const filterParts: string[] = [];
    const concatInputs: string[] = [];
    const totalSlides = timelineSegments.length;

    for (const [index, segment] of timelineSegments.entries()) {
      const slideNumber = index + 1;
      const subtitleText = segment.text;
      emitUpdate(onUpdate, {
        currentMessage: `Preparing slide ${slideNumber} of ${totalSlides}.`,
        log: `Preparing slide ${slideNumber}/${totalSlides} for timeline composition.`,
      });

      const preparedImageDataUrl = subtitleText.trim()
        ? await renderSubtitleBurnedImage({
            imageDataUrl: segment.image.dataUrl,
            subtitleText,
            language: project.language,
          })
        : segment.image.dataUrl;

      const fileName = `imagestory-image-${slideNumber}.png`;
      inputImageNames.push(fileName);
      await ffmpeg.writeFile(fileName, dataUrlToUint8Array(preparedImageDataUrl));
      imageInputArgs.push('-loop', '1', '-t', `${segment.durationSec}`, '-i', fileName);
      filterParts.push(
        `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`,
      );
      concatInputs.push(`[v${index}]`);
    }

    const concatFilterGraph = `${filterParts.join(';')};${concatInputs.join('')}concat=n=${timelineSegments.length}:v=1:a=0[vout]`;

    emitUpdate(onUpdate, {
      currentMessage: 'Rendering image timeline slideshow.',
      log: 'Rendering subtitle-burned slideshow frames to MP4.',
    });

    try {
      await execFfmpeg(
        ffmpeg,
        [
          ...imageInputArgs,
          '-filter_complex',
          concatFilterGraph,
          '-map',
          '[vout]',
          '-r',
          '30',
          '-c:v',
          'libx264',
          '-preset',
          h264Preset,
          '-crf',
          h264Crf,
          '-maxrate',
          h264MaxRate,
          '-bufsize',
          h264BufSize,
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          slideshowName,
        ],
        undefined,
        'compose',
        'Rendering image timeline slideshow (H.264).',
        { start: 0, end: 45 },
      );
    } catch (h264Error) {
      emitUpdate(onUpdate, {
        log: `H.264 slideshow encoding unavailable, fallback to MPEG-4: ${readThrownMessage(h264Error, 'Unknown encoding error.')}`,
      });

      await execFfmpeg(
        ffmpeg,
        [
          ...imageInputArgs,
          '-filter_complex',
          concatFilterGraph,
          '-map',
          '[vout]',
          '-r',
          '30',
          '-c:v',
          'mpeg4',
          '-q:v',
          '3',
          slideshowName,
        ],
        undefined,
        'compose',
        'Rendering image timeline slideshow (fallback MPEG-4).',
        { start: 0, end: 45 },
      );
    }

    emitUpdate(onUpdate, {
      currentMessage: 'Encoding browser preview video.',
      log: 'Encoding image-story preview with timeline narration.',
    });

    let previewVideo: VideoBinaryAsset | undefined;

    try {
      await execFfmpeg(
        ffmpeg,
        [
          '-i',
          slideshowName,
          '-i',
          narrationName,
          '-map',
          '0:v',
          '-map',
          '1:a',
          '-c:v',
          'libvpx',
          '-b:v',
          '2M',
          '-c:a',
          'libvorbis',
          '-shortest',
          previewName,
        ],
        undefined,
        'compose',
        'Encoding image story preview video.',
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
      currentMessage: 'Rendering final MP4 from image timeline.',
      log: 'Rendering final image story MP4.',
    });

    try {
      await execFfmpeg(
        ffmpeg,
        ['-i', slideshowName, '-i', narrationName, '-c:v', 'copy', '-c:a', 'aac', '-b:a', aacBitrate, '-movflags', '+faststart', '-shortest', outputName],
        undefined,
        'compose',
        'Rendering image story MP4 (stream copy).',
        { start: 50, end: 100 },
      );
    } catch (copyError) {
      emitUpdate(onUpdate, {
        log: `MP4 stream copy failed, retrying with H.264 re-encode: ${readThrownMessage(copyError, 'Unknown muxing error.')}`,
      });

      try {
        await execFfmpeg(
          ffmpeg,
          [
            '-i',
            slideshowName,
            '-i',
            narrationName,
            '-c:v',
            'libx264',
            '-preset',
            h264Preset,
            '-crf',
            h264Crf,
            '-maxrate',
            h264MaxRate,
            '-bufsize',
            h264BufSize,
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            aacBitrate,
            '-movflags',
            '+faststart',
            '-shortest',
            outputName,
          ],
          undefined,
          'compose',
          'Rendering image story MP4 (H.264).',
          { start: 50, end: 100 },
        );
      } catch (h264Error) {
        emitUpdate(onUpdate, {
          log: `H.264 final encoding unavailable, fallback to MPEG-4: ${readThrownMessage(h264Error, 'Unknown encoding error.')}`,
        });

        await execFfmpeg(
          ffmpeg,
          ['-i', slideshowName, '-i', narrationName, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-b:a', aacBitrate, '-shortest', outputName],
          undefined,
          'compose',
          'Rendering image story MP4 (fallback MPEG-4).',
          { start: 50, end: 100 },
        );
      }
    }

    const finalOutput = await ffmpeg.readFile(outputName);
    const finalVideo = await uint8ArrayToDataAsset(toUint8Array(finalOutput), 'video/mp4');

    return {
      previewVideo,
      finalVideo,
    };
  } finally {
    await cleanupFiles(ffmpeg, [narrationName, slideshowName, previewName, outputName, ...inputImageNames]);
  }
}

function buildImageStoryClipPlans(items: ImageStoryItem[]): ImageStoryClipPlan[] {
  const plans: ImageStoryClipPlan[] = [];

  for (const item of items) {
    const columns = extractNarrationColumns(item.text);

    for (const [columnIndex, text] of columns.entries()) {
      plans.push({
        id: `${item.id}-col-${columnIndex + 1}`,
        itemId: item.id,
        itemTitle: item.title,
        image: item.image,
        text,
      });
    }
  }

  return plans;
}

function appendGeneratedClip(generatedClipsByItemId: Map<string, ImageStoryTimelineSegment[]>, clip: ImageStoryTimelineSegment) {
  const existing = generatedClipsByItemId.get(clip.itemId) ?? [];
  existing.push(clip);
  generatedClipsByItemId.set(clip.itemId, existing);
}

function deriveItemsFromGeneratedClips(items: ImageStoryItem[], generatedClipsByItemId: Map<string, ImageStoryTimelineSegment[]>): ImageStoryItem[] {
  return items.map((item) => {
    const itemClips = generatedClipsByItemId.get(item.id) ?? [];
    const totalAudioDurationSec = roundSeconds(itemClips.reduce((sum, clip) => sum + (clip.audioDurationSec ?? 0), 0));

    return {
      ...item,
      audioClip: undefined,
      audioDurationSec: totalAudioDurationSec > 0 ? totalAudioDurationSec : undefined,
      subtitleText: item.text,
    };
  });
}

function buildImageStoryTimelineSegments(
  alignedItems: ImageStoryItem[],
  generatedClipsByItemId: Map<string, ImageStoryTimelineSegment[]>,
): ImageStoryTimelineSegment[] {
  const timelineSegments: ImageStoryTimelineSegment[] = [];

  for (const item of alignedItems) {
    const itemClips = generatedClipsByItemId.get(item.id) ?? [];

    if (!itemClips.length) {
      const fallbackText = extractNarrationColumns(item.text)[0] ?? item.text.trim();
      timelineSegments.push({
        id: `${item.id}-silent`,
        itemId: item.id,
        itemTitle: item.title,
        image: item.image,
        text: fallbackText,
        startSec: item.startSec,
        durationSec: item.durationSec,
        endSec: item.endSec,
      });
      continue;
    }

    let nextStartSec = item.startSec;

    for (const clip of itemClips) {
      const durationSec = roundSeconds(Math.max(clip.audioDurationSec ?? 0, 0.2));
      const startSec = roundSeconds(nextStartSec);
      const endSec = roundSeconds(startSec + durationSec);
      nextStartSec = endSec;

      timelineSegments.push({
        ...clip,
        startSec,
        durationSec,
        endSec,
      });
    }
  }

  return timelineSegments;
}

function extractNarrationColumns(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function formatTtsVendorLabel(vendor: ImageStoryProjectRecord['ttsVendor']) {
  if (vendor === 'openai') {
    return 'OpenAI';
  }

  if (vendor === 'azure') {
    return 'Azure Speech';
  }

  if (vendor === 'cantoneseai') {
    return 'Cantonese.ai';
  }

  if (vendor === 'audiodub') {
    return 'Audiodub';
  }

  if (vendor === 'minimax') {
    return 'MiniMax';
  }

  return vendor;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function getAudioExtension(mimeType?: string): string {
  if (!mimeType) {
    return 'wav';
  }

  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return 'mp3';
  }

  if (mimeType.includes('mp4') || mimeType.includes('aac')) {
    return 'm4a';
  }

  if (mimeType.includes('ogg') || mimeType.includes('vorbis')) {
    return 'ogg';
  }

  return 'wav';
}

async function cleanupFiles(ffmpeg: Awaited<ReturnType<typeof loadVideoFfmpeg>>, fileNames: string[]) {
  await Promise.all(
    fileNames.map(async (fileName) => {
      try {
        await ffmpeg.deleteFile(fileName);
      } catch {
        // Ignore cleanup errors.
      }
    }),
  );
}

function emitUpdate(onUpdate: ((update: ImageStoryGenerationUpdate) => void) | undefined, update: ImageStoryGenerationUpdate) {
  onUpdate?.(update);
}
