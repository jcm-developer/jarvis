import type { Db } from './client';

export interface ToolCallLog {
  conversationId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Audit trail of tool calls.
 *
 * Without this, understanding why the agent deleted the wrong thing or created a task
 * with an absurd date is guesswork. With it you see exactly which arguments the model
 * produced and what the database returned.
 *
 * It never throws: failing to write the log must not bring down the user's action.
 */
export async function logToolCall(db: Db, entry: ToolCallLog): Promise<void> {
  try {
    await db.insert('tool_call_logs', {
      conversation_id: entry.conversationId,
      tool_name: entry.toolName,
      arguments: entry.args,
      result: entry.result ?? null,
      success: entry.success,
      error: entry.error ?? null,
      duration_ms: Math.round(entry.durationMs),
    });
  } catch (error) {
    console.error('no se pudo guardar tool_call_log:', error);
  }
}
