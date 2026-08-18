import type { Env } from '../types';

/**
 * Acciones destructivas a la espera de confirmación.
 *
 * Viven en KV con TTL: si el usuario no contesta, la acción caduca sola. Una
 * confirmación de hace media hora ya no significa lo mismo, porque el contexto
 * de la conversación ha cambiado.
 */

const TTL_SECONDS = 900; // 15 min

export interface PendingCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PendingAction {
  /** Varias a la vez: "bórralas todas" se confirma de una sola vez, no una por una. */
  calls: PendingCall[];
  /** Lo que se le enseñó al usuario al preguntar. */
  prompt: string;
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
 * Recupera y consume la acción en un solo paso.
 *
 * El borrado es deliberado: sin él, pulsar el botón dos veces ejecutaría la
 * acción dos veces. Telegram deja pulsar un botón inline cuantas veces quieras.
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

/** 8 bytes en hex. callback_data de Telegram admite 64 bytes; vamos sobrados. */
function randomToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
