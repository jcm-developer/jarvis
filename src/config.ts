import { isProviderName, type ProviderName } from './llm';
import { isSttProviderName, type SttProviderName } from './stt';
import type { Env } from './types';

export interface Config {
  /** Authorised Telegram ids. Any other one is ignored silently. */
  allowedTelegramIds: Set<number>;
  defaultTimezone: string;
  llmProvider: ProviderName;
  llmModel: string;
  /** How many conversation rows are dragged along as context. */
  historyWindow: number;
  /** Cap on agentic loop rounds. Stops a confused model from burning the quota. */
  maxAgentIterations: number;
  sttProvider: SttProviderName;
  sttModel: string;
  sttLanguage: string;
  /** Local hour (0-23) at which the cron's daily briefing goes out. */
  briefingHour: number;
  /**
   * The day's window, in local hours, within which free slots are searched for.
   *
   * Without a declared window, "you are free from 03:00 to 07:00" is a technically
   * correct and useless answer: the calendar is empty at night because people sleep, not
   * because there is room for anything.
   */
  dayStartHour: number;
  dayEndHour: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: 'gpt-4.1-mini',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

const DEFAULT_STT_MODELS: Record<SttProviderName, string> = {
  openai: 'whisper-1',
  'workers-ai': '@cf/openai/whisper-large-v3-turbo',
};

export class ConfigError extends Error {}

/**
 * Validates the environment as the request starts.
 *
 * It fails loudly and early: a missing secret caught here is a readable error in the
 * logs, whereas caught midway through the flow it shows up as an opaque 401 from a
 * third-party API.
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
    // With no whitelist the bot is an open service: anyone burns quota and, from Phase 2
    // onwards, writes to the database.
    throw new ConfigError(
      'ALLOWED_TELEGRAM_IDS no contiene ningún id válido. Debe ser una lista de números ' +
        'separados por coma (te lo da @userinfobot); el bot rechaza todo mientras esté vacío.',
    );
  }

  // An unknown LLM_PROVIDER falls back to nvidia instead of bringing the bot down: it is
  // a wrangler.toml var, and a typo there must not leave the assistant unreachable.
  const rawProvider = env.LLM_PROVIDER?.trim().toLowerCase() ?? '';
  const llmProvider: ProviderName = isProviderName(rawProvider) ? rawProvider : 'nvidia';
  if (rawProvider && !isProviderName(rawProvider)) {
    console.warn(`LLM_PROVIDER "${rawProvider}" no reconocido; usando "${llmProvider}"`);
  }

  const rawStt = env.STT_PROVIDER?.trim().toLowerCase() ?? '';
  const sttProvider: SttProviderName = isSttProviderName(rawStt) ? rawStt : 'openai';

  // An inverted window would leave find_free_slots never returning a gap, and that is a
  // typo in wrangler.toml, not a reason to bring the bot down.
  const dayStartHour = parseHour(env.DAY_START_HOUR, 9);
  const dayEndHour = parseHour(env.DAY_END_HOUR, 21, 24);
  const sensibleDay = dayStartHour < dayEndHour;
  if (!sensibleDay) {
    console.warn(
      `DAY_START_HOUR (${dayStartHour}) no es anterior a DAY_END_HOUR (${dayEndHour}); ` +
        'se usa la franja por defecto 9-21',
    );
  }

  return {
    allowedTelegramIds,
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Europe/Madrid',
    sttProvider,
    sttModel: env.STT_MODEL?.trim() || DEFAULT_STT_MODELS[sttProvider],
    sttLanguage: env.STT_LANGUAGE?.trim() || 'es',
    llmProvider,
    llmModel: env.LLM_MODEL?.trim() || DEFAULT_MODELS[llmProvider],
    historyWindow: parsePositiveInt(env.HISTORY_WINDOW, 20),
    maxAgentIterations: parsePositiveInt(env.MAX_AGENT_ITERATIONS, 5),
    briefingHour: parseHour(env.BRIEFING_HOUR, 8),
    dayStartHour: sensibleDay ? dayStartHour : 9,
    dayEndHour: sensibleDay ? dayEndHour : 21,
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}

/**
 * Separate from parsePositiveInt because 0:00 is a valid hour and a zero is not.
 *
 * `max` goes up to 24 for the end of a window: "until 24" is the next midnight, and with
 * the cap at 23 there would be no way to say "until the end of the day".
 */
function parseHour(raw: string | undefined, fallback: number, max = 23): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
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
