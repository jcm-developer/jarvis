import type { PunchAction } from '../timeclock/provider';
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
 *
 * The punch is NOT here, and that was a change of mind worth recording: it has to land on
 * a specific minute, while a job is by definition the one thing nobody is waiting for
 * (§16). It runs inside the tick instead.
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

/**
 * A scheduled punch (phase 23). Replaces the scheduler's schedules.json.
 *
 * One row per action and time, rolled forward like `tasks`: there is no row per day.
 */
export interface PunchScheduleRow {
  id: string;
  user_id: string;
  action: PunchAction;
  /** Local time of day, 'HH:MM'. Local because the user thinks in local and Spain moves its clocks. */
  at_time: string;
  enabled: boolean;
  /**
   * The window the daily random offset is drawn from, in minutes.
   *
   * Columns rather than constants so the jitter can be turned off (0/0) without a deploy.
   */
  offset_min: number;
  offset_max: number;
  /**
   * The offset drawn for `offset_for`, and the local day it was drawn for.
   *
   * Persisted, and this is the part that looks like over-engineering and is not: the cron
   * ticks every five minutes and the firing rule is `now >= at_time + offset`. Re-rolling
   * the dice on every tick would fire on the first tick where any draw happens to pass,
   * which biases every day to the earliest edge of the window. Drawing once a day and
   * writing it down is what makes the offset mean anything.
   */
  offset_minutes: number | null;
  offset_for: string | null;
  /**
   * The last local day this row fired on. Same job as `tasks.reminded_at`: stops a second
   * tick in the same day from punching twice.
   */
  fired_on: string | null;
  created_at: string;
}

/**
 * A punch that went out (phase 22).
 *
 * Append-only, and it is not the source of truth: the portal is. What this answers is the
 * half the portal cannot —what the automation did and when— so that "did I clock in?" can
 * be answered with a time and not just with a yes.
 */
export interface PunchRow {
  id: string;
  user_id: string;
  action: PunchAction;
  /** 'auto' when the scheduler did it, 'manual' when it was asked for in the chat. */
  source: 'auto' | 'manual';
  /** The time the portal reported, when it reported one. Its clock, not ours. */
  registered_at: string | null;
  /** The local day it belongs to. What "have I clocked in today?" filters on. */
  local_day: string;
  punched_at: string;
}
