import type { PunchAction, Project } from '../ficha/provider';
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
 * `read_url` was the first tenant (phase 17); the punch and the imputation joined it in
 * phase 22 for the same reason and not by analogy: a login plus a form submit against
 * somebody else's ASP.NET site is seconds of their latency, and the turn has 27 s to
 * cover the model rounds as well.
 */
export type JobKind = 'read_url' | 'ficha_punch' | 'impute_hours';

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

/** A submitted imputation (phase 24). Replaces impute_log.json. */
export interface ImputationRow {
  id: string;
  user_id: string;
  project: string;
  task: string | null;
  hours: number;
  /** Mandatory, and enforced in the database too: the site rejects an empty one anyway. */
  comment: string;
  /** The working day the hours landed on, as the site reported it after submitting. */
  work_date: string;
  /** True when the site rolled the day over on this submission. */
  day_advanced: boolean;
  source: 'voice' | 'text';
  /**
   * When it was submitted. The streak in the gamification count is computed from this and
   * not from `work_date`, because what it rewards is the habit of logging, not the dates
   * logged.
   */
  logged_at: string;
}

/**
 * The day's project table, cached whole (phase 24).
 *
 * A blob and one row per day rather than a row per project: it is a snapshot of somebody
 * else's table, it is never queried by field, and the index inside it is only meaningful
 * together with the day. Storing it decomposed would invite treating those indexes as
 * ours.
 */
export interface ProjectCacheRow {
  user_id: string;
  /** The site's own working day (YYYY-MM-DD), not ours. */
  day: string;
  projects: Project[];
  scraped_at: string;
}
