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

/**
 * A quién escribe el cron. No hay chat de origen del que sacarlo, así que sale
 * del cruce de `users` y `conversations`.
 */
export interface CronTarget {
  userId: string;
  conversationId: string;
  chatId: number;
  telegramId: number;
  timezone: string;
}

/**
 * Usuarios con conversación abierta a los que el cron puede escribir.
 *
 * Dos consultas y el cruce en memoria en vez de un select con recurso embebido:
 * mantiene el cliente de base de datos tonto, y con un usuario son dos filas.
 *
 * El filtro por whitelist es la parte importante: si un id sale de
 * `ALLOWED_TELEGRAM_IDS`, el cron deja de escribirle aunque su fila siga en la
 * base de datos. Al revés que el webhook, aquí nadie más comprueba el permiso.
 */
export async function listCronTargets(
  db: Db,
  allowedTelegramIds: Set<number>,
  defaultTimezone: string,
): Promise<CronTarget[]> {
  const [users, conversations] = await Promise.all([
    db.select<UserRow>('users', { columns: 'id,telegram_id,timezone' }),
    db.select<ConversationRow>('conversations', { columns: 'id,user_id,telegram_chat_id' }),
  ]);

  const authorized = new Map(
    users.filter((user) => allowedTelegramIds.has(user.telegram_id)).map((user) => [user.id, user]),
  );

  const targets: CronTarget[] = [];
  for (const conversation of conversations) {
    const user = authorized.get(conversation.user_id);
    if (!user) continue;
    targets.push({
      userId: user.id,
      conversationId: conversation.id,
      chatId: conversation.telegram_chat_id,
      telegramId: user.telegram_id,
      timezone: user.timezone || defaultTimezone,
    });
  }
  return targets;
}
