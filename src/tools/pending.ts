import type { Env } from '../types';

/**
 * Destructive actions waiting for confirmation.
 *
 * They live in KV with a TTL: if the user never answers, the action expires on its
 * own. A confirmation from half an hour ago no longer means the same thing, because
 * the conversation's context has moved on.
 */

const TTL_SECONDS = 900; // 15 min

export interface PendingCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PendingAction {
  /** Several at once: "delete them all" is confirmed in one go, not one by one. */
  calls: PendingCall[];
  /** What the user was shown when asked. */
  prompt: string;
  /**
   * The message that led to the question, when there was one.
   *
   * Empty on the usual path —a button carries no text— and set for a photo's caption,
   * which is user text and does feed the date guardrails. Storing it means the
   * correction applied when the action runs is the same one that was applied when the
   * question was worded, instead of quietly disappearing in between.
   */
  userMessage?: string;
}

export async function savePending(
  env: Env,
  chatId: number,
  action: PendingAction,
): Promise<string> {
  const token = randomToken();
  await env.STATE.put(key(chatId, token), JSON.stringify(action), {
    expirationTtl: TTL_SECONDS,
  });
  return token;
}

/**
 * Fetches and consumes the action in a single step.
 *
 * The deletion is deliberate: without it, tapping the button twice would run the
 * action twice. Telegram lets you tap an inline button as many times as you like.
 */
export async function takePending(
  env: Env,
  chatId: number,
  token: string,
): Promise<PendingAction | null> {
  const raw = await env.STATE.get(key(chatId, token));
  if (!raw) return null;

  await env.STATE.delete(key(chatId, token));

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    const calls = candidate['calls'];
    if (!Array.isArray(calls) || calls.length === 0) return null;

    return {
      calls: calls.filter(isPendingCall),
      prompt: typeof candidate['prompt'] === 'string' ? candidate['prompt'] : '',
      userMessage: typeof candidate['userMessage'] === 'string' ? candidate['userMessage'] : '',
    };
  } catch {
    return null;
  }
}

function isPendingCall(value: unknown): value is PendingCall {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['toolName'] === 'string';
}

function key(chatId: number, token: string): string {
  return `pending:${chatId}:${token}`;
}

/** 8 bytes in hex. Telegram's callback_data allows 64, so there is room to spare. */
function randomToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
