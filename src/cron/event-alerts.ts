import { createCalendarClient } from '../calendar';
import type { CalendarEventSummary } from '../calendar/provider';
import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { Deadline } from '../lib/deadline';
import { eventLabel, timedEvents } from '../lib/events';
import { formatTime } from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import { MIN_CALENDAR_MS } from '../tools/calendar';
import type { Env } from '../types';

/**
 * The heads-up before an appointment.
 *
 * Google Calendar already sends its own notifications, and that is precisely the reason
 * this exists: they arrive wherever the calendar is installed, while everything else
 * this assistant knows —the tasks, what was agreed in the chat, the answer to "move it
 * an hour"— lives in Telegram. An appointment that only warns you somewhere else is the
 * one thing you have to keep two apps open for.
 *
 * The alert does NOT replace Google's: §13 already says our cron cannot promise an
 * event's reminder, because that one belongs to the calendar's own settings. This is a
 * second, separate ping, and the prompt still forbids the model from promising it.
 */

/** Cap for the calendar read. Same reasoning as the briefing's: it runs unattended. */
const CALENDAR_MAX_MS = 6_000;

/** Appointments read per tick. The window is minutes wide; there are never more. */
const EVENT_LIMIT = 10;

/**
 * How long the "already warned" marker lives.
 *
 * It only has to outlive its own window —the alert goes out once, minutes before— so
 * six hours is already generous. It expires on its own: nothing to clean up.
 */
const MARKER_TTL_SECONDS = 21_600; // 6 h

export interface EventAlertDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  /** Minutes of notice. 0 disables the job. */
  leadMinutes: number;
  deadline: Deadline;
}

/** Returns how many appointments were announced. */
export async function sendEventAlerts(deps: EventAlertDeps): Promise<number> {
  const { env, db, telegram, target, now, leadMinutes, deadline } = deps;

  if (leadMinutes <= 0) return 0;

  const budget = deadline.budgetFor(CALENDAR_MAX_MS);
  if (budget < MIN_CALENDAR_MS) return 0;

  // The window is the notice itself, not the day: reading four hours of calendar every
  // five minutes to announce what happens in the next fifteen would be 288 pointless
  // reads a day. Google returns whatever overlaps the range, so an appointment already
  // under way comes back too and is dropped below.
  const until = new Date(now.getTime() + leadMinutes * 60_000);

  let events: CalendarEventSummary[];
  try {
    const client = createCalendarClient(env);
    events = await client.listEvents(
      { from: now.toISOString(), to: until.toISOString(), query: null, limit: EVENT_LIMIT },
      budget,
    );
  } catch (error) {
    // Same rule as everywhere else the calendar is read from the cron: it costs its own
    // job and nothing else. The reminders and the briefing have already gone out, or
    // will, from their own `try`.
    console.warn(
      JSON.stringify({
        event: 'event_alerts_failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return 0;
  }

  // An appointment that has already started is not a warning, it is a reproach: the user
  // is in the meeting, or decided not to be.
  const upcoming = timedEvents(events).filter(
    (event) => Date.parse(event.startAt!) >= now.getTime(),
  );
  if (upcoming.length === 0) return 0;

  const fresh: CalendarEventSummary[] = [];
  for (const event of upcoming) {
    if (await env.STATE.get(markerKey(target.userId, event))) continue;
    fresh.push(event);
  }
  if (fresh.length === 0) return 0;

  const text = buildAlertText(fresh, target.timezone, now);
  await telegram.sendMessage(target.chatId, text);

  // Written after sending, like `reminded_at` in the reminders: if Telegram fails, no
  // marker is stored and the next tick tries again. The other way round, a 500 would
  // turn into an alert that never arrives.
  //
  // One KV write per appointment announced —a handful a day— and none per tick, which is
  // what keeps this inside the 1,000 writes of the free plan.
  await Promise.all(
    fresh.map((event) =>
      env.STATE.put(markerKey(target.userId, event), '1', {
        expirationTtl: MARKER_TTL_SECONDS,
      }).catch((error) => {
        // A repeated alert every five minutes until the appointment starts is worse than
        // a lost one, so this is logged loudly even though it changes nothing here.
        console.error('no se pudo marcar el aviso de la cita:', error);
      }),
    ),
  );

  // Into the history, so "muévela una hora" right after the alert has something to
  // refer to.
  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return fresh.length;
}

/**
 * The marker key carries the start instant, not just the id.
 *
 * Moving an appointment keeps its id —that is the whole point of `update_event`— so a
 * key without the hour would announce the 09:00 slot and then stay quiet about the 17:00
 * one it was moved to. With the instant in the key, the moved appointment is a different
 * thing to warn about, which is exactly what it is.
 */
function markerKey(userId: string, event: CalendarEventSummary): string {
  return `event_alert:${userId}:${event.id}:${event.startAt}`;
}

/**
 * The alert's text, written in code like the reminders and the briefing: it costs no
 * tokens, it cannot invent an appointment and it does not depend on the LLM being up
 * when the cron fires.
 *
 * Unlike the reminders, the title is NOT lowercased to fit inside the sentence. A task
 * is a verb phrase —"llamar al banco"— and an appointment is often a name: "David" as
 * "david" reads like a bug. So the sentence is built with a colon, which takes any
 * title as it is.
 */
function buildAlertText(events: CalendarEventSummary[], timezone: string, now: Date): string {
  if (events.length === 1) {
    const event = events[0]!;
    const at = formatTime(new Date(event.startAt!), timezone);
    const minutes = Math.round((Date.parse(event.startAt!) - now.getTime()) / 60_000);

    // Under two minutes the countdown is noise, and "dentro de 0 minutos" is how a
    // machine says "now".
    if (minutes <= 1) return `Ahora: ${eventLabel(event)}, a las ${at}.`;
    return `Dentro de ${minutes} minutos: ${eventLabel(event)}, a las ${at}.`;
  }

  return [
    'Dentro de un rato tienes esto:',
    '',
    ...events.map(
      (event) => `- ${formatTime(new Date(event.startAt!), timezone)} ${eventLabel(event)}`,
    ),
  ].join('\n');
}
