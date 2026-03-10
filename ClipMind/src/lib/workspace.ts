import { Readability } from '@mozilla/readability';
import type {
  JobPhase,
  ModelOption,
  ProviderKeys,
  ProviderRegions,
  ProviderKind,
  ProviderVendorOption,
  Source,
  SourceKind,
  StudioSettings,
  VideoGenerationStepDefinition,
  VideoPlan,
  VideoScene,
  VideoJobRecord,
  VideoJobStep,
} from '../types/workspace';

export const videoProviderKinds: Array<Exclude<keyof StudioSettings['models'], 'transcription'>> = ['summary', 'script', 'tts', 'image'];

export const voiceOptions = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

const azureVoiceCatalogByLanguage: Record<string, string[]> = {
  Cantonese: ['zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural', 'zh-HK-HiuGaaiNeural'],
  Mandarin: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'],
  English: ['en-US-AvaMultilingualNeural', 'en-US-RyanMultilingualNeural'],
  Japanese: ['ja-JP-NanamiNeural', 'ja-JP-KeitaNeural'],
  Spanish: ['es-ES-ElviraNeural', 'es-ES-AlvaroNeural'],
  French: ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural'],
};

const cantoneseAiVoiceOptions = ['default'];

const audiodubVoiceOptions = ['209536448462927'];

type SourceRecordInput = {
  id?: string;
  kind: SourceKind;
  title: string;
  origin: string;
  text: string;
  includeSummary?: boolean;
  selected?: boolean;
  status?: Source['status'];
  error?: string;
};

export const languageOptions = ['English', 'Cantonese', 'Mandarin', 'Japanese', 'Spanish', 'French'];

export const providerCatalog: ProviderVendorOption[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    sdk: 'openai',
    description: 'Transcription, text, image, and TTS via the official OpenAI JavaScript SDK.',
    capabilities: ['transcription', 'summary', 'script', 'tts', 'image'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    sdk: '@anthropic-ai/sdk',
    description: 'Long-context text generation via the official Anthropic TypeScript SDK.',
    capabilities: ['summary', 'script'],
  },
  {
    id: 'google',
    label: 'Google',
    sdk: '@google/genai',
    description: 'Gemini text and image generation via the official Google Gen AI SDK.',
    capabilities: ['summary', 'script', 'image'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    sdk: '@mistralai/mistralai',
    description: 'Fast text generation via the official Mistral JavaScript SDK.',
    capabilities: ['summary', 'script'],
  },
  {
    id: 'cantoneseai',
    label: 'Cantonese.ai',
    sdk: 'fetch (REST)',
    description: 'Cantonese, Mandarin, and English TTS via the cantonese.ai REST API.',
    capabilities: ['tts'],
  },
  {
    id: 'azure',
    label: 'Azure Speech',
    sdk: 'microsoft-cognitiveservices-speech-sdk',
    description: 'Text-to-speech via the official Azure AI Speech JavaScript SDK.',
    capabilities: ['tts'],
  },
  {
    id: 'audiodub',
    label: 'Audiodub',
    sdk: 'fetch (REST)',
    description: 'Multilingual TTS via the Audiodub REST API with MiniMax voice engine.',
    capabilities: ['tts'],
  },
];

export const modelCatalog: Record<keyof StudioSettings['models'], ModelOption[]> = {
  transcription: [
    { id: 'whisper-1', label: 'Whisper 1', note: 'Stable speech-to-text for uploaded audio and video', vendor: 'openai' },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini transcribe', note: 'Fast multilingual transcription option', vendor: 'openai' },
    { id: 'gpt-4o-transcribe', label: 'GPT-4o transcribe', note: 'Higher quality speech recognition pass', vendor: 'openai' },
  ],
  summary: [
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', note: 'Fast merge and source summary', vendor: 'openai' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', note: 'Low-latency synthesis pass', vendor: 'google' },
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', note: 'Long-context reasoning option', vendor: 'anthropic' },
    { id: 'mistral-small-latest', label: 'Mistral Small', note: 'Fast synthesis pass for local orchestration', vendor: 'mistral' },
  ],
  script: [
    { id: 'gpt-4.1', label: 'GPT-4.1', note: 'Narration and scene planning', vendor: 'openai' },
    { id: 'gemini-2.0-pro', label: 'Gemini 2.0 Pro', note: 'Structured script output', vendor: 'google' },
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', note: 'Storyboard-heavy drafts', vendor: 'anthropic' },
    { id: 'mistral-medium-latest', label: 'Mistral Medium', note: 'Compact script planning option', vendor: 'mistral' },
  ],
  tts: [
    { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', note: 'Compact multilingual voice', vendor: 'openai' },
    { id: 'cantoneseai-tts', label: 'Cantonese.ai TTS', note: 'Cantonese / Mandarin / English voice', vendor: 'cantoneseai' },
    { id: 'cantoneseai-tts-turbo', label: 'Cantonese.ai Turbo', note: 'Faster synthesis with turbo model', vendor: 'cantoneseai' },
    { id: 'azure-neural-tts', label: 'Azure Neural TTS', note: 'Azure Speech neural voices with locale-specific options', vendor: 'azure' },
    { id: 'audiodub-minimax', label: 'Audiodub MiniMax', note: 'Multilingual TTS with emotion and style control', vendor: 'audiodub' },
  ],
  image: [
    { id: 'gpt-image-1', label: 'GPT Image 1', note: 'Editorial still frames', vendor: 'openai' },
    { id: 'imagen-3-fast', label: 'Imagen 3 Fast', note: 'Quick storyboard iteration', vendor: 'google' },
  ],
};

export const defaultStudioSettings: StudioSettings = {
  language: 'English',
  targetDurationSec: 60,
  voice: 'alloy',
  models: {
    transcription: modelCatalog.transcription[0].id,
    summary: modelCatalog.summary[0].id,
    script: modelCatalog.script[0].id,
    tts: modelCatalog.tts[0].id,
    image: modelCatalog.image[0].id,
  },
};

export const defaultProviderKeys: ProviderKeys = {
  openai: '',
  anthropic: '',
  google: '',
  mistral: '',
  cantoneseai: '',
  azure: '',
  audiodub: '',
};

export const defaultProviderRegions: ProviderRegions = {
  azure: '',
};

export const initialSources: Source[] = [];

export const videoGenerationSteps: VideoGenerationStepDefinition[] = [
  {
    id: 'extract',
    kind: 'summary',
    stepLabel: 'Step 1',
    title: 'Extract key facts',
    detail: 'Extract structured facts, quotes, and themes from each source in the target language.',
  },
  {
    id: 'narrative',
    kind: 'script',
    stepLabel: 'Step 2',
    title: 'Design narrative arc',
    detail: 'Design a compelling story arc with hook, development, insight, and conclusion.',
  },
  {
    id: 'storyboard',
    stepLabel: 'Step 3',
    title: 'Write storyboard',
    detail: 'Write per-scene spoken narration, visual direction, and style guide using the same model as Step 2.',
  },
  {
    id: 'narration',
    stepLabel: 'Step 4',
    title: 'Generate narration audio',
    detail: 'Generate TTS audio clips using the voice and model configured in Generation settings above.',
  },
  {
    id: 'visuals',
    kind: 'image',
    stepLabel: 'Step 5',
    title: 'Generate scene images',
    detail: 'Generate storyboard images with a shared visual style guide for consistency.',
  },
  {
    id: 'compose',
    stepLabel: 'Step 6',
    title: 'Compose final video',
    detail: 'Combine narration audio, scene images, and subtitles into the final video timeline.',
  },
];

export function createJobPhases(): JobPhase[] {
  return [
    { id: 'context', label: 'Context merge', detail: 'Collect selected source text and summaries', status: 'idle' },
    { id: 'summary', label: 'Source summary', detail: 'Compress the current source set into a single brief', status: 'idle' },
    { id: 'script', label: 'Spoken script', detail: 'Rewrite the brief into voice-ready narration', status: 'idle' },
    { id: 'scenes', label: 'Scene map', detail: 'Split narration into scene beats and image prompts', status: 'idle' },
    { id: 'timeline', label: 'Timeline package', detail: 'Assign timing for audio and still-image playback', status: 'idle' },
  ];
}

export function createVideoJobRecord(sourceIds: string[], title = 'Untitled video job'): VideoJobRecord {
  const timestamp = new Date().toISOString();

  return {
    id: `video-job-${globalThis.crypto.randomUUID()}`,
    title,
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceIds,
    currentMessage: 'Queued and waiting to start video generation.',
    steps: createVideoJobSteps(),
    logs: [],
  };
}

export function createVideoJobSteps(): VideoJobStep[] {
  return videoGenerationSteps.map((step) => ({
    ...step,
    status: 'idle',
    message: step.detail,
    details: {
      logs: [],
    },
  }));
}

export function createSourceId(prefix: SourceKind = 'text'): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

export function createSourceRecord(input: SourceRecordInput): Source {
  const normalizedText = normalizeText(input.text);
  const includeSummary = input.includeSummary ?? false;

  return {
    id: input.id ?? createSourceId(input.kind),
    kind: input.kind,
    title: input.title,
    origin: input.origin,
    status: input.status ?? 'ready',
    selected: input.status === 'failed' ? false : input.selected ?? false,
    includeSummary,
    wordCount: countWords(normalizedText),
    excerpt: buildExcerpt(normalizedText),
    summary: includeSummary ? buildSummary(input.title, normalizedText) : '',
    rawText: normalizedText,
    error: input.error,
  };
}

export function extractTextFromHtml(html: string): string {
  return extractWebSourceFromHtml(html).text;
}

export function extractWebSourceFromHtml(
  html: string,
  fallbackTitle = '',
): {
  title: string;
  text: string;
  method: 'readability' | 'fallback';
} {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  cleanReadableDocument(documentFragment);

  const readabilityDocument = documentFragment.cloneNode(true) as Document;
  const article = new Readability(readabilityDocument).parse();
  const readabilityText = normalizeText(article?.textContent ?? '');
  const fallbackText = extractFallbackText(documentFragment);
  const text = shouldPreferReadabilityText(readabilityText, fallbackText) ? readabilityText : fallbackText;

  return {
    title: normalizeText(article?.title ?? '') || findDocumentTitle(documentFragment) || fallbackTitle,
    text,
    method: text === readabilityText && readabilityText ? 'readability' : 'fallback',
  };
}

export function createVideoPlan(sources: Source[], settings: StudioSettings): VideoPlan {
  const selectedSources = sources.filter((source) => source.status === 'ready' && source.selected);
  const orderedSources = selectedSources.length ? selectedSources : sources.filter((source) => source.status === 'ready');
  const summary = buildMergedSummary(orderedSources);
  const spokenScript = buildSpokenScript(summary, orderedSources, settings.language);
  const sceneTexts = splitIntoSceneTexts(spokenScript, clamp(orderedSources.length + 1, 3, 5));
  const sceneDurations = distributeDuration(sceneTexts.length, settings.targetDurationSec);
  let currentStart = 0;

  const scenes = sceneTexts.map((voiceText, index) => {
    const scene = createScene(voiceText, orderedSources, currentStart, sceneDurations[index], index);
    currentStart += scene.durationSec;
    return scene;
  });

  return {
    title: orderedSources.length ? `${orderedSources[0].title} video draft` : 'Local video draft',
    summary,
    spokenScript,
    totalDurationSec: settings.targetDurationSec,
    scenes,
  };
}

export function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

export function getModelOption(kind: ProviderKind, modelId: string): ModelOption | undefined {
  return modelCatalog[kind].find((model) => model.id === modelId);
}

export function getModelVendor(kind: ProviderKind, modelId: string) {
  return getModelOption(kind, modelId)?.vendor ?? 'openai';
}

export function getVoiceOptionsForVendor(vendor: ProviderVendorOption['id'], language: string): string[] {
  if (vendor === 'openai') {
    return voiceOptions;
  }

  if (vendor === 'azure') {
    return azureVoiceCatalogByLanguage[language] ?? azureVoiceCatalogByLanguage.English;
  }

  if (vendor === 'cantoneseai') {
    return cantoneseAiVoiceOptions;
  }

  if (vendor === 'audiodub') {
    return audiodubVoiceOptions;
  }

  return voiceOptions;
}

export function getDefaultVoiceForVendor(vendor: ProviderVendorOption['id'], language: string): string {
  return getVoiceOptionsForVendor(vendor, language)[0] ?? 'alloy';
}

function countWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function cleanReadableDocument(documentFragment: Document) {
  documentFragment.querySelectorAll('script, style, noscript, template, svg').forEach((element) => element.remove());
}

function extractFallbackText(documentFragment: Document): string {
  const root =
    documentFragment.querySelector('article, main, [role="main"], .article, .post, .content, .entry-content') ??
    documentFragment.body;
  return normalizeText(root.textContent ?? '');
}

function findDocumentTitle(documentFragment: Document): string {
  const headingTitle = normalizeText(
    documentFragment.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
      documentFragment.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ??
      '',
  );

  if (headingTitle) {
    return headingTitle;
  }

  return normalizeText(documentFragment.querySelector('title')?.textContent ?? '');
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shouldPreferReadabilityText(readabilityText: string, fallbackText: string): boolean {
  if (readabilityText.length >= 240) {
    return true;
  }

  if (!fallbackText.length) {
    return Boolean(readabilityText.length);
  }

  return readabilityText.length >= Math.max(120, Math.floor(fallbackText.length * 0.35));
}

function buildExcerpt(text: string, limit = 156): string {
  if (!text) {
    return 'No readable text extracted yet.';
  }

  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function buildSummary(title: string, text: string): string {
  if (!text) {
    return `${title} is waiting for local analysis.`;
  }

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(' ');
  return summary || `${title} is available for synthesis.`;
}

function buildMergedSummary(sources: Source[]): string {
  if (!sources.length) {
    return 'Select at least one analyzed source to prepare a local video draft.';
  }

  return sources
    .map((source) => `${source.title}: ${source.summary || source.excerpt}`)
    .join(' ');
}

function buildSpokenScript(summary: string, sources: Source[], language: string): string {
  if (!sources.length) {
    return 'Choose one or more ready sources and the browser-only studio will assemble a storyboard draft here.';
  }

  const titles = sources.map((source) => source.title).join(', ');
  return `Voiceover target: ${language}. We are turning ${titles} into a concise one-minute story. ${summary} The pacing stays clear, visual, and easy to localize before final image, speech, and video generation.`;
}

function splitIntoSceneTexts(script: string, targetSceneCount: number): string[] {
  const sentences = script.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (sentences.length <= targetSceneCount) {
    return sentences;
  }

  const chunkSize = Math.ceil(sentences.length / targetSceneCount);
  const sceneTexts: string[] = [];

  for (let index = 0; index < sentences.length; index += chunkSize) {
    sceneTexts.push(sentences.slice(index, index + chunkSize).join(' '));
  }

  return sceneTexts;
}

function distributeDuration(sceneCount: number, totalDurationSec: number): number[] {
  if (!sceneCount) {
    return [];
  }

  const base = Math.floor(totalDurationSec / sceneCount);
  const remainder = totalDurationSec % sceneCount;
  return Array.from({ length: sceneCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function createScene(voiceText: string, sources: Source[], startSec: number, durationSec: number, index: number): VideoScene {
  const focusSource = sources[index % Math.max(sources.length, 1)];
  const promptPalette = [
    'warm editorial desk, layered documents, cinematic overhead light',
    'storyboard wall, motion planning notes, brushed metal accents',
    'clean product studio, widescreen interface, soft daylight glow',
    'close-up paper texture, highlighted key phrases, precise depth of field',
    'final presentation frame, polished brand still, subtle camera drift',
  ];

  return {
    id: `scene-${index + 1}`,
    title: `Scene ${index + 1}`,
    voiceText,
    imagePrompt: `${focusSource?.title ?? 'Selected source'}, ${promptPalette[index % promptPalette.length]}, keep composition aligned to a one-minute explainer video.`,
    durationSec,
    startSec,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
