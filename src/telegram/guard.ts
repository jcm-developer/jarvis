import type { Config } from '../config';
import { timingSafeEqual } from '../core/secret';
import type { Env, TelegramUpdate } from '../types';

/** A repeated update is not processed again for 24 h. */
const DEDUPE_TTL_SECONDS = 86_400;

export interface Actor {
  telegramUserId: number;
  chatId: number;
}

/**
 * Validates the webhook's secret header.
 *
 * Telegram sends it on every request when the webhook was registered with
 * `secret_token`. Without this, the Worker's URL is a public endpoint anyone can call
 * with forged updates.
 */
export function verifyWebhookSecret(request: Request, env: Env): boolean {
  const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!received) return false;
  return timingSafeEqual(received, env.TELEGRAM_WEBHOOK_SECRET);
}

/** Extracts who is talking and in which chat, be it a message or a button tap. */
export function extractActor(update: TelegramUpdate): Actor | null {
  const message = update.message ?? update.edited_message;
  if (message?.from) {
    return { telegramUserId: message.from.id, chatId: message.chat.id };
  }

  const callback = update.callback_query;
  if (callback?.message) {
    return { telegramUserId: callback.from.id, chatId: callback.message.chat.id };
  }

  return null;
}

export function isAuthorized(actor: Actor, config: Config): boolean {
  return config.allowedTelegramIds.has(actor.telegramUserId);
}

/**
 * Claims an update_id. Returns `true` only the first time it is seen.
 *
 * Telegram retries delivery when the webhook does not answer 200 in time. Without this
 * lock, a retry re-runs the agent's actions: duplicated tasks or, worse, a repeated
 * deletion.
 *
 * KV is eventually consistent, so two near-simultaneous retries could slip through. For
 * a single user the risk is negligible; if it ever matters, the replacement is a Durable
 * Object.
 */
export async function claimUpdate(env: Env, updateId: number): Promise<boolean> {
  const key = `dedupe:update:${updateId}`;
  const seen = await env.STATE.get(key);
  if (seen !== null) return false;

  await env.STATE.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}
