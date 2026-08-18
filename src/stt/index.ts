import type { Config } from '../config';
import type { Env } from '../types';
import { OpenAITranscriber } from './openai';
import type { Transcriber } from './provider';
import { SttError } from './provider';
import { WorkersAiTranscriber } from './workers-ai';

export const STT_PROVIDERS = ['openai', 'workers-ai'] as const;
export type SttProviderName = (typeof STT_PROVIDERS)[number];

export function isSttProviderName(value: string): value is SttProviderName {
  return (STT_PROVIDERS as readonly string[]).includes(value);
}

export function createTranscriber(env: Env, config: Config): Transcriber {
  if (config.sttProvider === 'workers-ai') {
    return new WorkersAiTranscriber(env.AI, config.sttModel, config.sttLanguage);
  }

  if (!env.OPENAI_API_KEY) {
    throw new SttError('auth', 'Falta el secret OPENAI_API_KEY para transcribir.');
  }
  return new OpenAITranscriber(env.OPENAI_API_KEY, config.sttModel, config.sttLanguage);
}
