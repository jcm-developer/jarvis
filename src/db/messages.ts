import type { LLMMessage, ToolCall } from '../llm/provider';
import type { Db } from './client';
import type { MessageRow } from './types';

/**
 * Conversation history, in the `messages` table.
 *
 * It stores the COMPLETE sequence of the turn, tool calls and their results included.
 * Storing only the visible text looked sufficient and was not: the model lost track of
 * what it had already done and repeated actions — it created the same task twice when
 * the user mentioned it again on the following turn.
 *
 * This used to live in KV with a 7-day TTL. It moved here for two reasons: Cloudflare's
 * free plan allows 1,000 KV writes a day and one per message ate the budget, and the
 * history was the only thing left outside the database, so there was no way to read a
 * past conversation other than through the logs.
 */

/** Tool results can be long; the summary is enough for the history. */
const MAX_TOOL_CONTENT = 600;

export interface StoredTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Only on role='user': where the message came from. */
  source?: 'text' | 'voice';
  /** Only on audio: what the STT returned, for debugging odd transcriptions. */
  transcriptRaw?: string;
}

/** The N most recent messages, in chronological order and ready to replay. */
export async function loadHistory(
  db: Db,
  conversationId: string,
  limit: number,
): Promise<StoredTurn[]> {
  // They are requested newest first because it is the only way to keep the tail
  // without fetching the whole conversation; the index is in exactly that order.
  const rows = await db.select<MessageRow>('messages', {
    columns: 'role,content,tool_calls,tool_call_id',
    filters: { conversation_id: `eq.${conversationId}` },
    order: 'created_at.desc',
    limit,
  });

  return trimToValidStart(rows.reverse().filter(isReplayable).map(toStoredTurn));
}

/**
 * Persists the turns of one interaction.
 *
 * It never throws: the user already has their answer, and losing one turn's history is
 * a minor failure next to swallowing the reply over a write error.
 */
export async function saveTurns(
  db: Db,
  conversationId: string,
  turns: StoredTurn[],
): Promise<void> {
  if (turns.length === 0) return;

  // Explicit created_at, one millisecond per row.
  //
  // The column default is now(), which in Postgres is the same instant for every row of
  // an INSERT: reading them back ordered by date would return them in arbitrary order.
  // And a 'tool' message ahead of the call that produced it is not cosmetic disorder,
  // it is a 400 from the API that leaves the bot mute.
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
 * Deletes the conversation (/reset).
 *
 * A real delete, not a cut-off marker: if the user asks to forget, it is forgotten. The
 * audit trail of what the agent *did* is not lost with this — it lives in
 * `tool_call_logs`, which is the table you go to when something looked off.
 */
export async function clearHistory(db: Db, conversationId: string): Promise<void> {
  await db.delete('messages', { conversation_id: `eq.${conversationId}` }, { returning: 'minimal' });
}

/** Converts the stored history into the shape the provider expects. */
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
 * Drops messages from the front until one that can open the context is reached.
 *
 * Mandatory, not cosmetic: the window can cut right between an assistant message with
 * tool_calls and its result, and the API rejects an orphan 'tool' with a 400 that would
 * leave the bot mute until a /reset.
 *
 * A 'user' or an 'assistant' without tool_calls will do. Accepting the second matters: a
 * turn with many tools can fill the whole window, and then there is no 'user' left to
 * find. Keeping the assistant's last reply is worse than the full history, but far
 * better than starting from scratch.
 */
function trimToValidStart(turns: StoredTurn[]): StoredTurn[] {
  const start = turns.findIndex(
    (turn) => turn.role === 'user' || (turn.role === 'assistant' && !turn.toolCalls?.length),
  );
  return start === -1 ? [] : turns.slice(start);
}

/** The system prompt is built on every request; any stored rows are ignored. */
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
