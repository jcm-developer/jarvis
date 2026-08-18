import type { Env } from '../types';

/**
 * Acciones destructivas a la espera de confirmación.
 *
 * Viven en KV con TTL corto: si el usuario no contesta en 5 minutos, la acción
 * caduca sola. Es lo correcto — una confirmación de hace media hora ya no
 * significa lo mismo, y el contexto de la conversación ha cambiado.
 */

const TTL_SECONDS = 300;

export interface PendingAction {
  toolName: string;
  args: Record<string, unknown>;
  /** Lo que se le enseñó al usuario al preguntar, para poder repetirlo al confirmar. */
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
    if (typeof candidate['toolName'] !== 'string') return null;
    return {
      toolName: candidate['toolName'],
      args: (candidate['args'] ?? {}) as Record<string, unknown>,
      prompt: typeof candidate['prompt'] === 'string' ? candidate['prompt'] : '',
    };
  } catch {
    return null;
  }
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
