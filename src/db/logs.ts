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
 * Registro de auditoría de las llamadas a herramientas.
 *
 * Sin esto, entender por qué el agente borró lo que no era o creó una tarea con
 * fecha absurda es adivinar. Con esto se ve exactamente qué argumentos generó el
 * modelo y qué devolvió la base de datos.
 *
 * Nunca lanza: un fallo escribiendo el log no debe tumbar la acción del usuario.
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
