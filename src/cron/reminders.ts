import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import {
  formatDayAndTime,
  formatTime,
  localNow,
  localTomorrow,
  localYesterday,
} from '../lib/localtime';
import { nextOccurrence } from '../lib/recurrence';
import type { InlineKeyboardButton, TelegramClient } from '../telegram/client';
import { SNOOZE_OPTIONS, snoozeData } from '../tools/snooze';

/**
 * Reminders for tasks falling due.
 *
 * There are two classes of alert and they cannot be held to the same standard:
 *
 * - **At the requested time** (`remind_at`): "remind me at 12:10" has to arrive at
 *   12:10, not whenever convenient. The precision is set by the cron's period.
 * - **Before it is due** (`due_at` with no `remind_at`): here what matters is the margin.
 *   Warning right at the deadline is useless, so it goes out an hour ahead.
 *
 * This cost a real failure: with the cron running on the hour, an alert requested for
 * 12:10 from a message sent at 12:07 could not arrive before 13:00. That is why the cron
 * moved to every five minutes.
 *
 * `reminded_at` is what stops the alert repeating on every tick until the task is
 * completed. The first time this runs, tasks that were already overdue come in too: they
 * are the ones that most needed reminding.
 *
 * Both kinds of row are announced here, but they do not survive it the same way: see
 * `markAnnounced`.
 */

/** Same as the cron's period: the alert lands within those five minutes. */
const PRECISE_HORIZON_MS = 5 * 60 * 1000;

/** Courtesy head start for tasks that only have a due date. */
const DUE_HORIZON_MS = 60 * 60 * 1000;

/** Per-run cap: a backlog of overdue tasks must not arrive as an avalanche. */
const MAX_PER_RUN = 10;

export interface ReminderDeps {
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
}

/** Returns how many tasks were announced. */
export async function sendDueReminders(deps: ReminderDeps): Promise<number> {
  const { db, telegram, target, now } = deps;

  const base = {
    user_id: `eq.${target.userId}`,
    status: 'eq.pending',
    reminded_at: 'is.null',
  };

  // Two queries in parallel instead of one with `or`: the two sets are disjoint —one
  // requires remind_at, the other requires it to be null— so there is nothing to
  // deduplicate, and each filter uses syntax already proven elsewhere in the code.
  //
  // `lte` never matches a null column, so tasks with no date drop out on their own,
  // without a separate filter.
  const [requested, upcoming] = await Promise.all([
    db.select<TaskRow>('tasks', {
      filters: {
        ...base,
        remind_at: `lte.${new Date(now.getTime() + PRECISE_HORIZON_MS).toISOString()}`,
      },
      order: 'remind_at.asc',
      limit: MAX_PER_RUN,
    }),
    db.select<TaskRow>('tasks', {
      filters: {
        ...base,
        remind_at: 'is.null',
        due_at: `lte.${new Date(now.getTime() + DUE_HORIZON_MS).toISOString()}`,
      },
      order: 'due_at.asc',
      limit: MAX_PER_RUN,
    }),
  ]);

  // The Map deduplicates by id. The two sets should never overlap, but if one of the
  // filters ever changes and they do, the failure would be a repeated alert inside the
  // same message: cheap to prevent, ugly to read in the chat.
  const tasks = [...new Map([...requested, ...upcoming].map((task) => [task.id, task])).values()]
    .sort((a, b) => alarmTime(a) - alarmTime(b))
    .slice(0, MAX_PER_RUN);

  if (tasks.length === 0) return 0;

  const text = buildReminderText(tasks, target.timezone, now);
  await telegram.sendMessage(target.chatId, text, { inlineKeyboard: snoozeKeyboard(tasks) });

  // Marked AFTER sending, on purpose: if the send fails, the task stays unmarked and the
  // alert is retried on the next tick. The other way round, a Telegram failure would turn
  // into a reminder that never arrives.
  await markAnnounced(db, tasks, now, target.timezone);

  // The alert goes into the history so the model knows what it is being told about when
  // the user answers "done" or "push it back".
  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return tasks.length;
}

/**
 * Records that these rows have been announced. The two kinds part ways here.
 *
 * **A reminder is spent the moment it goes out.** Its whole content was the alert, so it
 * gets closed instead of waiting for a "done" that is never coming. Before this, "remind
 * me at 21:00 to take the bins out" stayed `pending` for ever: the pending list filled
 * up with alerts already delivered and they took the briefing's limited slots away from
 * what was genuinely left to do.
 *
 * **A task only gets `reminded_at`.** The alert is not the point of it —paying the bill
 * is— so it stays open until the user says otherwise.
 */
async function markAnnounced(
  db: Db,
  tasks: TaskRow[],
  now: Date,
  timezone: string,
): Promise<void> {
  const stamp = now.toISOString();

  // A recurring alert is neither spent nor left open: it moves on. "La pastilla todos los
  // días a las nueve" is one row for ever, and closing it would leave the user creating
  // it again tomorrow — the chore the frequency exists to remove.
  const repeating = tasks.filter((task) => task.kind === 'reminder' && task.recurrence);
  const spent = tasks
    .filter((task) => task.kind === 'reminder' && !task.recurrence)
    .map((task) => task.id);
  const open = tasks.filter((task) => task.kind !== 'reminder').map((task) => task.id);

  const writes: Promise<unknown>[] = [];
  for (const task of repeating) {
    const from = task.remind_at ?? task.due_at;
    const next = from ? nextOccurrence(new Date(from), task.recurrence!, now, timezone) : null;
    if (next === null) {
      // A frequency that cannot be advanced would announce the same alert on every tick,
      // so the row is closed like any other spent alert and the log says why.
      console.error(`recurrencia inválida en ${task.id}: "${task.recurrence}"`);
      spent.push(task.id);
      continue;
    }
    writes.push(
      db.update(
        'tasks',
        { id: `eq.${task.id}` },
        // The new date and the null `reminded_at` in the SAME patch: the cron only looks
        // at rows with a null one, so splitting these two writes would leave an alert
        // that either never comes back or comes back on every tick.
        { remind_at: next.toISOString(), reminded_at: null, status: 'pending' },
      ),
    );
  }
  if (spent.length > 0) {
    writes.push(
      db.update(
        'tasks',
        { id: `in.(${spent.join(',')})` },
        { reminded_at: stamp, status: 'done', completed_at: stamp },
      ),
    );
  }
  if (open.length > 0) {
    writes.push(db.update('tasks', { id: `in.(${open.join(',')})` }, { reminded_at: stamp }));
  }

  try {
    await Promise.all(writes);
  } catch (error) {
    // A repeated alert is annoying; a lost one is not merely annoying. If this fails the
    // alert goes out again later, and that is the preferable failure mode.
    console.error('no se pudo marcar reminded_at:', error);
  }
}

/**
 * The postpone buttons, and only when the message announces ONE task.
 *
 * With three in the same message there is no way to tell which one "+10 min" is about:
 * the alternative is a row of buttons per task, which in a chat is a menu, and a menu is
 * what stops being read. On a multiple alert the answer stays where it always was —"mueve
 * la basura a mañana"— and the model has `update_task` for that.
 *
 * The id travels in the `callback_data`, which is what keeps this from costing a KV write
 * per alert sent: see [tools/snooze.ts](../tools/snooze.ts).
 */
function snoozeKeyboard(tasks: TaskRow[]): InlineKeyboardButton[][] | undefined {
  if (tasks.length !== 1) return undefined;

  const task = tasks[0]!;
  return [
    SNOOZE_OPTIONS.map((option) => ({
      text: option.label,
      callback_data: snoozeData(task.id, option.code),
    })),
  ];
}

/** When this task is due to be announced: its own reminder, or its deadline. */
function alarmTime(task: TaskRow): number {
  const iso = task.remind_at ?? task.due_at;
  return iso ? new Date(iso).getTime() : 0;
}

/**
 * The alert's text, written the way a person would write it.
 *
 * The first version was a template —`Recordatorio: "X" venció a las 13:25`— and in the
 * chat it read like a system alarm: quotes around the title, the verb "expired" and the
 * time repeated even when it was the current one. An alert arriving at the requested time
 * is not a breach, so it is no longer announced as one.
 *
 * Composed here and not with the model: it costs zero tokens, it cannot invent a task,
 * and it does not depend on the LLM being available when the cron fires.
 */
const OPENERS = ['Acuérdate de', 'No te olvides de', 'Oye, acuérdate de', 'Recuerda'];

const COUNT_WORDS = ['', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'];

/** Margin within which the time is "now" and does not need saying. */
const IMMINENT_MS = 20 * 60 * 1000;

function buildReminderText(tasks: TaskRow[], timezone: string, now: Date): string {
  if (tasks.length === 1) {
    const task = tasks[0]!;
    const overdue = isOverdue(task, now);
    const when = whenSuffix(task, timezone, now);

    if (overdue) {
      return `Se te ha pasado ${lowerFirst(task.title)}${when ? `, era ${when}` : ''}.`;
    }

    // The opener is picked from the task's id: it varies between tasks and does not
    // change when the same alert repeats, which would read oddly.
    const opener = OPENERS[hash(task.id) % OPENERS.length]!;
    const connector = opener.endsWith('de') ? '' : ':';
    return `${opener}${connector} ${lowerFirst(task.title)}${when ? ` ${when}` : ''}.`;
  }

  const count = COUNT_WORDS[tasks.length] ?? String(tasks.length);
  return [
    `Tienes ${count} cosas encima:`,
    '',
    ...tasks.map((task) => {
      const when = whenSuffix(task, timezone, now);
      const mark = isOverdue(task, now) ? ' (se te ha pasado)' : '';
      return `- ${lowerFirst(task.title)}${when ? ` ${when}` : ''}${mark}`;
    }),
  ].join('\n');
}

function isOverdue(task: TaskRow, now: Date): boolean {
  return task.due_at !== null && new Date(task.due_at).getTime() < now.getTime() - IMMINENT_MS;
}

/**
 * "a las 18:00", "ayer a las 09:00", "el 20 de agosto a las 09:00" or nothing.
 *
 * It returns nothing when the time adds nothing: when it falls inside the right-now
 * margin, or when the title already carries it —"Llamar a David a las seis" with an "a
 * las 13:25" appended is more confusing than just the title.
 */
function whenSuffix(task: TaskRow, timezone: string, now: Date): string | null {
  if (!task.due_at) return null;
  if (/\ba\s+las?\s+/i.test(task.title)) return null;

  const due = new Date(task.due_at);
  if (Math.abs(due.getTime() - now.getTime()) <= IMMINENT_MS) return null;

  const day = localNow(due, timezone).date;
  const hour = formatTime(due, timezone);

  if (day === localNow(now, timezone).date) return `a las ${hour}`;
  if (day === localYesterday(now, timezone)) return `ayer a las ${hour}`;
  if (day === localTomorrow(now, timezone)) return `mañana a las ${hour}`;
  return `el ${formatDayAndTime(due, timezone)}`;
}

/** "Llamar a David" -> "llamar a David", which is how it reads inside a sentence. */
function lowerFirst(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

/** Cheap, stable hash. Only used to pick a phrase, nothing sensitive. */
function hash(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) total = (total + value.charCodeAt(i)) % 997;
  return total;
}
