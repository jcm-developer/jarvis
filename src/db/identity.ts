import type { Env, TelegramUser } from '../types';
import type { Db } from './client';
import type { ConversationRow, UserRow } from './types';

/**
 * Resolves the Supabase user and conversation for a Telegram chat, creating them when
 * they do not exist.
 *
 * The uuids are cached in KV: they are immutable, and looking them up on every message
 * would add two round trips to Supabase on top of a latency that already carries the
 * model's.
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
 * Who the cron writes to. There is no originating chat to take it from, so it comes
 * from joining `users` and `conversations`.
 */
export interface CronTarget {
  userId: string;
  conversationId: string;
  chatId: number;
  telegramId: number;
  timezone: string;
}

/**
 * Users with an open conversation the cron is allowed to write to.
 *
 * Two queries and the join in memory instead of a select with an embedded resource: it
 * keeps the database client dumb, and with one user it is two rows.
 *
 * The whitelist filter is the important part: if an id leaves
 * `ALLOWED_TELEGRAM_IDS`, the cron stops writing to them even though their row is still
 * in the database. Unlike the webhook, nobody else checks the permission here.
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
