import type { ModelVendor } from '../types/workspace';

export async function createOpenAIClient(apiKey: string) {
  const { OpenAI } = await import('openai');
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

export async function createAnthropicClient(apiKey: string) {
  const { Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export async function createGoogleClient(apiKey: string) {
  const { GoogleGenAI } = await import('@google/genai');
  return new GoogleGenAI({ apiKey });
}

export async function createMistralClient(apiKey: string) {
  const { Mistral } = await import('@mistralai/mistralai');
  return new Mistral({ apiKey });
}

export async function createAzureSpeechSdk() {
  return import('microsoft-cognitiveservices-speech-sdk');
}

export async function createVendorClient(vendor: ModelVendor, apiKey: string) {
  if (vendor === 'openai') {
    return createOpenAIClient(apiKey);
  }

  if (vendor === 'anthropic') {
    return createAnthropicClient(apiKey);
  }

  if (vendor === 'google') {
    return createGoogleClient(apiKey);
  }

  if (vendor === 'azure') {
    return createAzureSpeechSdk();
  }

  if (vendor === 'minimax') {
    throw new Error('MiniMax client is used only for TTS via REST helper in video-orchestrator.');
  }

  return createMistralClient(apiKey);
}
