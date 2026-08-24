import type { Db } from '../db/client';
import { logToolCall } from '../db/logs';
import type { TaskRow } from '../db/types';
import { formatTime, localNow, localTomorrow, zonedInstant } from '../lib/localtime';

/**
 * Postponing an alert from the alert itself (phase 15).
 *
 * The alert used to arrive and leave you writing "pospónlo diez minutos" — a model call,
 * two seconds and a chance of the date going wrong, to say something the alert could have
 * offered as a button. It is the most repeated answer to a proactive message and it was
 * the most expensive one.
 *
 * It lives next to [pending.ts](pending.ts) rather than in a tool file because it is the
 * same kind of thing: support for the button flow, not something the model can call. The
 * model already has `update_task` for this said out loud.
 */

/**
 * Callback prefix. Short on purpose: `callback_data` is capped at 64 bytes and a uuid
 * already eats 36 of them.
 *
 * `zz:<uuid>:<code>` is 42, which leaves the whole thing inside the limit **without a KV
 * write**. That is the difference from the confirmation flow, which does store a pending
 * call in KV: there the payload is a whole tool call, here it is one id and one option.
 * The alerts go out several times a day, and the free plan gives 1,000 writes.
 */
export const SNOOZE_PREFIX = 'zz:';

export interface SnoozeOption {
  /** What travels in the callback. */
  code: string;
  label: string;
}

/**
 * The three options, and only three: a fourth row of buttons in a chat is a menu, and a
 * menu is what you stop reading. "Mañana" is not a number of minutes because a day is
 * not 1,440 minutes on the two clock-change days a year.
 */
export const SNOOZE_OPTIONS: SnoozeOption[] = [
  { code: '10', label: '+10 min' },
  { code: '60', label: '+1 h' },
  { code: 'd', label: 'Mañana' },
];

export function snoozeData(taskId: string, code: string): string {
  return `${SNOOZE_PREFIX}${taskId}:${code}`;
}

export function parseSnooze(data: string): { taskId: string; code: string } | null {
  if (!data.startsWith(SNOOZE_PREFIX)) return null;

  const rest = data.slice(SNOOZE_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return null;

  const taskId = rest.slice(0, separator);
  const code = rest.slice(separator + 1);
  if (!SNOOZE_OPTIONS.some((option) => option.code === code)) return null;

  return { taskId, code };
}

export interface SnoozeDeps {
  db: Db;
  userId: string;
  /**
   * Where the postponement gets recorded. Arrived with phase 13: the weekly review counts
   * postponements out of `tool_call_logs`, and that table is keyed by conversation.
   */
  conversationId: string;
  taskId: string;
  code: string;
  now: Date;
  timezone: string;
}

/**
 * Moves the alert and returns what to say in the chat.
 *
 * **It reopens the row instead of creating another one**, and that is the opposite of
 * what §12 has the model do with a spent alert. The reason the model is told to create a
 * new one is that reopening means writing a date onto a closed row, and the cron only
 * looks at pending ones: a model that sets `remind_at` and forgets `status` produces an
 * alert that never arrives, silently. Here the three fields travel in a single patch,
 * which is exactly the guarantee the model cannot give.
 *
 * And it makes pressing the button twice harmless: the second press writes the same
 * fields on the same row. Creating a row per press would have turned a double tap into
 * two alerts.
 */
export async function applySnooze(deps: SnoozeDeps): Promise<string> {
  const { db, userId, conversationId, taskId, code, now, timezone } = deps;
  const startedAt = Date.now();

  const [task] = await db.select<TaskRow>('tasks', {
    filters: { id: `eq.${taskId}`, user_id: `eq.${userId}` },
    limit: 1,
  });

  if (!task) {
    return 'Esa tarea ya no existe, así que no he movido nada.';
  }

  // A spent alert is reopened —that is the whole point— but a task the user has already
  // closed is not resurrected by a button they pressed on an old message.
  if (task.kind !== 'reminder' && task.status !== 'pending') {
    return `"${task.title}" ya no está pendiente, así que no la he movido.`;
  }

  const target = snoozeUntil(task, code, now, timezone);
  if (target === null) {
    return 'No he entendido ese botón. Dime a qué hora lo quieres y lo cambio.';
  }

  await db.update<TaskRow>(
    'tasks',
    { id: `eq.${taskId}`, user_id: `eq.${userId}` },
    {
      remind_at: target.toISOString(),
      // Null on purpose: the cron only picks up rows with no `reminded_at`. Without this
      // the new time would be stored and nothing would ever go out — the silent failure
      // this whole flow exists to avoid.
      reminded_at: null,
      status: 'pending',
      completed_at: null,
    },
  );

  // Written down as if it were a tool call, because for the review it is one. This is the
  // most used way of postponing there is —that is the entire premise of phase 15— so a
  // weekly count built only on `update_task` would report what was said out loud and miss
  // what was actually pressed. One Supabase insert, no KV: it is not on the write budget.
  await logToolCall(db, {
    conversationId,
    toolName: 'snooze',
    args: { task_id: taskId, code },
    result: { id: task.id, title: task.title, remind_at: target.toISOString() },
    success: true,
    durationMs: Date.now() - startedAt,
  });

  const tomorrow = localNow(target, timezone).date !== localNow(now, timezone).date;
  const when = tomorrow
    ? `mañana a las ${formatTime(target, timezone)}`
    : `a las ${formatTime(target, timezone)}`;
  return `Vale, te lo recuerdo ${when}.`;
}

/**
 * When the alert should come back.
 *
 * "Mañana" keeps the hour the alert was set for, not the hour the button was pressed: the
 * bin alert is a 21:00 thing, and pressing "mañana" at 23:40 because the phone was in
 * another room must not turn it into a 23:40 thing for ever.
 */
function snoozeUntil(task: TaskRow, code: string, now: Date, timezone: string): Date | null {
  const minutes = Number.parseInt(code, 10);
  if (Number.isSafeInteger(minutes) && minutes > 0) {
    // To the minute: "te lo recuerdo a las 21:10" with 43 seconds hidden behind it reads
    // like a lie the moment the alert lands at 21:11.
    return new Date(Math.round((now.getTime() + minutes * 60_000) / 60_000) * 60_000);
  }
  if (code !== 'd') return null;

  const alarm = task.remind_at ?? task.due_at;
  const reference = alarm ? new Date(alarm) : now;
  const local = localNow(reference, timezone);
  return zonedInstant(localTomorrow(now, timezone), local.hour, local.minute, timezone);
}
