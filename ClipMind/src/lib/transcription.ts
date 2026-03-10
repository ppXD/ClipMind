import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
import { createOpenAIClient } from './provider-clients';

const maxDirectTranscriptionFileBytes = 25 * 1024 * 1024;
const maxProcessibleMediaBytes = 512 * 1024 * 1024;
const transcriptionChunkDurationSec = 10 * 60;
const directTranscriptionExtensions = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'wav', 'webm']);
const textLikeExtensions = new Set(['csv', 'json', 'markdown', 'md', 'txt']);
const movExtensions = new Set(['mov', 'qt']);
const ffmpegBaseUrl = '/ffmpeg';
const ffmpegLoadTimeoutMs = 120_000;
export type TranscriptionProgress = {
  message: string;
  progress: number;
};

type TranscriptionRequest = {
  apiKey: string;
  file: File;
  model: string;
  onProgress?: (update: TranscriptionProgress) => void;
};

type ProgressRange = {
  start: number;
  end: number;
};

type FFmpegModule = typeof import('@ffmpeg/ffmpeg');
type FFmpegInstance = InstanceType<FFmpegModule['FFmpeg']>;

let ffmpegInstancePromise: Promise<FFmpegInstance> | null = null;

export const sourceUploadAccept = '.txt,.md,.markdown,.json,.csv,.flac,.m4a,.mp3,.mp4,.mpeg,.mpga,.ogg,.wav,.webm,.mov,audio/*,video/mp4,video/webm,video/quicktime';

export function isTextLikeFile(file: File): boolean {
  const extension = getFileExtension(file.name);
  return file.type.startsWith('text/') || textLikeExtensions.has(extension);
}

export function isSupportedMediaFile(file: File): boolean {
  return isDirectTranscriptionFile(file) || isMovFile(file);
}

export function validateTranscriptionFile(file: File): string | null {
  if (!isSupportedMediaFile(file)) {
    return 'Only audio, MP4/WebM video, and MOV files can be transcribed right now.';
  }

  if (file.size > maxProcessibleMediaBytes) {
    return 'Large media uploads are currently limited to 512 MB in browser-only mode.';
  }

  return null;
}

export async function transcribeMediaFile({ apiKey, file, model, onProgress }: TranscriptionRequest): Promise<string> {
  const validationError = validateTranscriptionFile(file);

  if (validationError) {
    throw new Error(validationError);
  }

  emitProgress(onProgress, 'Validating media file.', 2);

  if (requiresChunking(file)) {
    return transcribeLargeMediaFile({ apiKey, file, model, onProgress });
  }

  emitProgress(onProgress, 'Preparing media upload.', 6);
  return requestTranscription({
    apiKey,
    file,
    model,
    onProgress,
    progressRange: { start: 8, end: 100 },
    progressMessage: 'Uploading media file for transcription.',
  });
}

async function requestTranscription({
  apiKey,
  file,
  model,
  prompt,
  onProgress,
  progressRange,
  progressMessage,
}: {
  apiKey: string;
  file: File;
  model: string;
  prompt?: string;
  onProgress?: (update: TranscriptionProgress) => void;
  progressRange?: ProgressRange;
  progressMessage?: string;
}): Promise<string> {
  const startProgress = progressRange?.start ?? 0;
  const endProgress = progressRange?.end ?? 100;
  const uploadMessage = progressMessage ?? 'Uploading media file for transcription.';

  emitProgress(onProgress, uploadMessage, startProgress);
  emitProgress(onProgress, 'Uploading media file for transcription.', mapRange({ start: startProgress, end: endProgress }, 0.4));

  try {
    const client = await createOpenAIClient(apiKey);
    emitProgress(onProgress, 'Waiting for transcription response.', mapRange({ start: startProgress, end: endProgress }, 0.72));
    const response = await client.audio.transcriptions.create({
      file,
      model,
      response_format: 'json',
      ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
    });
    const text = response.text?.trim();

    if (!text) {
      throw new Error('OpenAI transcription returned an empty transcript for this file.');
    }

    emitProgress(onProgress, 'Transcription completed.', endProgress);
    return text;
  } catch (error) {
    throw new Error(readThrownMessage(error, 'OpenAI transcription failed.'));
  }
}

async function transcribeLargeMediaFile({ apiKey, file, model, onProgress }: TranscriptionRequest): Promise<string> {
  const ffmpeg = await loadFfmpeg(onProgress, { start: 4, end: 24 });
  const { fetchFile } = await import('@ffmpeg/util');
  const inputName = sanitizeFileName(file.name, isMovFile(file) ? 'input.mov' : 'input-media');
  const durationInfoName = `${stripExtension(inputName)}-duration.txt`;

  emitProgress(onProgress, 'Reading media metadata.', 28);
  const browserDurationSec = await readMediaDurationFromFile(file).catch(() => null);

  emitProgress(onProgress, 'Preparing media for local audio chunking.', 28);
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  try {
    emitProgress(onProgress, 'Inspecting media duration.', 34);
    const durationSec =
      browserDurationSec ??
      (await readMediaDuration(ffmpeg, inputName, durationInfoName).catch((error) => {
        throw new Error(`Unable to determine media duration for chunked transcription. ${readThrownMessage(error, 'Local duration probe failed.')}`);
      }));
    const chunkCount = Math.max(1, Math.ceil(durationSec / transcriptionChunkDurationSec));
    const transcriptParts: string[] = [];
    const chunkProgressStart = 38;
    const chunkProgressSpan = 62;

    for (let index = 0; index < chunkCount; index += 1) {
      const startSec = index * transcriptionChunkDurationSec;
      const chunkDurationSec = Math.max(1, Math.min(transcriptionChunkDurationSec, durationSec - startSec));
      const chunkStart = chunkProgressStart + (chunkProgressSpan * index) / chunkCount;
      const chunkEnd = chunkProgressStart + (chunkProgressSpan * (index + 1)) / chunkCount;
      const extractionRange = { start: chunkStart, end: chunkStart + (chunkEnd - chunkStart) * 0.38 };
      const transcriptionRange = { start: extractionRange.end, end: chunkEnd };
      const chunkFile = await createAudioChunk(ffmpeg, inputName, startSec, chunkDurationSec, index, chunkCount, onProgress, extractionRange);
      const prompt = transcriptParts.length ? transcriptParts.join(' ').slice(-400) : undefined;

      const chunkText = await requestTranscription({
        apiKey,
        file: chunkFile,
        model,
        prompt,
        onProgress,
        progressRange: transcriptionRange,
        progressMessage: `Transcribing segment ${index + 1} of ${chunkCount}.`,
      });
      transcriptParts.push(chunkText);
    }

    emitProgress(onProgress, 'Transcription completed.', 100);
    return transcriptParts.join('\n\n').trim();
  } finally {
    await cleanupFfmpegFiles(ffmpeg, [inputName, durationInfoName]);
  }
}

async function createAudioChunk(
  ffmpeg: FFmpegInstance,
  inputName: string,
  startSec: number,
  durationSec: number,
  index: number,
  chunkCount: number,
  onProgress?: (update: TranscriptionProgress) => void,
  progressRange?: ProgressRange,
): Promise<File> {
  const primaryChunkName = `chunk-${index + 1}.m4a`;
  const fallbackChunkName = `chunk-${index + 1}.wav`;
  const progressLabel = `Extracting segment ${index + 1} of ${chunkCount}.`;

  let exitCode = await executeFfmpegCommand(
    ffmpeg,
    [
      '-ss',
      `${startSec}`,
      '-t',
      `${durationSec}`,
      '-i',
      inputName,
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      primaryChunkName,
    ],
    onProgress,
    progressRange,
    progressLabel,
  );

  if (exitCode === 0) {
    const data = await ffmpeg.readFile(primaryChunkName);
    await cleanupFfmpegFiles(ffmpeg, [primaryChunkName]);
    return uint8ArrayToFile(data, primaryChunkName, 'audio/mp4');
  }

  emitProgress(onProgress, `Retrying extraction for segment ${index + 1} of ${chunkCount}.`, progressRange?.start ?? 0);
  exitCode = await executeFfmpegCommand(
    ffmpeg,
    [
      '-ss',
      `${startSec}`,
      '-t',
      `${durationSec}`,
      '-i',
      inputName,
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      fallbackChunkName,
    ],
    onProgress,
    progressRange,
    progressLabel,
  );

  if (exitCode !== 0) {
    await cleanupFfmpegFiles(ffmpeg, [primaryChunkName, fallbackChunkName]);
    throw new Error('Local chunk preparation failed for this media file.');
  }

  const fallbackData = await ffmpeg.readFile(fallbackChunkName);
  await cleanupFfmpegFiles(ffmpeg, [fallbackChunkName]);
  return uint8ArrayToFile(fallbackData, fallbackChunkName, 'audio/wav');
}

async function executeFfmpegCommand(
  ffmpeg: FFmpegInstance,
  args: string[],
  onProgress?: (update: TranscriptionProgress) => void,
  progressRange?: ProgressRange,
  progressMessage = 'Processing media locally.',
): Promise<number> {
  const startProgress = progressRange?.start ?? 0;
  const endProgress = progressRange?.end ?? 100;
  const progressListener = ({ progress }: { progress: number }) => {
    emitProgress(onProgress, progressMessage, mapRange({ start: startProgress, end: endProgress }, clamp(progress, 0, 1)));
  };

  emitProgress(onProgress, progressMessage, startProgress);
  ffmpeg.on('progress', progressListener);

  try {
    return await ffmpeg.exec(args);
  } finally {
    ffmpeg.off('progress', progressListener);
  }
}

function emitProgress(onProgress: TranscriptionRequest['onProgress'], message: string, progress: number): void {
  onProgress?.({
    message,
    progress: Math.round(clamp(progress, 0, 100)),
  });
}


function mapRange(range: ProgressRange, ratio: number): number {
  return range.start + (range.end - range.start) * clamp(ratio, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readThrownMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;

    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  return fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
    }
  }
}

async function readMediaDurationFromFile(file: File): Promise<number> {
  const objectUrl = URL.createObjectURL(file);
  const mediaElement = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
  mediaElement.preload = 'metadata';
  mediaElement.muted = true;

  try {
    const durationSec = await new Promise<number>((resolve, reject) => {
      mediaElement.onloadedmetadata = () => {
        if (Number.isFinite(mediaElement.duration) && mediaElement.duration > 0) {
          resolve(mediaElement.duration);
          return;
        }

        reject(new Error('Browser metadata did not contain a usable duration.'));
      };

      mediaElement.onerror = () => {
        reject(new Error('Browser metadata read failed for this media file.'));
      };

      mediaElement.src = objectUrl;
    });

    return durationSec;
  } finally {
    mediaElement.removeAttribute('src');
    mediaElement.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function readMediaDuration(ffmpeg: FFmpegInstance, inputName: string, outputName: string): Promise<number> {
  const exitCode = await ffmpeg.ffprobe([
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    inputName,
    '-o',
    outputName,
  ]);

  if (exitCode !== 0) {
    throw new Error('Unable to inspect media duration for chunked transcription.');
  }

  const durationOutput = await ffmpeg.readFile(outputName, 'utf8');
  const durationText = typeof durationOutput === 'string' ? durationOutput : new TextDecoder().decode(durationOutput);
  const durationSec = Number.parseFloat(durationText.trim());

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('Unable to determine media duration for chunked transcription.');
  }

  return durationSec;
}

async function loadFfmpeg(onProgress?: (update: TranscriptionProgress) => void, progressRange: ProgressRange = { start: 0, end: 100 }): Promise<FFmpegInstance> {
  if (!ffmpegInstancePromise) {
    ffmpegInstancePromise = createFfmpegInstance(onProgress, progressRange).catch((error) => {
      ffmpegInstancePromise = null;
      throw error;
    });
  } else {
    emitProgress(onProgress, 'Local media engine is already available.', progressRange.end);
  }

  return ffmpegInstancePromise;
}

async function createFfmpegInstance(onProgress?: (update: TranscriptionProgress) => void, progressRange: ProgressRange = { start: 0, end: 100 }): Promise<FFmpegInstance> {
  emitProgress(onProgress, 'Loading local media tools. First use may take 10-30 seconds.', progressRange.start);
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();

  emitProgress(onProgress, 'Downloading local media engine.', mapRange(progressRange, 0.1));
  const coreURL = await fetchToBlobUrl(`${ffmpegBaseUrl}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await fetchToBlobUrl(`${ffmpegBaseUrl}/ffmpeg-core.wasm`, 'application/wasm');

  emitProgress(onProgress, 'Initializing local media engine.', mapRange(progressRange, 0.7));
  await withTimeout(
    ffmpeg.load({ classWorkerURL: ffmpegWorkerUrl, coreURL, wasmURL }),
    ffmpegLoadTimeoutMs,
    'The local media engine did not finish initializing within 2 minutes. Try refreshing the page or checking whether module workers are blocked in this browser.',
  );
  emitProgress(onProgress, 'Local media engine ready.', progressRange.end);
  return ffmpeg;
}

async function fetchToBlobUrl(url: string, mimeType: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (HTTP ${response.status}).`);
  }
  const blob = new Blob([await response.arrayBuffer()], { type: mimeType });
  return URL.createObjectURL(blob);
}

async function cleanupFfmpegFiles(ffmpeg: FFmpegInstance, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await ffmpeg.deleteFile(path);
      } catch {
        // Ignore cleanup failures in the in-memory FS.
      }
    }),
  );
}

function isDirectTranscriptionFile(file: File): boolean {
  const extension = getFileExtension(file.name);
  return file.type.startsWith('audio/') || file.type === 'video/mp4' || file.type === 'video/webm' || directTranscriptionExtensions.has(extension);
}

function requiresChunking(file: File): boolean {
  return isVideoFile(file) || file.size > maxDirectTranscriptionFileBytes;
}

function isMovFile(file: File): boolean {
  const extension = getFileExtension(file.name);
  return file.type === 'video/quicktime' || movExtensions.has(extension);
}

function isVideoFile(file: File): boolean {
  const extension = getFileExtension(file.name);
  return file.type.startsWith('video/') || extension === 'mp4' || extension === 'webm' || movExtensions.has(extension);
}

function getFileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

function sanitizeFileName(fileName: string, fallback: string): string {
  const normalized = fileName.trim().replace(/[^\w.-]+/g, '_');
  return normalized || fallback;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || 'audio-track';
}

function uint8ArrayToFile(data: Uint8Array | string, fileName: string, mimeType: string): File {
  if (typeof data === 'string') {
    return new File([data], fileName, { type: mimeType });
  }

  return new File([Uint8Array.from(data)], fileName, { type: mimeType });
}
