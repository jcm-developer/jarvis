import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow, ToolCallLogRow } from '../db/types';
import {
  formatDay,
  formatShortDateTime,
  localNow,
  localWeekday,
  shiftDate,
  startOfLocalDay,
  zonedInstant,
} from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import type { Env } from '../types';

/**
 * The weekly review (phase 13): what you closed, what is still open, and what you have
 * been putting off.
 *
 * The first two are the polite half and any task app shows them. The third is the one
 * worth sending: nothing else in the system ever says out loud "you have moved this four
 * times since the 2nd". It is also the only number here that could not be computed until
 * now — `tasks.updated_at` cannot tell moving a date apart from fixing a title.
 *
 * **Where the postponements come from.** `tool_call_logs`, which has stored every
 * `update_task` with its arguments since phase 2 and was write-only until today. Reading
 * it is what makes this phase cost no new column and no new write per message. The
 * counterpart is that the log is the only record: what is not in it did not happen as far
 * as this message is concerned, which is why `applySnooze` now writes a row of its own.
 *
 * **Composed in code, like the briefing and for the same reason.** The model would add
 * cost, latency and the chance of inventing a task that is not on the list. A review has
 * to be boring and exact; the uncomfortable part is the data, not the wording.
 */

/** The marker expires on its own, like the briefing's. */
const MARKER_TTL_SECONDS = 604_800; // 7 días

/**
 * Width of the sending window, in hours.
 *
 * Same reasoning as the briefing's and a wider margin: a missed tick on a weekly job does
 * not mean a late message, it means no message until next Sunday.
 */
const WINDOW_HOURS = 4;

/**
 * How far back postponements are counted, in days.
 *
 * Deliberately longer than the week the rest of the message covers: "you have been
 * putting this off" is not a thing that happens inside seven days, and a task moved once
 * last Tuesday is not news. Four weeks is what makes the line worth reading.
 */
const POSTPONE_WINDOW_DAYS = 28;

/**
 * Times something has to be moved before it is named.
 *
 * Two, not three. Below that this is a bot nagging about a task that slipped once, which
 * is how the whole message ends up muted.
 */
const MIN_POSTPONEMENTS = 2;

/** Caps on what the message lists. A review nobody scrolls is a review that gets read. */
const MAX_CLOSED_LISTED = 5;
const MAX_OVERDUE_LISTED = 3;
const MAX_STALLED_LISTED = 5;

/**
 * Log rows read per query.
 *
 * A week of one person's completions and a month of their postponements are tens of rows,
 * not hundreds. The cap is there so a runaway loop in some future tool cannot turn this
 * into a huge response; if it is ever hit, the counts read low and the log line says so.
 */
const MAX_LOG_ROWS = 200;

/** The tool calls that mean "this moved": said out loud, or pressed on a button. */
const POSTPONE_TOOLS = ['update_task', 'snooze'];

/** Arguments that make an `update_task` a postponement and not a rename. */
const DATE_FIELDS = ['due_at', 'due_in_minutes', 'remind_at', 'remind_in_minutes'];

export interface ReviewDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  reviewDay: number;
  reviewHour: number;
}

/** Returns true when it was sent. */
export async function sendWeeklyReviewIfDue(deps: ReviewDeps): Promise<boolean> {
  const { env, db, telegram, target, now, reviewDay, reviewHour } = deps;

  if (localWeekday(now, target.timezone) !== reviewDay) return false;

  const local = localNow(now, target.timezone);
  const hoursLate = local.hour - reviewHour;
  if (hoursLate < 0 || hoursLate >= WINDOW_HOURS) return false;

  const marker = `review:${target.userId}:${local.date}`;
  if (await env.STATE.get(marker)) return false;

  // The week is the seven local days ending tonight, so a review that goes out three
  // hours late still covers the same seven days and not a sliding 168 hours.
  const weekStart = startOfLocalDay(now, target.timezone).getTime() - 6 * 24 * 60 * 60 * 1000;
  const weekStartIso = new Date(weekStart).toISOString();
  const postponeStartIso = localDayStart(local.date, -POSTPONE_WINDOW_DAYS, target.timezone, now);

  const [closed, postponements, pending] = await Promise.all([
    readLogs(db, target.conversationId, ['complete_task'], weekStartIso),
    readLogs(db, target.conversationId, POSTPONE_TOOLS, postponeStartIso),
    db.select<TaskRow>('tasks', {
      filters: { user_id: `eq.${target.userId}`, status: 'eq.pending', kind: 'eq.task' },
      order: 'due_at.asc.nullslast,priority.asc',
      limit: 100,
    }),
  ]);

  const text = buildReviewText({
    closed: closedTitles(closed),
    stalled: stalledTasks(postponements, pending),
    pending,
    weekStart: new Date(weekStart),
    now,
    timezone: target.timezone,
  });

  await telegram.sendMessage(target.chatId, text);

  // After sending, like the briefing: a Telegram failure has to leave the next tick
  // inside the window able to retry.
  await env.STATE.put(marker, '1', { expirationTtl: MARKER_TTL_SECONDS });
  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return true;
}

/**
 * The local midnight `days` away from a local date.
 *
 * Through `shiftDate` and `zonedInstant` rather than subtracting milliseconds: four weeks
 * back crosses a clock change twice a year, and an hour of drift there would silently
 * move the window's edge.
 */
function localDayStart(date: string, days: number, timezone: string, fallback: Date): string {
  const shifted = zonedInstant(shiftDate(date, days), 0, 0, timezone);
  return (shifted ?? new Date(fallback.getTime() - Math.abs(days) * 86_400_000)).toISOString();
}

async function readLogs(
  db: Db,
  conversationId: string,
  tools: string[],
  since: string,
): Promise<ToolCallLogRow[]> {
  return db.select<ToolCallLogRow>('tool_call_logs', {
    columns: 'id,tool_name,arguments,result,created_at',
    filters: {
      conversation_id: `eq.${conversationId}`,
      success: 'is.true',
      tool_name: `in.(${tools.join(',')})`,
      created_at: `gte.${since}`,
    },
    order: 'created_at.asc',
    limit: MAX_LOG_ROWS,
  });
}

/**
 * What was closed, by title and without repeats.
 *
 * Read from the log and not from `tasks.completed_at` because of what repeats: completing
 * "sacar la basura" rolls the row forward instead of closing it (§12), so a week of bins
 * would show up as zero. The dedupe is by title for the same reason —the same weekly task
 * completed twice in seven days is one line, not two— and the count is of lines, which is
 * the number a person would give if asked.
 */
function closedTitles(logs: ToolCallLogRow[]): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (const log of logs) {
    const title = readTitle(log);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

interface Stalled {
  title: string;
  times: number;
  since: Date;
}

/**
 * What has been moved more than once and is still open.
 *
 * Still open is half the rule: something postponed three times and then done is a story
 * with an ending, and naming it in a review is nagging about work already finished. The
 * cross-check is against the pending list by id, which is also what keeps a deleted task
 * out of the message.
 */
function stalledTasks(logs: ToolCallLogRow[], pending: TaskRow[]): Stalled[] {
  const openById = new Map(pending.map((task) => [task.id, task]));
  const counts = new Map<string, { times: number; since: Date; title: string }>();

  for (const log of logs) {
    if (!isPostponement(log)) continue;

    const taskId = typeof log.arguments?.['task_id'] === 'string' ? log.arguments['task_id'] : null;
    if (!taskId) continue;

    const task = openById.get(taskId);
    if (!task) continue;

    const entry = counts.get(taskId);
    if (entry) {
      entry.times++;
    } else {
      // The title comes from the task as it is NOW, not from the logged result: a task
      // renamed after being postponed has to be named the way the user would recognise it
      // today.
      counts.set(taskId, { times: 1, since: new Date(log.created_at), title: task.title });
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.times >= MIN_POSTPONEMENTS)
    .sort((left, right) => right.times - left.times)
    .slice(0, MAX_STALLED_LISTED)
    .map((entry) => ({ title: entry.title, times: entry.times, since: entry.since }));
}

/**
 * Whether a logged call actually moved a date.
 *
 * `snooze` always did —it is the only thing that call does— while `update_task` is the
 * tool for renaming, reprioritising and closing as well. Counting every `update_task`
 * would turn "I fixed a typo in the title" into "you have been putting this off", which
 * is the kind of wrong that makes the whole message untrustworthy.
 */
function isPostponement(log: ToolCallLogRow): boolean {
  if (log.tool_name === 'snooze') return true;
  if (log.tool_name !== 'update_task') return false;

  const args = log.arguments ?? {};
  return DATE_FIELDS.some((field) => args[field] !== undefined && args[field] !== null);
}

function readTitle(log: ToolCallLogRow): string | null {
  const title = log.result?.['title'];
  return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
}

interface ReviewText {
  closed: string[];
  stalled: Stalled[];
  pending: TaskRow[];
  weekStart: Date;
  now: Date;
  timezone: string;
}

export function buildReviewText(input: ReviewText): string {
  const { closed, stalled, pending, weekStart, now, timezone } = input;

  const overdue = pending.filter(
    (task) => task.due_at !== null && new Date(task.due_at).getTime() < now.getTime(),
  );

  const lines = [
    `Repaso de la semana, del ${formatDay(weekStart, timezone)} al ${formatDay(now, timezone)}.`,
    '',
  ];

  if (closed.length > 0) {
    lines.push(`Cerradas: ${closed.length}.`);
    for (const title of closed.slice(0, MAX_CLOSED_LISTED)) lines.push(`- ${title}`);
    const rest = closed.length - MAX_CLOSED_LISTED;
    if (rest > 0) lines.push(`- y ${rest} más.`);
  } else {
    // Said plainly and without softening it. A review that finds a nice way to phrase a
    // week with nothing closed is a review that stops meaning anything.
    lines.push('Cerradas: ninguna esta semana.');
  }

  lines.push('');
  if (pending.length === 0) {
    lines.push('No te queda nada pendiente.');
  } else if (overdue.length > 0) {
    const plural = overdue.length === 1 ? 'vencida' : 'vencidas';
    lines.push(`Pendientes: ${pending.length}, y ${overdue.length} ya ${plural}:`);
    for (const task of overdue.slice(0, MAX_OVERDUE_LISTED)) {
      lines.push(`- ${task.title} (${formatShortDateTime(new Date(task.due_at!), timezone)})`);
    }
    const rest = overdue.length - MAX_OVERDUE_LISTED;
    if (rest > 0) lines.push(`- y ${rest} vencida${rest === 1 ? '' : 's'} más.`);
  } else {
    lines.push(`Pendientes: ${pending.length}, ninguna vencida.`);
  }

  if (stalled.length > 0) {
    lines.push('', 'Llevas aplazando:');
    for (const entry of stalled) {
      lines.push(
        `- ${entry.title}: ${entry.times} veces desde el ${formatDay(entry.since, timezone)}.`,
      );
    }
  }

  return lines.join('\n');
}
