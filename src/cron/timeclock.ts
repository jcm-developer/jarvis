import type { Db } from '../db/client';
import {
  claimScheduleForDay,
  drawDailyOffset,
  logPunch,
  releaseSchedule,
  seedSchedules,
} from '../db/timeclock';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { PunchScheduleRow } from '../db/types';
import { createPunchClient, punchConfigured } from '../timeclock';
import { ACTION_NAMES, TimeclockError, type PunchAction } from '../timeclock/provider';
import type { Deadline } from '../lib/deadline';
import { localNow } from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import type { Env } from '../types';

/**
 * The scheduled punches (phase 22).
 *
 * This is the first thing in this project that writes to a system outside our control on
 * its own initiative, and every decision here follows from that. Two of them are worth
 * stating up front:
 *
 * - **It does not go through the job queue**, unlike every other slow external call. A
 *   job is by definition the one thing nobody is waiting for (§16) and can sit for five
 *   minutes; a punch has to land on the minute it was told to. So it runs inside the tick
 *   and takes its slice of the budget like the appointment alerts do.
 * - **The portal is the source of truth, not our table.** The user can clock in from the
 *   web whenever they like, and the site only ever offers the action that comes next. So
 *   "already punched" is not something we track: it is what the page tells us, and the
 *   automation stays quiet and waits for the next stage.
 */

/**
 * The working day, created the first time the tick runs for a user.
 *
 * These four times are the user's actual day. They are a seed and not a constant the code
 * reads every tick: from the first run on, the rows in Supabase are what count, so a time
 * can be changed there without a deploy.
 */
export const WORKDAY: readonly { action: PunchAction; atTime: string }[] = [
  { action: 'clock_in', atTime: '09:00' },
  { action: 'break_start', atTime: '14:00' },
  { action: 'break_end', atTime: '15:00' },
  { action: 'clock_out', atTime: '18:00' },
];

/**
 * Cap for one punch: three requests against somebody else's portal.
 *
 * It is a big slice of the tick's 25 s, which is why this runs before the briefing and
 * why the budget is checked before claiming anything rather than after.
 */
const MAX_PUNCH_MS = 12_000;

/**
 * Below this the punch is not even claimed.
 *
 * Same lesson the job queue paid for: claiming and then running out of budget spends the
 * day's only attempt without ever reaching the portal.
 */
const MIN_PUNCH_MS = 9_000;

/**
 * How late a punch may still go out.
 *
 * A punch at 09:00 that lands at 09:22 because the portal was down is fine. At 11:00 it
 * is a lie, and one written on a legal record. Past the window the day is closed and the
 * user is told, which is the only honest ending.
 */
const GIVE_UP_MINUTES = 30;

export interface PunchRunDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  deadline: Deadline;
}

/** Returns how many punches actually went out. */
export async function runScheduledPunches(deps: PunchRunDeps): Promise<number> {
  const { env, db, target, now, deadline } = deps;
  if (!punchConfigured(env)) return 0;

  const local = localNow(now, target.timezone);
  // Monday to Friday. Holidays are not in here and cannot be: nobody told us the calendar
  // of somebody else's company. On a holiday the portal simply will not offer the button
  // and the punch is skipped as "another stage", which is the safe direction.
  if (isWeekend(local.date)) return 0;

  const enabled = (await seedSchedules(db, target.userId, WORKDAY)).filter((row) => row.enabled);

  const nowMinutes = local.hour * 60 + local.minute;
  let punched = 0;

  for (const schedule of enabled) {
    if (schedule.fired_on === local.date) continue;

    const offset = await offsetForToday(db, schedule, local.date);
    if (offset === null) continue;

    const atMinutes = parseAtTime(schedule.at_time);
    if (atMinutes === null) {
      console.error(`timeclock: invalid at_time on ${schedule.id}: ${schedule.at_time}`);
      continue;
    }

    const fireAt = atMinutes + offset;
    if (nowMinutes < fireAt) continue;

    if (nowMinutes > fireAt + GIVE_UP_MINUTES) {
      await giveUp(schedule, local.date, deps);
      continue;
    }

    // Checked before claiming, never after: see MIN_PUNCH_MS.
    if (!deadline.hasRoomFor(MIN_PUNCH_MS)) break;

    // The claim is what stops two overlapping ticks from punching twice, and a double
    // punch is the one failure here that cannot be undone from the chat.
    if (!(await claimScheduleForDay(db, schedule.id, local.date))) continue;

    if (await attempt(schedule, local.date, deps)) punched++;
  }

  return punched;
}

/**
 * One punch, with the four endings it can have.
 *
 * The branching is not defensive programming: each kind of failure has a different right
 * answer, and getting them wrong means either a silent day or a duplicate punch.
 */
async function attempt(
  schedule: PunchScheduleRow,
  localDay: string,
  deps: PunchRunDeps,
): Promise<boolean> {
  const { env, db, target, deadline } = deps;

  try {
    const result = await createPunchClient(env).punch(schedule.action, {
      timeoutMs: deadline.budgetFor(MAX_PUNCH_MS),
    });

    await logPunch(db, {
      userId: target.userId,
      action: schedule.action,
      source: 'auto',
      registeredAt: result.registeredAt,
      localDay,
    });

    const when = result.registeredAt
      ? `a las ${result.registeredAt}`
      : 'ahora mismo (el portal no ha dicho la hora)';
    await announce(`Fichada ${`la ${ACTION_NAMES[schedule.action]}`} ${when}.`, deps);
    return true;
  } catch (error) {
    if (!(error instanceof TimeclockError)) throw error;

    switch (error.kind) {
      case 'not_available':
        // The stage is already done —almost always because the user punched it themselves
        // from the web— or its turn has not come. Exactly what was asked for: touch
        // nothing and wait for the next stage. Silent on purpose: there is nothing to
        // tell, and a message per skipped stage is how a bot gets muted.
        console.info(`timeclock: ${schedule.action} not due (${error.message})`);
        return false;

      case 'upstream':
        // Nothing was written: the portal never answered. The day goes back so the next
        // tick tries again, still inside the 30 minute window.
        await releaseSchedule(db, schedule.id);
        console.warn(`timeclock: ${schedule.action} retryable: ${error.message}`);
        return false;

      default: {
        // auth, config, parse, refused, unverified: none of them get better by trying again, and
        // 'unverified' must NOT be retried —it is the case where the punch may already
        // have landed. The day stays closed and a human is told.
        console.error(`timeclock: ${schedule.action} failed (${error.kind}): ${error.message}`);
        await announce(
          `No he podido fichar ${`la ${ACTION_NAMES[schedule.action]}`}: ${error.userMessage}`,
          deps,
        );
        return false;
      }
    }
  }
}

/**
 * The window closed without the punch going out.
 *
 * The claim is taken first so this is said once and not on every tick for the rest of the
 * day, and it is said at all because the alternative —a working day with a hole in it and
 * nobody warned— is the failure this whole feature exists to prevent.
 */
async function giveUp(
  schedule: PunchScheduleRow,
  localDay: string,
  deps: PunchRunDeps,
): Promise<void> {
  if (!(await claimScheduleForDay(deps.db, schedule.id, localDay))) return;
  console.warn(`timeclock: window missed for ${schedule.action} (${schedule.at_time})`);
  await announce(
    `No he fichado ${`la ${ACTION_NAMES[schedule.action]}`} de las ${schedule.at_time} y ya es tarde ` +
      'para hacerlo por mi cuenta. Fíchalo tú o dime que lo intente.',
    deps,
  );
}

/**
 * The offset for today, drawn once and written down.
 *
 * Re-drawing it on every tick would fire on the first tick whose draw happens to pass,
 * pinning every day to the earliest edge of the window and defeating the point of having
 * one. Null means another tick is drawing it right now: the next tick will read it.
 */
async function offsetForToday(
  db: Db,
  schedule: PunchScheduleRow,
  localDay: string,
): Promise<number | null> {
  if (schedule.offset_for === localDay) return schedule.offset_minutes ?? 0;

  const span = schedule.offset_max - schedule.offset_min;
  const drawn = schedule.offset_min + Math.round(Math.random() * Math.max(0, span));
  const updated = await drawDailyOffset(db, schedule.id, localDay, drawn);
  return updated?.offset_minutes ?? null;
}

/** The message plus its copy in the history, so the model knows what it already said. */
async function announce(text: string, deps: PunchRunDeps): Promise<void> {
  const { db, telegram, target } = deps;
  try {
    await telegram.sendMessage(target.chatId, text);
    await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);
  } catch (error) {
    console.error('timeclock: could not announce the punch:', error);
  }
}

/** 'HH:MM' to minutes since midnight, or null when the row is malformed. */
function parseAtTime(atTime: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(atTime);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

/**
 * Saturday or Sunday, from the local date string.
 *
 * Built as a UTC instant on purpose: the string is already a local day, so adding a zone
 * to it a second time is how a Friday night becomes a Saturday.
 */
function isWeekend(localDate: string): boolean {
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
