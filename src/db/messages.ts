import type { LLMMessage, ToolCall } from '../llm/provider';
import type { Db } from './client';
import type { MessageRow } from './types';

/**
 * Historial de conversación, en la tabla `messages`.
 *
 * Guarda la secuencia COMPLETA del turno, incluidas las llamadas a herramientas y
 * sus resultados. Guardar solo el texto visible parecía suficiente y no lo era: el
 * modelo perdía constancia de lo que ya había hecho y repetía acciones — creaba dos
 * veces la misma tarea al volver a mencionarla en el turno siguiente.
 *
 * Antes vivía en KV con TTL de 7 días. Se mueve aquí por dos motivos: el plan free
 * de Cloudflare da 1.000 escrituras de KV al día y una por mensaje se comía el
 * presupuesto, y el historial es lo único que quedaba fuera de la base de datos,
 * así que no había forma de leer una conversación pasada más que por los logs.
 */

/** Los resultados de herramienta pueden ser largos; en el historial basta el resumen. */
const MAX_TOOL_CONTENT = 600;

export interface StoredTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Solo en role='user': de dónde salió el mensaje. */
  source?: 'text' | 'voice';
  /** Solo en audios: lo que devolvió el STT, para depurar transcripciones raras. */
  transcriptRaw?: string;
}

/** Los N mensajes más recientes, en orden cronológico y listos para replayear. */
export async function loadHistory(
  db: Db,
  conversationId: string,
  limit: number,
): Promise<StoredTurn[]> {
  // Se piden del más nuevo al más viejo porque es la única forma de quedarse con
  // la cola sin traer la conversación entera; el índice está justo en ese orden.
  const rows = await db.select<MessageRow>('messages', {
    columns: 'role,content,tool_calls,tool_call_id',
    filters: { conversation_id: `eq.${conversationId}` },
    order: 'created_at.desc',
    limit,
  });

  return trimToValidStart(rows.reverse().filter(isReplayable).map(toStoredTurn));
}

/**
 * Persiste los turnos de una interacción.
 *
 * Nunca lanza: el usuario ya tiene su respuesta y perder el historial de un turno
 * es un fallo menor comparado con tragarse la respuesta por un error de escritura.
 */
export async function saveTurns(
  db: Db,
  conversationId: string,
  turns: StoredTurn[],
): Promise<void> {
  if (turns.length === 0) return;

  // created_at explícito, un milisegundo por fila.
  //
  // El default de la columna es now(), que en Postgres es el mismo instante para
  // todas las filas de un INSERT: al releerlas ordenadas por fecha volverían en
  // orden arbitrario. Y un mensaje 'tool' delante de la llamada que lo originó no
  // es un desorden cosmético, es un 400 de la API que deja el bot mudo.
  const base = Date.now();

  try {
    await db.insertMany(
      'messages',
      turns.map((turn, index) => ({
        conversation_id: conversationId,
        role: turn.role,
        content: turn.content,
        tool_calls: turn.toolCalls ?? null,
        tool_call_id: turn.toolCallId ?? null,
        source: turn.source ?? 'text',
        transcript_raw: turn.transcriptRaw ?? null,
        created_at: new Date(base + index).toISOString(),
      })),
    );
  } catch (error) {
    console.error('no se pudo guardar el historial:', error);
  }
}

/**
 * Borra la conversación (/reset).
 *
 * Borrado real, no marca de corte: si el usuario pide olvidar, se olvida. La
 * auditoría de lo que el agente *hizo* no se pierde con esto — vive en
 * `tool_call_logs`, que es la tabla que se consulta cuando algo salió raro.
 */
export async function clearHistory(db: Db, conversationId: string): Promise<void> {
  await db.delete('messages', { conversation_id: `eq.${conversationId}` }, { returning: 'minimal' });
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
 * Descarta mensajes del principio hasta llegar a uno que pueda abrir el contexto.
 *
 * Obligatorio, no cosmético: la ventana puede cortar justo entre un assistant con
 * tool_calls y su resultado, y la API rechaza un 'tool' huérfano con un 400 que
 * dejaría el bot mudo hasta hacer /reset.
 *
 * Vale un 'user' o un 'assistant' sin tool_calls. Aceptar el segundo importa: un
 * turno con muchas herramientas puede llenar la ventana entero, y entonces no hay
 * ningún 'user' que encontrar. Quedarse con la última respuesta del asistente es
 * peor que el historial completo, pero mucho mejor que empezar de cero.
 */
function trimToValidStart(turns: StoredTurn[]): StoredTurn[] {
  const start = turns.findIndex(
    (turn) => turn.role === 'user' || (turn.role === 'assistant' && !turn.toolCalls?.length),
  );
  return start === -1 ? [] : turns.slice(start);
}

/** El system prompt se construye en cada petición; si hubiera filas, se ignoran. */
function isReplayable(row: MessageRow): boolean {
  return row.role !== 'system';
}

function toStoredTurn(row: MessageRow): StoredTurn {
  const turn: StoredTurn = {
    role: row.role as StoredTurn['role'],
    content: row.content,
  };
  if (row.tool_calls?.length) turn.toolCalls = row.tool_calls;
  if (row.tool_call_id) turn.toolCallId = row.tool_call_id;
  return turn;
}
