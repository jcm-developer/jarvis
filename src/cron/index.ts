import { createDb } from '../agent';
import type { Config } from '../config';
import { listCronTargets } from '../db/identity';
import type { Deadline } from '../lib/deadline';
import { TelegramClient } from '../telegram/client';
import type { Env } from '../types';
import { sendBriefingIfDue } from './briefing';
import { sendEventAlerts } from './event-alerts';
import { runDueJobs } from './jobs';
import { sendDueReminders } from './reminders';
import { sendWeeklyReviewIfDue } from './review';

/**
 * What runs on every cron tick (every five minutes, in UTC).
 *
 * This is where the assistant stops being reactive: nobody wrote anything and yet it has
 * to decide whether to act. Most of what happens here does not go through the model at
 * all —the reminders come out of Supabase, the alerts and the briefing out of
 * the calendar— which is deliberate: zero tokens, nothing to invent, and no dependency on
 * the provider being up when the alarm goes off.
 *
 * The deferred jobs of phase 17 are the exception and run last, because summarising a page
 * is not something code can compose and it is the only thing here nobody is waiting on.
 *
 * The tick's hour says nothing on its own: the cron runs in UTC and what matters is each
 * user's local time, which `lib/localtime.ts` computes.
 */

/** With no room for a query and a send, better not to start on the next user. */
const MIN_ROOM_MS = 6_000;

export async function runScheduled(env: Env, config: Config, deadline: Deadline): Promise<void> {
  const started = Date.now();
  const now = new Date();

  const db = createDb(env);
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const targets = await listCronTargets(db, config.allowedTelegramIds, config.defaultTimezone);

  let reminded = 0;
  let announced = 0;
  let briefings = 0;
  let reviews = 0;
  let jobsDone = 0;
  let failures = 0;

  for (const target of targets) {
    if (!deadline.hasRoomFor(MIN_ROOM_MS)) {
      console.warn('cron: presupuesto agotado, quedan usuarios sin procesar');
      break;
    }

    // Each block carries its own try: one user's failing reminder must not leave the
    // rest without a briefing, nor that same user without the other half of their alert.
    //
    // A task falling due within the briefing's own hour shows up in both messages. That
    // is accepted: they are different things —planning the day and flagging what is
    // imminent— and suppressing the reminder would silence precisely the most urgent
    // thing of the day.
    try {
      reminded += await sendDueReminders({ db, telegram, target, now });
    } catch (error) {
      failures++;
      console.error(`cron: fallo en recordatorios de ${target.telegramId}:`, error);
    }

    // Between the reminders and the briefing on purpose: this is the only job of the
    // three that is time-critical to the minute —an appointment announced late is not an
    // appointment announced— so it does not queue behind the briefing's calendar read.
    try {
      announced += await sendEventAlerts({
        env,
        db,
        telegram,
        target,
        now,
        leadMinutes: config.eventAlertMinutes,
        deadline,
      });
    } catch (error) {
      failures++;
      console.error(`cron: fallo en los avisos de citas de ${target.telegramId}:`, error);
    }

    try {
      const sent = await sendBriefingIfDue({
        env,
        db,
        telegram,
        target,
        now,
        briefingHour: config.briefingHour,
        deadline,
      });
      if (sent) briefings++;
    } catch (error) {
      failures++;
      console.error(`cron: fallo en el briefing de ${target.telegramId}:`, error);
    }

    // After the briefing and before the jobs: it reads only Supabase, so it cannot be
    // held up by anybody else's outage, and on the other 2,015 ticks of the week it is
    // two comparisons and no query at all.
    try {
      const sent = await sendWeeklyReviewIfDue({
        env,
        db,
        telegram,
        target,
        now,
        reviewDay: config.reviewDay,
        reviewHour: config.reviewHour,
      });
      if (sent) reviews++;
    } catch (error) {
      failures++;
      console.error(`cron: fallo en el repaso semanal de ${target.telegramId}:`, error);
    }

    // Last, and it is the one job here nobody is waiting on: it takes whatever budget the
    // other three left and defers the rest to the next tick. Putting it any earlier would
    // mean a page download delaying an appointment alert, and an appointment announced
    // late is not an appointment announced.
    try {
      jobsDone += await runDueJobs({ env, config, db, telegram, target, now, deadline });
    } catch (error) {
      failures++;
      console.error(`cron: fallo en los trabajos de ${target.telegramId}:`, error);
    }
  }

  // One line per run. Nobody is watching the cron: unless the logs record that it ran
  // and did nothing, there is no way to tell that apart from it never running.
  console.info(
    JSON.stringify({
      event: 'cron_run',
      targets: targets.length,
      reminded_tasks: reminded,
      events_announced: announced,
      briefings_sent: briefings,
      reviews_sent: reviews,
      jobs_done: jobsDone,
      failures,
      duration_ms: Date.now() - started,
      budget_left_ms: deadline.remainingMs(),
    }),
  );
}
