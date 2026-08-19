import type { Config } from '../config';
import type { Env } from '../types';
import type { LLMProvider } from './provider';
import { LLMError } from './provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible';

/**
 * The provider catalogue.
 *
 * All three speak OpenAI's format, so they share one adapter. Adding a new one is an
 * entry here; the rest of the code does not notice.
 *
 * Gemini is left out on purpose: its native API is not compatible and would need its
 * own adapter. It will be added if the need shows up.
 *
 * ⚠️ When picking an OpenAI model: the reasoning ones (the o series) reject
 * `max_tokens` (they expect `max_completion_tokens`) and do not accept `temperature`.
 * The adapter sends both parameters, so stay in the gpt-4o / gpt-4.1 family unless it
 * gets adapted first.
 */
const ENDPOINTS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    keyName: 'OPENAI_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyName: 'GROQ_API_KEY',
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyName: 'NVIDIA_API_KEY',
  },
} as const;

export type ProviderName = keyof typeof ENDPOINTS;

export function isProviderName(value: string): value is ProviderName {
  return value in ENDPOINTS;
}

/**
 * Throws LLMError when the key is missing. That is deliberate: the agent catches it and
 * warns over Telegram, instead of dying silently the way a configuration failure would.
 */
export function createProvider(env: Env, config: Config): LLMProvider {
  const endpoint = ENDPOINTS[config.llmProvider];
  const apiKey = env[endpoint.keyName];

  if (!apiKey) {
    throw new LLMError(
      'auth',
      `Falta el secret ${endpoint.keyName} para el proveedor "${config.llmProvider}".`,
    );
  }

  return new OpenAICompatibleProvider({
    name: config.llmProvider,
    baseUrl: endpoint.baseUrl,
    apiKey,
    model: config.llmModel,
  });
}
