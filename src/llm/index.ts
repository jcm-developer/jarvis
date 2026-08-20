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
 * Which models read images, by name.
 *
 * An allowlist and not a `true` per provider, because the two ways of being wrong do
 * not cost the same. Guessing that a text-only model sees means downloading the photo,
 * spending the budget and getting a 400 back mid-turn, which reaches the user as
 * "algo ha fallado por dentro". Guessing the other way costs one sentence saying it
 * cannot see photos. Only the second one is recoverable, so the doubt resolves there.
 *
 * The OpenAI entry covers `gpt-4o`, `gpt-4.1` and `gpt-5` with their `-mini` variants,
 * which is where production lives. On Groq and NVIDIA vision is the exception rather
 * than the rule, so only the families that announce it are listed.
 */
const VISION_MODELS: Record<ProviderName, RegExp> = {
  openai: /^(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/,
  groq: /vision|llama-4|scout|maverick/,
  nvidia: /vision|llama-4|vila|neva/,
};

/**
 * Whether the configured model can be sent a photo.
 *
 * Read outside `src/llm/` in two places —the handler, to answer before downloading
 * anything, and the prompt, so the list of limits does not promise something the model
 * cannot do— and it is a function of the config, not of the provider instance: asking
 * it must not require an API key.
 */
export function seesImages(config: Config): boolean {
  return VISION_MODELS[config.llmProvider].test(config.llmModel.trim().toLowerCase());
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
    supportsImages: seesImages(config),
  });
}
