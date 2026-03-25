import type { ImageStoryItem } from '../types/workspace';

const minNarrationDurationSec = 1.2;
const emptyNarrationDurationSec = 2.2;

export function estimateImageStoryNarrationDurationSec(text: string): number {
  const normalizedText = text.replace(/\s+/g, ' ').trim();

  if (!normalizedText) {
    return emptyNarrationDurationSec;
  }

  const cjkCharCount = countMatches(normalizedText, /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu);
  const nonCjkText = normalizedText.replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu, ' ');
  const latinWordCount = nonCjkText.split(/[\s,.;:!?，。！？；：、]+/).filter(Boolean).length;
  const punctuationCount = countMatches(normalizedText, /[,.!?;:，。！？；：、]/g);

  const cjkSeconds = cjkCharCount / 3.6;
  const latinSeconds = latinWordCount / 2.8;
  const pauseSeconds = punctuationCount * 0.18 + 0.2;
  const estimatedSeconds = cjkSeconds + latinSeconds + pauseSeconds;

  return roundSeconds(Math.max(minNarrationDurationSec, estimatedSeconds));
}

export function buildImageStoryTimelineFromText(items: ImageStoryItem[]): ImageStoryItem[] {
  let nextStartSec = 0;

  return items.map((item) => {
    const estimatedDurationSec = estimateImageStoryNarrationDurationSec(item.text);
    const durationSec = roundSeconds(Math.max(item.audioDurationSec ?? 0, estimatedDurationSec, minNarrationDurationSec));
    const startSec = roundSeconds(nextStartSec);
    const endSec = roundSeconds(startSec + durationSec);
    nextStartSec = endSec;

    return {
      ...item,
      startSec,
      durationSec,
      endSec,
    };
  });
}

export function normalizeImageStoryTimeline(items: ImageStoryItem[]): ImageStoryItem[] {
  const orderedItems = [...items];
  let nextStartSec = 0;

  return orderedItems.map((item) => {
    const durationSec = roundSeconds(Math.max(item.durationSec, item.audioDurationSec ?? 0, minNarrationDurationSec));
    const startSec = roundSeconds(nextStartSec);
    const endSec = roundSeconds(startSec + durationSec);
    nextStartSec = endSec;

    return {
      ...item,
      startSec,
      durationSec,
      endSec,
    };
  });
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}
