import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  DotsHorizontalIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  FileIcon,
  FileTextIcon,
  GearIcon,
  GlobeIcon,
  Link1Icon,
  MagnifyingGlassIcon,
  MagicWandIcon,
  MixerHorizontalIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
  VideoIcon,
} from '@radix-ui/react-icons';
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  ScrollArea,
  Select,
  Slider,
  Switch,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import './App.css';
import {
  createSourceId,
  createSourceRecord,
  createVideoJobRecord,
  createVideoJobSteps,
  defaultProviderRegions,
  defaultProviderKeys,
  defaultStudioSettings,
  extractWebSourceFromHtml,
  getDefaultVoiceForVendor,
  getModelVendor,
  getModelOption,
  getVoiceOptionsForVendor,
  initialSources,
  languageOptions,
  modelCatalog,
  providerCatalog,
  videoGenerationSteps,
  wait,
} from './lib/workspace';
import { isSupportedMediaFile, isTextLikeFile, sourceUploadAccept, transcribeMediaFile, validateTranscriptionFile, type TranscriptionProgress } from './lib/transcription';
import { generateTextWithVendor, runVideoGenerationJob, type VideoGenerationUpdate } from './lib/video-orchestrator';
import type { JobStatus, ModelVendor, ProviderKind, ProviderKeys, ProviderRegions, Source, SourceKind, StudioSettings, VideoJobRecord } from './types/workspace';

const studioSettingsStorageKey = 'clipmind.studio-settings';
const providerKeysStorageKey = 'clipmind.provider-keys';
const providerRegionsStorageKey = 'clipmind.provider-regions';
const sourcesStorageKey = 'clipmind.sources';
const activePreviewSourceStorageKey = 'clipmind.active-preview-source';
const videoJobsStorageKey = 'clipmind.video-jobs';
const cacheDatabaseName = 'clipmind-cache';
const cacheStoreName = 'app-state';
const rotatingHighlights = ['您的文档', '网站'];

type SourceDraft = {
  url: string;
  title: string;
  body: string;
  includeSummary: boolean;
};

type PreviewTarget = {
  kind: 'source' | 'video';
  id: string;
};

type WebSourceImportResult = {
  title: string;
  text: string;
  method: 'direct' | 'proxy' | 'reader';
};

type WebSourceStageUpdate = {
  excerpt: string;
  summary: string;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const [sources, setSources] = useState<Source[]>(readStoredSources);
  const [isAddSourceDialogOpen, setIsAddSourceDialogOpen] = useState(false);
  const [isVideoStudioDialogOpen, setIsVideoStudioDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isDropZoneActive, setIsDropZoneActive] = useState(false);
  const [isTextComposerOpen, setIsTextComposerOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [activePreviewTarget, setActivePreviewTarget] = useState<PreviewTarget | null>(readStoredPreviewTarget);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({ url: '', title: '', body: '', includeSummary: false });
  const [studioSettings, setStudioSettings] = useState<StudioSettings>(readStoredStudioSettings);
  const [providerKeys, setProviderKeys] = useState<ProviderKeys>(readStoredProviderKeys);
  const [providerRegions, setProviderRegions] = useState<ProviderRegions>(readStoredProviderRegions);
  const [sourceError, setSourceError] = useState('');
  const [videoDialogError, setVideoDialogError] = useState('');
  const [videoJobs, setVideoJobs] = useState<VideoJobRecord[]>([]);
  const [hasHydratedVideoJobs, setHasHydratedVideoJobs] = useState(false);
  const [sourceDeleteCandidate, setSourceDeleteCandidate] = useState<Source | null>(null);
  const [jobDeleteCandidate, setJobDeleteCandidate] = useState<VideoJobRecord | null>(null);
  const [expandedJobIds, setExpandedJobIds] = useState<Record<string, boolean>>({});
  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});

  const readySources = useMemo(() => sources.filter((source) => source.status === 'ready'), [sources]);
  const selectedSources = useMemo(() => readySources.filter((source) => source.selected), [readySources]);
  const activePreviewSource = useMemo(
    () => (activePreviewTarget?.kind === 'source' ? sources.find((source) => source.id === activePreviewTarget.id && source.status === 'ready') ?? null : null),
    [activePreviewTarget, sources],
  );
  const activePreviewVideoJob = useMemo(
    () =>
      activePreviewTarget?.kind === 'video'
        ? videoJobs.find((job) => job.id === activePreviewTarget.id && job.status === 'ready' && (job.previewVideo || job.finalVideo)) ?? null
        : null,
    [activePreviewTarget, videoJobs],
  );
  const activePreviewVideoAsset = useMemo(() => activePreviewVideoJob?.previewVideo ?? activePreviewVideoJob?.finalVideo ?? null, [activePreviewVideoJob]);
  const activePreviewVideoUrl = useObjectUrl(activePreviewVideoAsset?.dataUrl, activePreviewVideoAsset?.mimeType);
  const allReadySelected = readySources.length > 0 && selectedSources.length === readySources.length;
  const hasRunningVideoJob = useMemo(() => videoJobs.some((job) => job.status === 'running'), [videoJobs]);
  const selectedTtsVendor = useMemo(() => getModelVendor('tts', studioSettings.models.tts), [studioSettings.models.tts]);
  const availableVoiceOptions = useMemo(() => getVoiceOptionsForVendor(selectedTtsVendor, studioSettings.language), [selectedTtsVendor, studioSettings.language]);

  useEffect(() => {
    window.localStorage.setItem(studioSettingsStorageKey, JSON.stringify(studioSettings));
  }, [studioSettings]);

  useEffect(() => {
    window.localStorage.setItem(providerKeysStorageKey, JSON.stringify(providerKeys));
  }, [providerKeys]);

  useEffect(() => {
    window.localStorage.setItem(providerRegionsStorageKey, JSON.stringify(providerRegions));
  }, [providerRegions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(sourcesStorageKey, JSON.stringify(sources));
    } catch {
      console.warn('Unable to persist sources in local storage.');
    }
  }, [sources]);

  useEffect(() => {
    try {
      if (activePreviewTarget) {
        window.localStorage.setItem(activePreviewSourceStorageKey, JSON.stringify(activePreviewTarget));
        return;
      }

      window.localStorage.removeItem(activePreviewSourceStorageKey);
    } catch {
      console.warn('Unable to persist preview source in local storage.');
    }
  }, [activePreviewTarget]);

  useEffect(() => {
    let isCancelled = false;

    async function hydrateVideoJobs() {
      const storedJobs = await readCachedValue<unknown>(videoJobsStorageKey);

      if (isCancelled) {
        return;
      }

      setVideoJobs(normalizeStoredVideoJobs(storedJobs));
      setHasHydratedVideoJobs(true);
    }

    void hydrateVideoJobs();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedVideoJobs) {
      return;
    }

    void writeCachedValue(videoJobsStorageKey, videoJobs).catch(() => {
      console.warn('Unable to persist video jobs in local cache.');
    });
  }, [hasHydratedVideoJobs, videoJobs]);

  useEffect(() => {
    if (!isAddSourceDialogOpen) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setHighlightIndex((currentIndex) => (currentIndex + 1) % rotatingHighlights.length);
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [isAddSourceDialogOpen]);

  useEffect(() => {
    if (!activePreviewTarget) {
      return;
    }

    const shouldClearPreviewTarget =
      (activePreviewTarget.kind === 'source' && !sources.some((source) => source.id === activePreviewTarget.id && source.status === 'ready')) ||
      (activePreviewTarget.kind === 'video' &&
        hasHydratedVideoJobs &&
        !videoJobs.some((job) => job.id === activePreviewTarget.id && job.status === 'ready' && (job.previewVideo || job.finalVideo)));

    if (!shouldClearPreviewTarget) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setActivePreviewTarget((currentTarget) =>
        currentTarget && currentTarget.kind === activePreviewTarget.kind && currentTarget.id === activePreviewTarget.id ? null : currentTarget,
      );
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activePreviewTarget, hasHydratedVideoJobs, sources, videoJobs]);

  async function handleWebSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!sourceDraft.url.trim()) {
      return;
    }

    let url: URL;

    try {
      url = normalizeWebSourceUrl(sourceDraft.url);
    } catch {
      setSourceError('Enter a valid public URL before adding a web source.');
      return;
    }

    const sourceId = createSourceId('web');
    const provisionalSource: Source = {
      id: sourceId,
      kind: 'web',
      title: url.hostname.replace('www.', ''),
      origin: url.toString(),
      status: 'analyzing',
      selected: false,
      includeSummary: sourceDraft.includeSummary,
      wordCount: 0,
      excerpt: 'Trying to read this page directly from the browser.',
      summary: sourceDraft.includeSummary ? 'This source is waiting for local extraction.' : '',
      rawText: '',
    };

    setSourceError('');
    closeAddSourceDialog();
    setSources((currentSources) => [provisionalSource, ...currentSources]);
    setSourceDraft((currentDraft) => ({ ...currentDraft, url: '', includeSummary: false }));

    try {
      const importedSource = await importWebSource(url, {
        fallbackTitle: url.hostname.replace('www.', ''),
        onStageChange: (stage) => {
          setSources((currentSources) =>
            currentSources.map((source) =>
              source.id === sourceId
                ? {
                    ...source,
                    excerpt: stage.excerpt,
                    summary: stage.summary,
                  }
                : source,
            ),
          );
        },
      });

      const record = createSourceRecord({
        id: sourceId,
        kind: 'web',
        title: importedSource.title || url.hostname.replace('www.', ''),
        origin: url.toString(),
        text: importedSource.text,
        includeSummary: sourceDraft.includeSummary,
        selected: true,
      });

      const aiSummary = await tryGenerateAiSummary(sourceId, record);

      startTransition(() => {
        setSources((currentSources) =>
          currentSources.map((source) =>
            source.id === sourceId
              ? { ...record, summary: aiSummary || record.summary }
              : source,
          ),
        );
      });
    } catch (error) {
      const message = readErrorMessage(error, 'Unable to fetch the web source in browser-only mode.');

      setSources((currentSources) =>
        currentSources.map((source) =>
          source.id === sourceId
            ? {
                ...source,
                status: 'failed',
                excerpt: 'This site could not be imported into browser-only mode.',
                summary: 'Web extraction failed after direct and fallback attempts.',
                error: message,
              }
            : source,
        ),
      );
    }
  }

  async function tryGenerateAiSummary(sourceId: string, record: Source): Promise<string | null> {
    if (!record.includeSummary) {
      return null;
    }

    const summaryVendor = getModelVendor('summary', studioSettings.models.summary);
    const apiKey = providerKeys[summaryVendor];

    if (!apiKey?.trim() || !record.rawText.trim()) {
      return null;
    }

    setSources((currentSources) =>
      currentSources.map((source) =>
        source.id === sourceId
          ? { ...source, excerpt: `Generating AI summary with ${getVendorLabel(summaryVendor)}...` }
          : source,
      ),
    );

    try {
      const summary = await generateTextWithVendor({
        vendor: summaryVendor,
        apiKey,
        model: studioSettings.models.summary,
        systemPrompt: [
          'You summarize content for research and video production.',
          `Write a focused summary in 2-4 sentences in ${studioSettings.language}.`,
          'Capture the main topic, key arguments or findings, and any important data points.',
          'Do not use markdown formatting. Write plain text only.',
        ].join(' '),
        userPrompt: `Summarize this content:\n\nTitle: ${record.title}\n\n${record.rawText.slice(0, 12000)}`,
      });

      return summary.trim() || null;
    } catch {
      return null;
    }
  }

  async function handleTextSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!sourceDraft.body.trim()) {
      return;
    }

    const sourceId = createSourceId('text');
    const title = sourceDraft.title.trim() || `Quick note ${sources.length + 1}`;
    const body = sourceDraft.body;

    closeAddSourceDialog();
    setSources((currentSources) => [
      {
        id: sourceId,
        kind: 'text',
        title,
        origin: 'Manual note',
        status: 'analyzing',
        selected: false,
        includeSummary: sourceDraft.includeSummary,
        wordCount: 0,
        excerpt: 'Preparing your pasted text for local analysis.',
        summary: sourceDraft.includeSummary ? 'Text source queued for analysis.' : '',
        rawText: '',
      },
      ...currentSources,
    ]);
    setSourceDraft((currentDraft) => ({ ...currentDraft, title: '', body: '', includeSummary: false }));

    await wait(380);

    const record = createSourceRecord({
      id: sourceId,
      kind: 'text',
      title,
      origin: 'Manual note',
      text: body,
      includeSummary: sourceDraft.includeSummary,
      selected: true,
    });

    const aiSummary = await tryGenerateAiSummary(sourceId, record);

    startTransition(() => {
      setSources((currentSources) =>
        currentSources.map((source) =>
          source.id === sourceId
            ? { ...record, summary: aiSummary || record.summary }
            : source,
        ),
      );
    });
  }

  async function addFileSource(file: File) {
    const sourceId = createSourceId('file');
    const isMediaFile = isSupportedMediaFile(file);
    const isPlainTextFile = isTextLikeFile(file);

    if (!isMediaFile && !isPlainTextFile) {
      setSourceError('This first pass supports text files plus OpenAI-compatible audio and video uploads.');
      return;
    }

    if (isMediaFile) {
      const validationError = validateTranscriptionFile(file);

      if (validationError) {
        setSourceError(validationError);
        return;
      }

      if (!providerKeys.openai.trim()) {
        setSourceError('Set the OpenAI API key in Settings before uploading audio or video.');
        return;
      }
    }

    setSourceError('');
    closeAddSourceDialog();
    setSources((currentSources) => [
      {
        id: sourceId,
        kind: 'file',
        title: file.name,
        origin: file.name,
        status: 'analyzing',
        selected: false,
        includeSummary: sourceDraft.includeSummary,
        wordCount: 0,
        excerpt: isMediaFile ? 'Uploading media file for OpenAI transcription.' : 'Reading the uploaded file in browser-only mode.',
        summary: sourceDraft.includeSummary ? (isMediaFile ? 'Media source queued for transcription.' : 'File source queued for analysis.') : '',
        rawText: '',
      },
      ...currentSources,
    ]);

    try {
      const updateSourceProgress = ({ message, progress }: TranscriptionProgress) => {
        setSources((currentSources) =>
          currentSources.map((source) =>
            source.id === sourceId
              ? {
                  ...source,
                  excerpt: message,
                  summary: source.includeSummary ? (isMediaFile ? 'Media source is being transcribed.' : source.summary) : '',
                  processingProgress: progress,
                }
              : source,
          ),
        );
      };

      const fileText = isMediaFile
        ? await transcribeMediaFile({
            apiKey: providerKeys.openai.trim(),
            file,
            model: studioSettings.models.transcription,
            onProgress: updateSourceProgress,
          })
        : await file.text();

      const record = createSourceRecord({
        id: sourceId,
        kind: 'file',
        title: file.name,
        origin: file.name,
        text: fileText,
        includeSummary: sourceDraft.includeSummary,
        selected: true,
      });

      const aiSummary = await tryGenerateAiSummary(sourceId, record);

      startTransition(() => {
        setSources((currentSources) =>
          currentSources.map((source) =>
            source.id === sourceId
              ? { ...record, summary: aiSummary || record.summary }
              : source,
          ),
        );
      });
    } catch (error) {
      const message = readErrorMessage(error, 'Unable to read the selected file.');

      setSources((currentSources) =>
        currentSources.map((source) =>
          source.id === sourceId
            ? {
                ...source,
                status: 'failed',
                excerpt: isMediaFile ? 'The media file could not be transcribed.' : 'This upload could not be read in browser-only mode.',
                summary: isMediaFile ? 'Media transcription failed.' : 'File analysis failed.',
                error: message,
              }
            : source,
        ),
      );
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await addFileSource(file);
    event.target.value = '';
  }

  async function handleDropZoneDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDropZoneActive(false);

    const file = event.dataTransfer.files?.[0];

    if (!file) {
      return;
    }

    await addFileSource(file);
  }

  function handleSourceToggle(sourceId: string) {
    const source = sources.find((currentSource) => currentSource.id === sourceId);

    if (!source || source.status !== 'ready') {
      return;
    }

    startTransition(() => {
      setSources((currentSources) =>
        currentSources.map((source) =>
          source.id === sourceId && source.status === 'ready' ? { ...source, selected: !source.selected } : source,
        ),
      );
    });
  }

  function handleSourcePreview(sourceId: string) {
    const source = sources.find((currentSource) => currentSource.id === sourceId);

    if (!source || source.status !== 'ready') {
      return;
    }

    setActivePreviewTarget((currentTarget) =>
      currentTarget?.kind === 'source' && currentTarget.id === sourceId ? null : { kind: 'source', id: sourceId },
    );
  }

  function handleToggleAllSources() {
    startTransition(() => {
      setSources((currentSources) =>
        currentSources.map((source) =>
          source.status === 'ready' ? { ...source, selected: !allReadySelected } : source,
        ),
      );
    });
  }

  function handleModelChange(kind: ProviderKind, value: string) {
    setStudioSettings((currentSettings) => ({
      ...currentSettings,
      models: {
        ...currentSettings.models,
        [kind]: value,
      },
    }));
  }

  function handleStepProviderChange(kind: Exclude<ProviderKind, 'transcription'>, vendor: ModelVendor) {
    const vendorModels = getStepModels(kind, vendor);

    if (!vendorModels.length) {
      return;
    }

    if (kind === 'tts') {
      setStudioSettings((currentSettings) => ({
        ...currentSettings,
        voice: getDefaultVoiceForVendor(vendor, currentSettings.language),
        models: {
          ...currentSettings.models,
          [kind]: vendorModels[0].id,
        },
      }));
      return;
    }

    handleModelChange(kind, vendorModels[0].id);
  }

  function handleProviderKeyChange(vendor: ModelVendor, value: string) {
    setProviderKeys((currentKeys) => ({
      ...currentKeys,
      [vendor]: value,
    }));
  }

  function handleProviderRegionChange(vendor: ModelVendor, value: string) {
    setProviderRegions((currentRegions) => ({
      ...currentRegions,
      [vendor]: value,
    }));
  }

  function handleJobExpandToggle(jobId: string) {
    setExpandedJobIds((currentState) => ({
      ...currentState,
      [jobId]: !currentState[jobId],
    }));
  }

  function handleStepExpandToggle(jobId: string, stepId: VideoJobRecord['steps'][number]['id']) {
    const key = `${jobId}:${stepId}`;
    setExpandedStepIds((currentState) => ({
      ...currentState,
      [key]: !currentState[key],
    }));
  }

  function handleVideoJobPreview(jobId: string) {
    const job = videoJobs.find((currentJob) => currentJob.id === jobId);

    if (!job || job.status !== 'ready' || (!job.previewVideo && !job.finalVideo)) {
      return;
    }

    setActivePreviewTarget((currentTarget) =>
      currentTarget?.kind === 'video' && currentTarget.id === jobId ? null : { kind: 'video', id: jobId },
    );
  }

  function handleRequestDeleteVideoJob(jobId: string) {
    const job = videoJobs.find((currentJob) => currentJob.id === jobId);

    if (!job || job.status === 'running') {
      return;
    }

    setJobDeleteCandidate(job);
  }

  function handleDownloadVideoJob(jobId: string) {
    const job = videoJobs.find((currentJob) => currentJob.id === jobId);

    if (!job?.finalVideo) {
      return;
    }

    downloadBinaryAsset(job.finalVideo, `${slugifyFilename(job.title) || 'clipmind-video'}.mp4`);
  }

  function handleRequestDeleteSource(sourceId: string) {
    const source = sources.find((currentSource) => currentSource.id === sourceId);

    if (!source) {
      return;
    }

    setSourceDeleteCandidate(source);
  }

  function handleConfirmDeleteSource() {
    if (!sourceDeleteCandidate) {
      return;
    }

    const sourceId = sourceDeleteCandidate.id;
    setSources((currentSources) => currentSources.filter((source) => source.id !== sourceId));
    setActivePreviewTarget((currentTarget) =>
      currentTarget?.kind === 'source' && currentTarget.id === sourceId ? null : currentTarget,
    );
    setSourceDeleteCandidate(null);
  }

  function handleConfirmDeleteVideoJob() {
    if (!jobDeleteCandidate) {
      return;
    }

    const jobId = jobDeleteCandidate.id;
    setVideoJobs((currentJobs) => currentJobs.filter((job) => job.id !== jobId));
    setExpandedJobIds((currentState) => {
      const nextState = { ...currentState };
      delete nextState[jobId];
      return nextState;
    });
    setExpandedStepIds((currentState) =>
      Object.fromEntries(Object.entries(currentState).filter(([key]) => !key.startsWith(`${jobId}:`))),
    );
    setActivePreviewTarget((currentTarget) =>
      currentTarget?.kind === 'video' && currentTarget.id === jobId ? null : currentTarget,
    );
    setJobDeleteCandidate(null);
  }

  function updateVideoJob(jobId: string, updater: (job: VideoJobRecord) => VideoJobRecord) {
    setVideoJobs((currentJobs) => currentJobs.map((job) => (job.id === jobId ? updater(job) : job)));
  }

  function applyVideoJobUpdate(jobId: string, update: VideoGenerationUpdate) {
    updateVideoJob(jobId, (job) => {
      const nextUpdatedAt = new Date().toISOString();
      const nextJob: VideoJobRecord = {
        ...job,
        updatedAt: nextUpdatedAt,
        title: update.title ?? job.title,
        status: update.status ?? job.status,
        currentMessage: update.currentMessage ?? job.currentMessage,
        error: update.error ?? (update.status === 'ready' ? undefined : job.error),
        plan: update.plan ?? job.plan,
        images: update.images ?? job.images,
        audioClips: update.audioClips ?? job.audioClips,
        narrationAudio: update.narrationAudio ?? job.narrationAudio,
        previewVideo: update.previewVideo ?? job.previewVideo,
        finalVideo: update.finalVideo ?? job.finalVideo,
      };

      if (update.step) {
        nextJob.steps = job.steps.map((step) =>
          step.id === update.step?.id
            ? {
                ...step,
                status: update.step.status ?? step.status,
                message: update.step.message ?? step.message,
                provider: update.step.provider ?? step.provider,
                model: update.step.model ?? step.model,
                details: {
                  ...step.details,
                  request: update.step.request ?? step.details.request,
                  result: update.step.result ?? step.details.result,
                  handoff: update.step.handoff ?? step.details.handoff,
                },
              }
            : step,
        );
      }

      if (update.log) {
        const nextLog = {
          id: `job-log-${globalThis.crypto.randomUUID()}`,
          stepId: update.log.stepId,
          message: update.log.message,
          createdAt: nextUpdatedAt,
        };

        nextJob.logs = [nextLog, ...job.logs];
        nextJob.steps = nextJob.steps.map((step) =>
          step.id === update.log?.stepId
            ? {
                ...step,
                details: {
                  ...step.details,
                  logs: [nextLog, ...step.details.logs],
                },
              }
            : step,
        );
      }

      return nextJob;
    });
  }

  function closeAddSourceDialog() {
    setIsAddSourceDialogOpen(false);
    setIsDropZoneActive(false);
    setIsTextComposerOpen(false);
    setSourceDraft((currentDraft) => ({ ...currentDraft, includeSummary: false }));
  }

  function openAddSourceDialog() {
    setSourceError('');
    setHighlightIndex(0);
    setSourceDraft((currentDraft) => ({ ...currentDraft, includeSummary: false }));
    setIsAddSourceDialogOpen(true);
  }

  async function handleGenerateVideoPlan() {
    if (!selectedSources.length) {
      setVideoDialogError('Select at least one ready source before generating a video.');
      return;
    }

    if (hasRunningVideoJob) {
      setVideoDialogError('A browser-side video job is already running. Wait for it to finish before starting another one.');
      return;
    }

    setVideoDialogError('');

    const nextJob = createVideoJobRecord(
      selectedSources.map((source) => source.id),
      selectedSources.length === 1 ? `${selectedSources[0].title} video` : `${selectedSources[0].title} and more`,
    );
    setVideoJobs((currentJobs) => [nextJob, ...currentJobs]);
    setIsVideoStudioDialogOpen(false);

    try {
      await runVideoGenerationJob({
        sources: selectedSources,
        settings: studioSettings,
        providerKeys,
        providerRegions,
        onUpdate: (update) => applyVideoJobUpdate(nextJob.id, update),
      });
    } catch (error) {
      const message = readErrorMessage(error, 'The browser-side video pipeline stopped before the final MP4 was created.');
      applyVideoJobUpdate(nextJob.id, {
        status: 'failed',
        error: message,
        currentMessage: message,
      });
    }
  }

  return (
    <Box className="app-shell">
      <Flex className="workspace-layout" gap="4">
        <Box asChild className="app-rail">
          <nav aria-label="Workspace navigation">
            <Box className="app-rail-mark" />
            <Flex direction="column" gap="3" className="app-rail-actions">
              <IconButton size="3" radius="large" className="rail-primary-action" aria-label="Create notebook">
                <PlusIcon />
              </IconButton>
              <IconButton size="2" radius="large" variant="ghost" color="gray" className="rail-action is-active" aria-label="Sources">
                <FileTextIcon />
              </IconButton>
              <IconButton size="2" radius="large" variant="ghost" color="gray" className="rail-action" aria-label="Preview">
                <PlayIcon />
              </IconButton>
              <IconButton size="2" radius="large" variant="ghost" color="gray" className="rail-action" aria-label="Search">
                <MagnifyingGlassIcon />
              </IconButton>
              <IconButton size="2" radius="large" variant="ghost" color="gray" className="rail-action" aria-label="Settings" onClick={() => setIsSettingsDialogOpen(true)}>
                <GearIcon />
              </IconButton>
            </Flex>
          </nav>
        </Box>

        <Flex direction="column" gap="4" className="workspace-main">
          <Box className="workspace-grid">
            <Card className="column-card">
              <Flex className="column-header" align="center" justify="between" gap="3">
                <Heading as="h2" size="5" weight="medium">
                  Sources
                </Heading>
                <Button
                  size="2"
                  radius="large"
                  className="source-add-button"
                  onClick={openAddSourceDialog}
                >
                  <PlusIcon />
                  Add Source
                </Button>
              </Flex>

              <Flex align="center" justify="between" className="column-toolbar">
                <Text size="2" color="gray">
                  {readySources.length} ready
                </Text>
                <Flex align="center" gap="2">
                  <Text size="2" color="gray">
                    Select all
                  </Text>
                  <Checkbox checked={allReadySelected} onCheckedChange={handleToggleAllSources} disabled={!readySources.length} />
                </Flex>
              </Flex>

              <ScrollArea type="auto" scrollbars="vertical" className="column-scroll">
                <Flex direction="column" gap="3" className="column-body">
                  {!sources.length ? (
                    <Card size="2" variant="surface" className="empty-card">
                      <Flex direction="column" align="center" gap="2">
                        <FileTextIcon className="empty-card-icon" />
                        <Text size="3" weight="medium">
                          No sources yet
                        </Text>
                        <Text size="2" color="gray" align="center">
                          Add a website, file, or pasted text to begin building your video context.
                        </Text>
                      </Flex>
                    </Card>
                  ) : (
                    sources.map((source) => (
                      <Card
                        key={source.id}
                        size="2"
                        variant="surface"
                        className="source-card"
                        data-selected={source.selected ? 'true' : 'false'}
                        data-preview-active={activePreviewSource?.id === source.id ? 'true' : 'false'}
                        data-previewable={source.status === 'ready' ? 'true' : 'false'}
                        onClick={source.status === 'ready' ? () => handleSourcePreview(source.id) : undefined}
                        onKeyDown={
                          source.status === 'ready'
                            ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  handleSourcePreview(source.id);
                                }
                              }
                            : undefined
                        }
                        tabIndex={source.status === 'ready' ? 0 : -1}
                      >
                        <Box className="source-menu-shell" onClick={(event) => event.stopPropagation()}>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger>
                              <IconButton
                                radius="full"
                                variant="ghost"
                                color="gray"
                                size="2"
                                className="source-menu-trigger"
                                aria-label="Open source menu"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <DotsHorizontalIcon />
                              </IconButton>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                              <DropdownMenu.Item
                                color="red"
                                onSelect={(event) => {
                                  event.preventDefault();
                                  handleRequestDeleteSource(source.id);
                                }}
                              >
                                <TrashIcon />
                                Delete
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </Box>

                        <Box className="source-checkbox-shell" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={source.selected}
                            onCheckedChange={() => handleSourceToggle(source.id)}
                            disabled={source.status !== 'ready'}
                          />
                        </Box>

                        <Flex align="start" justify="between" gap="3">
                          <Flex align="start" gap="3" className="source-row-main">
                            <Box className="source-icon">
                              <SourceKindIcon kind={source.kind} />
                            </Box>
                            <Flex direction="column" gap="2" className="source-copy">
                              <Text size="3" weight="medium" className="source-name">
                                {source.title}
                              </Text>
                              <Flex wrap="wrap" gap="2">
                                <Badge size="1" radius="full" variant="soft" color="gray">
                                  {source.kind}
                                </Badge>
                                <Badge size="1" radius="full" variant="soft" color={getStatusColor(source.status)}>
                                  {source.status}
                                </Badge>
                              </Flex>
                              <Text size="1" color="gray" className="truncate-line">
                                {source.origin}
                              </Text>
                              <Text size="2" color="gray" className="clamp-3">
                                {source.status === 'ready' ? source.summary || source.excerpt : source.excerpt}
                              </Text>
                              {source.status === 'failed' && source.error ? (
                                <Text size="1" color="red">
                                  {source.error}
                                </Text>
                              ) : null}
                              {source.status === 'analyzing' && typeof source.processingProgress === 'number' ? (
                                <Box className="source-progress-shell">
                                  <Flex align="center" justify="between" gap="2">
                                    <Text size="1" color="gray">
                                      Progress
                                    </Text>
                                    <Text size="1" color="gray">
                                      {source.processingProgress}%
                                    </Text>
                                  </Flex>
                                  <Box className="source-progress-track">
                                    <Box className="source-progress-fill" style={{ width: `${source.processingProgress}%` }} />
                                  </Box>
                                </Box>
                              ) : null}
                            </Flex>
                          </Flex>
                        </Flex>
                      </Card>
                    ))
                  )}
                </Flex>
              </ScrollArea>
            </Card>

            <Card className="column-card">
              <Flex className="column-header" align="center" gap="3">
                <Heading as="h2" size="5" weight="medium">
                  Preview
                </Heading>
              </Flex>

              <Box className="column-scroll preview-column-scroll">
                <Flex direction="column" gap="3" className="column-body preview-column-body">
                  <Card size="3" variant="surface" className="preview-transcript-card">
                    {activePreviewVideoAsset && activePreviewVideoUrl ? (
                      <Flex direction="column" gap="3" className="preview-transcript-shell">
                        <Text size="4" weight="medium">
                          {activePreviewVideoJob?.title ?? 'Generated video'}
                        </Text>
                        <Text size="1" color="gray" className="truncate-line transcript-origin">
                          Final generated video preview
                        </Text>
                        <Box className="preview-video-shell">
                          <video className="preview-video-player" controls preload="metadata" src={activePreviewVideoUrl} />
                        </Box>
                      </Flex>
                    ) : activePreviewSource ? (
                      <Flex direction="column" gap="3" className="preview-transcript-shell">
                        <Text size="4" weight="medium">
                          {activePreviewSource.title}
                        </Text>
                        <Text size="1" color="gray" className="truncate-line transcript-origin">
                          {activePreviewSource.origin}
                        </Text>
                        {activePreviewSource.includeSummary && activePreviewSource.summary ? (
                          <Text size="2">
                            {activePreviewSource.summary}
                          </Text>
                        ) : null}
                        <Box className="preview-transcript-scroll">
                          <Text size="2" color="gray" className="transcript-text">
                            {activePreviewSource.rawText || 'No transcript text extracted yet.'}
                          </Text>
                        </Box>
                      </Flex>
                    ) : (
                      <Flex direction="column" align="center" justify="center" gap="2" className="preview-empty-state">
                        <FileTextIcon className="empty-card-icon" />
                        <Text size="3" weight="medium">
                          No preview selected
                        </Text>
                        <Text size="2" color="gray" align="center">
                          Select a ready source or a completed video job to preview it here.
                        </Text>
                      </Flex>
                    )}
                  </Card>
                </Flex>
              </Box>
            </Card>

            <Card className="column-card">
              <Flex direction="column" align="start" gap="3" className="column-header studio-header">
                <Heading as="h2" size="5" weight="medium">
                  Studio
                </Heading>
                <Button
                  size="2"
                  radius="large"
                  variant="soft"
                  className="studio-trigger-button"
                  onClick={() => {
                    setVideoDialogError('');
                    setIsVideoStudioDialogOpen(true);
                  }}
                >
                  <VideoIcon />
                  Generate Video
                </Button>
              </Flex>

              <Box className="studio-section-divider" />

              <ScrollArea type="auto" scrollbars="vertical" className="column-scroll">
                <Flex direction="column" gap="3" className="column-body studio-panel-body">
                  <Box className="studio-task-list-shell">
                    {videoJobs.length ? (
                      videoJobs.map((job) => (
                      <Card
                        key={job.id}
                        size="2"
                        variant="surface"
                        className="studio-job-card"
                        data-previewable={job.status === 'ready' && (job.previewVideo || job.finalVideo) ? 'true' : 'false'}
                        data-preview-active={activePreviewTarget?.kind === 'video' && activePreviewTarget.id === job.id ? 'true' : 'false'}
                        onClick={() => handleJobExpandToggle(job.id)}
                      >
                        <Flex direction="column" gap="2">
                          <Flex align="start" justify="between" gap="3" className="studio-job-summary-row">
                              <Flex align="start" gap="3" className="studio-job-summary-trigger">
                                <Box className="artifact-icon-shell">
                                  <VideoIcon />
                                </Box>
                                <Box className="studio-job-summary-copy">
                                  <Flex align="center" justify="between" gap="3" className="studio-job-title-row">
                                    <Text size="3" weight="medium">
                                      {job.title}
                                    </Text>
                                    <Badge size="1" radius="full" variant="soft" color={getJobStatusColor(job.status)}>
                                      {formatJobStatusLabel(job.status)}
                                    </Badge>
                                  </Flex>
                                  <Flex align="center" gap="2" mt="1" wrap="wrap">
                                    <Text size="1" color="gray">
                                      {formatJobTimestamp(job.updatedAt)}
                                    </Text>
                                    {job.plan ? (
                                      <Text size="1" color="gray">
                                        {job.plan.scenes.length} scenes · {formatPlanDuration(job.plan.totalDurationSec)}
                                      </Text>
                                    ) : null}
                                  </Flex>
                                </Box>
                              </Flex>

                              <Flex align="center" gap="1">
                                {job.status === 'ready' && (job.previewVideo || job.finalVideo) ? (
                                  <IconButton
                                    radius="full"
                                    variant="ghost"
                                    color="gray"
                                    size="2"
                                    aria-label="Preview completed video"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleVideoJobPreview(job.id);
                                    }}
                                  >
                                    <PlayIcon />
                                  </IconButton>
                                ) : null}

                                <IconButton
                                  radius="full"
                                  variant="ghost"
                                  color="gray"
                                  size="2"
                                  aria-label={expandedJobIds[job.id] ? 'Collapse video job details' : 'Expand video job details'}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleJobExpandToggle(job.id);
                                  }}
                                >
                                  {expandedJobIds[job.id] ? <ChevronDownIcon /> : <ChevronRightIcon />}
                                </IconButton>
                              </Flex>
                          </Flex>

                            {job.status === 'running' ? (
                              <Box className="studio-job-progress-pill">
                                <Text size="1" className="studio-job-progress-text">
                                  {job.currentMessage}
                                </Text>
                              </Box>
                            ) : null}

                            <Flex justify="end" className="studio-job-footer">
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger>
                                  <IconButton
                                    radius="full"
                                    variant="ghost"
                                    color="gray"
                                    size="2"
                                    className="studio-job-menu-trigger"
                                    aria-label="Open video job menu"
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <DotsHorizontalIcon />
                                  </IconButton>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                                  <DropdownMenu.Item
                                    disabled={!job.finalVideo}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      handleDownloadVideoJob(job.id);
                                    }}
                                  >
                                    <FileIcon />
                                    Download MP4
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item
                                    color="red"
                                    disabled={job.status === 'running'}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      handleRequestDeleteVideoJob(job.id);
                                    }}
                                  >
                                    <TrashIcon />
                                    Delete
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </Flex>

                            {expandedJobIds[job.id] ? (
                              <Flex
                                direction="column"
                                gap="2"
                                className="studio-step-list"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {job.steps.map((step) => {
                                  const stepKey = `${job.id}:${step.id}`;
                                  const isExpanded = Boolean(expandedStepIds[stepKey]);
                                  const latestStepLog = step.details.logs[0]?.message ?? step.message;

                                  return (
                                    <Box key={stepKey} className="studio-step-card">
                                      <Flex
                                        align="start"
                                        justify="between"
                                        gap="3"
                                        className="studio-step-row"
                                        onClick={() => handleStepExpandToggle(job.id, step.id)}
                                      >
                                        <Box className="studio-step-copy">
                                          <Text size="2" weight="medium">
                                            {step.stepLabel} · {step.title}
                                          </Text>
                                          <Text as="p" size="1" color="gray" mt="1">
                                            {latestStepLog}
                                          </Text>
                                        </Box>
                                        <Flex align="center" gap="2">
                                          <Badge size="1" radius="full" variant="soft" color={getStepStatusColor(step.status)}>
                                            {formatStepStatusLabel(step.status)}
                                          </Badge>
                                          <IconButton radius="full" variant="ghost" color="gray" size="1" aria-label={isExpanded ? 'Collapse step details' : 'Expand step details'}>
                                            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                                          </IconButton>
                                        </Flex>
                                      </Flex>

                                      {isExpanded ? (
                                        <Flex direction="column" gap="2" className="studio-step-detail-panel">
                                          {step.provider || step.model ? (
                                            <Text size="1" color="gray">
                                              {[step.provider ? getVendorLabel(step.provider) : '', step.model ?? ''].filter(Boolean).join(' · ')}
                                            </Text>
                                          ) : null}

                                          {step.details.request ? <StepDebugBlock title="Request" content={step.details.request} /> : null}
                                          {step.details.result ? <StepDebugBlock title="Result" content={step.details.result} /> : null}
                                          {step.details.handoff ? <StepDebugBlock title="Next handoff" content={step.details.handoff} /> : null}

                                          {step.details.logs.length ? (
                                            <Box className="studio-step-debug-block">
                                              <Text size="1" weight="medium">
                                                Logs
                                              </Text>
                                              <Flex direction="column" gap="1" mt="2">
                                                {step.details.logs.map((log) => (
                                                  <Text key={log.id} size="1" color="gray" className="studio-step-log-line">
                                                    {formatLogLine(log.createdAt, log.message)}
                                                  </Text>
                                                ))}
                                              </Flex>
                                            </Box>
                                          ) : null}
                                        </Flex>
                                      ) : null}
                                    </Box>
                                  );
                                })}
                              </Flex>
                            ) : null}

                            {expandedJobIds[job.id] && job.error ? (
                              <Callout.Root color="red" variant="soft">
                                <Callout.Icon>
                                  <ExclamationTriangleIcon />
                                </Callout.Icon>
                                <Callout.Text>{job.error}</Callout.Text>
                              </Callout.Root>
                            ) : null}
                          </Flex>
                        </Card>
                      ))
                    ) : (
                      <Box className="studio-task-empty-state">
                        <Flex direction="column" align="center" gap="2">
                          <MagicWandIcon className="studio-task-empty-icon" />
                          <Text size="3" weight="medium">
                            Studio 输出将保存在此处。
                          </Text>
                          <Text size="2" color="gray" align="center">
                            添加来源后，点击即可生成视频！
                          </Text>
                        </Flex>
                      </Box>
                    )}
                  </Box>

                  <Flex justify="end" className="studio-bottom-bar">
                    <Button
                      variant="soft"
                      color="gray"
                      radius="full"
                      className="settings-trigger-button"
                      onClick={() => setIsSettingsDialogOpen(true)}
                    >
                      <GearIcon />
                      Settings
                    </Button>
                  </Flex>
                </Flex>
              </ScrollArea>
            </Card>
          </Box>
        </Flex>
      </Flex>

      <input ref={fileInputRef} className="sr-only" type="file" accept={sourceUploadAccept} onChange={handleFileChange} />

      <Dialog.Root open={isAddSourceDialogOpen} onOpenChange={(open) => (open ? openAddSourceDialog() : closeAddSourceDialog())}>
        <Dialog.Content className="add-source-dialog" maxWidth="920px">
          <Box className="dialog-topbar">
            <Box className="dialog-header">
              <Dialog.Title>
                <Heading as="h1" size="6" align="center" weight="medium">
                  根据以下内容生成音频概览和视频概览
                </Heading>
              </Dialog.Title>
              <Dialog.Description>
                <Text size="5" align="center" className="dialog-rotating-line">
                  <span className="dialog-highlight">{rotatingHighlights[highlightIndex]}</span>
                </Text>
              </Dialog.Description>
            </Box>
            <Dialog.Close className="dialog-close">
              <IconButton radius="full" variant="ghost" color="gray" aria-label="Close add source dialog">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Box>

          <Flex direction="column" gap="4" mt="4">
            <form onSubmit={handleWebSourceSubmit}>
              <Card size="3" variant="surface" className="dialog-search-shell">
                <Flex direction="column" gap="3">
                  <Flex align="center" gap="3">
                    <TextField.Root
                      ref={queryInputRef}
                      size="3"
                      radius="large"
                      placeholder="在网络中搜索新来源"
                      value={sourceDraft.url}
                      onChange={(event) => setSourceDraft((currentDraft) => ({ ...currentDraft, url: event.target.value }))}
                      className="dialog-search-field"
                    >
                      <TextField.Slot>
                        <MagnifyingGlassIcon />
                      </TextField.Slot>
                    </TextField.Root>
                    <IconButton type="submit" radius="full" size="3" disabled={!sourceDraft.url.trim()} aria-label="Submit web source">
                      <ArrowRightIcon />
                    </IconButton>
                  </Flex>

                  <Flex gap="2" wrap="wrap">
                    <Button type="button" variant="soft" color="gray" radius="full">
                      <GlobeIcon />
                      Web
                    </Button>
                    <Button type="button" variant="soft" color="gray" radius="full">
                      <MagicWandIcon />
                      Fast Research
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            </form>

            {sourceError ? (
              <Callout.Root color="amber" variant="soft">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>{sourceError}</Callout.Text>
              </Callout.Root>
            ) : null}

            <Card
              size="4"
              variant="surface"
              className="drop-zone-card"
              data-active={isDropZoneActive ? 'true' : 'false'}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDropZoneActive(true);
              }}
              onDragLeave={() => setIsDropZoneActive(false)}
              onDrop={handleDropZoneDrop}
            >
              <Flex direction="column" align="center" gap="5">
                <Flex direction="column" align="center" gap="2">
                  <Heading as="h2" size="7" weight="medium">
                    或拖放文件
                  </Heading>
                  <Text size="4" color="gray" align="center">
                    视频、音频、文档、等等
                  </Text>
                </Flex>

                <Flex wrap="wrap" justify="center" gap="3">
                  <Button size="3" variant="outline" radius="full" onClick={() => fileInputRef.current?.click()}>
                    <UploadIcon />
                    上传文件
                  </Button>
                  <Button
                    size="3"
                    variant="outline"
                    radius="full"
                    onClick={() => {
                      setIsTextComposerOpen(false);
                      queryInputRef.current?.focus();
                    }}
                  >
                    <Link1Icon />
                    网站
                  </Button>
                  <Button size="3" variant="outline" radius="full" disabled>
                    <FileIcon />
                    云端硬盘
                  </Button>
                  <Button size="3" variant="outline" radius="full" onClick={() => setIsTextComposerOpen((currentValue) => !currentValue)}>
                    <ClipboardIcon />
                    复制的文字
                  </Button>
                </Flex>
              </Flex>
            </Card>

            {isTextComposerOpen ? (
              <Card size="3" variant="surface">
                <form onSubmit={handleTextSourceSubmit}>
                  <Flex direction="column" gap="3">
                    <Flex align="center" justify="between" gap="3">
                      <Box>
                        <Text as="p" size="3" weight="medium">
                          Copied text
                        </Text>
                        <Text as="p" size="2" color="gray">
                          Add raw text without changing the main website search box.
                        </Text>
                      </Box>
                      <IconButton type="button" variant="ghost" color="gray" radius="full" aria-label="Close copied text panel" onClick={() => setIsTextComposerOpen(false)}>
                        <Cross2Icon />
                      </IconButton>
                    </Flex>

                    <Box>
                      <Text as="label" size="2" weight="medium">
                        Title
                      </Text>
                      <TextField.Root
                        mt="2"
                        placeholder="Storyboard notes"
                        value={sourceDraft.title}
                        onChange={(event) => setSourceDraft((currentDraft) => ({ ...currentDraft, title: event.target.value }))}
                      />
                    </Box>

                    <Box>
                      <Text as="label" size="2" weight="medium">
                        Copied text
                      </Text>
                      <TextArea
                        mt="2"
                        rows={6}
                        placeholder="Paste text to convert it into a source"
                        value={sourceDraft.body}
                        onChange={(event) => setSourceDraft((currentDraft) => ({ ...currentDraft, body: event.target.value }))}
                      />
                    </Box>

                    <Flex justify="end">
                      <Button type="submit" disabled={!sourceDraft.body.trim()}>
                        Add copied text
                      </Button>
                    </Flex>
                  </Flex>
                </form>
              </Card>
            ) : null}

            <Flex align="center" justify="between" gap="3">
              <Box>
                <Text as="p" size="2" weight="medium">
                  Generate summary
                </Text>
                <Text as="p" size="1" color="gray">
                  Off by default. Turn it on only when you want a short summary above the transcript.
                </Text>
              </Box>
              <Switch
                size="2"
                checked={sourceDraft.includeSummary}
                onCheckedChange={(checked) => {
                  setSourceDraft((currentDraft) => ({
                    ...currentDraft,
                    includeSummary: checked,
                  }));
                }}
              />
            </Flex>

          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={isVideoStudioDialogOpen} onOpenChange={setIsVideoStudioDialogOpen}>
        <Dialog.Content className="video-studio-dialog" maxWidth="760px">
          <Flex align="start" justify="between" gap="3">
            <Box>
              <Dialog.Title>
                <Heading as="h2" size="5" weight="medium">
                  生成视频
                </Heading>
              </Dialog.Title>
              <Dialog.Description>
                <Text size="2" color="gray">
                  选择时长和各步骤模型，然后生成视频脚本。
                </Text>
              </Dialog.Description>
            </Box>
            <Dialog.Close>
              <IconButton radius="full" variant="ghost" color="gray" aria-label="Close video studio dialog">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Flex>

          <Flex direction="column" gap="4" mt="4">
            <Card size="2" variant="surface">
              <Flex direction="column" gap="4">
                <Text size="3" weight="medium">
                  Generation
                </Text>

                <Flex direction={{ initial: 'column', sm: 'row' }} gap="4">
                  <Box className="video-config-field">
                    <Text size="2" weight="medium">
                      Runtime target
                    </Text>
                    <Slider
                      mt="4"
                      value={[studioSettings.targetDurationSec]}
                      min={30}
                      max={90}
                      step={5}
                      onValueChange={([value]) =>
                        setStudioSettings((currentSettings) => ({
                          ...currentSettings,
                          targetDurationSec: value ?? currentSettings.targetDurationSec,
                        }))
                      }
                    />
                    <Text size="2" color="gray" mt="2">
                      {studioSettings.targetDurationSec} seconds
                    </Text>
                  </Box>
                </Flex>

                <Flex direction={{ initial: 'column', sm: 'row' }} gap="4">
                  <Box className="video-config-field">
                    <Text as="label" size="2" weight="medium">
                      Output language
                    </Text>
                    <Select.Root
                      value={studioSettings.language}
                      onValueChange={(value) =>
                        setStudioSettings((currentSettings) => {
                          const currentVendor = getModelVendor('tts', currentSettings.models.tts);
                          const nextVoiceOptions = getVoiceOptionsForVendor(currentVendor, value);
                          const nextVoice = nextVoiceOptions.includes(currentSettings.voice)
                            ? currentSettings.voice
                            : getDefaultVoiceForVendor(currentVendor, value);

                          return {
                            ...currentSettings,
                            language: value,
                            voice: nextVoice,
                          };
                        })
                      }
                    >
                      <Select.Trigger mt="2" />
                      <Select.Content>
                        {languageOptions.map((language) => (
                          <Select.Item key={`gen-language-${language}`} value={language}>
                            {language}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Box>

                  <Box className="video-config-field">
                    <Text as="label" size="2" weight="medium">
                      Voice
                    </Text>
                    <Select.Root value={studioSettings.voice} onValueChange={(value) => setStudioSettings((currentSettings) => ({ ...currentSettings, voice: value }))}>
                      <Select.Trigger mt="2" />
                      <Select.Content>
                        {availableVoiceOptions.map((voice) => (
                          <Select.Item key={`gen-voice-${voice}`} value={voice}>
                            {voice}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Box>
                </Flex>

                <Flex direction={{ initial: 'column', sm: 'row' }} gap="4">
                  <Box className="video-config-field">
                    <Text as="label" size="2" weight="medium">
                      Narration provider
                    </Text>
                    <Select.Root value={selectedTtsVendor} onValueChange={(value) => handleStepProviderChange('tts', value as ModelVendor)}>
                      <Select.Trigger mt="2" />
                      <Select.Content>
                        {getStepProviders('tts').map((provider) => (
                          <Select.Item key={`gen-tts-provider-${provider.id}`} value={provider.id}>
                            {provider.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Box>

                  <Box className="video-config-field">
                    <Text as="label" size="2" weight="medium">
                      Narration model
                    </Text>
                    <Select.Root value={studioSettings.models.tts} onValueChange={(value) => handleModelChange('tts', value)}>
                      <Select.Trigger mt="2" />
                      <Select.Content>
                        {getStepModels('tts', getModelVendor('tts', studioSettings.models.tts)).map((model) => (
                          <Select.Item key={`gen-tts-model-${model.id}`} value={model.id}>
                            {model.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Box>
                </Flex>
              </Flex>
            </Card>

            <Flex direction="column" gap="3">
              <Text size="3" weight="medium">
                Steps
              </Text>

              {videoGenerationSteps.map((step) => {
                if (!step.kind) {
                  return (
                    <Card key={step.id} size="2" variant="surface">
                      <Flex direction="column" gap="3">
                        <Box>
                          <Text size="1" weight="medium" color="gray">
                            {step.stepLabel}
                          </Text>
                          <Text as="p" size="3" weight="medium" mt="1">
                            {step.title}
                          </Text>
                          <Text as="p" size="2" color="gray" mt="1">
                            {step.detail}
                          </Text>
                        </Box>

                        <Text size="1" color="gray">
                          {step.id === 'compose'
                            ? 'This step runs locally with ffmpeg to combine the generated narration audio and scene images into the final video.'
                            : step.detail}
                        </Text>
                      </Flex>
                    </Card>
                  );
                }

                const kind = step.kind;
                const selectedVendor = getModelVendor(kind, studioSettings.models[kind]);
                const providerOptions = getStepProviders(kind);
                const modelOptions = getStepModels(kind, selectedVendor);

                return (
                  <Card key={step.id} size="2" variant="surface">
                    <Flex direction="column" gap="3">
                      <Box>
                        <Text size="1" weight="medium" color="gray">
                          {step.stepLabel}
                        </Text>
                        <Text as="p" size="3" weight="medium" mt="1">
                          {step.title}
                        </Text>
                        <Text as="p" size="2" color="gray" mt="1">
                          {step.detail}
                        </Text>
                      </Box>

                      <Flex direction={{ initial: 'column', sm: 'row' }} gap="4" className="step-config-row">
                        <Box className="video-config-field">
                          <Text as="label" size="2" weight="medium">
                            Provider
                          </Text>
                          <Select.Root value={selectedVendor} onValueChange={(value) => handleStepProviderChange(kind, value as ModelVendor)}>
                            <Select.Trigger mt="2" />
                            <Select.Content>
                              {providerOptions.map((provider) => (
                                <Select.Item key={`${step.id}-${provider.id}`} value={provider.id}>
                                  {provider.label}
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                        </Box>

                        <Box className="video-config-field">
                          <Text as="label" size="2" weight="medium">
                            Model
                          </Text>
                          <Select.Root value={studioSettings.models[kind]} onValueChange={(value) => handleModelChange(kind, value)}>
                            <Select.Trigger mt="2" />
                            <Select.Content>
                              {modelOptions.map((model) => (
                                <Select.Item key={`${step.id}-${model.id}`} value={model.id}>
                                  {model.label}
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                        </Box>
                      </Flex>

                      <Text size="1" color="gray">
                        {getModelNote(kind, studioSettings.models[kind])}
                      </Text>
                    </Flex>
                  </Card>
                );
              })}
            </Flex>

              {videoDialogError ? (
                <Callout.Root color="amber" variant="soft">
                  <Callout.Icon>
                    <ExclamationTriangleIcon />
                  </Callout.Icon>
                  <Callout.Text>{videoDialogError}</Callout.Text>
                </Callout.Root>
              ) : null}

            <Flex justify="end" gap="3">
              <Button variant="soft" color="gray" onClick={() => setIsVideoStudioDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleGenerateVideoPlan} disabled={hasRunningVideoJob}>
                {hasRunningVideoJob ? 'Video generation running...' : 'Generate video'}
              </Button>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={isSettingsDialogOpen} onOpenChange={setIsSettingsDialogOpen}>
        <Dialog.Content className="settings-dialog" maxWidth="640px">
          <Flex align="start" justify="between" gap="3">
            <Box>
              <Dialog.Title>
                <Heading as="h2" size="5" weight="medium">
                  Settings
                </Heading>
              </Dialog.Title>
            </Box>
            <Dialog.Close>
              <IconButton radius="full" variant="ghost" color="gray" aria-label="Close settings dialog">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Flex>

          <Flex direction="column" gap="3" mt="4">
            {providerCatalog.map((provider) => (
              <Card key={provider.id} size="2" variant="surface">
                <Flex direction="column" gap="3">
                  <Box>
                    <Text size="3" weight="medium">
                      {provider.label}
                    </Text>
                    <Text as="p" size="1" color="gray" mt="1">
                      Official SDK: {provider.sdk}
                    </Text>
                  </Box>

                  <Box>
                    <Text size="2" weight="medium">
                      API key
                    </Text>
                    <TextField.Root
                      mt="2"
                      type="password"
                      placeholder={`${provider.label} API key`}
                      value={providerKeys[provider.id]}
                      onChange={(event) => handleProviderKeyChange(provider.id, event.target.value)}
                    >
                      <TextField.Slot>
                        <MixerHorizontalIcon />
                      </TextField.Slot>
                      </TextField.Root>
                  </Box>

                  {provider.id === 'azure' ? (
                    <Box>
                      <Text size="2" weight="medium">
                        Region
                      </Text>
                      <TextField.Root
                        mt="2"
                        placeholder="eastus"
                        value={providerRegions.azure ?? ''}
                        onChange={(event) => handleProviderRegionChange('azure', event.target.value)}
                      >
                        <TextField.Slot>
                          <GlobeIcon />
                        </TextField.Slot>
                      </TextField.Root>
                    </Box>
                  ) : null}
                </Flex>
              </Card>
            ))}
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <AlertDialog.Root open={Boolean(jobDeleteCandidate)} onOpenChange={(open) => (!open ? setJobDeleteCandidate(null) : undefined)}>
        <AlertDialog.Content maxWidth="420px">
          <AlertDialog.Title>Delete video job?</AlertDialog.Title>
          <AlertDialog.Description>
            This removes the generated video, logs, images, and audio for{' '}
            <Text as="span" weight="medium">
              {jobDeleteCandidate?.title ?? 'this job'}
            </Text>
            . This action cannot be undone.
          </AlertDialog.Description>
          <Flex justify="end" gap="3" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={handleConfirmDeleteVideoJob}>
                Delete
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>

      <AlertDialog.Root open={Boolean(sourceDeleteCandidate)} onOpenChange={(open) => (!open ? setSourceDeleteCandidate(null) : undefined)}>
        <AlertDialog.Content maxWidth="420px">
          <AlertDialog.Title>Delete source?</AlertDialog.Title>
          <AlertDialog.Description>
            This removes{' '}
            <Text as="span" weight="medium">
              {sourceDeleteCandidate?.title ?? 'this source'}
            </Text>{' '}
            from your local sources list. This action cannot be undone.
          </AlertDialog.Description>
          <Flex justify="end" gap="3" mt="4">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={handleConfirmDeleteSource}>
                Delete
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Box>
  );
}

function SourceKindIcon({ kind }: { kind: SourceKind }) {
  if (kind === 'web') {
    return <GlobeIcon />;
  }

  if (kind === 'file') {
    return <FileIcon />;
  }

  return <ClipboardIcon />;
}

function StepDebugBlock({ title, content }: { title: string; content: string }) {
  return (
    <Box className="studio-step-debug-block">
      <Text size="1" weight="medium">
        {title}
      </Text>
      <Text as="p" size="1" color="gray" className="studio-step-debug-content">
        {content}
      </Text>
    </Box>
  );
}

function useObjectUrl(dataUrl?: string, mimeType?: string) {
  const objectUrl = useMemo(() => {
    if (!dataUrl) {
      return null;
    }

    const blob = dataUrlToBlob(dataUrl, mimeType);
    return URL.createObjectURL(blob);
  }, [dataUrl, mimeType]);

  useEffect(() => {
    if (!objectUrl) {
      return;
    }

    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  return objectUrl;
}

function getStatusColor(status: Source['status']): 'gray' | 'green' | 'amber' | 'red' {
  if (status === 'ready') {
    return 'green';
  }

  if (status === 'analyzing') {
    return 'amber';
  }

  return 'red';
}

function getJobStatusColor(status: Exclude<JobStatus, 'idle'>): 'gray' | 'green' | 'amber' | 'red' | 'blue' {
  if (status === 'ready') {
    return 'green';
  }

  if (status === 'running') {
    return 'blue';
  }

  return 'red';
}

function getStepStatusColor(status: VideoJobRecord['steps'][number]['status']): 'gray' | 'green' | 'amber' | 'red' | 'blue' {
  if (status === 'done') {
    return 'green';
  }

  if (status === 'running') {
    return 'blue';
  }

  if (status === 'failed') {
    return 'red';
  }

  return 'gray';
}

function formatJobStatusLabel(status: Exclude<JobStatus, 'idle'>): string {
  if (status === 'running') {
    return 'Running';
  }

  if (status === 'ready') {
    return 'Success';
  }

  return 'Failed';
}

function formatStepStatusLabel(status: VideoJobRecord['steps'][number]['status']): string {
  if (status === 'running') {
    return 'Running';
  }

  if (status === 'done') {
    return 'Done';
  }

  if (status === 'failed') {
    return 'Failed';
  }

  return 'Pending';
}

function formatJobTimestamp(isoValue: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(new Date(isoValue));
  } catch {
    return isoValue;
  }
}

function formatLogLine(isoValue: string, message: string): string {
  return `${formatJobTimestamp(isoValue)} · ${message}`;
}

function formatPlanDuration(durationSec: number): string {
  return `${durationSec.toFixed(1)}s`;
}

function getModelNote(kind: ProviderKind, modelId: string): string {
  const model = getModelOption(kind, modelId);

  if (!model) {
    return '';
  }

  return `${model.note} · ${getVendorLabel(model.vendor)}`;
}

function getStepProviders(kind: Exclude<ProviderKind, 'transcription'>) {
  const supportedVendors = new Set(modelCatalog[kind].map((model) => model.vendor));
  return providerCatalog.filter((provider) => supportedVendors.has(provider.id));
}

function getStepModels(kind: Exclude<ProviderKind, 'transcription'>, vendor: ModelVendor) {
  return modelCatalog[kind].filter((model) => model.vendor === vendor);
}

function getVendorLabel(vendor: ModelVendor): string {
  return providerCatalog.find((provider) => provider.id === vendor)?.label ?? vendor;
}

function normalizeWebSourceUrl(input: string): URL {
  const normalizedInput = input.trim();

  if (!normalizedInput) {
    throw new Error('Missing URL.');
  }

  if (/^https?:\/\//i.test(normalizedInput)) {
    return new URL(normalizedInput);
  }

  return new URL(`https://${normalizedInput}`);
}

async function importWebSource(url: URL, options: { fallbackTitle: string; onStageChange?: (stage: WebSourceStageUpdate) => void }): Promise<WebSourceImportResult> {
  const fallbackTitle = options.fallbackTitle;

  if (isYouTubeUrl(url)) {
    try {
      return await importYouTubeSource(url, fallbackTitle, options.onStageChange);
    } catch {
      // YouTube transcript extraction failed — fall through to regular web import
    }
  }

  try {
    options.onStageChange?.({
      excerpt: 'Fetching the page through local proxy server.',
      summary: 'Fetching the page through the dev server proxy.',
    });
    return await importProxiedWebSource(url, fallbackTitle);
  } catch {
    // Server proxy not available or failed — fall through to browser methods
  }

  try {
    options.onStageChange?.({
      excerpt: 'Trying to read this page directly from the browser.',
      summary: 'Fetching the original page in browser-only mode.',
    });
    return await importDirectWebSource(url, fallbackTitle);
  } catch (directError) {
    const directMessage = readErrorMessage(directError, 'Direct browser fetch failed.');

    try {
      options.onStageChange?.({
        excerpt: 'Direct browser access was blocked. Retrying through a CORS-friendly web reader.',
        summary: 'Trying a browser-safe fallback for this page.',
      });
      return await importFallbackWebSource(url, fallbackTitle);
    } catch (fallbackError) {
      const fallbackMessage = readErrorMessage(fallbackError, 'The browser-safe web reader also failed.');
      throw new Error(`Direct browser access failed: ${directMessage} Fallback reader failed: ${fallbackMessage}`);
    }
  }
}

async function importProxiedWebSource(url: URL, fallbackTitle: string): Promise<WebSourceImportResult> {
  const proxyUrl = `/api/fetch-url?url=${encodeURIComponent(url.toString())}`;
  const html = await fetchTextWithTimeout(proxyUrl, 'The local proxy server did not respond in time.');
  const extractedSource = extractWebSourceFromHtml(html, fallbackTitle);

  if (!extractedSource.text) {
    throw new Error('No readable article text found via the local proxy.');
  }

  return {
    title: extractedSource.title || fallbackTitle,
    text: extractedSource.text,
    method: 'proxy',
  };
}

type YouTubeCaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind?: string;
};

function isYouTubeUrl(url: URL): boolean {
  const host = url.hostname.replace('www.', '').replace('m.', '');
  return host === 'youtube.com' || host === 'youtu.be';
}

function extractYouTubeVideoId(url: URL): string | null {
  const host = url.hostname.replace('www.', '').replace('m.', '');

  if (host === 'youtu.be') {
    return url.pathname.slice(1).split('/')[0] || null;
  }

  if (host === 'youtube.com') {
    const videoIdFromQuery = url.searchParams.get('v');
    if (videoIdFromQuery) return videoIdFromQuery;

    const pathMatch = url.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/);
    return pathMatch?.[2] || null;
  }

  return null;
}

async function importYouTubeSource(
  url: URL,
  fallbackTitle: string,
  onStageChange?: (stage: WebSourceStageUpdate) => void,
): Promise<WebSourceImportResult> {
  const videoId = extractYouTubeVideoId(url);

  if (!videoId) {
    throw new Error('Could not extract YouTube video ID from the URL.');
  }

  onStageChange?.({
    excerpt: 'Fetching YouTube video page to extract transcript...',
    summary: 'Loading YouTube video metadata.',
  });

  const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const pageHtml = await fetchTextWithTimeout(
    `/api/fetch-url?url=${encodeURIComponent(pageUrl)}`,
    'The YouTube page did not respond in time.',
  );

  const videoTitle = extractYouTubeTitle(pageHtml) || fallbackTitle;
  const description = extractYouTubeDescription(pageHtml);
  const captionTracks = extractYouTubeCaptionTracks(pageHtml);

  if (!captionTracks.length) {
    if (description) {
      return { title: videoTitle, text: description, method: 'proxy' };
    }

    throw new Error('This YouTube video has no captions or subtitles available.');
  }

  onStageChange?.({
    excerpt: `Found ${captionTracks.length} subtitle track${captionTracks.length > 1 ? 's' : ''}. Downloading transcript...`,
    summary: `Downloading transcript for "${videoTitle}".`,
  });

  const preferredTrack = selectPreferredCaptionTrack(captionTracks);
  const transcriptUrl = `/api/fetch-url?url=${encodeURIComponent(preferredTrack.baseUrl)}`;
  const transcriptXml = await fetchTextWithTimeout(transcriptUrl, 'YouTube transcript download timed out.');
  const transcript = parseYouTubeTranscriptXml(transcriptXml);

  if (!transcript) {
    if (description) {
      return { title: videoTitle, text: description, method: 'proxy' };
    }

    throw new Error('The YouTube transcript was empty.');
  }

  const fullText = description
    ? `${description}\n\n---\n\n${transcript}`
    : transcript;

  return {
    title: videoTitle,
    text: fullText,
    method: 'proxy',
  };
}

function extractYouTubeTitle(html: string): string {
  const ogMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)
    ?? html.match(/<meta\s+content="([^"]*)"\s+property="og:title"/);

  if (ogMatch?.[1]) {
    return decodeHtmlEntities(ogMatch[1]).trim();
  }

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  return titleMatch?.[1]?.replace(/\s*-\s*YouTube\s*$/, '').trim() || '';
}

function extractYouTubeDescription(html: string): string {
  const match = html.match(/"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match?.[1]) return '';

  try {
    return JSON.parse(`"${match[1]}"`).trim();
  } catch {
    return '';
  }
}

function extractYouTubeCaptionTracks(html: string): YouTubeCaptionTrack[] {
  const marker = '"captionTracks":';
  const startIndex = html.indexOf(marker);
  if (startIndex === -1) return [];

  let i = startIndex + marker.length;
  while (i < html.length && html[i] === ' ') i++;
  if (html[i] !== '[') return [];

  let depth = 0;
  let arrayEnd = i;

  for (let j = i; j < html.length; j++) {
    if (html[j] === '[') depth++;
    else if (html[j] === ']') depth--;

    if (depth === 0) {
      arrayEnd = j + 1;
      break;
    }
  }

  try {
    const rawTracks = JSON.parse(html.slice(i, arrayEnd)) as Array<Record<string, unknown>>;
    return rawTracks
      .filter((track) => typeof track.baseUrl === 'string')
      .map((track) => ({
        baseUrl: track.baseUrl as string,
        languageCode: typeof track.languageCode === 'string' ? track.languageCode : 'en',
        kind: typeof track.kind === 'string' ? track.kind : undefined,
      }));
  } catch {
    return [];
  }
}

function selectPreferredCaptionTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack {
  const manualTracks = tracks.filter((t) => t.kind !== 'asr');
  const pool = manualTracks.length ? manualTracks : tracks;
  return pool.find((t) => t.languageCode === 'en') || pool[0];
}

function parseYouTubeTranscriptXml(xml: string): string {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const textElements = doc.querySelectorAll('text');
    const segments: string[] = [];

    for (const el of textElements) {
      const text = (el.textContent || '').trim();
      if (text) segments.push(text);
    }

    return segments.join(' ');
  } catch {
    return '';
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

async function importDirectWebSource(url: URL, fallbackTitle: string): Promise<WebSourceImportResult> {
  const html = await fetchTextWithTimeout(url.toString(), 'The original page took too long to respond.');
  const extractedSource = extractWebSourceFromHtml(html, fallbackTitle);

  if (!extractedSource.text) {
    throw new Error('No readable article text found on the original page.');
  }

  return {
    title: extractedSource.title || fallbackTitle,
    text: extractedSource.text,
    method: 'direct',
  };
}

async function importFallbackWebSource(url: URL, fallbackTitle: string): Promise<WebSourceImportResult> {
  try {
    const proxiedHtml = await fetchTextWithTimeout(buildAllOriginsRawUrl(url.toString()), 'The CORS-friendly web reader timed out.');
    const extractedSource = extractWebSourceFromHtml(proxiedHtml, fallbackTitle);

    if (extractedSource.text) {
      return {
        title: extractedSource.title || fallbackTitle,
        text: extractedSource.text,
        method: 'proxy',
      };
    }
  } catch (proxyError) {
    const proxyMessage = readErrorMessage(proxyError, 'The CORS-friendly web reader could not fetch the page HTML.');
    return await importReaderFallbackWebSource(url, fallbackTitle, proxyMessage);
  }

  return await importReaderFallbackWebSource(url, fallbackTitle, 'The CORS-friendly HTML fetch returned no readable article body.');
}

async function importReaderFallbackWebSource(url: URL, fallbackTitle: string, previousFailure: string): Promise<WebSourceImportResult> {
  const readerText = await fetchTextWithTimeout(buildAllOriginsRawUrl(buildJinaReaderUrl(url)), 'The text reader timed out while importing this page.');
  const extractedSource = extractWebSourceFromReaderText(readerText, fallbackTitle);

  if (!extractedSource.text) {
    throw new Error(`${previousFailure} The text reader also returned no readable content.`);
  }

  return {
    title: extractedSource.title || fallbackTitle,
    text: extractedSource.text,
    method: 'reader',
  };
}

async function fetchTextWithTimeout(url: string, timeoutMessage: string, timeoutMs = 15000): Promise<string> {
  let timeoutId: number | undefined;
  const controller = new AbortController();

  try {
    timeoutId = window.setTimeout(() => controller.abort(timeoutMessage), timeoutMs);
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }

    throw error;
  } finally {
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
    }
  }
}

function buildAllOriginsRawUrl(targetUrl: string): string {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
}

function buildJinaReaderUrl(url: URL): string {
  return `https://r.jina.ai/http://${url.host}${url.pathname}${url.search}`;
}

function extractWebSourceFromReaderText(
  payload: string,
  fallbackTitle: string,
): {
  title: string;
  text: string;
} {
  const normalizedPayload = payload.replace(/\r/g, '').trim();
  const titleMatch = normalizedPayload.match(/^Title:\s*(.+)$/m) ?? normalizedPayload.match(/^#\s+(.+)$/m);
  const text = normalizedPayload
    .split('\n')
    .filter((line) => {
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        return false;
      }

      return !/^(Title|URL|Markdown Content):/i.test(trimmedLine);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: titleMatch?.[1]?.trim() || fallbackTitle,
    text,
  };
}

function readErrorMessage(error: unknown, fallback: string): string {
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

function readStoredStudioSettings(): StudioSettings {
  const fallbackSettings = defaultStudioSettings;

  try {
    const storedValue = window.localStorage.getItem(studioSettingsStorageKey);

    if (!storedValue) {
      return fallbackSettings;
    }

    const parsedValue = JSON.parse(storedValue) as Partial<StudioSettings>;
    const normalizedSettings = {
      ...fallbackSettings,
      ...parsedValue,
      models: {
        ...fallbackSettings.models,
        ...parsedValue.models,
      },
    };
    const selectedTtsVendor = getModelVendor('tts', normalizedSettings.models.tts);
    const voiceOptionsForVendor = getVoiceOptionsForVendor(selectedTtsVendor, normalizedSettings.language);
    return {
      ...normalizedSettings,
      voice: voiceOptionsForVendor.includes(normalizedSettings.voice)
        ? normalizedSettings.voice
        : getDefaultVoiceForVendor(selectedTtsVendor, normalizedSettings.language),
    };
  } catch {
    return fallbackSettings;
  }
}

function readStoredSources(): Source[] {
  try {
    const storedValue = window.localStorage.getItem(sourcesStorageKey);

    if (!storedValue) {
      return initialSources;
    }

    const parsedValue = JSON.parse(storedValue);
    return normalizeStoredSources(parsedValue);
  } catch {
    return initialSources;
  }
}

function readStoredPreviewTarget(): PreviewTarget | null {
  try {
    const storedValue = window.localStorage.getItem(activePreviewSourceStorageKey);

    if (!storedValue) {
      return null;
    }

    const parsedValue = JSON.parse(storedValue) as Partial<PreviewTarget>;

    if ((parsedValue.kind === 'source' || parsedValue.kind === 'video') && typeof parsedValue.id === 'string' && parsedValue.id.trim()) {
      return { kind: parsedValue.kind, id: parsedValue.id };
    }

    return null;
  } catch {
    return null;
  }
}

function dataUrlToBlob(dataUrl: string, fallbackMimeType = 'application/octet-stream'): Blob {
  const [header, payload = ''] = dataUrl.split(',');
  const mimeTypeMatch = header.match(/data:(.*?)(;base64)?$/);
  const mimeType = mimeTypeMatch?.[1] || fallbackMimeType;

  if (!header.includes(';base64')) {
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  }

  const binary = window.atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function downloadBinaryAsset(asset: NonNullable<VideoJobRecord['finalVideo']>, filename: string) {
  const blob = dataUrlToBlob(asset.dataUrl, asset.mimeType);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function slugifyFilename(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readStoredProviderKeys(): ProviderKeys {
  const fallbackKeys = defaultProviderKeys;

  try {
    const storedValue = window.localStorage.getItem(providerKeysStorageKey);

    if (!storedValue) {
      return fallbackKeys;
    }

    return {
      ...fallbackKeys,
      ...normalizeStoredProviderKeys(JSON.parse(storedValue)),
    };
  } catch {
    return fallbackKeys;
  }
}

function readStoredProviderRegions(): ProviderRegions {
  const fallbackRegions = defaultProviderRegions;

  try {
    const storedValue = window.localStorage.getItem(providerRegionsStorageKey);

    if (!storedValue) {
      return fallbackRegions;
    }

    return {
      ...fallbackRegions,
      ...normalizeStoredProviderRegions(JSON.parse(storedValue)),
    };
  } catch {
    return fallbackRegions;
  }
}

function normalizeStoredProviderKeys(value: unknown): Partial<ProviderKeys> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const parsedValue = value as Partial<Record<string, unknown>>;
  return {
    openai: readStoredString(parsedValue.openai) ?? readStoredString(parsedValue.transcription) ?? '',
    anthropic: readStoredString(parsedValue.anthropic) ?? '',
    google: readStoredString(parsedValue.google) ?? '',
    mistral: readStoredString(parsedValue.mistral) ?? '',
    cantoneseai: readStoredString(parsedValue.cantoneseai) ?? '',
    azure: readStoredString(parsedValue.azure) ?? '',
    audiodub: readStoredString(parsedValue.audiodub) ?? '',
  };
}

function normalizeStoredProviderRegions(value: unknown): Partial<ProviderRegions> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const parsedValue = value as Partial<Record<string, unknown>>;
  return {
    azure: readStoredString(parsedValue.azure) ?? '',
  };
}

function normalizeStoredVideoJobs(value: unknown): VideoJobRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalizedJob = normalizeStoredVideoJob(entry);
    return normalizedJob ? [normalizedJob] : [];
  });
}

function normalizeStoredVideoJob(value: unknown): VideoJobRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const parsedValue = value as Partial<VideoJobRecord>;
  const id = readStoredString(parsedValue.id);
  const title = readStoredString(parsedValue.title);

  if (!id || !title) {
    return null;
  }

  const isInterruptedJob = parsedValue.status === 'running';
  const timestamp = new Date().toISOString();
  const storedSteps = Array.isArray(parsedValue.steps) ? parsedValue.steps : [];
  const steps = createVideoJobSteps().map((templateStep) => {
    const storedStep = storedSteps.find((step) => step && typeof step === 'object' && 'id' in step && step.id === templateStep.id) as
      | Partial<VideoJobRecord['steps'][number]>
      | undefined;
    const normalizedStatus = normalizeJobPhaseStatus(storedStep?.status, templateStep.status);

    return {
      ...templateStep,
      status: isInterruptedJob && normalizedStatus !== 'done' ? 'failed' : normalizedStatus,
      provider: normalizeModelVendor(storedStep?.provider),
      model: readStoredString(storedStep?.model) ?? undefined,
      message:
        isInterruptedJob && normalizedStatus !== 'done'
          ? 'Interrupted after a page refresh. Generate again to recreate this video.'
          : readStoredString(storedStep?.message) ?? templateStep.message,
      details: {
        request: readStoredString(storedStep?.details?.request) ?? undefined,
        result: readStoredString(storedStep?.details?.result) ?? undefined,
        handoff: readStoredString(storedStep?.details?.handoff) ?? undefined,
        logs: normalizeStoredJobLogs(storedStep?.details?.logs),
      },
    };
  });

  return {
    id,
    title,
    status: isInterruptedJob ? 'failed' : normalizeJobStatus(parsedValue.status),
    createdAt: readStoredString(parsedValue.createdAt) ?? timestamp,
    updatedAt: isInterruptedJob ? timestamp : readStoredString(parsedValue.updatedAt) ?? timestamp,
    sourceIds: Array.isArray(parsedValue.sourceIds) ? parsedValue.sourceIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [],
    currentMessage:
      isInterruptedJob
        ? 'This browser-side video job was interrupted by a refresh. Generate again to recreate it.'
        : readStoredString(parsedValue.currentMessage) ?? 'Stored video job restored from local cache.',
    steps,
    logs: normalizeStoredJobLogs(parsedValue.logs),
    error:
      isInterruptedJob
        ? 'This browser-side video job was interrupted by a refresh. Generate again to recreate it.'
        : readStoredString(parsedValue.error) ?? undefined,
    plan: normalizeStoredVideoPlan(parsedValue.plan),
    images: normalizeStoredImageAssets(parsedValue.images),
    audioClips: normalizeStoredAudioClips(parsedValue.audioClips),
    narrationAudio: normalizeStoredBinaryAsset(parsedValue.narrationAudio),
    previewVideo: normalizeStoredBinaryAsset(parsedValue.previewVideo),
    finalVideo: normalizeStoredBinaryAsset(parsedValue.finalVideo),
  };
}

function normalizeStoredVideoPlan(value: unknown): VideoJobRecord['plan'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const parsedValue = value as Partial<VideoJobRecord['plan']>;
  const title = readStoredString(parsedValue?.title);
  const summary = readStoredString(parsedValue?.summary);
  const spokenScript = readStoredString(parsedValue?.spokenScript);

  if (!title || !summary || !spokenScript || typeof parsedValue?.totalDurationSec !== 'number' || !Array.isArray(parsedValue.scenes)) {
    return undefined;
  }

  const scenes = parsedValue.scenes.flatMap((scene) => {
    if (!scene || typeof scene !== 'object') {
      return [];
    }

    const parsedScene = scene as Partial<NonNullable<VideoJobRecord['plan']>['scenes'][number]>;
    const sceneId = readStoredString(parsedScene.id);
    const sceneTitle = readStoredString(parsedScene.title);
    const voiceText = readStoredString(parsedScene.voiceText);
    const imagePrompt = readStoredString(parsedScene.imagePrompt);

    if (!sceneId || !sceneTitle || !voiceText || !imagePrompt || typeof parsedScene.durationSec !== 'number' || typeof parsedScene.startSec !== 'number') {
      return [];
    }

    return [
      {
        id: sceneId,
        title: sceneTitle,
        voiceText,
        imagePrompt,
        durationSec: parsedScene.durationSec,
        startSec: parsedScene.startSec,
      },
    ];
  });

  return scenes.length
    ? {
        title,
        summary,
        spokenScript,
        totalDurationSec: parsedValue.totalDurationSec,
        scenes,
      }
    : undefined;
}

function normalizeStoredImageAssets(value: unknown): VideoJobRecord['images'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const assets = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const parsedValue = entry as Partial<NonNullable<VideoJobRecord['images']>[number]>;
    const id = readStoredString(parsedValue.id);
    const sceneId = readStoredString(parsedValue.sceneId);
    const prompt = readStoredString(parsedValue.prompt);
    const mimeType = readStoredString(parsedValue.mimeType);
    const dataUrl = readStoredString(parsedValue.dataUrl);

    if (!id || !sceneId || !prompt || !mimeType || !dataUrl) {
      return [];
    }

    return [{ id, sceneId, prompt, mimeType, dataUrl }];
  });

  return assets.length ? assets : undefined;
}

function normalizeStoredAudioClips(value: unknown): VideoJobRecord['audioClips'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const clips = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const parsedValue = entry as Partial<NonNullable<VideoJobRecord['audioClips']>[number]>;
    const id = readStoredString(parsedValue.id);
    const sceneId = readStoredString(parsedValue.sceneId);
    const mimeType = readStoredString(parsedValue.mimeType);
    const dataUrl = readStoredString(parsedValue.dataUrl);

    if (!id || !sceneId || !mimeType || !dataUrl || typeof parsedValue.durationSec !== 'number') {
      return [];
    }

    return [{ id, sceneId, mimeType, dataUrl, durationSec: parsedValue.durationSec }];
  });

  return clips.length ? clips : undefined;
}

function normalizeStoredBinaryAsset(value: unknown): VideoJobRecord['finalVideo'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const parsedValue = value as Partial<NonNullable<VideoJobRecord['finalVideo']>>;
  const mimeType = readStoredString(parsedValue.mimeType);
  const dataUrl = readStoredString(parsedValue.dataUrl);
  return mimeType && dataUrl ? { mimeType, dataUrl } : undefined;
}

function normalizeStoredJobLogs(value: unknown): VideoJobRecord['logs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const parsedValue = entry as Partial<VideoJobRecord['logs'][number]>;
    const id = readStoredString(parsedValue.id);
    const stepId = readStoredString(parsedValue.stepId);
    const message = readStoredString(parsedValue.message);
    const createdAt = readStoredString(parsedValue.createdAt);

    if (!id || !stepId || !message || !createdAt || !isVideoJobStepId(stepId)) {
      return [];
    }

    return [{ id, stepId, message, createdAt }];
  });
}

function normalizeJobStatus(value: unknown): VideoJobRecord['status'] {
  return value === 'running' || value === 'ready' || value === 'failed' ? value : 'failed';
}

function normalizeJobPhaseStatus(value: unknown, fallback: VideoJobRecord['steps'][number]['status']): VideoJobRecord['steps'][number]['status'] {
  return value === 'idle' || value === 'running' || value === 'done' || value === 'failed' ? value : fallback;
}

function normalizeModelVendor(value: unknown): ModelVendor | undefined {
  return value === 'openai' || value === 'anthropic' || value === 'google' || value === 'mistral' || value === 'cantoneseai' || value === 'azure' || value === 'audiodub'
    ? value
    : undefined;
}

function isVideoJobStepId(value: unknown): value is VideoJobRecord['steps'][number]['id'] {
  return value === 'extract' || value === 'narrative' || value === 'storyboard' || value === 'narration' || value === 'visuals' || value === 'compose';
}

async function readCachedValue<T>(key: string): Promise<T | null> {
  try {
    const database = await openCacheDatabase();

    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(cacheStoreName, 'readonly');
      const request = transaction.objectStore(cacheStoreName).get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    });
  } catch {
    return null;
  }
}

async function writeCachedValue(key: string, value: unknown): Promise<void> {
  const database = await openCacheDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(cacheStoreName, 'readwrite');
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
    transaction.objectStore(cacheStoreName).put(value, key);
  });
}

async function openCacheDatabase(): Promise<IDBDatabase> {
  return await new Promise((resolve, reject) => {
    const request = window.indexedDB.open(cacheDatabaseName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(cacheStoreName)) {
        database.createObjectStore(cacheStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function normalizeStoredSources(value: unknown): Source[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(normalizeStoredSource);
}

function normalizeStoredSource(value: unknown): Source[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const source = value as Partial<Source>;
  const kind = normalizeStoredSourceKind(source.kind);
  const status = normalizeStoredSourceStatus(source.status);
  const title = typeof source.title === 'string' ? source.title.trim() : '';
  const origin = typeof source.origin === 'string' ? source.origin.trim() : '';

  if (!kind || !title || !origin || typeof source.id !== 'string' || !source.id.trim()) {
    return [];
  }

  const rawText = typeof source.rawText === 'string' ? source.rawText : '';
  const excerpt = typeof source.excerpt === 'string' ? source.excerpt : '';
  const summary = typeof source.summary === 'string' ? source.summary : '';
  const includeSummary = typeof source.includeSummary === 'boolean' ? source.includeSummary : Boolean(summary && kind !== 'file');
  const error = typeof source.error === 'string' && source.error.trim() ? source.error : undefined;
  const processingProgress = typeof source.processingProgress === 'number' ? clampProgress(source.processingProgress) : undefined;
  const normalizedSource: Source = {
    id: source.id,
    kind,
    title,
    origin,
    status,
    selected: Boolean(source.selected) && status === 'ready',
    includeSummary,
    wordCount: typeof source.wordCount === 'number' && Number.isFinite(source.wordCount) ? source.wordCount : countStoredWords(rawText),
    excerpt,
    summary: includeSummary ? summary : '',
    rawText,
    processingProgress,
    error,
  };

  return [status === 'analyzing' ? recoverInterruptedSource(normalizedSource) : normalizedSource];
}

function normalizeStoredSourceKind(kind: unknown): SourceKind | null {
  if (kind === 'web' || kind === 'file' || kind === 'text') {
    return kind;
  }

  return null;
}

function normalizeStoredSourceStatus(status: unknown): Source['status'] {
  if (status === 'ready' || status === 'failed' || status === 'analyzing') {
    return status;
  }

  return 'failed';
}

function recoverInterruptedSource(source: Source): Source {
  return {
    ...source,
    status: 'failed',
    selected: false,
    processingProgress: undefined,
    excerpt: 'Processing stopped after a refresh. Re-upload this source to continue.',
    summary: 'Source processing was interrupted.',
    error: source.error ?? 'This browser refresh interrupted the local processing task.',
  };
}

function clampProgress(progress: number): number {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function countStoredWords(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function readStoredString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export default App;
