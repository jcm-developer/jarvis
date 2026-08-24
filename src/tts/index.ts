import type { Config } from '../config';
import type { Env } from '../types';
import { OpenAISynthesizer } from './openai';
import type { Synthesizer } from './provider';
import { TtsError } from './provider';
import { WorkersAiSynthesizer } from './workers-ai';

export const TTS_PROVIDERS = ['openai', 'workers-ai'] as const;
export type TtsProviderName = (typeof TTS_PROVIDERS)[number];

export function isTtsProviderName(value: string): value is TtsProviderName {
  return (TTS_PROVIDERS as readonly string[]).includes(value);
}

export function createSynthesizer(env: Env, config: Config): Synthesizer {
  if (config.ttsProvider === 'workers-ai') {
    return new WorkersAiSynthesizer(env.AI, config.ttsModel, config.ttsVoice, config.sttLanguage);
  }

  if (!env.OPENAI_API_KEY) {
    throw new TtsError('auth', 'Falta el secret OPENAI_API_KEY para sintetizar voz.');
  }
  return new OpenAISynthesizer(env.OPENAI_API_KEY, config.ttsModel, config.ttsVoice);
}
