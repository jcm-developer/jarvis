import type { Project } from '../ficha/provider';
import type { PunchAction } from '../ficha/provider';
import type { Db } from './client';
import type { ImputationRow, ProjectCacheRow, PunchScheduleRow } from './types';

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

/** Only what the tick has to look at: disabled rows never reach the firing rule. */
export async function listEnabledSchedules(db: Db, userId: string): Promise<PunchScheduleRow[]> {
  return db.select<PunchScheduleRow>('punch_schedules', {
    filters: { user_id: `eq.${userId}`, enabled: 'is.true' },
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

export async function setScheduleEnabled(
  db: Db,
  userId: string,
  id: string,
  enabled: boolean,
): Promise<PunchScheduleRow | null> {
  const rows = await db.update<PunchScheduleRow>(
    'punch_schedules',
    { id: `eq.${id}`, user_id: `eq.${userId}` },
    { enabled },
  );
  return rows[0] ?? null;
}

export async function deleteSchedule(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db.delete<PunchScheduleRow>('punch_schedules', {
    id: `eq.${id}`,
    user_id: `eq.${userId}`,
  });
  return rows.length > 0;
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

/* ------------------------------- Imputations ------------------------------- */

export interface NewImputation {
  userId: string;
  project: string;
  task?: string | null;
  hours: number;
  comment: string;
  workDate: string;
  dayAdvanced: boolean;
  source: 'voice' | 'text';
}

/** Append-only on purpose: this is a log of what was sent to somebody else's system. */
export async function logImputation(db: Db, entry: NewImputation): Promise<ImputationRow> {
  return db.insert<ImputationRow>('imputations', {
    user_id: entry.userId,
    project: entry.project,
    task: entry.task ?? null,
    hours: entry.hours,
    comment: entry.comment,
    work_date: entry.workDate,
    day_advanced: entry.dayAdvanced,
    source: entry.source,
  });
}

/** For the day view and for the streak. Newest first, capped: nobody reads further back. */
export async function listImputations(
  db: Db,
  userId: string,
  sinceIso: string,
  limit = 100,
): Promise<ImputationRow[]> {
  return db.select<ImputationRow>('imputations', {
    filters: { user_id: `eq.${userId}`, logged_at: `gte.${sinceIso}` },
    order: 'logged_at.desc',
    limit,
  });
}

/* ------------------------------ Project cache ------------------------------ */

/**
 * The day's project table, as scraped by the tick.
 *
 * The turn reads this and never the site: a login plus a scrape does not fit next to
 * three model rounds in 27 s (§11), and a project list that arrives after the answer is
 * the same as no project list.
 */
export async function saveProjectCache(
  db: Db,
  userId: string,
  day: string,
  projects: Project[],
): Promise<void> {
  await db.upsert<ProjectCacheRow>(
    'ficha_projects',
    { user_id: userId, day, projects, scraped_at: new Date().toISOString() },
    'user_id,day',
  );
}

export async function readProjectCache(
  db: Db,
  userId: string,
  day: string,
): Promise<ProjectCacheRow | null> {
  const rows = await db.select<ProjectCacheRow>('ficha_projects', {
    filters: { user_id: `eq.${userId}`, day: `eq.${day}` },
    limit: 1,
  });
  return rows[0] ?? null;
}
