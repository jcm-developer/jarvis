import type { Config } from '../config';
import type { Env } from '../types';
import type { LLMProvider } from './provider';
import { LLMError } from './provider';
import { OpenAICompatibleProvider } from './providers/openai-compatible';

/**
 * Catálogo de proveedores.
 *
 * Los tres hablan el formato de OpenAI, así que comparten adaptador. Añadir uno
 * nuevo es una entrada aquí; el resto del código no se entera.
 *
 * Gemini queda fuera a propósito: su API nativa no es compatible y necesitaría
 * su propio adaptador. Se añadirá si hace falta.
 */
const ENDPOINTS = {
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyName: 'NVIDIA_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyName: 'GROQ_API_KEY',
  },
} as const;

export type ProviderName = keyof typeof ENDPOINTS;

export function isProviderName(value: string): value is ProviderName {
  return value in ENDPOINTS;
}

/**
 * Lanza LLMError si falta la clave. Es deliberado: el agente lo captura y avisa
 * por Telegram, en vez de morir en silencio como haría un fallo de configuración.
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
