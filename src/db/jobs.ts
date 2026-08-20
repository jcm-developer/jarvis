import type { Db } from './client';
import type { JobRow } from './types';

/**
 * The deferred-job queue (phase 17).
 *
 * The queue exists because some work does not fit inside a message and never will:
 * downloading a page is seconds of somebody else's latency, and the turn has 27 s to
 * cover the model as well. So the turn writes a row and the cron does the work.
 *
 * Nobody is watching this table, which is what makes it different from everything else
 * in the project. A tool that fails tells the model, and the model tells the user; a job
 * that fails silently is just a promise never kept. Hence the attempt counter, the dead
 * state and the recovery of rows left mid-flight.
 */

/** After this many tries the job is dead and stops costing ticks. */
const MAX_ATTEMPTS = 3;

/**
 * How long a claimed row may stay 'running' before it is considered abandoned.
 *
 * This is the case `waitUntil()` makes real: Cloudflare cancels the tick without an
 * exception, so the row keeps the state the code never got to change. Generous against
 * the cron's five-minute period, because reclaiming a job that is still running would
 * fetch the same URL twice.
 */
const STALE_MS = 15 * 60 * 1000;

export interface NewJob {
  userId: string;
  kind: JobRow['kind'];
  payload: Record<string, unknown>;
}

/** Queued from inside a turn. The answer arrives on some later tick. */
export async function enqueueJob(db: Db, job: NewJob): Promise<JobRow> {
  return db.insert<JobRow>('jobs', {
    user_id: job.userId,
    kind: job.kind,
    payload: job.payload,
  });
}

/**
 * Takes up to `limit` eligible jobs and marks them as running.
 *
 * Two steps because PostgREST cannot open a transaction: a select for the candidates and
 * one conditional update per row. The condition is the whole point — `state=eq.pending`
 * in the filter means the update only touches a row nobody else has taken, and a loser
 * gets an empty array back rather than a second copy of the same job. Without a
 * transaction that is as close to a real claim as this client gets.
 *
 * `attempts` is incremented HERE and not when the job finishes. A job whose fetch hangs
 * long enough to get the whole tick cancelled would otherwise never count a try, and a
 * URL that always times out would be retried for ever, every five minutes.
 */
export async function claimJobs(
  db: Db,
  userId: string,
  now: Date,
  limit: number,
): Promise<JobRow[]> {
  const candidates = await db.select<JobRow>('jobs', {
    filters: {
      user_id: `eq.${userId}`,
      state: 'eq.pending',
      run_after: `lte.${now.toISOString()}`,
    },
    order: 'run_after.asc',
    limit,
  });

  const claimed: JobRow[] = [];
  for (const candidate of candidates) {
    const rows = await db.update<JobRow>(
      'jobs',
      { id: `eq.${candidate.id}`, state: 'eq.pending' },
      {
        state: 'running',
        started_at: now.toISOString(),
        attempts: candidate.attempts + 1,
      },
    );
    const row = rows[0];
    if (row) claimed.push(row);
  }

  return claimed;
}

/**
 * Returns rows abandoned mid-flight to the queue.
 *
 * Runs before claiming, and it is not a nicety: without it a single cancelled tick
 * leaves the job 'running' for ever, and "I'll tell you later" becomes a lie with no
 * trace in the logs. One that has used up its attempts goes straight to dead — it has
 * already had its tries, and one of them took the tick down with it.
 */
export async function recoverStaleJobs(db: Db, userId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();

  const stale = await db.select<JobRow>('jobs', {
    filters: {
      user_id: `eq.${userId}`,
      state: 'eq.running',
      started_at: `lte.${cutoff}`,
    },
    limit: 20,
  });
  if (stale.length === 0) return 0;

  const exhausted = stale.filter((job) => job.attempts >= MAX_ATTEMPTS).map((job) => job.id);
  const retryable = stale.filter((job) => job.attempts < MAX_ATTEMPTS).map((job) => job.id);

  const writes: Promise<unknown>[] = [];
  if (exhausted.length > 0) {
    writes.push(
      db.update(
        'jobs',
        { id: `in.(${exhausted.join(',')})` },
        { state: 'dead', last_error: 'el trabajo se quedó a medias y ya no le quedaban intentos' },
      ),
    );
  }
  if (retryable.length > 0) {
    writes.push(
      db.update(
        'jobs',
        { id: `in.(${retryable.join(',')})` },
        { state: 'pending', started_at: null, run_after: now.toISOString() },
      ),
    );
  }
  await Promise.all(writes);

  console.warn(`jobs: ${stale.length} recuperados de un tick que se quedó a medias`);
  return stale.length;
}

/** The job is done and will not run again. */
export async function finishJob(db: Db, jobId: string): Promise<void> {
  await db.update('jobs', { id: `eq.${jobId}` }, { state: 'done', last_error: null });
}

/**
 * The job failed in a way another attempt cannot fix, so it gives up now.
 *
 * Separate from `failJob` because the two failures are not the same shape: a site that
 * is down deserves another go, and a 404 will still be a 404 in ten minutes. Retrying
 * what cannot change is three wasted ticks and a message half an hour late.
 */
export async function killJob(db: Db, jobId: string, error: string): Promise<void> {
  await db.update('jobs', { id: `eq.${jobId}` }, { state: 'dead', last_error: error.slice(0, 500) });
}

/**
 * The job failed. It either waits for another go or gives up for good.
 *
 * The backoff grows with the attempt because the usual reason for a failure here is a
 * site that is down or rate-limiting us, and hammering it on the very next tick is how a
 * temporary block turns into a permanent one.
 */
export async function failJob(
  db: Db,
  job: JobRow,
  error: string,
  now: Date,
): Promise<'retry' | 'dead'> {
  const detail = error.slice(0, 500);

  if (job.attempts >= MAX_ATTEMPTS) {
    await db.update('jobs', { id: `eq.${job.id}` }, { state: 'dead', last_error: detail });
    return 'dead';
  }

  const backoffMs = job.attempts * 10 * 60 * 1000;
  await db.update(
    'jobs',
    { id: `eq.${job.id}` },
    {
      state: 'pending',
      started_at: null,
      last_error: detail,
      run_after: new Date(now.getTime() + backoffMs).toISOString(),
    },
  );
  return 'retry';
}
