import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import {
  endOfLocalDay,
  formatLongDate,
  formatShortDateTime,
  formatTime,
  localNow,
} from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import type { Env } from '../types';

/**
 * Daily briefing: what today holds, once a day and at the user's local hour.
 *
 * The text is composed here, without going through the model. It is a list of tasks with
 * dates: the LLM would add nothing and would add cost, latency and the chance of
 * inventing a task that does not exist. The briefing has to be boring and exact.
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

export interface BriefingDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  briefingHour: number;
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

  const tasks = await db.select<TaskRow>('tasks', {
    filters: { user_id: `eq.${target.userId}`, status: 'eq.pending' },
    order: 'due_at.asc.nullslast,priority.asc',
    limit: MAX_TASKS,
  });

  const text = buildBriefingText(tasks, target.timezone, now);
  await telegram.sendMessage(target.chatId, text);

  // The marker is written after sending: if Telegram fails, the next tick retries while
  // still inside the window.
  await env.STATE.put(marker, '1', { expirationTtl: MARKER_TTL_SECONDS });

  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return true;
}

function buildBriefingText(tasks: TaskRow[], timezone: string, now: Date): string {
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

  const header = `${greeting(localNow(now, timezone).hour)}. Hoy es ${formatLongDate(now, timezone)}.`;

  if (overdue.length === 0 && today.length === 0 && undatedUrgent.length === 0) {
    return `${header} No tienes nada apuntado para hoy.`;
  }

  const lines = [header];

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
