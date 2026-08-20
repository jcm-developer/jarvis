import { createCalendarClient } from '../calendar';
import type { CalendarEventSummary } from '../calendar/provider';
import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import type { Deadline } from '../lib/deadline';
import { eventLabel, timedEvents } from '../lib/events';
import {
  endOfLocalDay,
  formatLongDate,
  formatShortDateTime,
  formatTime,
  localNow,
  startOfLocalDay,
} from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import { MIN_CALENDAR_MS } from '../tools/calendar';
import type { Env } from '../types';

/**
 * Daily briefing: what today holds, once a day and at the user's local hour.
 *
 * The text is composed here, without going through the model. It is a list of
 * appointments and tasks with dates: the LLM would add nothing and would add cost,
 * latency and the chance of inventing something that is not there. The briefing has to
 * be boring and exact.
 */

/** The "already sent today" marker expires on its own; no cleanup needed. */
const MARKER_TTL_SECONDS = 172_800; // 48 h

/**
 * Width of the sending window, in hours. With BRIEFING_HOUR=8: 8, 9 or 10.
 *
 * The cron may miss its tick, and comparing the exact hour would simply mean no briefing
 * that day. A window recovers it; with no limit at all, a "good morning" would land at
 * eleven at night.
 */
const WINDOW_HOURS = 3;

/** Enough for a busy day, and it bounds the message's size. */
const MAX_TASKS = 25;

/**
 * Cap for the briefing's calendar read.
 *
 * Shorter than the 10 s the tools allow themselves because this runs unattended and
 * shares the cron's budget with every other user's reminders. If it does not fit, the
 * tasks still go out: that is the whole reason the calendar is read last.
 */
const CALENDAR_MAX_MS = 6_000;

/** Appointments read for a single day. There are never more in one. */
const DAY_EVENT_LIMIT = 20;

export interface BriefingDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  briefingHour: number;
  deadline: Deadline;
}

/** Returns true when it was sent. */
export async function sendBriefingIfDue(deps: BriefingDeps): Promise<boolean> {
  const { env, db, telegram, target, now, briefingHour } = deps;

  const local = localNow(now, target.timezone);
  const hoursLate = local.hour - briefingHour;
  if (hoursLate < 0 || hoursLate >= WINDOW_HOURS) return false;

  // The key carries the LOCAL date, not the UTC one: that is what defines "today" for
  // whoever reads the message. One KV write a day, which the 1,000 budget does not feel.
  const marker = `briefing:${target.userId}:${local.date}`;
  if (await env.STATE.get(marker)) return false;

  // Alerts stay out (`kind='task'`). They announce themselves at their own time, so
  // listing them here would say the same thing twice, and one "remind me at 21:00" would
  // take a slot away from something that really is on the day's plan.
  const tasks = await db.select<TaskRow>('tasks', {
    filters: { user_id: `eq.${target.userId}`, status: 'eq.pending', kind: 'eq.task' },
    order: 'due_at.asc.nullslast,priority.asc',
    limit: MAX_TASKS,
  });

  // Read after the tasks, never before: the appointments are the half that depends on a
  // third party, and this order is what makes a Google outage cost the calendar section
  // instead of the whole message.
  const events = await todaysEvents(deps);

  const text = buildBriefingText(tasks, events, target.timezone, now);
  await telegram.sendMessage(target.chatId, text);

  // The marker is written after sending: if Telegram fails, the next tick retries while
  // still inside the window.
  await env.STATE.put(marker, '1', { expirationTtl: MARKER_TTL_SECONDS });

  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return true;
}

/**
 * Today's appointments, or null when the calendar could not be read.
 *
 * Null is not an error: the briefing goes out with the tasks and says out loud that the
 * appointments are missing. Same split as the cron's per-job try and as what_now in §14.
 * Losing the tasks because Google returned a 500 would trade a useful message for
 * silence, and this is a message nobody asked for: there is no one to notice and ask
 * again.
 */
async function todaysEvents(deps: BriefingDeps): Promise<CalendarEventSummary[] | null> {
  const { deadline, env, now, target } = deps;

  const budget = deadline.budgetFor(CALENDAR_MAX_MS);
  if (budget < MIN_CALENDAR_MS) {
    console.warn(JSON.stringify({ event: 'briefing_calendar_skipped', reason: 'sin presupuesto' }));
    return null;
  }

  try {
    const client = createCalendarClient(env);
    // The whole local day, not from `now`: the window may run three hours late, and
    // dropping what has already gone by would hide the 09:00 meeting from a briefing
    // that went out at 10. The day's plan is not the same thing as what is left of it.
    return await client.listEvents(
      {
        from: startOfLocalDay(now, target.timezone).toISOString(),
        to: endOfLocalDay(now, target.timezone).toISOString(),
        query: null,
        limit: DAY_EVENT_LIMIT,
      },
      budget,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'briefing_calendar_failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

function buildBriefingText(
  tasks: TaskRow[],
  events: CalendarEventSummary[] | null,
  timezone: string,
  now: Date,
): string {
  const endOfDay = endOfLocalDay(now, timezone).getTime();

  const overdue: TaskRow[] = [];
  const today: TaskRow[] = [];
  const undatedUrgent: TaskRow[] = [];

  for (const task of tasks) {
    if (!task.due_at) {
      // Tasks with neither a date nor a priority stay out: the briefing is today, not
      // the full inventory of pending things.
      if (task.priority === 1) undatedUrgent.push(task);
      continue;
    }
    const due = new Date(task.due_at).getTime();
    if (due < now.getTime()) overdue.push(task);
    else if (due < endOfDay) today.push(task);
  }

  // Timed and all-day appointments go in separate lists: one holds a slot and the other
  // does not, and mixing them would drop "Ana's birthday" between two meetings as though
  // it were one of them. Same distinction §14 makes to compute free gaps.
  const timed = timedEvents(events ?? []);
  const allDay = (events ?? []).filter((event) => event.allDay);

  const header = `${greeting(localNow(now, timezone).hour)}. Hoy es ${formatLongDate(now, timezone)}.`;
  const lines = [header];

  const nothingAtAll =
    timed.length === 0 &&
    allDay.length === 0 &&
    overdue.length === 0 &&
    today.length === 0 &&
    undatedUrgent.length === 0;

  if (nothingAtAll) {
    // With no calendar there is no way to promise an empty day: what can be said is
    // what was actually read.
    lines.push(
      events === null ? 'No tienes tareas apuntadas para hoy.' : 'No tienes nada apuntado para hoy.',
    );
  }

  if (timed.length > 0) {
    lines.push('', 'Agenda:');
    for (const event of timed) {
      const from = formatTime(new Date(event.startAt!), timezone);
      const to = formatTime(new Date(event.endAt!), timezone);
      lines.push(`- ${from}-${to} ${eventLabel(event)}`);
    }
  }

  if (allDay.length > 0) {
    lines.push('', 'Todo el día:');
    for (const event of allDay) {
      lines.push(`- ${eventLabel(event)}`);
    }
  }

  if (overdue.length > 0) {
    lines.push('', 'Vencidas:');
    for (const task of overdue) {
      lines.push(`- ${task.title} (${formatShortDateTime(new Date(task.due_at!), timezone)})`);
    }
  }

  if (today.length > 0) {
    lines.push('', 'Hoy:');
    for (const task of today) {
      lines.push(`- ${formatTime(new Date(task.due_at!), timezone)} ${task.title}${flag(task)}`);
    }
  }

  if (undatedUrgent.length > 0) {
    lines.push('', 'Sin fecha, prioridad alta:');
    for (const task of undatedUrgent) {
      lines.push(`- ${task.title}`);
    }
  }

  // A day full of meetings and no tasks must not read as though the task list had not
  // been checked. It is one line and it is the difference between "nothing pending" and
  // "nobody looked".
  if (timed.length + allDay.length > 0 && overdue.length + today.length === 0) {
    lines.push('', 'De tareas no tienes nada para hoy.');
  }

  // Said at the end and in plain words: there is no model here to soften it, and a
  // briefing that quietly leaves the appointments out is worse than one that admits it.
  if (events === null && !nothingAtAll) {
    lines.push('', 'No he podido leer tu calendario, así que las citas no están en esta lista.');
  } else if (events === null) {
    lines.push('Y no he podido leer tu calendario, así que puede que tengas alguna cita.');
  }

  return lines.join('\n');
}

function flag(task: TaskRow): string {
  return task.priority === 1 ? ' (alta)' : '';
}

/** BRIEFING_HOUR is configurable, so the greeting cannot assume it is morning. */
function greeting(hour: number): string {
  if (hour < 14) return 'Buenos días';
  if (hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}
