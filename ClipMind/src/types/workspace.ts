export type SourceKind = 'web' | 'file' | 'text';

export type SourceStatus = 'analyzing' | 'ready' | 'failed';

export type ProviderKind = 'summary' | 'script' | 'tts' | 'image' | 'transcription';

export type ModelVendor = 'openai' | 'anthropic' | 'google' | 'mistral' | 'cantoneseai' | 'azure' | 'audiodub';

export type ProviderKeys = Record<ModelVendor, string>;

export type ProviderRegions = Partial<Record<ModelVendor, string>>;

export type JobStatus = 'idle' | 'running' | 'ready' | 'failed';

export type JobPhaseStatus = 'idle' | 'running' | 'done' | 'failed';

export type Source = {
  id: string;
  kind: SourceKind;
  title: string;
  origin: string;
  status: SourceStatus;
  selected: boolean;
  includeSummary: boolean;
  wordCount: number;
  excerpt: string;
  summary: string;
  rawText: string;
  processingProgress?: number;
  error?: string;
};

export type ModelOption = {
  id: string;
  label: string;
  note: string;
  vendor: ModelVendor;
};

export type ProviderVendorOption = {
  id: ModelVendor;
  label: string;
  sdk: string;
  description: string;
  capabilities: ProviderKind[];
};

export type StudioSettings = {
  language: string;
  targetDurationSec: number;
  voice: string;
  models: Record<ProviderKind, string>;
};

export type JobPhase = {
  id: string;
  label: string;
  detail: string;
  status: JobPhaseStatus;
};

export type VideoScene = {
  id: string;
  title: string;
  voiceText: string;
  imagePrompt: string;
  durationSec: number;
  startSec: number;
  transition?: 'cut' | 'crossfade';
  subtitleCues?: string[];
};

export type VideoPlan = {
  title: string;
  summary: string;
  spokenScript: string;
  totalDurationSec: number;
  scenes: VideoScene[];
  visualStyleGuide?: string;
};

export type VideoJobStepId = 'extract' | 'narrative' | 'storyboard' | 'narration' | 'visuals' | 'compose';

export type VideoGenerationStepDefinition = {
  id: VideoJobStepId;
  kind?: Exclude<ProviderKind, 'transcription'>;
  stepLabel: string;
  title: string;
  detail: string;
};

export type VideoJobStep = VideoGenerationStepDefinition & {
  status: JobPhaseStatus;
  provider?: ModelVendor;
  model?: string;
  message: string;
  details: VideoJobStepDetails;
};

export type VideoJobLog = {
  id: string;
  stepId: VideoJobStepId;
  message: string;
  createdAt: string;
};

export type VideoJobStepDetails = {
  request?: string;
  result?: string;
  handoff?: string;
  logs: VideoJobLog[];
};

export type VideoImageAsset = {
  id: string;
  sceneId: string;
  prompt: string;
  mimeType: string;
  dataUrl: string;
};

export type VideoAudioClip = {
  id: string;
  sceneId: string;
  mimeType: string;
  dataUrl: string;
  durationSec: number;
};

export type VideoBinaryAsset = {
  mimeType: string;
  dataUrl: string;
};

export type VideoJobRecord = {
  id: string;
  title: string;
  status: Exclude<JobStatus, 'idle'>;
  createdAt: string;
  updatedAt: string;
  sourceIds: string[];
  currentMessage: string;
  steps: VideoJobStep[];
  logs: VideoJobLog[];
  error?: string;
  plan?: VideoPlan;
  images?: VideoImageAsset[];
  audioClips?: VideoAudioClip[];
  narrationAudio?: VideoBinaryAsset;
  previewVideo?: VideoBinaryAsset;
  finalVideo?: VideoBinaryAsset;
};
