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

/**
 * The kinds of work the queue knows how to do.
 *
 * `read_url` was the first tenant (phase 17) and `impute_hours` joins it for the same
 * reason: a login plus a form submit against somebody else's ASP.NET site is seconds of
 * their latency, and the turn has 27 s to cover the model rounds as well.
 */
export type JobKind = 'read_url' | 'impute_hours';

/** A deferred job (phase 17). `payload` shape depends on `kind`. */
export interface JobRow {
  id: string;
  user_id: string;
  kind: JobKind;
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
 * A book the user has read, is reading, or wants to read (phase 24).
 *
 * The row is the taste, not the edition: what makes it worth storing is `rating`,
 * `notes` and `topics`, which are what a recommendation is argued from.
 */
export interface BookRow {
  id: string;
  user_id: string;
  title: string;
  author: string | null;
  status: 'read' | 'reading' | 'pending' | 'abandoned';
  /** 1 to 5, or null when the user logged the book without judging it. */
  rating: number | null;
  /** Comma-separated, written by the model: 'ciencia ficción, distopía'. */
  topics: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A link hanging off a project: a short label and where it points. */
export interface ProjectLink {
  /** 'repo', 'docs', 'staging'. It is the key: sending it again corrects the url. */
  label: string;
  url: string;
}

/**
 * Something the user is building (phase 25).
 *
 * It is context, not work: the tasks and the appointments about a project come and go,
 * the project stays, and what it is for is that "el de la web" resolves to a name, a
 * description and a repo without the user explaining it again.
 */
export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  /** 'idea' not started, 'active' in progress, 'paused' parked, 'done' finished. */
  status: 'active' | 'paused' | 'done' | 'idea';
  links: ProjectLink[];
  notes: string | null;
  created_at: string;
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

/**
 * A tool call as it was recorded (phase 2), read back (phase 13).
 *
 * It was write-only for eleven phases: an audit trail you open when something went wrong.
 * The weekly review is the first thing that queries it, and that is the whole reason it
 * can count postponements without a new column — `arguments` already holds what the model
 * asked for and `result` what the database answered.
 */
export interface ToolCallLogRow {
  id: string;
  conversation_id: string | null;
  tool_name: string;
  arguments: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  success: boolean;
  created_at: string;
}

