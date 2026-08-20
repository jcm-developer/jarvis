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
  kind: 'task' | 'reminder';
  due_at: string | null;
  remind_at: string | null;
  priority: number;
  status: 'pending' | 'done' | 'cancelled';
  completed_at: string | null;
  reminded_at: string | null;
  /** Frequency when it repeats. One row, rolled forward; never a row per occurrence. */
  recurrence: string | null;
  created_at: string;
}

/** A deferred job (phase 17). `payload` shape depends on `kind`. */
export interface JobRow {
  id: string;
  user_id: string;
  kind: 'read_url';
  payload: Record<string, unknown>;
  state: 'pending' | 'running' | 'done' | 'dead';
  attempts: number;
  run_after: string;
  last_error: string | null;
  started_at: string | null;
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
 * A history row. `tool_calls` stores the provider's structure verbatim, so the model's
 * context can be rebuilt without transforming it.
 */
export interface MessageRow {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
}
