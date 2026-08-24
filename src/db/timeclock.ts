import type { PunchAction } from '../timeclock/provider';
import type { Db } from './client';
import type { PunchRow, PunchScheduleRow } from './types';

/**
 * Persistence for the fichaje and imputación domains (phases 23-24).
 *
 * Everything here is deliberately dumb: no clock, no random, no decisions. The tick owns
 * the local day (lib/localtime.ts) and passes it in, because "today" is the one value in
 * this domain that must not be computed in two places — a schedule that fires against a
 * UTC day and a `fired_on` written against a local one would double-punch twice a year.
 */

/* -------------------------------- Schedules -------------------------------- */

export async function listSchedules(db: Db, userId: string): Promise<PunchScheduleRow[]> {
  return db.select<PunchScheduleRow>('punch_schedules', {
    filters: { user_id: `eq.${userId}` },
    order: 'at_time.asc',
  });
}

export interface NewSchedule {
  userId: string;
  action: PunchAction;
  /** Local 'HH:MM'. */
  atTime: string;
  offsetMin?: number;
  offsetMax?: number;
}

/**
 * Upsert and not insert: asking twice for the same punch at the same time is a repeated
 * instruction, not a second schedule. The unique key in the table is what makes it work.
 */
export async function saveSchedule(db: Db, schedule: NewSchedule): Promise<PunchScheduleRow> {
  return db.upsert<PunchScheduleRow>(
    'punch_schedules',
    {
      user_id: schedule.userId,
      action: schedule.action,
      at_time: schedule.atTime,
      enabled: true,
      ...(schedule.offsetMin !== undefined ? { offset_min: schedule.offsetMin } : {}),
      ...(schedule.offsetMax !== undefined ? { offset_max: schedule.offsetMax } : {}),
    },
    'user_id,action,at_time',
  );
}



/**
 * The "this column is not today" guard, as PostgREST needs it spelled.
 *
 * `col=not.eq.<day>` alone is a trap: it becomes `NOT (col = day)`, which is NULL —and
 * therefore no match— on a row that has never been stamped. That is exactly the row this
 * is meant to catch, so the null case has to be named explicitly.
 */
function notStampedToday(column: string, localDay: string): string {
  return `(${column}.is.null,${column}.neq.${localDay})`;
}

/**
 * Writes the offset drawn for a day, once, and answers whether this call did the writing.
 *
 * A row already rolled for today comes back empty and the caller keeps the value it read.
 * That is the point: the draw has to survive the five minutes to the next tick, or the
 * firing time moves under our feet.
 */
export async function drawDailyOffset(
  db: Db,
  id: string,
  localDay: string,
  offsetMinutes: number,
): Promise<PunchScheduleRow | null> {
  const rows = await db.update<PunchScheduleRow>(
    'punch_schedules',
    { id: `eq.${id}`, or: notStampedToday('offset_for', localDay) },
    { offset_minutes: offsetMinutes, offset_for: localDay },
  );
  return rows[0] ?? null;
}

/**
 * Marks the row as fired for a local day, and answers whether this call is the one that
 * did it.
 *
 * `fired_on=not.eq.<day>` in the filter is the same trick the job queue claims rows with
 * (§16): the update is atomic per row, so two overlapping ticks cannot both get a row
 * back, and only the winner sends the punch. Without it a slow tick punches twice, and a
 * double punch on a legal record is the one failure here that cannot be undone from the
 * chat.
 */
export async function claimScheduleForDay(
  db: Db,
  id: string,
  localDay: string,
): Promise<boolean> {
  const rows = await db.update<PunchScheduleRow>(
    'punch_schedules',
    { id: `eq.${id}`, or: notStampedToday('fired_on', localDay) },
    { fired_on: localDay },
  );
  return rows.length > 0;
}

/**
 * Gives the day back, so the next tick tries again.
 *
 * Only for failures that certainly happened BEFORE the portal was written to —it did not
 * answer, the credentials are wrong— never for the ones where the outcome is unknown. A
 * released claim is a second punch waiting to happen if the first one actually landed.
 */
export async function releaseSchedule(db: Db, id: string): Promise<void> {
  await db.update<PunchScheduleRow>('punch_schedules', { id: `eq.${id}` }, { fired_on: null });
}

/**
 * The working day, created the first time it is needed.
 *
 * In code and not as a SQL seed because a seed runs before the user row exists —the users
 * table is written on the first message— and would silently insert nothing. It only fires
 * when there is not a single schedule for the user, so a row disabled on purpose is never
 * resurrected.
 */
export async function seedSchedules(
  db: Db,
  userId: string,
  defaults: readonly { action: PunchAction; atTime: string }[],
): Promise<PunchScheduleRow[]> {
  const existing = await listSchedules(db, userId);
  if (existing.length > 0) return existing;

  for (const entry of defaults) {
    await saveSchedule(db, { userId, action: entry.action, atTime: entry.atTime });
  }
  console.info(`timeclock: default schedule created for ${userId}`);
  return listSchedules(db, userId);
}

/* --------------------------------- Punches --------------------------------- */

export interface NewPunch {
  userId: string;
  action: PunchAction;
  source: 'auto' | 'manual';
  registeredAt: string | null;
  localDay: string;
}

export async function logPunch(db: Db, punch: NewPunch): Promise<PunchRow> {
  return db.insert<PunchRow>('punches', {
    user_id: punch.userId,
    action: punch.action,
    source: punch.source,
    registered_at: punch.registeredAt,
    local_day: punch.localDay,
  });
}

/** What we know we punched today. The portal knows the rest, including what the user did. */
export async function listPunchesForDay(
  db: Db,
  userId: string,
  localDay: string,
): Promise<PunchRow[]> {
  return db.select<PunchRow>('punches', {
    filters: { user_id: `eq.${userId}`, local_day: `eq.${localDay}` },
    order: 'punched_at.asc',
  });
}
