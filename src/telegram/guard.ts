import type { Config } from '../config';
import type { Env, TelegramUpdate } from '../types';

/** Un update repetido no se vuelve a procesar durante 24 h. */
const DEDUPE_TTL_SECONDS = 86_400;

export interface Actor {
  telegramUserId: number;
  chatId: number;
}

/**
 * Valida la cabecera secreta del webhook.
 *
 * Telegram la envía en cada petición si se registró el webhook con `secret_token`.
 * Sin esto, la URL del Worker es un endpoint público que cualquiera puede invocar
 * con updates falsos.
 */
export function verifyWebhookSecret(request: Request, env: Env): boolean {
  const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!received) return false;
  return timingSafeEqual(received, env.TELEGRAM_WEBHOOK_SECRET);
}

/** Comparación en tiempo constante. La longitud sí se filtra, y es aceptable. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;

  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

/** Extrae quién habla y en qué chat, sea un mensaje o un botón pulsado. */
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
 * Reclama un update_id. Devuelve `true` solo la primera vez que se ve.
 *
 * Telegram reintenta la entrega si el webhook no responde 200 a tiempo. Sin este
 * candado, un reintento reejecuta las acciones del agente: tareas duplicadas o,
 * peor, un borrado repetido.
 *
 * KV es eventualmente consistente, así que dos reintentos casi simultáneos podrían
 * colarse. Para un solo usuario el riesgo es despreciable; si algún día importa,
 * el reemplazo es un Durable Object.
 */
export async function claimUpdate(env: Env, updateId: number): Promise<boolean> {
  const key = `dedupe:update:${updateId}`;
  const seen = await env.STATE.get(key);
  if (seen !== null) return false;

  await env.STATE.put(key, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  return true;
}
