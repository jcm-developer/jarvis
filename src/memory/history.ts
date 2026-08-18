import type { LLMMessage, ToolCall } from '../llm/provider';
import type { Env } from '../types';

/**
 * Historial de conversación de corto plazo, en KV.
 *
 * Guarda la secuencia COMPLETA de mensajes, incluidas las llamadas a herramientas
 * y sus resultados. Guardar solo el texto visible parecía suficiente y no lo era:
 * el modelo perdía constancia de lo que ya había hecho y repetía acciones —
 * creaba dos veces la misma tarea al mencionarla de nuevo en el turno siguiente.
 *
 * INTERINO. En la Fase 4 lo sustituye la tabla `messages` de Supabase, cuyo
 * esquema ya contempla estos mismos campos.
 */

const PREFIX = 'history:';
const TTL_SECONDS = 604_800; // 7 días
/** Los resultados de herramienta pueden ser largos; en el historial basta el resumen. */
const MAX_TOOL_CONTENT = 600;

export interface StoredTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
    return trimToValidStart(parsed.filter(isStoredTurn));
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
  const merged = trimToValidStart([...previous, ...turns].slice(-windowSize));
  await env.STATE.put(key(chatId), JSON.stringify(merged), { expirationTtl: TTL_SECONDS });
}

export async function clearHistory(env: Env, chatId: number): Promise<void> {
  await env.STATE.delete(key(chatId));
}

/** Convierte el historial guardado al formato que espera el proveedor. */
export function toLLMMessages(turns: StoredTurn[]): LLMMessage[] {
  return turns.map((turn) => {
    const message: LLMMessage = { role: turn.role, content: turn.content };
    if (turn.toolCalls?.length) message.toolCalls = turn.toolCalls;
    if (turn.toolCallId) message.toolCallId = turn.toolCallId;
    return message;
  });
}

export function toolTurn(toolCallId: string, result: unknown): StoredTurn {
  return {
    role: 'tool',
    toolCallId,
    content: JSON.stringify(result).slice(0, MAX_TOOL_CONTENT),
  };
}

/**
 * Descarta mensajes del principio hasta encontrar un 'user'.
 *
 * Obligatorio, no cosmético: la ventana deslizante puede cortar justo entre un
 * assistant con tool_calls y su resultado, y la API rechaza un mensaje 'tool'
 * huérfano con un 400 que dejaría el bot mudo hasta hacer /reset.
 */
function trimToValidStart(turns: StoredTurn[]): StoredTurn[] {
  let start = 0;
  while (start < turns.length && turns[start]!.role !== 'user') start++;
  return turns.slice(start);
}

function isStoredTurn(value: unknown): value is StoredTurn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Record<string, unknown>;
  const role = turn['role'];
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
  return typeof turn['content'] === 'string' || turn['content'] === null;
}
