import type { Env, TelegramUser } from '../types';
import type { Db } from './client';
import type { ConversationRow, UserRow } from './types';

/**
 * Resuelve el usuario y la conversación de Supabase para un chat de Telegram,
 * creándolos si no existen.
 *
 * Los uuid se cachean en KV: son inmutables y consultarlos en cada mensaje
 * añadiría dos saltos a Supabase a una latencia que ya arrastra la del modelo.
 */

const CACHE_TTL_SECONDS = 2_592_000; // 30 días

export interface Identity {
  userId: string;
  conversationId: string;
  timezone: string;
}

export async function resolveIdentity(
  env: Env,
  db: Db,
  from: TelegramUser | undefined,
  chatId: number,
  defaultTimezone: string,
): Promise<Identity> {
  const telegramId = from?.id ?? chatId;

  const cached = await env.STATE.get(cacheKey(telegramId, chatId), 'json');
  if (isCachedIdentity(cached)) return cached;

  const user = await db.upsert<UserRow>(
    'users',
    {
      telegram_id: telegramId,
      username: from?.username ?? null,
      first_name: from?.first_name ?? null,
      timezone: defaultTimezone,
    },
    'telegram_id',
  );

  const conversation = await db.upsert<ConversationRow>(
    'conversations',
    { user_id: user.id, telegram_chat_id: chatId },
    'telegram_chat_id',
  );

  const identity: Identity = {
    userId: user.id,
    conversationId: conversation.id,
    timezone: user.timezone || defaultTimezone,
  };

  await env.STATE.put(cacheKey(telegramId, chatId), JSON.stringify(identity), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return identity;
}

function cacheKey(telegramId: number, chatId: number): string {
  return `identity:${telegramId}:${chatId}`;
}

function isCachedIdentity(value: unknown): value is Identity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['conversationId'] === 'string' &&
    typeof candidate['timezone'] === 'string'
  );
}
