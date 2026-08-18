import type { Env } from '../types';

/**
 * Historial de conversación de corto plazo, en KV.
 *
 * INTERINO. En la Fase 4 esto se sustituye por la tabla `messages` de Supabase,
 * que además guarda tool_calls, transcripciones y permite consultarlo. Vive aquí
 * de momento porque una conversación sin memoria del turno anterior no se puede
 * ni probar, y KV no exige montar la base de datos todavía.
 *
 * Coste: 1 lectura + 1 escritura por mensaje. Con las 1.000 escrituras/día del
 * plan free, y contando la del dedupe, salen unos 500 mensajes diarios. De sobra
 * para uso personal, pero es el límite que primero se rozaría.
 */

const PREFIX = 'history:';
const TTL_SECONDS = 604_800; // 7 días

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
}

function key(chatId: number): string {
  return `${PREFIX}${chatId}`;
}

export async function loadHistory(env: Env, chatId: number): Promise<StoredTurn[]> {
  const raw = await env.STATE.get(key(chatId));
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredTurn);
  } catch {
    // Historial corrupto: mejor empezar limpio que romper la conversación.
    return [];
  }
}

export async function appendTurns(
  env: Env,
  chatId: number,
  previous: StoredTurn[],
  turns: StoredTurn[],
  windowSize: number,
): Promise<void> {
  // Ventana deslizante: solo interesan los últimos N turnos.
  const merged = [...previous, ...turns].slice(-windowSize);
  await env.STATE.put(key(chatId), JSON.stringify(merged), { expirationTtl: TTL_SECONDS });
}

export async function clearHistory(env: Env, chatId: number): Promise<void> {
  await env.STATE.delete(key(chatId));
}

function isStoredTurn(value: unknown): value is StoredTurn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    (turn['role'] === 'user' || turn['role'] === 'assistant') && typeof turn['content'] === 'string'
  );
}
