import type { ToolCall } from '../llm/provider';

export interface UserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  timezone: string;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  telegram_chat_id: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: number;
  status: 'pending' | 'done' | 'cancelled';
  completed_at: string | null;
  reminded_at: string | null;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  key: string;
  value: string;
  updated_at: string;
}

/**
 * Fila de historial. `tool_calls` guarda la estructura del proveedor tal cual,
 * para poder reconstruir el contexto del modelo sin transformarla.
 */
export interface MessageRow {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
}
