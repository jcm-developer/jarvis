import type { Env } from './types';

export interface Config {
  /** IDs de Telegram autorizados. Cualquier otro se ignora en silencio. */
  allowedTelegramIds: Set<number>;
  defaultTimezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

/**
 * Valida el entorno al arrancar la petición.
 *
 * Falla ruidosamente y pronto: un secret ausente detectado aquí es un error
 * legible en los logs, mientras que detectado a mitad del flujo se manifiesta
 * como un 401 opaco de una API de terceros.
 */
export function loadConfig(env: Env): Config {
  const missing = (['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const).filter(
    (key) => !env[key],
  );
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
      'ALLOWED_TELEGRAM_IDS está vacío. Añade tu telegram user id en wrangler.toml ' +
        'antes de desplegar; el bot rechaza todo mientras esté vacío.',
    );
  }

  return {
    allowedTelegramIds,
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Europe/Madrid',
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
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
