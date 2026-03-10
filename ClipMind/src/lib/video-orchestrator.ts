import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
import { createAnthropicClient, createAzureSpeechSdk, createGoogleClient, createMistralClient, createOpenAIClient } from './provider-clients';
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

  const selectedSummaryVendor = getModelVendor('summary', settings.models.summary);
  const selectedScriptVendor = getModelVendor('script', settings.models.script);
  const selectedTtsVendor = getModelVendor('tts', settings.models.tts);
  const selectedImageVendor = getModelVendor('image', settings.models.image);
  validateProviderKeys(
    [
      ['extract', selectedSummaryVendor],
      ['narrative', selectedScriptVendor],
      ['narration', selectedTtsVendor],
      ['visuals', selectedImageVendor],
    ],
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

    const extraction = await runExtractStep({ sources, settings, providerKeys, vendor: selectedSummaryVendor, onUpdate });
    activeStepId = 'narrative';
    const narrativeArc = await runNarrativeStep({ extraction, settings, providerKeys, vendor: selectedScriptVendor, onUpdate });
    activeStepId = 'storyboard';
    const plan = await runStoryboardStep({ extraction, narrativeArc, sources, settings, providerKeys, vendor: selectedScriptVendor, onUpdate });
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

  if (vendor !== 'openai' && vendor !== 'cantoneseai' && vendor !== 'azure' && vendor !== 'audiodub') {
    throw new Error('Narration voice generation requires an OpenAI, Azure Speech, Cantonese.ai, or Audiodub TTS model.');
  }

  const voice = settings.voice || 'alloy';
  const audioClips: VideoAudioClip[] = [];
  const actualDurations: number[] = [];
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
    currentMessage: `Step 4: generating ${plan.scenes.length} narration clips in parallel.`,
    step: {
      id: 'narration',
      status: 'running',
      message: `Generating ${plan.scenes.length} narration clips in parallel.`,
    },
    log: {
      stepId: 'narration',
      message: `Launching ${plan.scenes.length} parallel TTS requests.`,
    },
  });

  let narrationCompletedCount = 0;
  const clipResults = await Promise.all(
    plan.scenes.map(async (scene, index) => {
      const blob = vendor === 'cantoneseai'
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
            })
        : await generateOpenAiTts({
            apiKey: providerKeys[vendor],
            model: settings.models.tts,
            text: scene.voiceText,
            voice,
            language: settings.language,
          });

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
    }),
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
        subtitleMode: 'Burned-in SRT subtitles with force_style',
        timeline: plan.scenes.map((scene) => ({
          sceneId: scene.id,
          durationSec: scene.durationSec,
          startSec: scene.startSec,
        })),
      }),
      handoff: 'The final MP4 and merged narration audio will be stored locally and exposed to the Studio list and Preview panel.',
    },
  });
  const ffmpeg = await loadVideoFfmpeg(onUpdate, { start: 0, end: 28 });
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
          const burnedDataUrl = await burnSubtitleOnImage(image.dataUrl, cue.text, settings.language);
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
        '4',
        slideshowName,
      ],
      onUpdate,
      'compose',
      'Rendering slideshow frames.',
      { start: 50, end: 74 },
    );

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
    await execFfmpeg(
      ffmpeg,
      ['-i', slideshowName, '-i', narrationName, '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', outputName],
      onUpdate,
      'compose',
      'Muxing narration into final video.',
      { start: 86, end: 100 },
    );

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

const subtitleVideoWidth = 1280;
const subtitleVideoHeight = 720;

async function burnSubtitleOnImage(
  imageDataUrl: string,
  subtitleText: string,
  language: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = subtitleVideoWidth;
      canvas.height = subtitleVideoHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to create canvas context for subtitle burning.'));
        return;
      }

      ctx.drawImage(img, 0, 0, subtitleVideoWidth, subtitleVideoHeight);

      const cjk = isCjkLanguage(language) || isCjkText(subtitleText);
      const fontSize = cjk ? 24 : 26;
      const fontStack = cjk
        ? `bold ${fontSize}px "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`
        : `bold ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
      ctx.font = fontStack;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const lines = subtitleText.split('\n').map((l) => l.trim()).filter(Boolean);
      const lineHeight = Math.round(fontSize * 1.45);
      const paddingH = 14;
      const paddingV = 8;
      const marginBottom = 36;

      const lineWidths = lines.map((l) => ctx.measureText(l).width);
      const maxLineWidth = Math.max(...lineWidths, 10);
      const blockHeight = lines.length * lineHeight;

      const boxWidth = maxLineWidth + paddingH * 2;
      const boxHeight = blockHeight + paddingV * 2;
      const boxX = (subtitleVideoWidth - boxWidth) / 2;
      const boxY = subtitleVideoHeight - marginBottom - boxHeight;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.58)';
      ctx.beginPath();
      roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 6);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(20, 20, 20, 0.7)';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';

      for (let i = 0; i < lines.length; i++) {
        const x = subtitleVideoWidth / 2;
        const y = boxY + paddingV + i * lineHeight;
        ctx.strokeText(lines[i], x, y);
        ctx.fillText(lines[i], x, y);
      }

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to load scene image for subtitle burning.'));
    img.src = imageDataUrl;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
  const response = await client.audio.speech.create({
    model,
    input: text,
    voice: voice as 'alloy',
    response_format: 'wav',
  });
  return new Blob([await response.arrayBuffer()], { type: 'audio/wav' });
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

export async function generateAudiodubTts({
  apiKey,
  text,
  language,
  voiceId,
}: {
  apiKey: string;
  text: string;
  language: string;
  voiceId?: string;
}): Promise<Blob> {
  const response = await fetch('https://api.audiodub.ai/text-to-speech/generate', {
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
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Audiodub TTS failed (HTTP ${response.status})${errorText ? `: ${errorText}` : ''}`);
  }

  const json = await response.json() as Record<string, unknown>;
  const audioFileUrl = json.audio_file;

  if (typeof audioFileUrl !== 'string' || !audioFileUrl) {
    throw new Error('Audiodub TTS response did not contain an audio_file URL.');
  }

  const audioResponse = await fetch(proxyAudiodubS3Url(audioFileUrl));

  if (!audioResponse.ok) {
    throw new Error(`Audiodub TTS audio file could not be fetched (HTTP ${audioResponse.status}).`);
  }

  const audioBlob = await audioResponse.blob();

  if (!audioBlob.size) {
    throw new Error('Audiodub TTS returned an empty audio file.');
  }

  return new Blob([await audioBlob.arrayBuffer()], { type: audioBlob.type || 'audio/mpeg' });
}

function proxyAudiodubS3Url(url: string): string {
  const s3Host = 'https://s3.ap-southeast-1.amazonaws.com';

  if (url.startsWith(s3Host)) {
    return `/proxy/audiodub-s3${url.slice(s3Host.length)}`;
  }

  return url;
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

export async function loadVideoFfmpeg(onUpdate?: (update: VideoGenerationUpdate) => void, _progressRange: ProgressRange = { start: 0, end: 100 }): Promise<FFmpegInstance> {
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

  ffmpeg.on('progress', progressListener);

  try {
    const exitCode = await ffmpeg.exec(args);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode} while running "${progressMessage}".`);
    }

    emitJobUpdate(onUpdate, {
      log: {
        stepId,
        message: `${progressMessage} completed.`,
      },
    });
  } finally {
    ffmpeg.off('progress', progressListener);
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatSeconds(durationSec: number): string {
  return `${durationSec.toFixed(1)}s`;
}
