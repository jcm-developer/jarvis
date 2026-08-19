import { createDb } from '../agent';
import type { Config } from '../config';
import { listCronTargets } from '../db/identity';
import type { Deadline } from '../lib/deadline';
import { TelegramClient } from '../telegram/client';
import type { Env } from '../types';
import { sendBriefingIfDue } from './briefing';
import { sendDueReminders } from './reminders';

/**
 * What runs on every cron tick (every five minutes, in UTC).
 *
 * This is where the assistant stops being reactive: nobody wrote anything and yet it has
 * to decide whether to speak. Both decisions —briefing and reminders— are made from
 * Supabase data, not with the model.
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
  let briefings = 0;
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

    try {
      const sent = await sendBriefingIfDue({
        env,
        db,
        telegram,
        target,
        now,
        briefingHour: config.briefingHour,
      });
      if (sent) briefings++;
    } catch (error) {
      failures++;
      console.error(`cron: fallo en el briefing de ${target.telegramId}:`, error);
    }
  }

  // One line per run. Nobody is watching the cron: unless the logs record that it ran
  // and did nothing, there is no way to tell that apart from it never running.
  console.info(
    JSON.stringify({
      event: 'cron_run',
      targets: targets.length,
      reminded_tasks: reminded,
      briefings_sent: briefings,
      failures,
      duration_ms: Date.now() - started,
      budget_left_ms: deadline.remainingMs(),
    }),
  );
}
