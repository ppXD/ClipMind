import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
import { createAnthropicClient, createAzureSpeechSdk, createGoogleClient, createMistralClient, createOpenAIClient } from './provider-clients';
import { renderSubtitleBurnedImage } from './subtitle-theme';
import { getModelVendor } from './workspace';
import type {
  JobPhaseStatus,
  ModelVendor,
  ProviderKeys,
  ProviderRegions,
  Source,
  StudioSettings,
  VideoAudioClip,
  VideoBinaryAsset,
  VideoImageAsset,
  VideoJobStepId,
  VideoPlan,
  VideoScene,
} from '../types/workspace';

const ffmpegBaseUrl = '/ffmpeg';
const ffmpegLoadTimeoutMs = 120_000;
const fallbackSceneCount = 4;
const maxContextChars = 28_000;
const audiodubTtsBaseRequestTimeoutMs = 45_000;
const audiodubTtsMaxRequestTimeoutMs = 150_000;
const audiodubTtsPerCharTimeoutMs = 18;
const audiodubTtsMaxAttempts = 2;
const audiodubTtsAudioFetchTimeoutMs = 30_000;
const audiodubNarrationConcurrency = 1;
const minimaxTtsRequestTimeoutMs = 90_000;
const h264Preset = 'veryfast';
const h264Crf = '21';
const h264MaxRate = '5M';
const h264BufSize = '10M';
const aacBitrate = '128k';

type ProgressRange = {
  start: number;
  end: number;
};

type SubtitleCue = {
  index: number;
  sceneId: string;
  startSec: number;
  endSec: number;
  text: string;
};

type FFmpegModule = typeof import('@ffmpeg/ffmpeg');
type FFmpegInstance = InstanceType<FFmpegModule['FFmpeg']>;

export type VideoGenerationUpdate = {
  title?: string;
  status?: 'running' | 'ready' | 'failed';
  currentMessage?: string;
  step?: {
    id: VideoJobStepId;
    status?: JobPhaseStatus;
    message?: string;
    provider?: ModelVendor;
    model?: string;
    request?: string;
    result?: string;
    handoff?: string;
  };
  log?: {
    stepId: VideoJobStepId;
    message: string;
  };
  plan?: VideoPlan;
  images?: VideoImageAsset[];
  audioClips?: VideoAudioClip[];
  narrationAudio?: VideoBinaryAsset;
  previewVideo?: VideoBinaryAsset;
  finalVideo?: VideoBinaryAsset;
  error?: string;
};

export type VideoGenerationRequest = {
  sources: Source[];
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
  onUpdate?: (update: VideoGenerationUpdate) => void;
};

let ffmpegInstancePromise: Promise<FFmpegInstance> | null = null;

export async function runVideoGenerationJob({ sources, settings, providerKeys, providerRegions, onUpdate }: VideoGenerationRequest) {
  if (!sources.length) {
    throw new Error('Select at least one ready source before starting video generation.');
  }

  const useDirectSourceMode = settings.contentMode === 'direct-source';
  const selectedSummaryVendor = getModelVendor('summary', settings.models.summary);
  const selectedScriptVendor = getModelVendor('script', settings.models.script);
  const selectedTtsVendor = getModelVendor('tts', settings.models.tts);
  const selectedImageVendor = getModelVendor('image', settings.models.image);

  const requiredProviders: Array<[string, ModelVendor]> = useDirectSourceMode
    ? [
        ['narration', selectedTtsVendor],
        ['visuals', selectedImageVendor],
      ]
    : [
        ['extract', selectedSummaryVendor],
        ['narrative', selectedScriptVendor],
        ['narration', selectedTtsVendor],
        ['visuals', selectedImageVendor],
      ];
  validateProviderKeys(
    requiredProviders,
    providerKeys,
    providerRegions,
  );

  let activeStepId: VideoJobStepId = 'extract';

  try {
    emitJobUpdate(onUpdate, {
      status: 'running',
      currentMessage: 'Collecting selected source text and preparing the 6-step video generation pipeline.',
      log: { stepId: 'extract', message: `Loaded ${sources.length} selected source${sources.length > 1 ? 's' : ''} into the browser-side pipeline.` },
    });

    const extraction = useDirectSourceMode
      ? await runExtractDirectStep({ sources, settings, onUpdate })
      : await runExtractStep({ sources, settings, providerKeys, vendor: selectedSummaryVendor, onUpdate });
    activeStepId = 'narrative';
    const narrativeArc = useDirectSourceMode
      ? await runNarrativeDirectStep({ extraction, settings, onUpdate })
      : await runNarrativeStep({ extraction, settings, providerKeys, vendor: selectedScriptVendor, onUpdate });
    activeStepId = 'storyboard';
    const plan = useDirectSourceMode
      ? await runStoryboardDirectStep({ extraction, sources, settings, onUpdate })
      : await runStoryboardStep({ extraction, narrativeArc, sources, settings, providerKeys, vendor: selectedScriptVendor, onUpdate });
    activeStepId = 'narration';
    const audioStep = await runNarrationStep({ plan, settings, providerKeys, providerRegions, vendor: selectedTtsVendor, onUpdate });
    activeStepId = 'visuals';
    const images = await runVisualsStep({ plan: audioStep.plan, settings, providerKeys, vendor: selectedImageVendor, onUpdate });
    activeStepId = 'compose';
    const composition = await runComposeStep({ plan: audioStep.plan, audioClips: audioStep.audioClips, images, settings, onUpdate });

    emitJobUpdate(onUpdate, {
      status: 'ready',
      currentMessage: 'Video generation finished. The final subtitled MP4 is ready.',
      step: {
        id: 'compose',
        status: 'done',
        message: 'Final subtitled MP4 export completed.',
        result: formatDebugValue({
          previewVideoMimeType: composition.previewVideo?.mimeType ?? 'not generated',
          finalVideoMimeType: composition.finalVideo.mimeType,
          narrationAudioMimeType: composition.narrationAudio.mimeType,
          totalDurationSec: audioStep.plan.totalDurationSec,
          sceneCount: audioStep.plan.scenes.length,
          subtitleCueCount: countSubtitleCues(audioStep.plan),
          subtitlePreview: createSubtitlePreview(audioStep.plan),
        }),
        handoff: 'The final subtitled MP4 is now attached to the completed Studio job and can be previewed in the Preview panel.',
      },
      log: { stepId: 'compose', message: 'The slideshow video, subtitle timeline, narration audio, and final MP4 are ready in the browser.' },
      plan: audioStep.plan,
      images,
      audioClips: audioStep.audioClips,
      narrationAudio: composition.narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
      title: audioStep.plan.title,
    });

    return {
      plan: audioStep.plan,
      images,
      audioClips: audioStep.audioClips,
      narrationAudio: composition.narrationAudio,
      previewVideo: composition.previewVideo,
      finalVideo: composition.finalVideo,
    };
  } catch (error) {
    const message = readThrownMessage(error, 'Video generation failed before the final MP4 was created.');
    emitJobUpdate(onUpdate, {
      status: 'failed',
      currentMessage: message,
      error: message,
      step: {
        id: activeStepId,
        status: 'failed',
        message,
      },
      log: {
        stepId: activeStepId,
        message,
      },
    });
    throw error;
  }
}

async function runExtractStep({
  sources,
  settings,
  providerKeys,
  vendor,
  onUpdate,
}: {
  sources: Source[];
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  vendor: ModelVendor;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<string> {
  emitStepStarted(onUpdate, 'extract', vendor, settings.models.summary, 'Extracting structured key facts from the selected sources.');
  const context = buildSourceContext(sources);
  const extractRequest = formatDebugValue({
    vendor,
    model: settings.models.summary,
    sourceCount: sources.length,
    language: settings.language,
    targetDurationSec: settings.targetDurationSec,
    promptPreview: truncateText(context, 2000),
  });
  emitJobUpdate(onUpdate, {
    currentMessage: `Step 1: extracting key facts from ${sources.length} source${sources.length > 1 ? 's' : ''} with ${formatVendorName(vendor)} ${settings.models.summary}.`,
    step: {
      id: 'extract',
      request: extractRequest,
      handoff: 'The extracted facts will be passed into Step 2 for narrative arc design.',
    },
    log: {
      stepId: 'extract',
      message: `Calling ${formatVendorName(vendor)} ${settings.models.summary} to extract facts from ${sources.length} source${sources.length > 1 ? 's' : ''}.`,
    },
  });
  const extraction = await generateTextWithVendor({
    vendor,
    apiKey: providerKeys[vendor],
    model: settings.models.summary,
    systemPrompt: [
      'You extract structured information from source material for video production.',
      `Work entirely in ${settings.language}. Output a structured summary with these sections per source:`,
      '- Key facts: important facts and statistics',
      '- Quotes: notable direct quotes',
      '- Themes: recurring themes or topics',
      '- Emotional hooks: surprising or attention-grabbing elements',
    ].join('\n'),
    userPrompt: [
      `Extract key facts, statistics, quotes, and themes from each source for a ${settings.targetDurationSec}-second video.`,
      `Write everything in ${settings.language}. Preserve the most important details and signal.`,
      '',
      context,
    ].join('\n'),
  });

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 1 completed. Structured key facts are ready for narrative design.',
    step: {
      id: 'extract',
      status: 'done',
      message: 'Key fact extraction completed.',
      result: formatDebugValue({
        extraction: truncateText(extraction, 3000),
        length: extraction.length,
      }),
      handoff: 'Step 2 will use these extracted facts to design the narrative arc.',
    },
    log: {
      stepId: 'extract',
      message: `Step 1 completed with ${extraction.length} characters of extracted facts in ${settings.language}.`,
    },
  });

  return extraction;
}

async function runExtractDirectStep({
  sources,
  settings,
  onUpdate,
}: {
  sources: Source[];
  settings: StudioSettings;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<string> {
  emitStepStarted(onUpdate, 'extract', undefined, undefined, 'Step 1: using source text directly (no summary rewrite).');
  const extraction = buildDirectSourceText(sources);

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 1 completed. Direct source text is ready for sentence mapping.',
    step: {
      id: 'extract',
      status: 'done',
      message: 'Direct source mode keeps the original wording.',
      result: formatDebugValue({
        mode: settings.contentMode,
        sourceCount: sources.length,
        charCount: extraction.length,
        preview: truncateText(extraction, 3000),
      }),
      handoff: 'Step 2 confirms direct mode and keeps text unchanged.',
    },
    log: {
      stepId: 'extract',
      message: `Direct source mode enabled. Reused ${extraction.length} characters from selected sources without summarization.`,
    },
  });

  return extraction;
}

async function runNarrativeStep({
  extraction,
  settings,
  providerKeys,
  vendor,
  onUpdate,
}: {
  extraction: string;
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  vendor: ModelVendor;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<string> {
  emitStepStarted(onUpdate, 'narrative', vendor, settings.models.script, 'Designing the narrative arc for the video.');
  const narrativeRequest = formatDebugValue({
    vendor,
    model: settings.models.script,
    language: settings.language,
    targetDurationSec: settings.targetDurationSec,
    extractionPreview: truncateText(extraction, 2000),
  });
  emitJobUpdate(onUpdate, {
    currentMessage: `Step 2: designing narrative arc with ${formatVendorName(vendor)} ${settings.models.script}.`,
    step: {
      id: 'narrative',
      request: narrativeRequest,
      handoff: 'The narrative arc will guide Step 3 storyboard scene planning.',
    },
    log: {
      stepId: 'narrative',
      message: `Calling ${formatVendorName(vendor)} ${settings.models.script} for narrative arc design in ${settings.language}.`,
    },
  });

  const narrativeArc = await generateTextWithVendor({
    vendor,
    apiKey: providerKeys[vendor],
    model: settings.models.script,
    systemPrompt: [
      `You are a video narrative designer. Given extracted facts, design a compelling story arc for a ${settings.targetDurationSec}-second video.`,
      '',
      'Structure your narrative as:',
      '1. Hook (first 5-8 seconds): A surprising fact, question, or bold statement that grabs attention',
      '2. Development: Build context and explain the background',
      '3. Insight: The "aha moment" — the key takeaway viewers should remember',
      '4. Conclusion: A memorable ending that sticks',
      '',
      `Write entirely in spoken ${settings.language}.`,
      'Return plain text describing the narrative arc, with each section clearly labeled.',
    ].join('\n'),
    userPrompt: [
      `Design a narrative arc for a ${settings.targetDurationSec}-second video based on these extracted facts.`,
      `Write in ${settings.language}. Focus on creating a compelling story, not a flat list of facts.`,
      '',
      'Extracted facts:',
      extraction,
    ].join('\n'),
  });

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 2 completed. Narrative arc is ready for storyboard planning.',
    step: {
      id: 'narrative',
      status: 'done',
      message: 'Narrative arc design completed.',
      result: formatDebugValue({
        narrativeArc: truncateText(narrativeArc, 3000),
        length: narrativeArc.length,
      }),
      handoff: 'Step 3 will use this narrative arc to write per-scene narration and visual direction.',
    },
    log: {
      stepId: 'narrative',
      message: `Step 2 completed with ${narrativeArc.length} characters of narrative arc in ${settings.language}.`,
    },
  });

  return narrativeArc;
}

async function runNarrativeDirectStep({
  extraction,
  settings,
  onUpdate,
}: {
  extraction: string;
  settings: StudioSettings;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<string> {
  emitStepStarted(onUpdate, 'narrative', undefined, undefined, 'Step 2: skipping narrative rewrite in direct source mode.');

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 2 completed. Narrative rewrite skipped to preserve source text.',
    step: {
      id: 'narrative',
      status: 'done',
      message: 'Direct source mode bypassed narrative rewriting.',
      result: formatDebugValue({
        mode: settings.contentMode,
        preservedCharacters: extraction.length,
      }),
      handoff: 'Step 3 will split source text into scene-aligned sentence groups without rewriting.',
    },
    log: {
      stepId: 'narrative',
      message: 'Narrative rewrite skipped. Source wording remains unchanged for storyboard segmentation.',
    },
  });

  return extraction;
}

async function runStoryboardStep({
  extraction,
  narrativeArc,
  sources,
  settings,
  providerKeys,
  vendor,
  onUpdate,
}: {
  extraction: string;
  narrativeArc: string;
  sources: Source[];
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  vendor: ModelVendor;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<VideoPlan> {
  emitStepStarted(onUpdate, 'storyboard', vendor, settings.models.script, 'Writing per-scene narration, visual direction, and style guide.');
  const targetSceneCount = clamp(Math.round(settings.targetDurationSec / 14), 3, 6);
  const context = buildSourceHeadlines(sources);
  const storyboardRequest = formatDebugValue({
    vendor,
    model: settings.models.script,
    language: settings.language,
    targetDurationSec: settings.targetDurationSec,
    targetSceneCount,
    narrativeArcPreview: truncateText(narrativeArc, 2000),
    sourceHeadlines: truncateText(context, 2500),
  });

  emitJobUpdate(onUpdate, {
    currentMessage: `Step 3: writing storyboard with ${formatVendorName(vendor)} ${settings.models.script}.`,
    step: {
      id: 'storyboard',
      request: storyboardRequest,
      handoff: 'The storyboard plan will feed Step 4 for narration audio and Step 5 for image generation.',
    },
    log: {
      stepId: 'storyboard',
      message: `Requesting a JSON storyboard with ${targetSceneCount} scenes in ${settings.language}.`,
    },
  });

  const rawPlan = await generateTextWithVendor({
    vendor,
    apiKey: providerKeys[vendor],
    model: settings.models.script,
    expectJson: true,
    systemPrompt: [
      'You write video storyboards with narration and visual direction.',
      'Return only strict JSON. Do not include markdown fences, commentary, or explanations.',
      '',
      `CRITICAL: Write ALL narration as natural spoken ${settings.language}.`,
      `- Use the rhythm and phrasing of a native ${settings.language} speaker`,
      '- Include natural spoken connectors, not written transitions',
      '- Keep sentences short and punchy for voice delivery',
      '',
      'Also generate:',
      '1. A "visualStyleGuide" that ALL scene images must follow',
      '   (e.g., "Cinematic photography, warm golden tones, shallow depth of field, 16:9")',
      '2. Per-scene "imagePrompt" — ALWAYS in English, must reference the style guide',
      '3. Per-scene "transition" — "cut" or "crossfade"',
      '',
      'For each scene, also split the voiceText into subtitle cue segments at natural',
      'pause points. Each cue should be 1-2 short lines that display well on screen.',
    ].join('\n'),
    userPrompt: [
      `Create a ${settings.targetDurationSec}-second video storyboard with exactly ${targetSceneCount} scenes.`,
      `Write narration in spoken ${settings.language} — like a YouTuber or podcast host, not a textbook.`,
      'Write every imagePrompt in English so image models can follow it reliably.',
      'durationSec values must add up exactly to the target duration.',
      '',
      'Return JSON using this shape:',
      '{',
      '  "title": "string",',
      '  "summary": "string",',
      '  "visualStyleGuide": "string describing consistent visual style for all scenes",',
      '  "spokenScript": "full narration text concatenated",',
      '  "scenes": [{',
      '    "title": "string",',
      '    "voiceText": "spoken narration for this scene",',
      '    "subtitleCues": ["first subtitle line", "second subtitle line"],',
      '    "imagePrompt": "English image prompt incorporating the style guide",',
      '    "transition": "crossfade",',
      '    "durationSec": 12',
      '  }]',
      '}',
      '',
      'Narrative arc to follow:',
      narrativeArc,
      '',
      'Extracted facts:',
      extraction,
      '',
      'Source headlines:',
      context,
    ].join('\n'),
  });

  const parsedPlan = parseVideoPlan(rawPlan, settings.targetDurationSec, extraction);
  emitJobUpdate(onUpdate, {
    title: parsedPlan.title,
    currentMessage: 'Step 3 completed. The storyboard with narration and visual direction is ready.',
    step: {
      id: 'storyboard',
      status: 'done',
      message: `Storyboard completed with ${parsedPlan.scenes.length} scenes.`,
      result: formatDebugValue({
        title: parsedPlan.title,
        summary: parsedPlan.summary,
        visualStyleGuide: parsedPlan.visualStyleGuide,
        totalDurationSec: parsedPlan.totalDurationSec,
        scenes: parsedPlan.scenes.map((scene) => ({
          id: scene.id,
          title: scene.title,
          durationSec: scene.durationSec,
          voiceText: scene.voiceText,
          imagePrompt: scene.imagePrompt,
          transition: scene.transition,
          subtitleCueCount: scene.subtitleCues?.length,
        })),
      }),
      handoff: 'Step 4 receives each scene voiceText to generate narration clips. Step 5 receives each scene imagePrompt with the style guide to generate still images.',
    },
    log: {
      stepId: 'storyboard',
      message: `Step 3 completed. Parsed ${parsedPlan.scenes.length} scenes and ${parsedPlan.spokenScript.length} characters of narration.`,
    },
    plan: parsedPlan,
  });

  return parsedPlan;
}

async function runStoryboardDirectStep({
  extraction,
  sources,
  settings,
  onUpdate,
}: {
  extraction: string;
  sources: Source[];
  settings: StudioSettings;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<VideoPlan> {
  emitStepStarted(onUpdate, 'storyboard', undefined, undefined, 'Step 3: splitting direct source text into scene sentence groups.');

  const sourceSentences = splitDirectSourceSentences(extraction, settings.language);
  const sceneSentenceGroups = groupSentencesIntoSceneGroups(sourceSentences, settings.language);
  const sceneTexts = sceneSentenceGroups.map((sentences) => joinSentences(sentences, settings.language));
  const targetDurations = estimateDirectSceneDurations(sceneTexts, settings.language);
  const totalEstimatedDurationSec = Math.max(10, Math.round(targetDurations.reduce((sum, duration) => sum + duration, 0)));
  const normalizedDurations = rebalanceDurations(targetDurations, totalEstimatedDurationSec);
  const headlineContext = buildSourceHeadlines(sources);
  let startSec = 0;

  const scenes: VideoScene[] = sceneTexts.map((voiceText, index) => {
    const sentenceGroup = sceneSentenceGroups[index] ?? [voiceText];
    const durationSec = normalizedDurations[index] ?? 1;
    const scene: VideoScene = {
      id: `scene-${index + 1}`,
      title: `Source Segment ${index + 1}`,
      voiceText,
      imagePrompt: buildDirectImagePrompt(voiceText, headlineContext),
      durationSec,
      startSec,
      transition: index === 0 ? 'cut' : 'crossfade',
      subtitleCues: createDirectSubtitleCuesFromSentences(sentenceGroup, settings.language),
    };
    startSec += durationSec;
    return scene;
  });

  const plan: VideoPlan = {
    title: sources.length === 1 ? `${sources[0].title} video` : `${sources[0]?.title ?? 'Source'} and more`,
    summary: `Direct source mode. Text preserved from ${sources.length} source${sources.length > 1 ? 's' : ''}.`,
    spokenScript: sceneTexts.join(' '),
    totalDurationSec: scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
    scenes,
    visualStyleGuide: 'Documentary stills, realistic editorial look, consistent color grading, clean composition, widescreen 16:9.',
  };

  emitJobUpdate(onUpdate, {
    title: plan.title,
    currentMessage: 'Step 3 completed. Direct source storyboard is ready.',
    step: {
      id: 'storyboard',
      status: 'done',
      message: `Mapped source text into ${plan.scenes.length} scenes without rewriting.`,
      result: formatDebugValue({
        mode: settings.contentMode,
        totalDurationSec: plan.totalDurationSec,
        sceneCount: plan.scenes.length,
        scenes: plan.scenes.map((scene) => ({
          id: scene.id,
          durationSec: scene.durationSec,
          startSec: scene.startSec,
          voiceText: scene.voiceText,
        })),
      }),
      handoff: 'Step 4 will generate narration directly from preserved scene text. Step 5 will generate matching images.',
    },
    log: {
      stepId: 'storyboard',
      message: `Direct source storyboard built with ${plan.scenes.length} scenes and ${plan.spokenScript.length} script characters.`,
    },
    plan,
  });

  return plan;
}

async function runNarrationStep({
  plan,
  settings,
  providerKeys,
  providerRegions,
  vendor,
  onUpdate,
}: {
  plan: VideoPlan;
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  providerRegions: ProviderRegions;
  vendor: ModelVendor;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<{ plan: VideoPlan; audioClips: VideoAudioClip[] }> {
  emitStepStarted(onUpdate, 'narration', vendor, settings.models.tts, 'Generating narration audio clip-by-clip.');

  if (vendor !== 'openai' && vendor !== 'cantoneseai' && vendor !== 'azure' && vendor !== 'audiodub' && vendor !== 'minimax') {
    throw new Error('Narration voice generation requires an OpenAI, Azure Speech, Cantonese.ai, Audiodub, or MiniMax TTS model.');
  }

  const voice = settings.voice || 'alloy';
  const audioClips: VideoAudioClip[] = [];
  const actualDurations: number[] = [];
  const narrationConcurrency = resolveNarrationConcurrency(vendor, plan.scenes.length);
  const ttsRequest = formatDebugValue({
    vendor,
    model: settings.models.tts,
    language: settings.language,
    voice,
    sceneCount: plan.scenes.length,
    scenes: plan.scenes.map((scene) => ({
      sceneId: scene.id,
      title: scene.title,
      voiceText: scene.voiceText,
    })),
  });

  emitJobUpdate(onUpdate, {
    currentMessage: `Step 4: generating ${plan.scenes.length} narration clip${plan.scenes.length > 1 ? 's' : ''} in ${settings.language} with ${formatVendorName(vendor)}.`,
    step: {
      id: 'narration',
      request: ttsRequest,
      handoff: 'The generated audio clips will update scene durations and then feed Step 6 for final ffmpeg composition.',
    },
    log: {
      stepId: 'narration',
      message: `Calling ${formatVendorName(vendor)} ${settings.models.tts} for clip-based narration generation.`,
    },
  });

  emitJobUpdate(onUpdate, {
    currentMessage: `Step 4: generating narration with up to ${narrationConcurrency} concurrent request${narrationConcurrency > 1 ? 's' : ''}.`,
    step: {
      id: 'narration',
      status: 'running',
      message: `Generating ${plan.scenes.length} narration clips with controlled concurrency.`,
    },
    log: {
      stepId: 'narration',
      message: `Launching up to ${narrationConcurrency} concurrent TTS requests for ${plan.scenes.length} scenes.`,
    },
  });

  let narrationCompletedCount = 0;
  const clipResults = await mapWithConcurrency(
    plan.scenes,
    narrationConcurrency,
    async (scene, index) => {
      emitJobUpdate(onUpdate, {
        log: {
          stepId: 'narration',
          message: `Starting narration request for ${scene.title} (${index + 1}/${plan.scenes.length}).`,
        },
      });

      let blob: Blob;
      try {
        blob = vendor === 'cantoneseai'
          ? await generateCantoneseAiTts({
              apiKey: providerKeys.cantoneseai,
              text: scene.voiceText,
              language: settings.language,
              voiceId: voice,
              useTurbo: settings.models.tts === 'cantoneseai-tts-turbo',
            })
          : vendor === 'azure'
            ? await generateAzureSpeechTts({
                apiKey: providerKeys.azure,
                region: providerRegions.azure ?? '',
                text: scene.voiceText,
                language: settings.language,
                voice,
              })
          : vendor === 'audiodub'
            ? await generateAudiodubTts({
                apiKey: providerKeys.audiodub,
                text: scene.voiceText,
                language: settings.language,
                voiceId: voice,
                onProgress: (status) => {
                  emitJobUpdate(onUpdate, {
                    log: {
                      stepId: 'narration',
                      message: `Scene ${index + 1}/${plan.scenes.length} (${scene.title}): ${status}`,
                    },
                  });
                },
              })
          : vendor === 'minimax'
            ? await generateMiniMaxTts({
                apiKey: providerKeys.minimax,
                text: scene.voiceText,
                language: settings.language,
                voiceId: voice,
                model: settings.models.tts,
                onProgress: (status) => {
                  emitJobUpdate(onUpdate, {
                    log: {
                      stepId: 'narration',
                      message: `Scene ${index + 1}/${plan.scenes.length} (${scene.title}): ${status}`,
                    },
                  });
                },
              })
          : await generateOpenAiTts({
              apiKey: providerKeys[vendor],
              model: settings.models.tts,
              text: scene.voiceText,
              voice,
              language: settings.language,
            });
      } catch (error) {
        const detail = readThrownMessage(error, 'TTS request failed.');
        throw new Error(`Narration request ${index + 1}/${plan.scenes.length} failed for ${scene.title}. ${detail}`);
      }

      const durationSec = await readMediaDurationFromBlob(blob, 'audio/wav');
      const dataUrl = await blobToDataUrl(blob);
      narrationCompletedCount += 1;

      emitJobUpdate(onUpdate, {
        currentMessage: `Step 4: ${narrationCompletedCount} of ${plan.scenes.length} narration clips ready.`,
        step: {
          id: 'narration',
          status: 'running',
          message: `Narration ${narrationCompletedCount} of ${plan.scenes.length} is ready (${scene.title}).`,
        },
        log: {
          stepId: 'narration',
          message: `Narration for ${scene.title} (scene ${index + 1}) is ready at ${formatSeconds(durationSec)}.`,
        },
      });

      return { index, scene, blob, durationSec, dataUrl };
    },
  );

  for (const result of clipResults.sort((a, b) => a.index - b.index)) {
    audioClips.push({
      id: `audio-${result.scene.id}`,
      sceneId: result.scene.id,
      mimeType: result.blob.type || 'audio/wav',
      dataUrl: result.dataUrl,
      durationSec: result.durationSec,
    });
    actualDurations.push(result.durationSec);
  }

  emitJobUpdate(onUpdate, {
    audioClips: [...audioClips],
  });

  const durationAlignedPlan = applySceneDurations(plan, actualDurations);
  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 4 completed. Narration clips are ready and scene timing was updated from real audio lengths.',
    step: {
      id: 'narration',
      status: 'done',
      message: 'Narration audio clips completed.',
      result: formatDebugValue({
        totalDurationSec: durationAlignedPlan.totalDurationSec,
        voice,
        audioClips: audioClips.map((clip) => ({
          sceneId: clip.sceneId,
          durationSec: clip.durationSec,
          mimeType: clip.mimeType,
        })),
      }),
      handoff: 'Step 5 keeps using the updated scene plan. Step 6 will combine these audio clips with generated images.',
    },
    log: {
      stepId: 'narration',
      message: `Step 4 completed. Total narration length is ${formatSeconds(durationAlignedPlan.totalDurationSec)}.`,
    },
    plan: durationAlignedPlan,
    audioClips,
  });

  return {
    plan: durationAlignedPlan,
    audioClips,
  };
}

async function runVisualsStep({
  plan,
  settings,
  providerKeys,
  vendor,
  onUpdate,
}: {
  plan: VideoPlan;
  settings: StudioSettings;
  providerKeys: ProviderKeys;
  vendor: ModelVendor;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<VideoImageAsset[]> {
  emitStepStarted(onUpdate, 'visuals', vendor, settings.models.image, 'Rendering storyboard images with shared visual style.');
  const styleGuide = plan.visualStyleGuide || '';
  const imageRequest = formatDebugValue({
    vendor,
    model: settings.models.image,
    visualStyleGuide: styleGuide,
    sceneCount: plan.scenes.length,
    prompts: plan.scenes.map((scene) => ({
      sceneId: scene.id,
      title: scene.title,
      imagePrompt: scene.imagePrompt,
    })),
  });
  emitJobUpdate(onUpdate, {
    currentMessage: `Step 5: generating ${plan.scenes.length} storyboard image${plan.scenes.length > 1 ? 's' : ''} with consistent visual style.`,
    step: {
      id: 'visuals',
      request: imageRequest,
      handoff: 'The generated still images will be handed to Step 6 for slideshow rendering and final muxing.',
    },
    log: {
      stepId: 'visuals',
      message: `Calling ${formatVendorName(vendor)} ${settings.models.image} for styled storyboard stills.`,
    },
  });

  emitJobUpdate(onUpdate, {
    currentMessage: `Step 5: generating ${plan.scenes.length} images in parallel.`,
    step: {
      id: 'visuals',
      status: 'running',
      message: `Generating ${plan.scenes.length} images in parallel.`,
    },
    log: {
      stepId: 'visuals',
      message: `Launching ${plan.scenes.length} parallel image generation requests.`,
    },
  });

  const styledScenes = plan.scenes.map((scene) =>
    styleGuide ? { ...scene, imagePrompt: `${styleGuide}. ${scene.imagePrompt}` } : scene,
  );

  let completedCount = 0;
  const imageResults = await Promise.all(
    styledScenes.map(async (scene, index) => {
      const asset = await generateSceneImage({
        vendor,
        apiKey: providerKeys[vendor],
        model: settings.models.image,
        scene,
      });
      completedCount += 1;
      emitJobUpdate(onUpdate, {
        currentMessage: `Step 5: ${completedCount} of ${plan.scenes.length} images ready.`,
        step: {
          id: 'visuals',
          status: 'running',
          message: `Image ${completedCount} of ${plan.scenes.length} is ready (${scene.title}).`,
        },
        log: {
          stepId: 'visuals',
          message: `Image for ${scene.title} (scene ${index + 1}) is ready.`,
        },
      });
      return asset;
    }),
  );

  const images = imageResults;

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 5 completed. Storyboard images are ready for video composition.',
    step: {
      id: 'visuals',
      status: 'done',
      message: `Generated ${images.length} storyboard images with consistent visual style.`,
      result: formatDebugValue({
        visualStyleGuide: styleGuide,
        images: images.map((image) => ({
          sceneId: image.sceneId,
          mimeType: image.mimeType,
          prompt: image.prompt,
        })),
      }),
      handoff: 'Step 6 will pair these images with the narration timeline to render the final MP4.',
    },
    log: {
      stepId: 'visuals',
      message: `Step 5 completed. ${images.length} images are stored locally in the browser session.`,
    },
    images,
  });

  return images;
}

async function runComposeStep({
  plan,
  audioClips,
  images,
  settings,
  onUpdate,
}: {
  plan: VideoPlan;
  audioClips: VideoAudioClip[];
  images: VideoImageAsset[];
  settings: StudioSettings;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<{ narrationAudio: VideoBinaryAsset; previewVideo?: VideoBinaryAsset; finalVideo: VideoBinaryAsset }> {
  emitStepStarted(onUpdate, 'compose', undefined, undefined, 'Preparing the local ffmpeg composition runtime.');
  emitJobUpdate(onUpdate, {
    step: {
      id: 'compose',
      request: formatDebugValue({
        runtime: 'ffmpeg.wasm',
        sceneCount: plan.scenes.length,
        audioClipCount: audioClips.length,
        imageCount: images.length,
        subtitleMode: 'Burned-in canvas subtitle theme',
        timeline: plan.scenes.map((scene) => ({
          sceneId: scene.id,
          durationSec: scene.durationSec,
          startSec: scene.startSec,
        })),
      }),
      handoff: 'The final MP4 and merged narration audio will be stored locally and exposed to the Studio list and Preview panel.',
    },
  });
  const ffmpeg = await loadVideoFfmpeg(onUpdate);
  const audioListName = 'audio-list.txt';
  const sceneListName = 'scene-list.txt';
  const narrationName = 'narration.wav';
  const slideshowName = 'slideshow.mp4';
  const previewName = 'clipmind-preview.webm';
  const outputName = 'clipmind-video.mp4';
  const subtitleFrameNames: string[] = [];

  try {
    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: writing generated audio clips and images into the local composition workspace.',
      log: {
        stepId: 'compose',
        message: 'Writing generated assets into the in-browser ffmpeg filesystem.',
      },
    });

    const audioEntries: string[] = [];
    for (const [index, clip] of audioClips.entries()) {
      const clipName = `narration-${index + 1}.wav`;
      await ffmpeg.writeFile(clipName, dataUrlToUint8Array(clip.dataUrl));
      audioEntries.push(`file '${clipName}'`);
    }

    const imageEntries: string[] = [];

    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: burning subtitles into scene images using browser Canvas.',
      log: {
        stepId: 'compose',
        message: 'Rendering subtitle text onto scene images via Canvas API for reliable cross-language support.',
      },
    });

    for (const [sceneIndex, scene] of plan.scenes.entries()) {
      const image = images[sceneIndex];

      if (!image) {
        continue;
      }

      const cueTexts = scene.subtitleCues?.length
        ? scene.subtitleCues
        : createSubtitleCueTexts(scene.voiceText, scene.durationSec, settings.language);

      if (!cueTexts.length) {
        const imageName = `scene-${sceneIndex + 1}.png`;
        await ffmpeg.writeFile(imageName, dataUrlToUint8Array(image.dataUrl));
        imageEntries.push(`file '${imageName}'`);
        imageEntries.push(`duration ${scene.durationSec.toFixed(3)}`);
        if (sceneIndex === plan.scenes.length - 1) {
          imageEntries.push(`file '${imageName}'`);
        }
        continue;
      }

      const sceneCues = createSceneSubtitleCues(scene, cueTexts, 0);

      for (const [cueIndex, cue] of sceneCues.entries()) {
        const frameName = `scene-${sceneIndex + 1}-cue-${cueIndex + 1}.png`;
        subtitleFrameNames.push(frameName);

        try {
          const burnedDataUrl = await renderSubtitleBurnedImage({
            imageDataUrl: image.dataUrl,
            subtitleText: cue.text,
            language: settings.language,
          });
          await ffmpeg.writeFile(frameName, dataUrlToUint8Array(burnedDataUrl));
        } catch {
          await ffmpeg.writeFile(frameName, dataUrlToUint8Array(image.dataUrl));
        }

        const cueDuration = cue.endSec - cue.startSec;
        imageEntries.push(`file '${frameName}'`);
        imageEntries.push(`duration ${cueDuration.toFixed(3)}`);
      }

      if (sceneIndex === plan.scenes.length - 1 && sceneCues.length) {
        const lastFrameName = `scene-${sceneIndex + 1}-cue-${sceneCues.length}.png`;
        imageEntries.push(`file '${lastFrameName}'`);
      }

      emitJobUpdate(onUpdate, {
        step: {
          id: 'compose',
          status: 'running',
          message: `Burned ${sceneCues.length} subtitle frame${sceneCues.length > 1 ? 's' : ''} for ${scene.title}.`,
        },
        log: {
          stepId: 'compose',
          message: `Burned ${sceneCues.length} subtitle frame${sceneCues.length > 1 ? 's' : ''} for ${scene.title}.`,
        },
      });
    }

    await ffmpeg.writeFile(audioListName, new TextEncoder().encode(audioEntries.join('\n')));
    await ffmpeg.writeFile(sceneListName, new TextEncoder().encode(imageEntries.join('\n')));

    emitJobUpdate(onUpdate, {
      currentMessage: `Step 6: subtitle frames ready — ${subtitleFrameNames.length} images with burned-in text.`,
      log: {
        stepId: 'compose',
        message: `Subtitle frames prepared: ${subtitleFrameNames.length} images with burned-in text.`,
      },
    });

    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: concatenating narration clips into one timeline audio track.',
      log: {
        stepId: 'compose',
        message: 'Concatenating narration clips into a single WAV track.',
      },
    });
    await execFfmpeg(
      ffmpeg,
      ['-f', 'concat', '-safe', '0', '-i', audioListName, '-c', 'copy', narrationName],
      onUpdate,
      'compose',
      'Combining narration clips.',
      { start: 30, end: 48 },
    );

    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: rendering the slideshow timeline from generated still images.',
      log: {
        stepId: 'compose',
        message: 'Rendering the storyboard image sequence into a local slideshow video.',
      },
    });
    try {
      await execFfmpeg(
        ffmpeg,
        [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          sceneListName,
          '-vf',
          'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
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
        onUpdate,
        'compose',
        'Rendering slideshow frames (H.264).',
        { start: 50, end: 74 },
      );
    } catch (error) {
      emitJobUpdate(onUpdate, {
        log: {
          stepId: 'compose',
          message: `H.264 slideshow encoding unavailable, fallback to MPEG-4: ${readThrownMessage(error, 'unknown encoding error')}`,
        },
      });

      await execFfmpeg(
        ffmpeg,
        [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          sceneListName,
          '-vf',
          'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
          '-r',
          '30',
          '-c:v',
          'mpeg4',
          '-q:v',
          '3',
          slideshowName,
        ],
        onUpdate,
        'compose',
        'Rendering slideshow frames (fallback MPEG-4).',
        { start: 50, end: 74 },
      );
    }

    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: encoding a browser preview video.',
      log: {
        stepId: 'compose',
        message: 'Encoding a browser-friendly WebM preview (subtitles already burned into frames).',
      },
    });
    const previewVideo = await tryCreatePreviewVideo({
      ffmpeg,
      narrationName,
      slideshowName,
      previewName,
      onUpdate,
    });

    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: muxing narration into the final MP4.',
      log: {
        stepId: 'compose',
        message: 'Muxing the narration track into the final MP4 (subtitles already burned into frames).',
      },
    });
    try {
      await execFfmpeg(
        ffmpeg,
        ['-i', slideshowName, '-i', narrationName, '-c:v', 'copy', '-c:a', 'aac', '-b:a', aacBitrate, '-movflags', '+faststart', '-shortest', outputName],
        onUpdate,
        'compose',
        'Muxing narration into final video (stream copy).',
        { start: 86, end: 100 },
      );
    } catch (copyError) {
      emitJobUpdate(onUpdate, {
        log: {
          stepId: 'compose',
          message: `Final MP4 stream copy failed, retrying with H.264 re-encode: ${readThrownMessage(copyError, 'unknown muxing error')}`,
        },
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
          onUpdate,
          'compose',
          'Muxing narration into final video (H.264).',
          { start: 86, end: 100 },
        );
      } catch (x264Error) {
        emitJobUpdate(onUpdate, {
          log: {
            stepId: 'compose',
            message: `H.264 final encoding unavailable, fallback to MPEG-4: ${readThrownMessage(x264Error, 'unknown encoding error')}`,
          },
        });

        await execFfmpeg(
          ffmpeg,
          ['-i', slideshowName, '-i', narrationName, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-b:a', aacBitrate, '-shortest', outputName],
          onUpdate,
          'compose',
          'Muxing narration into final video (fallback MPEG-4).',
          { start: 86, end: 100 },
        );
      }
    }

    const narrationFile = await ffmpeg.readFile(narrationName);
    const videoFile = await ffmpeg.readFile(outputName);
    const narrationAudio = await uint8ArrayToDataAsset(toUint8Array(narrationFile), 'audio/wav');
    const finalVideo = await uint8ArrayToDataAsset(toUint8Array(videoFile), 'video/mp4');

    return {
      narrationAudio,
      previewVideo,
      finalVideo,
    };
  } finally {
    await cleanupFiles(ffmpeg, [
      audioListName,
      sceneListName,
      narrationName,
      slideshowName,
      previewName,
      outputName,
      ...audioClips.map((_, index) => `narration-${index + 1}.wav`),
      ...images.map((_, index) => `scene-${index + 1}.png`),
      ...subtitleFrameNames,
    ]);
  }
}

async function tryCreatePreviewVideo({
  ffmpeg,
  narrationName,
  slideshowName,
  previewName,
  onUpdate,
}: {
  ffmpeg: FFmpegInstance;
  narrationName: string;
  slideshowName: string;
  previewName: string;
  onUpdate?: (update: VideoGenerationUpdate) => void;
}): Promise<VideoBinaryAsset | undefined> {
  try {
    await execFfmpeg(
      ffmpeg,
      ['-i', slideshowName, '-i', narrationName, '-c:v', 'libvpx', '-b:v', '2M', '-c:a', 'libvorbis', '-shortest', previewName],
      onUpdate,
      'compose',
      'Encoding browser preview video.',
      { start: 76, end: 84 },
    );
    const previewFile = await ffmpeg.readFile(previewName);
    return uint8ArrayToDataAsset(toUint8Array(previewFile), 'video/webm');
  } catch (error) {
    emitJobUpdate(onUpdate, {
      log: {
        stepId: 'compose',
        message: `Preview WebM encoding was skipped: ${readThrownMessage(error, 'unknown ffmpeg preview error')}`,
      },
    });
    return undefined;
  }
}

async function generateSceneImage({
  vendor,
  apiKey,
  model,
  scene,
}: {
  vendor: ModelVendor;
  apiKey: string;
  model: string;
  scene: VideoScene;
}): Promise<VideoImageAsset> {
  if (vendor === 'openai') {
    const client = await createOpenAIClient(apiKey);
    const response = await client.images.generate({
      model,
      prompt: scene.imagePrompt,
      size: '1536x1024',
    });
    const base64 = response.data?.[0]?.b64_json?.trim();
    const imageUrl = response.data?.[0]?.url?.trim();

    if (base64) {
      return {
        id: `image-${scene.id}`,
        sceneId: scene.id,
        prompt: scene.imagePrompt,
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${base64}`,
      };
    }

    if (!imageUrl) {
      throw new Error(`OpenAI image generation returned no image data for ${scene.title}.`);
    }

    const remoteImage = await fetch(imageUrl);

    if (!remoteImage.ok) {
      throw new Error(`OpenAI image generation returned an unreadable image URL for ${scene.title} (HTTP ${remoteImage.status}).`);
    }

    const imageBlob = await remoteImage.blob();

    return {
      id: `image-${scene.id}`,
      sceneId: scene.id,
      prompt: scene.imagePrompt,
      mimeType: imageBlob.type || 'image/png',
      dataUrl: await blobToDataUrl(imageBlob),
    };
  }

  if (vendor === 'google') {
    const client = await createGoogleClient(apiKey);
    const response = await client.models.generateImages({
      model,
      prompt: scene.imagePrompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '16:9',
        outputMimeType: 'image/png',
      },
    });
    const generatedImage = response.generatedImages?.[0]?.image;
    const base64 = generatedImage?.imageBytes?.trim();
    const mimeType = generatedImage?.mimeType?.trim() || 'image/png';

    if (!base64) {
      throw new Error(`Google image generation returned no image data for ${scene.title}.`);
    }

    return {
      id: `image-${scene.id}`,
      sceneId: scene.id,
      prompt: scene.imagePrompt,
      mimeType,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  }

  throw new Error(`Image generation is not implemented for ${formatVendorName(vendor)} in browser-only mode.`);
}

export async function generateOpenAiTts({
  apiKey,
  model,
  text,
  voice,
}: {
  apiKey: string;
  model: string;
  text: string;
  voice: string;
  language: string;
}): Promise<Blob> {
  const client = await createOpenAIClient(apiKey);
  const candidateModels = buildOpenAiTtsModelCandidates(model);
  let lastError: unknown;

  for (const candidateModel of candidateModels) {
    try {
      const response = await client.audio.speech.create({
        model: candidateModel,
        input: text,
        voice: voice as 'alloy',
        response_format: 'wav',
      });

      return new Blob([await response.arrayBuffer()], { type: 'audio/wav' });
    } catch (error) {
      lastError = error;

      if (!shouldFallbackOpenAiTtsModel(error) || candidateModel === candidateModels[candidateModels.length - 1]) {
        const detail = readThrownMessage(error, 'OpenAI text-to-speech request failed.');
        throw new Error(`OpenAI TTS failed with model "${candidateModel}". ${detail}`);
      }
    }
  }

  const detail = readThrownMessage(lastError, 'OpenAI text-to-speech request failed.');
  throw new Error(`OpenAI TTS failed. ${detail}`);
}

function buildOpenAiTtsModelCandidates(model: string): string[] {
  const fallbackModels = ['gpt-4o-mini-tts', 'tts-1'];
  return [model, ...fallbackModels.filter((fallbackModel) => fallbackModel !== model)];
}

function shouldFallbackOpenAiTtsModel(error: unknown): boolean {
  const status = readThrownStatus(error);
  const message = readThrownMessage(error, '').toLowerCase();
  const looksLikeModelIssue =
    message.includes('model') &&
    (message.includes('not found') ||
      message.includes('not supported') ||
      message.includes('does not exist') ||
      message.includes('not available') ||
      message.includes('not permitted') ||
      message.includes('invalid'));

  return (status === 400 || status === 404) && looksLikeModelIssue;
}

export async function generateAzureSpeechTts({
  apiKey,
  region,
  text,
  language,
  voice,
}: {
  apiKey: string;
  region: string;
  text: string;
  language: string;
  voice: string;
}): Promise<Blob> {
  if (!region.trim()) {
    throw new Error('Add an Azure Speech region in Settings before using Azure Speech narration.');
  }

  const sdk = await createAzureSpeechSdk();
  const speechConfig = sdk.SpeechConfig.fromSubscription(apiKey, region.trim());
  speechConfig.speechSynthesisLanguage = mapToAzureSpeechLanguage(language);
  speechConfig.speechSynthesisVoiceName = voice || getDefaultAzureVoice(language);
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

  return await new Promise<Blob>((resolve, reject) => {
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();

        if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
          reject(new Error(result.errorDetails || 'Azure Speech did not return synthesized audio.'));
          return;
        }

        const audioData = result.audioData as ArrayBuffer | undefined;

        if (!audioData || !audioData.byteLength) {
          reject(new Error('Azure Speech returned an empty audio response.'));
          return;
        }

        resolve(new Blob([audioData], { type: 'audio/wav' }));
      },
      (error) => {
        synthesizer.close();
        reject(new Error(typeof error === 'string' ? error : readThrownMessage(error, 'Azure Speech synthesis failed.')));
      },
    );
  });
}

export async function generateCantoneseAiTts({
  apiKey,
  text,
  language,
  voiceId,
  useTurbo = false,
}: {
  apiKey: string;
  text: string;
  language: string;
  voiceId?: string;
  useTurbo?: boolean;
}): Promise<Blob> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    text,
    language: mapToCantoneseAiLanguage(language),
    frame_rate: '24000',
    speed: 1,
    pitch: 0,
    output_extension: 'wav',
    should_use_turbo_model: useTurbo,
    should_return_timestamp: false,
  };

  if (voiceId && isUuidLike(voiceId)) {
    body.voice_id = voiceId;
  }

  const response = await fetch('https://cantonese.ai/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Cantonese.ai TTS failed (HTTP ${response.status})${errorText ? `: ${errorText}` : ''}`);
  }

  const blob = await response.blob();

  if (!blob.size) {
    throw new Error('Cantonese.ai TTS returned an empty audio response.');
  }

  return new Blob([await blob.arrayBuffer()], { type: 'audio/wav' });
}

export async function generateMiniMaxTts({
  apiKey,
  text,
  language,
  voiceId,
  model,
  onProgress,
}: {
  apiKey: string;
  text: string;
  language: string;
  voiceId?: string;
  model?: string;
  onProgress?: (message: string) => void;
}): Promise<Blob> {
  onProgress?.('Submitting request to MiniMax.');

  let response: Response;
  try {
    response = await fetchWithTimeout(
      getMiniMaxApiUrl(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model?.trim() || 'speech-2.6-turbo',
          text,
          stream: false,
          output_format: 'hex',
          language_boost: mapToMiniMaxLanguageBoost(language),
          voice_setting: {
            voice_id: voiceId?.trim() || getDefaultMiniMaxVoice(language),
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: 'mp3',
            channel: 1,
          },
        }),
      },
      minimaxTtsRequestTimeoutMs,
      `MiniMax TTS request timed out after ${Math.round(minimaxTtsRequestTimeoutMs / 1000)}s.`,
    );
  } catch (error) {
    const detail = readThrownMessage(error, 'Failed to send the MiniMax TTS request.');
    throw new Error(formatMiniMaxRequestFailure(detail));
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`MiniMax TTS failed (HTTP ${response.status})${errorText ? `: ${truncateErrorText(errorText)}` : ''}`);
  }

  onProgress?.('MiniMax accepted request. Parsing response.');
  const payload = await parseMiniMaxTtsPayload(response);
  const statusError = readMiniMaxStatusError(payload);

  if (statusError) {
    throw new Error(statusError);
  }

  const audioHex = readMiniMaxAudioHex(payload);
  if (!audioHex) {
    const detail = readMiniMaxPayloadDetail(payload);
    throw new Error(`MiniMax TTS response did not contain audio hex.${detail ? ` ${detail}` : ''}`);
  }

  const audioBytes = hexToUint8Array(audioHex);
  if (!audioBytes.byteLength) {
    throw new Error('MiniMax TTS returned empty audio bytes.');
  }

  return new Blob([audioBytes], { type: 'audio/mpeg' });
}

export async function generateAudiodubTts({
  apiKey,
  text,
  language,
  voiceId,
  onProgress,
}: {
  apiKey: string;
  text: string;
  language: string;
  voiceId?: string;
  onProgress?: (message: string) => void;
}): Promise<Blob> {
  const requestTimeoutMs = resolveAudiodubTtsRequestTimeoutMs(text);
  let response: Response | null = null;
  let lastRequestError: Error | null = null;

  for (let attempt = 1; attempt <= audiodubTtsMaxAttempts; attempt += 1) {
    onProgress?.(`Submitting request to Audiodub (attempt ${attempt}/${audiodubTtsMaxAttempts}).`);

    try {
      response = await fetchWithTimeout(
        getAudiodubApiUrl(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            text,
            language,
            voice_model: 'minimax',
            model: 'minimax',
            voice_id: voiceId || '209536448462927',
            speed: '1',
            stability: '+0',
            style: 0.4,
            use_speaker_boost: false,
            emotion: 'happy',
            prompt_character: 5000,
            min_rows: 14,
            search_in_history: '',
            current_audio: {},
          }),
        },
        requestTimeoutMs,
        `Audiodub TTS request timed out after ${Math.round(requestTimeoutMs / 1000)}s.`,
      );
      break;
    } catch (error) {
      const detail = readThrownMessage(error, 'Failed to send the Audiodub TTS request.');
      const isTimeout = /timed out/i.test(detail);

      if (isTimeout && attempt < audiodubTtsMaxAttempts) {
        onProgress?.(`Audiodub is still processing. Retrying request ${attempt + 1}/${audiodubTtsMaxAttempts}.`);
        await delayMs(900 * attempt);
        continue;
      }

      lastRequestError = new Error(formatAudiodubRequestFailure(detail, isTimeout));
      break;
    }
  }

  if (!response) {
    throw lastRequestError ?? new Error('Audiodub TTS request did not return a response.');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Audiodub TTS failed (HTTP ${response.status})${errorText ? `: ${errorText}` : ''}`);
  }

  onProgress?.('Audiodub accepted request. Parsing response.');
  const payload = await parseAudiodubTtsPayload(response);
  const audioFileUrl = readAudiodubAudioFileUrl(payload);

  if (typeof audioFileUrl !== 'string' || !audioFileUrl) {
    const payloadDetail = readAudiodubPayloadDetail(payload);
    throw new Error(`Audiodub TTS response did not contain an audio_file URL.${payloadDetail ? ` ${payloadDetail}` : ''}`);
  }

  const audioBlob = await fetchAudiodubAudioBlobWithRetry(audioFileUrl, onProgress);

  if (!audioBlob.size) {
    throw new Error('Audiodub TTS returned an empty audio file.');
  }

  return new Blob([await audioBlob.arrayBuffer()], { type: audioBlob.type || 'audio/mpeg' });
}

function getMiniMaxApiUrl() {
  return import.meta.env.DEV ? '/proxy/minimax-api/v1/t2a_v2' : 'https://api.minimax.io/v1/t2a_v2';
}

function mapToMiniMaxLanguageBoost(language: string): string {
  const lower = language.toLowerCase();

  if (lower.includes('cantonese')) {
    return 'Chinese,Yue';
  }

  if (lower.includes('mandarin') || lower.includes('chinese')) {
    return 'Chinese';
  }

  if (lower.includes('japanese')) {
    return 'Japanese';
  }

  if (lower.includes('spanish')) {
    return 'Spanish';
  }

  if (lower.includes('french')) {
    return 'French';
  }

  return 'English';
}

function getDefaultMiniMaxVoice(language: string): string {
  const lower = language.toLowerCase();

  if (lower.includes('cantonese')) {
    return 'Cantonese_GentleLady';
  }

  if (lower.includes('mandarin') || lower.includes('chinese')) {
    return 'Arrogant_Miss';
  }

  if (lower.includes('japanese')) {
    return 'Japanese_KindLady';
  }

  if (lower.includes('spanish')) {
    return 'Spanish_Narrator';
  }

  if (lower.includes('french')) {
    return 'French_MaleNarrator';
  }

  return 'English_expressive_narrator';
}

function formatMiniMaxRequestFailure(detail: string): string {
  if (/timed out/i.test(detail)) {
    return `${detail} MiniMax can take longer on larger text segments. Try shorter segments or retry.`;
  }

  if (/failed to fetch|network\s*error|cors|fetch\s*failed/i.test(detail)) {
    return `${detail} MiniMax browser requests may be blocked by CORS. Use local dev proxy or check browser network policies.`;
  }

  return detail;
}

async function parseMiniMaxTtsPayload(response: Response): Promise<unknown> {
  const responseText = await response.text().catch(() => '');
  const trimmed = responseText.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`MiniMax TTS returned a non-JSON response: ${truncateErrorText(trimmed)}`);
  }
}

function readMiniMaxStatusError(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const baseResponse = payload.base_resp;
  if (!isObjectRecord(baseResponse)) {
    return null;
  }

  const statusCode = readFiniteNumberText(baseResponse.status_code);
  const statusMessage = readNonEmptyString(baseResponse.status_msg) ?? readNonEmptyString(baseResponse.message);

  if (!statusCode) {
    return null;
  }

  if (statusCode === '0') {
    return null;
  }

  return `MiniMax TTS failed (status ${statusCode})${statusMessage ? `: ${statusMessage}` : ''}.`;
}

function readMiniMaxAudioHex(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const data = payload.data;
  if (!isObjectRecord(data)) {
    return null;
  }

  return readNonEmptyString(data.audio);
}

function readMiniMaxPayloadDetail(payload: unknown): string | null {
  if (payload === null) {
    return 'Response payload was null.';
  }

  if (!isObjectRecord(payload)) {
    return `Unexpected payload type: ${Array.isArray(payload) ? 'array' : typeof payload}.`;
  }

  const baseResponse = isObjectRecord(payload.base_resp) ? payload.base_resp : null;
  const statusCode = baseResponse ? readFiniteNumberText(baseResponse.status_code) : null;
  const statusMessage = baseResponse ? readNonEmptyString(baseResponse.status_msg) : null;
  const message = readNonEmptyString(payload.message);
  const parts = [
    statusCode ? `status=${statusCode}` : null,
    statusMessage ? `status_msg=${truncateErrorText(statusMessage)}` : null,
    message ? `message=${truncateErrorText(message)}` : null,
  ].filter((value): value is string => Boolean(value));

  if (parts.length) {
    return `Response detail: ${parts.join(', ')}.`;
  }

  const preview = toJsonPreview(payload);
  return preview ? `Response payload: ${preview}.` : null;
}

function hexToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const normalizedValue = value.replace(/^0x/i, '').replace(/\s+/g, '');

  if (!normalizedValue || normalizedValue.length % 2 !== 0) {
    throw new Error('MiniMax TTS returned invalid hex audio data.');
  }

  const bytes = new Uint8Array(new ArrayBuffer(normalizedValue.length / 2));

  for (let index = 0; index < normalizedValue.length; index += 2) {
    const byte = Number.parseInt(normalizedValue.slice(index, index + 2), 16);

    if (!Number.isFinite(byte) || Number.isNaN(byte)) {
      throw new Error('MiniMax TTS returned malformed hex audio data.');
    }

    bytes[index / 2] = byte;
  }

  return bytes;
}

function getAudiodubApiUrl() {
  return import.meta.env.DEV ? '/proxy/audiodub-api/text-to-speech/generate' : 'https://api.audiodub.ai/text-to-speech/generate';
}

function resolveAudiodubTtsRequestTimeoutMs(text: string): number {
  const charCount = text.trim().length;
  const dynamicTimeoutMs = audiodubTtsBaseRequestTimeoutMs + charCount * audiodubTtsPerCharTimeoutMs;
  return Math.max(audiodubTtsBaseRequestTimeoutMs, Math.min(dynamicTimeoutMs, audiodubTtsMaxRequestTimeoutMs));
}

function formatAudiodubRequestFailure(detail: string, isTimeout: boolean): string {
  if (isTimeout) {
    return `${detail} Audiodub can take longer on larger text segments. Try a shorter segment, retry, or switch provider (OpenAI / Azure / Cantonese.ai).`;
  }

  if (/failed to fetch|network\s*error|cors|fetch\s*failed/i.test(detail)) {
    return `${detail} Audiodub browser requests may be blocked by CORS. Use local dev proxy or switch provider (OpenAI / Azure / Cantonese.ai).`;
  }

  return detail;
}

async function parseAudiodubTtsPayload(response: Response): Promise<unknown> {
  const responseText = await response.text().catch(() => '');
  const trimmed = responseText.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Audiodub TTS returned a non-JSON response: ${truncateErrorText(trimmed)}`);
  }
}

function proxyAudiodubS3Url(url: string): string {
  const s3Host = 'https://s3.ap-southeast-1.amazonaws.com';

  if (url.startsWith(s3Host)) {
    return `/proxy/audiodub-s3${url.slice(s3Host.length)}`;
  }

  return url;
}

function readAudiodubAudioFileUrl(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const topLevelAudioFile = readNonEmptyString(payload.audio_file);
  if (topLevelAudioFile) {
    return topLevelAudioFile;
  }

  const nestedAudioFile = [
    payload.data,
    payload.result,
    payload.response,
    payload.output,
  ]
    .map(readAudioFileFromNestedRecord)
    .find((value) => typeof value === 'string');

  return nestedAudioFile ?? null;
}

function readAudioFileFromNestedRecord(value: unknown): string | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const directAudioFile = readNonEmptyString(value.audio_file);
  if (directAudioFile) {
    return directAudioFile;
  }

  const nestedAudio = value.audio;
  if (isObjectRecord(nestedAudio)) {
    return readNonEmptyString(nestedAudio.audio_file) ?? readNonEmptyString(nestedAudio.url);
  }

  return null;
}

function readAudiodubPayloadDetail(payload: unknown): string | null {
  if (payload === null) {
    return 'Response payload was null.';
  }

  if (typeof payload === 'string') {
    return payload.trim() ? `Response message: ${truncateErrorText(payload)}` : 'Response payload was an empty string.';
  }

  if (!isObjectRecord(payload)) {
    return `Unexpected payload type: ${Array.isArray(payload) ? 'array' : typeof payload}.`;
  }

  const statusText = readNonEmptyString(payload.status) ?? readFiniteNumberText(payload.status);
  const messageText = readNonEmptyString(payload.message);
  const detailText = readNonEmptyString(payload.detail);
  const errorText = readNestedObjectString(payload.error, 'message') ?? readNestedObjectString(payload.error, 'detail');
  const dataNull = payload.data === null ? 'data=null' : null;
  const resultNull = payload.result === null ? 'result=null' : null;
  const parts = [
    statusText ? `status=${statusText}` : null,
    messageText ? `message=${truncateErrorText(messageText)}` : null,
    detailText ? `detail=${truncateErrorText(detailText)}` : null,
    errorText ? `error=${truncateErrorText(errorText)}` : null,
    dataNull,
    resultNull,
  ].filter((value): value is string => Boolean(value));

  if (parts.length) {
    return `Response detail: ${parts.join(', ')}.`;
  }

  const preview = toJsonPreview(payload);
  return preview ? `Response payload: ${preview}.` : null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readFiniteNumberText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsedValue = Number(value.trim());
    return Number.isFinite(parsedValue) ? String(Math.trunc(parsedValue)) : null;
  }

  return null;
}

function readNestedObjectString(parent: unknown, key: string): string | null {
  if (!isObjectRecord(parent)) {
    return null;
  }

  return readNonEmptyString(parent[key]);
}

function toJsonPreview(value: unknown): string | null {
  try {
    return truncateErrorText(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function fetchAudiodubAudioBlobWithRetry(audioFileUrl: string, onProgress?: (message: string) => void): Promise<Blob> {
  const maxAttempts = 4;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptLabel = `attempt ${attempt}/${maxAttempts}`;
    onProgress?.(`Downloading Audiodub audio file (${attemptLabel}).`);

    try {
      const response = await fetchWithTimeout(
        proxyAudiodubS3Url(audioFileUrl),
        { cache: 'no-store' },
        audiodubTtsAudioFetchTimeoutMs,
        `Audiodub audio download timed out after ${Math.round(audiodubTtsAudioFetchTimeoutMs / 1000)}s.`,
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const suffix = errorText ? `: ${truncateErrorText(errorText)}` : '';
        lastError = new Error(`Audiodub TTS audio file could not be fetched (HTTP ${response.status})${suffix}.`);

        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          break;
        }
      } else {
        const blob = await response.blob();

        if (!blob.size) {
          lastError = new Error('Audiodub returned an empty audio file.');
        } else {
          return blob;
        }
      }
    } catch (error) {
      lastError = new Error(readThrownMessage(error, 'Failed to download Audiodub audio file.'));
    }

    if (attempt < maxAttempts) {
      onProgress?.(`Audiodub audio not ready yet. Retrying ${attempt + 1}/${maxAttempts}...`);
      await delayMs(500 * attempt);
    }
  }

  throw lastError ?? new Error('Audiodub TTS audio file download failed.');
}

function truncateErrorText(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 219)}…` : trimmed;
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function resolveNarrationConcurrency(vendor: ModelVendor, sceneCount: number): number {
  const baseConcurrency = vendor === 'audiodub' ? audiodubNarrationConcurrency : 4;
  return Math.max(1, Math.min(baseConcurrency, sceneCount));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage);
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function mapToCantoneseAiLanguage(language: string): string {
  const lower = language.toLowerCase();

  if (lower.includes('cantonese')) {
    return 'cantonese';
  }

  if (lower.includes('mandarin') || lower.includes('chinese')) {
    return 'mandarin';
  }

  return 'english';
}

function mapToAzureSpeechLanguage(language: string): string {
  const lower = language.toLowerCase();

  if (lower.includes('cantonese')) {
    return 'zh-HK';
  }

  if (lower.includes('mandarin') || lower.includes('chinese')) {
    return 'zh-CN';
  }

  if (lower.includes('japanese')) {
    return 'ja-JP';
  }

  if (lower.includes('spanish')) {
    return 'es-ES';
  }

  if (lower.includes('french')) {
    return 'fr-FR';
  }

  return 'en-US';
}

function getDefaultAzureVoice(language: string): string {
  const locale = mapToAzureSpeechLanguage(language);

  if (locale === 'zh-HK') {
    return 'zh-HK-HiuMaanNeural';
  }

  if (locale === 'zh-CN') {
    return 'zh-CN-XiaoxiaoNeural';
  }

  if (locale === 'ja-JP') {
    return 'ja-JP-NanamiNeural';
  }

  if (locale === 'es-ES') {
    return 'es-ES-ElviraNeural';
  }

  if (locale === 'fr-FR') {
    return 'fr-FR-DeniseNeural';
  }

  return 'en-US-AvaMultilingualNeural';
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function generateTextWithVendor({
  vendor,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  expectJson = false,
}: {
  vendor: ModelVendor;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  expectJson?: boolean;
}): Promise<string> {
  if (vendor === 'openai') {
    const client = await createOpenAIClient(apiKey);
    const response = await client.responses.create({
      model,
      instructions: systemPrompt,
      input: userPrompt,
    });
    const text = response.output_text?.trim();

    if (!text) {
      throw new Error(`OpenAI ${model} returned an empty response.`);
    }

    return text;
  }

  if (vendor === 'anthropic') {
    const client = await createAnthropicClient(apiKey);
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = response.content
      .flatMap((item) => ('text' in item && typeof item.text === 'string' ? [item.text] : []))
      .join('\n')
      .trim();

    if (!text) {
      throw new Error(`Anthropic ${model} returned an empty response.`);
    }

    return text;
  }

  if (vendor === 'google') {
    const client = await createGoogleClient(apiKey);
    const response = await client.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        ...(expectJson ? { responseMimeType: 'application/json' } : {}),
      },
    });
    const text = response.text?.trim();

    if (!text) {
      throw new Error(`Google ${model} returned an empty response.`);
    }

    return text;
  }

  const client = await createMistralClient(apiKey);
  const response = await client.chat.complete({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: {
      type: expectJson ? 'json_object' : 'text',
    },
  });
  const content = response.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : Array.isArray(content) ? content.flatMap((item) => ('text' in item && typeof item.text === 'string' ? [item.text] : [])).join('\n').trim() : '';

  if (!text) {
    throw new Error(`Mistral ${model} returned an empty response.`);
  }

  return text;
}

function parseVideoPlan(rawText: string, targetDurationSec: number, fallbackSummary: string): VideoPlan {
  const jsonText = extractJsonPayload(rawText);
  const parsedValue = JSON.parse(jsonText) as Partial<VideoPlan> & {
    scenes?: Array<Partial<VideoScene>>;
  };

  const rawScenes = Array.isArray(parsedValue.scenes) ? parsedValue.scenes : [];
  const fallbackVoiceText = typeof parsedValue.spokenScript === 'string' ? parsedValue.spokenScript.trim() : '';
  const normalizedScenes = normalizeScenes(rawScenes, targetDurationSec, fallbackVoiceText);
  const totalDurationSec = normalizedScenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const visualStyleGuide = typeof parsedValue.visualStyleGuide === 'string' && parsedValue.visualStyleGuide.trim()
    ? parsedValue.visualStyleGuide.trim()
    : undefined;

  return {
    title: typeof parsedValue.title === 'string' && parsedValue.title.trim() ? parsedValue.title.trim() : 'Generated video',
    summary: typeof parsedValue.summary === 'string' && parsedValue.summary.trim() ? parsedValue.summary.trim() : fallbackSummary,
    spokenScript:
      typeof parsedValue.spokenScript === 'string' && parsedValue.spokenScript.trim()
        ? parsedValue.spokenScript.trim()
        : normalizedScenes.map((scene) => scene.voiceText).join(' '),
    totalDurationSec,
    scenes: normalizedScenes,
    visualStyleGuide,
  };
}

function normalizeScenes(rawScenes: Array<Partial<VideoScene>>, targetDurationSec: number, fallbackVoiceText: string): VideoScene[] {
  const seededScenes: Array<Partial<VideoScene>> = rawScenes.length
    ? rawScenes
    : Array.from({ length: fallbackSceneCount }, (_, index) => ({
        title: `Scene ${index + 1}`,
        voiceText: fallbackVoiceText || `Narration beat ${index + 1}.`,
        imagePrompt: `Editorial storyboard still for beat ${index + 1}, cinematic composition, clean lighting, English prompt.`,
        durationSec: Math.max(1, Math.floor(targetDurationSec / fallbackSceneCount)),
      }));
  const proposedDurations = seededScenes.map((scene) => {
    const duration = typeof scene.durationSec === 'number' && Number.isFinite(scene.durationSec) ? scene.durationSec : 0;
    return duration > 0 ? duration : 0;
  });
  const balancedDurations = rebalanceDurations(proposedDurations, targetDurationSec);
  let startSec = 0;

  return seededScenes.map((scene, index) => {
    const transition = scene.transition === 'cut' || scene.transition === 'crossfade' ? scene.transition : undefined;
    const subtitleCues = Array.isArray(scene.subtitleCues) && scene.subtitleCues.every((c) => typeof c === 'string')
      ? scene.subtitleCues.filter((c) => c.trim())
      : undefined;
    const normalizedScene: VideoScene = {
      id: `scene-${index + 1}`,
      title: typeof scene.title === 'string' && scene.title.trim() ? scene.title.trim() : `Scene ${index + 1}`,
      voiceText:
        typeof scene.voiceText === 'string' && scene.voiceText.trim()
          ? scene.voiceText.trim()
          : `Narration beat ${index + 1}.`,
      imagePrompt:
        typeof scene.imagePrompt === 'string' && scene.imagePrompt.trim()
          ? scene.imagePrompt.trim()
          : `Editorial storyboard still for scene ${index + 1}, English prompt, cinematic, widescreen frame.`,
      durationSec: balancedDurations[index] ?? 1,
      startSec,
      transition,
      subtitleCues,
    };
    startSec += normalizedScene.durationSec;
    return normalizedScene;
  });
}

function applySceneDurations(plan: VideoPlan, actualDurations: number[]): VideoPlan {
  let startSec = 0;
  const scenes = plan.scenes.map((scene, index) => {
    const durationSec = actualDurations[index] && actualDurations[index] > 0 ? actualDurations[index] : scene.durationSec;
    const nextScene = {
      ...scene,
      durationSec,
      startSec,
    };
    startSec += durationSec;
    return nextScene;
  });

  return {
    ...plan,
    spokenScript: scenes.map((scene) => scene.voiceText).join(' '),
    totalDurationSec: scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
    scenes,
  };
}

function isCjkText(text: string): boolean {
  const cjkPattern = /[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
  const cjkChars = (text.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return cjkPattern.test(text) && cjkChars > text.length * 0.15;
}

function isCjkLanguage(language: string): boolean {
  const lower = language.toLowerCase();
  return ['mandarin', 'chinese', 'japanese', 'korean', 'cantonese'].some((lang) => lower.includes(lang));
}

function buildDirectSourceText(sources: Source[]): string {
  return sources
    .map((source) => {
      const rawText = source.rawText.trim();
      const fallbackText = source.summary?.trim() || source.excerpt.trim();
      const content = rawText || fallbackText;

      if (!content) {
        return '';
      }

      return content;
    })
    .filter(Boolean)
    .join('\n\n');
}

function splitDirectSourceSentences(text: string, language: string): string[] {
  const normalized = normalizeDirectSourceText(text);

  if (!normalized) {
    return [];
  }

  const cjk = isCjkLanguage(language) || isCjkText(normalized);
  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const sentences = paragraphs.flatMap((paragraph) =>
    splitParagraphIntoSentences(paragraph, cjk),
  );
  const filteredSentences = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (filteredSentences.length) {
    return filteredSentences;
  }

  return [normalized.replace(/\s+/g, ' ').trim()];
}

function groupSentencesIntoSceneGroups(sentences: string[], language: string): string[][] {
  if (!sentences.length) {
    return [['No source text available.']];
  }

  const cjk = isCjkLanguage(language) || isCjkText(sentences.join(' '));
  const maxSentencesPerScene = cjk ? 2 : 3;
  const targetSceneDurationSec = cjk ? 7.5 : 10;
  const hardSceneDurationSec = cjk ? 10 : 13;
  const sceneGroups: string[][] = [];
  let currentChunk: string[] = [];

  for (const sentence of sentences) {
    currentChunk.push(sentence);
    const chunkText = joinSentences(currentChunk, language);
    const chunkDurationSec = estimateSpeechDurationFromText(chunkText, language);
    const reachedHardCap = chunkDurationSec >= hardSceneDurationSec;
    const reachedSentenceLimit = currentChunk.length >= maxSentencesPerScene;
    const reachedTargetCadence = currentChunk.length >= 2 && chunkDurationSec >= targetSceneDurationSec;
    const shouldFlush = reachedHardCap || reachedSentenceLimit || reachedTargetCadence;

    if (shouldFlush) {
      sceneGroups.push(currentChunk);
      currentChunk = [];
    }
  }

  if (currentChunk.length) {
    sceneGroups.push(currentChunk);
  }

  const filteredSceneGroups = sceneGroups
    .map((group) => group.map((sentence) => sentence.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
  const maxSceneCount = 24;

  if (filteredSceneGroups.length <= maxSceneCount) {
    return filteredSceneGroups;
  }

  const mergeBatchSize = Math.ceil(filteredSceneGroups.length / maxSceneCount);
  const mergedSceneGroups: string[][] = [];

  for (let index = 0; index < filteredSceneGroups.length; index += mergeBatchSize) {
    const mergedGroup = filteredSceneGroups.slice(index, index + mergeBatchSize).flat();
    mergedSceneGroups.push(mergedGroup);
  }

  return mergedSceneGroups.filter((group) => group.length > 0);
}

function estimateDirectSceneDurations(sceneTexts: string[], language: string): number[] {
  return sceneTexts.map((text) => Math.max(2, Math.round(estimateSpeechDurationFromText(text, language))));
}

function estimateSpeechDurationFromText(text: string, language: string): number {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 2;
  }

  if (isCjkLanguage(language) || isCjkText(normalized)) {
    const charCount = normalized.replace(/\s/g, '').length;
    return charCount / 4.2 + 0.8;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount / 2.7 + 0.8;
}

function buildDirectImagePrompt(sceneText: string, sourceHeadlines: string): string {
  const conciseText = truncateText(sceneText, 320);
  const conciseHeadlines = truncateText(sourceHeadlines, 420);

  return [
    'Documentary editorial still, realistic, high detail, widescreen 16:9.',
    `Depict this exact narration segment without adding new facts: ${conciseText}`,
    `Context references: ${conciseHeadlines}`,
  ].join(' ');
}

function createDirectSubtitleCuesFromSentences(sentences: string[], language: string): string[] {
  const cjk = isCjkLanguage(language) || isCjkText(sentences.join(' '));
  const maxLineLen = cjk ? 15 : 30;
  const directCues = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => splitLongSubtitleChunk(sentence, cjk))
    .map((chunk) => wrapSubtitleText(chunk, maxLineLen, cjk))
    .filter(Boolean);

  if (directCues.length) {
    return directCues;
  }

  const fallbackText = joinSentences(sentences, language);
  const estimatedDurationSec = Math.max(3, estimateSpeechDurationFromText(fallbackText, language));
  return createSubtitleCueTexts(fallbackText, estimatedDurationSec, language);
}

function normalizeDirectSourceText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitParagraphIntoSentences(paragraph: string, cjk: boolean): string[] {
  const normalizedParagraph = paragraph.replace(/\s+/g, ' ').trim();

  if (!normalizedParagraph) {
    return [];
  }

  const boundaryPattern = cjk ? /(?<=[。！？；])/ : /(?<=[.!?;:])\s+/;
  const seedSentences = normalizedParagraph
    .split(boundaryPattern)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (!seedSentences.length) {
    return [normalizedParagraph];
  }

  return seedSentences.flatMap((sentence) => splitLongSentenceForDirectMode(sentence, cjk));
}

function splitLongSentenceForDirectMode(sentence: string, cjk: boolean): string[] {
  const normalizedSentence = sentence.replace(/\s+/g, ' ').trim();

  if (!normalizedSentence) {
    return [];
  }

  const maxSentenceLength = cjk ? 52 : 220;
  if (normalizedSentence.length <= maxSentenceLength) {
    return [normalizedSentence];
  }

  if (cjk) {
    return chunkTextByLength(normalizedSentence, 36);
  }

  const words = normalizedSentence.split(' ').filter(Boolean);
  if (words.length <= 1) {
    return chunkTextByLength(normalizedSentence, 80);
  }

  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    const projectedLength = currentLength + word.length + (currentChunk.length ? 1 : 0);

    if (currentChunk.length && projectedLength > 120) {
      chunks.push(currentChunk.join(' '));
      currentChunk = [word];
      currentLength = word.length;
      continue;
    }

    currentChunk.push(word);
    currentLength = projectedLength;
  }

  if (currentChunk.length) {
    chunks.push(currentChunk.join(' '));
  }

  return chunks.filter(Boolean);
}

function joinSentences(sentences: string[], language: string): string {
  const cjk = isCjkLanguage(language) || isCjkText(sentences.join(' '));
  return sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join(cjk ? '' : ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createSubtitleCueTexts(voiceText: string, durationSec: number, language = 'English'): string[] {
  const normalizedText = voiceText.replace(/\s+/g, ' ').trim();

  if (!normalizedText) {
    return [];
  }

  const cjk = isCjkText(normalizedText) || isCjkLanguage(language);
  const maxLineLen = cjk ? 15 : 30;

  const sentences = cjk
    ? normalizedText.split(/(?<=[。！？，；：、])/).map((s) => s.trim()).filter(Boolean)
    : normalizedText.split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);

  const seedChunks = sentences.length ? sentences : [normalizedText];
  const expandedChunks = seedChunks.flatMap((chunk) => splitLongSubtitleChunk(chunk, cjk));
  const maxCueCount = Math.max(1, Math.min(expandedChunks.length, Math.floor(durationSec / 1.8) || 1));
  const joiner = cjk ? '' : ' ';
  const mergedChunks = mergeSubtitleCueTexts(expandedChunks, maxCueCount, joiner);
  return mergedChunks.map((chunk) => wrapSubtitleText(chunk, maxLineLen, cjk));
}

function splitLongSubtitleChunk(text: string, cjk = false): string[] {
  const normalizedText = text.replace(/\s+/g, ' ').trim();

  if (!normalizedText) {
    return [];
  }

  const maxLen = cjk ? 30 : 64;
  const targetLen = cjk ? 24 : 56;

  if (normalizedText.length <= maxLen) {
    return [normalizedText];
  }

  if (cjk) {
    const parts = normalizedText.split(/(?<=[。！？，；：、])/).filter(Boolean);
    if (parts.length > 1) {
      return parts.map((p) => p.trim()).filter(Boolean);
    }
    return chunkTextByLength(normalizedText, targetLen);
  }

  const words = normalizedText.split(' ').filter(Boolean);

  if (words.length <= 1) {
    return chunkTextByLength(normalizedText, 48);
  }

  const chunks: string[] = [];
  let currentChunk = '';

  for (const word of words) {
    const nextChunk = currentChunk ? `${currentChunk} ${word}` : word;

    if (nextChunk.length <= targetLen) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    currentChunk = word;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [normalizedText];
}

function mergeSubtitleCueTexts(chunks: string[], targetCount: number, joiner = ' '): string[] {
  if (!chunks.length || chunks.length <= targetCount) {
    return chunks;
  }

  const safeTargetCount = Math.max(1, targetCount);
  const mergedChunks: string[] = [];
  let currentIndex = 0;

  for (let groupIndex = 0; groupIndex < safeTargetCount; groupIndex += 1) {
    const remainingChunkCount = chunks.length - currentIndex;
    const remainingGroupCount = safeTargetCount - groupIndex;
    const nextGroupSize = Math.ceil(remainingChunkCount / remainingGroupCount);
    mergedChunks.push(chunks.slice(currentIndex, currentIndex + nextGroupSize).join(joiner));
    currentIndex += nextGroupSize;
  }

  return mergedChunks;
}

function wrapSubtitleText(text: string, maxLineLength: number, cjk = false): string {
  if (cjk) {
    if (text.length <= maxLineLength) {
      return text;
    }
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += maxLineLength) {
      lines.push(text.slice(i, i + maxLineLength));
    }
    return lines.slice(0, 2).join('\n');
  }

  const words = text.split(' ').filter(Boolean);

  if (!words.length) {
    return text.trim();
  }

  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;

    if (nextLine.length <= maxLineLength) {
      currentLine = nextLine;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  if (lines.length <= 2) {
    return lines.join('\n');
  }

  const mergedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    mergedLines.push(lines.slice(index, index + 2).join('\n'));
  }

  return mergedLines.join('\n');
}

function chunkTextByLength(text: string, maxLength: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }

  return chunks;
}

function createSceneSubtitleCues(scene: VideoScene, cueTexts: string[], startIndex: number): SubtitleCue[] {
  if (!cueTexts.length) {
    return [];
  }

  const weights = cueTexts.map((text) => Math.max(text.replace(/\n/g, ' ').trim().length, 1));
  const durations = distributeWeightedDurations(scene.durationSec, weights);
  const sceneCues: SubtitleCue[] = [];
  let cueStartSec = scene.startSec;

  for (const [index, text] of cueTexts.entries()) {
    const durationSec = durations[index] ?? 0;
    const cueEndSec = index === cueTexts.length - 1 ? scene.startSec + scene.durationSec : cueStartSec + durationSec;
    sceneCues.push({
      index: startIndex + index + 1,
      sceneId: scene.id,
      startSec: cueStartSec,
      endSec: cueEndSec,
      text,
    });
    cueStartSec = cueEndSec;
  }

  return sceneCues;
}

function distributeWeightedDurations(totalDurationSec: number, weights: number[]): number[] {
  if (!weights.length) {
    return [];
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const durations = weights.map((weight) => (weight / totalWeight) * totalDurationSec);
  let cursor = 0;

  return durations.map((duration, index) => {
    if (index === durations.length - 1) {
      return Math.max(totalDurationSec - cursor, 0.5);
    }

    const nextDuration = Math.max(duration, 0.6);
    cursor += nextDuration;
    return nextDuration;
  });
}

function countSubtitleCues(plan: VideoPlan): number {
  return plan.scenes.reduce((count, scene) => {
    const cues = scene.subtitleCues?.length ? scene.subtitleCues : createSubtitleCueTexts(scene.voiceText, scene.durationSec);
    return count + cues.length;
  }, 0);
}

function createSubtitlePreview(plan: VideoPlan): Array<{ sceneId: string; startSec: number; endSec: number; text: string }> {
  return plan.scenes
    .flatMap((scene) => {
      const cues = scene.subtitleCues?.length ? scene.subtitleCues : createSubtitleCueTexts(scene.voiceText, scene.durationSec);
      return createSceneSubtitleCues(scene, cues, 0);
    })
    .slice(0, 6)
    .map((cue) => ({
      sceneId: cue.sceneId,
      startSec: Number(cue.startSec.toFixed(2)),
      endSec: Number(cue.endSec.toFixed(2)),
      text: cue.text.replace(/\n/g, ' '),
    }));
}

function rebalanceDurations(durations: number[], targetTotal: number): number[] {
  if (!durations.length) {
    return [];
  }

  const safeDurations = durations.map((duration) => (duration > 0 ? duration : 1));
  const currentTotal = safeDurations.reduce((sum, duration) => sum + duration, 0);

  if (!currentTotal || currentTotal === targetTotal) {
    return safeDurations.map((duration) => Math.max(1, Math.round(duration)));
  }

  const scaled = safeDurations.map((duration) => (duration / currentTotal) * targetTotal);
  const rounded = scaled.map((duration) => Math.max(1, Math.floor(duration)));
  let difference = targetTotal - rounded.reduce((sum, duration) => sum + duration, 0);

  while (difference !== 0) {
    for (const [index] of rounded.entries()) {
      if (difference === 0) {
        break;
      }

      if (difference > 0) {
        rounded[index] += 1;
        difference -= 1;
        continue;
      }

      if (rounded[index] > 1) {
        rounded[index] -= 1;
        difference += 1;
      }
    }
  }

  return rounded;
}

function buildSourceContext(sources: Source[]): string {
  const perSourceBudget = Math.max(2000, Math.floor(maxContextChars / Math.max(sources.length, 1)));

  return sources
    .map((source, index) => {
      const body = truncateText(source.rawText, perSourceBudget);
      return [`Source ${index + 1}: ${source.title}`, `Origin: ${source.origin}`, 'Transcript:', body].join('\n');
    })
    .join('\n\n');
}

function buildSourceHeadlines(sources: Source[]): string {
  return sources
    .map((source, index) => {
      const excerpt = truncateText(source.rawText, 1800);
      const lines = [`Source ${index + 1}: ${source.title}`];

      if (source.includeSummary && source.summary.trim()) {
        lines.push(`Summary: ${source.summary}`);
      }

      lines.push(`Key text: ${excerpt}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

function truncateText(text: string, limit: number): string {
  if (!text.trim()) {
    return 'No transcript text available.';
  }

  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function emitStepStarted(
  onUpdate: VideoGenerationRequest['onUpdate'],
  stepId: VideoJobStepId,
  vendor: ModelVendor | undefined,
  model: string | undefined,
  message: string,
) {
  emitJobUpdate(onUpdate, {
    currentMessage: message,
    step: {
      id: stepId,
      status: 'running',
      message,
      provider: vendor,
      model,
    },
    log: {
      stepId,
      message,
    },
  });
}

function formatDebugValue(value: unknown): string {
  return truncateText(JSON.stringify(value, null, 2), 8000);
}

function emitJobUpdate(onUpdate: VideoGenerationRequest['onUpdate'], update: VideoGenerationUpdate) {
  onUpdate?.(update);
}

function validateProviderKeys(selectedVendors: Array<[string, ModelVendor]>, providerKeys: ProviderKeys, providerRegions: ProviderRegions) {
  for (const [stepName, vendor] of selectedVendors) {
    if (!providerKeys[vendor]?.trim()) {
      throw new Error(`Add a ${formatVendorName(vendor)} API key in Settings before running ${stepName}.`);
    }

    if (vendor === 'azure' && !providerRegions.azure?.trim()) {
      throw new Error(`Add an Azure Speech region in Settings before running ${stepName}.`);
    }
  }
}

function formatVendorName(vendor: ModelVendor): string {
  if (vendor === 'openai') {
    return 'OpenAI';
  }

  if (vendor === 'anthropic') {
    return 'Anthropic';
  }

  if (vendor === 'google') {
    return 'Google';
  }

  if (vendor === 'cantoneseai') {
    return 'Cantonese.ai';
  }

  if (vendor === 'azure') {
    return 'Azure Speech';
  }

  if (vendor === 'audiodub') {
    return 'Audiodub';
  }

  if (vendor === 'minimax') {
    return 'MiniMax';
  }

  return 'Mistral';
}

function extractJsonPayload(rawText: string): string {
  const trimmed = rawText.trim();

  if (!trimmed) {
    throw new Error('The model returned an empty JSON response.');
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');

  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    throw new Error('The model response did not contain a valid JSON object.');
  }

  return candidate.slice(objectStart, objectEnd + 1);
}

export async function readMediaDurationFromBlob(blob: Blob, fallbackMimeType: string): Promise<number> {
  const objectUrl = URL.createObjectURL(blob);
  const mediaElement = document.createElement(blob.type.startsWith('video/') ? 'video' : 'audio');
  mediaElement.preload = 'metadata';

  try {
    return await new Promise<number>((resolve, reject) => {
      mediaElement.onloadedmetadata = () => {
        if (Number.isFinite(mediaElement.duration) && mediaElement.duration > 0) {
          resolve(mediaElement.duration);
          return;
        }

        reject(new Error(`Unable to measure media duration for ${fallbackMimeType}.`));
      };

      mediaElement.onerror = () => reject(new Error(`Unable to measure media duration for ${fallbackMimeType}.`));
      mediaElement.src = objectUrl;
    });
  } finally {
    mediaElement.removeAttribute('src');
    mediaElement.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Unable to convert blob data into a local preview URL.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to convert blob data into a local preview URL.'));
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const [, base64Payload = ''] = dataUrl.split(',');
  const binary = window.atob(base64Payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function uint8ArrayToDataAsset(bytes: Uint8Array, mimeType: string): Promise<VideoBinaryAsset> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mimeType });
  return {
    mimeType,
    dataUrl: await blobToDataUrl(blob),
  };
}

export async function loadVideoFfmpeg(onUpdate?: (update: VideoGenerationUpdate) => void): Promise<FFmpegInstance> {
  if (!ffmpegInstancePromise) {
    ffmpegInstancePromise = createVideoFfmpegInstance(onUpdate).catch((error) => {
      ffmpegInstancePromise = null;
      throw error;
    });
  } else {
    emitJobUpdate(onUpdate, {
      currentMessage: 'Step 6: reusing the local ffmpeg runtime that is already loaded.',
      log: {
        stepId: 'compose',
        message: 'Local ffmpeg runtime already loaded. Reusing it for composition.',
      },
    });
  }

  return ffmpegInstancePromise;
}

async function createVideoFfmpegInstance(onUpdate?: (update: VideoGenerationUpdate) => void): Promise<FFmpegInstance> {
  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 6: loading the local ffmpeg runtime. The first run can take 10-30 seconds.',
    log: {
      stepId: 'compose',
      message: 'Loading local ffmpeg runtime for browser-side video composition.',
    },
  });
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();

  const coreURL = await fetchToBlobUrl(`${ffmpegBaseUrl}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await fetchToBlobUrl(`${ffmpegBaseUrl}/ffmpeg-core.wasm`, 'application/wasm');

  emitJobUpdate(onUpdate, {
    currentMessage: 'Step 6: initializing the local ffmpeg engine.',
    log: {
      stepId: 'compose',
      message: 'Initializing the local ffmpeg engine.',
    },
  });
  await withTimeout(
    ffmpeg.load({ classWorkerURL: ffmpegWorkerUrl, coreURL, wasmURL }),
    ffmpegLoadTimeoutMs,
    'The local ffmpeg engine did not finish initializing within 2 minutes. Refresh the page or check whether module workers are blocked in this browser.',
  );

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

export async function execFfmpeg(
  ffmpeg: FFmpegInstance,
  args: string[],
  onUpdate: VideoGenerationRequest['onUpdate'],
  stepId: VideoJobStepId,
  progressMessage: string,
  progressRange: ProgressRange,
) {
  const logLines: string[] = [];
  const progressListener = ({ progress }: { progress: number }) => {
    const ratio = clamp(progress, 0, 1);
    const stepMessage = `${progressMessage} ${Math.round(mapRange(progressRange, ratio))}%`;
    emitJobUpdate(onUpdate, {
      currentMessage: stepMessage,
      step: {
        id: stepId,
        status: 'running',
        message: stepMessage,
      },
    });
  };
  const logListener = ({ message }: { message: string }) => {
    const line = message.trim();
    if (!line) {
      return;
    }

    logLines.push(line);
    if (logLines.length > 30) {
      logLines.shift();
    }
  };

  ffmpeg.on('progress', progressListener);
  ffmpeg.on('log', logListener);

  try {
    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      const logTail = logLines.slice(-6).join(' | ');
      const details = logTail ? ` ffmpeg logs: ${logTail}` : '';
      throw new Error(`ffmpeg exited with code ${exitCode} while running "${progressMessage}".${details}`);
    }

    emitJobUpdate(onUpdate, {
      log: {
        stepId,
        message: `${progressMessage} completed.`,
      },
    });
  } finally {
    ffmpeg.off('progress', progressListener);
    ffmpeg.off('log', logListener);
  }
}

function mapRange(range: ProgressRange, ratio: number): number {
  return range.start + (range.end - range.start) * clamp(ratio, 0, 1);
}

async function cleanupFiles(ffmpeg: FFmpegInstance, paths: string[]) {
  await Promise.all(
    paths.map(async (path) => {
      try {
        await ffmpeg.deleteFile(path);
      } catch {
        // Ignore in-memory cleanup errors.
      }
    }),
  );
}

export function toUint8Array(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export function readThrownMessage(error: unknown, fallback: string): string {
  const status = readThrownStatus(error);
  const primaryMessage = readPrimaryThrownMessage(error);
  const nestedDetail = readNestedThrownDetail(error);
  const genericFetchError = Boolean(primaryMessage && /failed to fetch|network\s*error|fetch\s*failed/i.test(primaryMessage));

  if (nestedDetail) {
    if (status && !nestedDetail.includes(`HTTP ${status}`) && !nestedDetail.includes(` ${status}`)) {
      return `${nestedDetail} (HTTP ${status})`;
    }

    return nestedDetail;
  }

  if (primaryMessage) {
    if (status && !primaryMessage.includes(`HTTP ${status}`) && !primaryMessage.includes(` ${status}`)) {
      return `${primaryMessage} (HTTP ${status})`;
    }

    if (genericFetchError) {
      const genericHelp = 'Verify API key, selected model, and CORS/browser network access for this provider endpoint.';
      if (primaryMessage.toLowerCase().includes(genericHelp.toLowerCase())) {
        return primaryMessage;
      }

      return `${primaryMessage}. ${genericHelp}`;
    }

    return primaryMessage;
  }

  if (status) {
    return `${fallback} (HTTP ${status}).`;
  }

  return fallback;
}

function readPrimaryThrownMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;

    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  return null;
}

function readThrownStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const directStatus = (error as { status?: unknown }).status;

  if (typeof directStatus === 'number' && Number.isFinite(directStatus)) {
    return Math.trunc(directStatus);
  }

  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;

  if (typeof responseStatus === 'number' && Number.isFinite(responseStatus)) {
    return Math.trunc(responseStatus);
  }

  const causeStatus = (error as { cause?: unknown }).cause;
  return causeStatus && causeStatus !== error ? readThrownStatus(causeStatus) : null;
}

function readNestedThrownDetail(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const errorMessage = (error as { error?: { message?: unknown } }).error?.message;

  if (typeof errorMessage === 'string' && errorMessage.trim()) {
    return errorMessage.trim();
  }

  const responseErrorMessage = (error as { response?: { data?: { error?: { message?: unknown } } } }).response?.data?.error?.message;

  if (typeof responseErrorMessage === 'string' && responseErrorMessage.trim()) {
    return responseErrorMessage.trim();
  }

  const bodyErrorMessage = (error as { body?: { error?: { message?: unknown } } }).body?.error?.message;

  if (typeof bodyErrorMessage === 'string' && bodyErrorMessage.trim()) {
    return bodyErrorMessage.trim();
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? readNestedThrownDetail(cause) : null;
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatSeconds(durationSec: number): string {
  return `${durationSec.toFixed(1)}s`;
}
