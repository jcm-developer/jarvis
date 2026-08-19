import { localNow, localTomorrow, zonedInstant } from '../lib/localtime';
import { mentionsAnotherDay, parseRelativeMinutes } from '../lib/relative-time';
import type { ToolContext } from './types';
import { optionalInt } from './types';

/**
 * What has to be corrected in the model's output before anything gets written.
 *
 * This lived inside tasks.ts until create_event needed the very same corrections. The
 * lesson from the test phase —a rule the model follows voluntarily is not a
 * guarantee— applies to an appointment exactly as much as to a task, and keeping two
 * copies of this would guarantee they drifted apart immediately.
 */

/** One year. Cap for relative offsets: beyond that it smells like a model error. */
export const MAX_OFFSET_MINUTES = 525_600;

/** Slack forgiven to the model before a relative deadline gets corrected. */
export const DRIFT_TOLERANCE_MS = 10 * 60 * 1000;

export const OFFSET_HINT =
  'Minutos desde ahora, para cuando el usuario habla en relativo ("en 5 minutos", ' +
  '"dentro de media hora"). Preferible a calcular la fecha tú. Manda esto o el ISO, no ambos.';

/**
 * Resolves an offset in minutes into an ISO date.
 *
 * It exists because the model kept getting the day wrong. Asking it for "in 5
 * minutes" as ISO forces it into calendar arithmetic, and that is what it fails at:
 * it got the time right and wrote tomorrow's date, copied from another task in the
 * history. The offset is computed by the Worker, which does know what time it is.
 */
export function resolveOffset(args: Record<string, unknown>, field: string): string | null {
  const minutes = optionalInt(args, field, 1, MAX_OFFSET_MINUTES);
  return minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString();
}

export interface Deadlines {
  dueAt: string | null;
  remindAt: string | null;
}

/**
 * Corrects the model's dates with what the user actually said in their message.
 *
 * The prompt rules were not enough: `gpt-4o-mini` dated "remind me in 3 minutes" to
 * the following day even with a minutes field available so it would not have to
 * compute anything, and it did the same with "remind me at 13:14". The user's message
 * is the authentic source, so the user wins.
 *
 * Correction only kicks in past a ten-minute deviation: if the model got it right,
 * there is nothing to touch.
 */
export function honourUserDeadlines(chosen: Deadlines, ctx: ToolContext): Deadlines {
  const minutes = parseRelativeMinutes(ctx.userMessage);

  if (minutes !== null) {
    // The delay describes the reminder when there is one, and the due date only when
    // there is not. "Call David at six, remind me in five minutes" holds two different
    // times, and the delay is one of them, not both.
    if (chosen.remindAt !== null || chosen.dueAt === null) {
      return {
        dueAt: correctDay(chosen.dueAt, ctx, 'due_at'),
        remindAt: applyOffset(minutes, chosen.remindAt, 'remind_at'),
      };
    }
    return { dueAt: applyOffset(minutes, chosen.dueAt, 'due_at'), remindAt: null };
  }

  return {
    dueAt: correctDay(chosen.dueAt, ctx, 'due_at'),
    remindAt: correctDay(chosen.remindAt, ctx, 'remind_at'),
  };
}

/**
 * The same correction for a single instant.
 *
 * An appointment has no due-date/reminder pair like a task does: it starts at a time
 * and that is it. The split `honourUserDeadlines` makes between the two fields does
 * not apply here, but both corrections —the message's relative delay and the day the
 * model makes up— do.
 */
export function honourUserInstant(
  chosen: string | null,
  ctx: ToolContext,
  field: string,
): string | null {
  const minutes = parseRelativeMinutes(ctx.userMessage);
  if (minutes !== null) return applyOffset(minutes, chosen, field);
  return correctDay(chosen, ctx, field);
}

function applyOffset(minutes: number, chosen: string | null, field: string): string {
  const target = Date.now() + minutes * 60_000;
  if (chosen !== null && Math.abs(new Date(chosen).getTime() - target) <= DRIFT_TOLERANCE_MS) {
    return chosen;
  }
  return correct(field, chosen, new Date(target), { user_minutes: minutes });
}

/**
 * When the user did not say which day they meant, the day is today.
 *
 * This is the case that took three attempts: the model gets the time right ("13:14",
 * "17:30") and writes tomorrow's date. Here its time is respected —that is the part
 * it does well— and the day is swapped for the one the user had in mind.
 *
 * If the message does name another day ("on Thursday", "on 19 September"), nothing is
 * touched: there the day is theirs and we have nothing to add.
 */
function correctDay(chosen: string | null, ctx: ToolContext, field: string): string | null {
  if (chosen === null) return null;
  // With no message there is nothing to interpret: this came from a confirmation
  // button, and correcting blindly would mean inventing the user's intent.
  if (!ctx.userMessage) return chosen;
  if (mentionsAnotherDay(ctx.userMessage)) return chosen;

  const now = new Date();
  const clock = localNow(new Date(chosen), ctx.timezone);
  const today = localNow(now, ctx.timezone).date;

  let target = zonedInstant(today, clock.hour, clock.minute, ctx.timezone);
  if (target === null) return chosen;

  // That time already went by today, so they meant tomorrow. "Remind me at 8" said at
  // eleven at night is tomorrow at 8, not a year from now.
  if (target.getTime() < now.getTime() - DRIFT_TOLERANCE_MS) {
    const tomorrow = localTomorrow(now, ctx.timezone);
    target = zonedInstant(tomorrow, clock.hour, clock.minute, ctx.timezone) ?? target;
  }

  if (Math.abs(target.getTime() - new Date(chosen).getTime()) <= DRIFT_TOLERANCE_MS) {
    return chosen;
  }

  return correct(field, chosen, target, { user_time_of_day: `${clock.hour}:${clock.minute}` });
}

function correct(
  field: string,
  chosen: string | null,
  target: Date,
  detail: Record<string, unknown>,
): string {
  const corrected = target.toISOString();
  // Always logged: it is the only way to know how often the model is wrong without
  // depending on the user noticing.
  console.warn(
    JSON.stringify({
      event: 'deadline_corrected',
      field,
      ...detail,
      model_value: chosen,
      corrected_to: corrected,
    }),
  );
  return corrected;
}

/**
 * Strips the "remind me to" out of the title.
 *
 * The prompt forbids titles like "Recordar llamar a David" and the model writes them
 * anyway. The task is calling David; remembering it is what the cron does.
 */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(
    /^\s*(?:recordatorio(?:\s+de)?|recordarme|recordar|acordarme(?:\s+de)?|avisarme(?:\s+de)?|avisar(?:\s+de)?)\s+(?:que\s+)?/i,
    '',
  );
  if (cleaned.length === 0) return title;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
