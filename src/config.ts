import { isProviderName, type ProviderName } from './llm';
import type { Env } from './types';

export interface Config {
  /** IDs de Telegram autorizados. Cualquier otro se ignora en silencio. */
  allowedTelegramIds: Set<number>;
  defaultTimezone: string;
  llmProvider: ProviderName;
  llmModel: string;
  /** Nº de turnos de conversación que se arrastran como contexto. */
  historyWindow: number;
  /** Tope de vueltas del bucle agéntico. Evita que un modelo confundido queme la cuota. */
  maxAgentIterations: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

export class ConfigError extends Error {}

/**
 * Valida el entorno al arrancar la petición.
 *
 * Falla ruidosamente y pronto: un secret ausente detectado aquí es un error
 * legible en los logs, mientras que detectado a mitad del flujo se manifiesta
 * como un 401 opaco de una API de terceros.
 */
export function loadConfig(env: Env): Config {
  const missing = (
    ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'ALLOWED_TELEGRAM_IDS'] as const
  ).filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new ConfigError(
      `Faltan secrets: ${missing.join(', ')}. Defínelos con \`wrangler secret put <NOMBRE>\` ` +
        'o en `.dev.vars` para desarrollo local.',
    );
  }

  const allowedTelegramIds = parseIdList(env.ALLOWED_TELEGRAM_IDS);
  if (allowedTelegramIds.size === 0) {
    // Sin whitelist el bot es un servicio abierto: cualquiera consume cuota y,
    // a partir de la Fase 2, escribe en la base de datos.
    throw new ConfigError(
      'ALLOWED_TELEGRAM_IDS no contiene ningún id válido. Debe ser una lista de números ' +
        'separados por coma (te lo da @userinfobot); el bot rechaza todo mientras esté vacío.',
    );
  }

  // Un LLM_PROVIDER desconocido cae a nvidia en vez de tumbar el bot: es una var
  // de wrangler.toml, y un typo ahí no debe dejar al asistente incomunicado.
  const rawProvider = env.LLM_PROVIDER?.trim().toLowerCase() ?? '';
  const llmProvider: ProviderName = isProviderName(rawProvider) ? rawProvider : 'nvidia';
  if (rawProvider && !isProviderName(rawProvider)) {
    console.warn(`LLM_PROVIDER "${rawProvider}" no reconocido; usando "${llmProvider}"`);
  }

  return {
    allowedTelegramIds,
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Europe/Madrid',
    llmProvider,
    llmModel: env.LLM_MODEL?.trim() || DEFAULT_MODELS[llmProvider],
    historyWindow: parsePositiveInt(env.HISTORY_WINDOW, 20),
    maxAgentIterations: parsePositiveInt(env.MAX_AGENT_ITERATIONS, 5),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIdList(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isSafeInteger(id));
  return new Set(ids);
}

function parseLogLevel(raw: string | undefined): Config['logLevel'] {
  switch (raw) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return raw;
    default:
      return 'info';
  }
}
