import { localNow, shiftDate, zonedInstant } from './localtime';

/**
 * When something that repeats happens next.
 *
 * The vocabulary is deliberately the same one the calendar's appointments already use
 * (`RECURRENCE_RULES` in tools/calendar.ts): the model must not have to remember that
 * "mensual" is the word for an appointment and something else for a task. There the
 * frequency turns into an RRULE and Google does the arithmetic; here there is no Google,
 * so the arithmetic is ours, which is why this file exists.
 *
 * And it is the code's, not the model's, for the reason §7 is entirely about: an LLM
 * asked for "the same day next month" answers 31 February without blinking.
 */

/** The closed list. The model picks one of these words and never writes a date. */
export const REPEAT_FREQUENCIES = ['diario', 'laborables', 'semanal', 'mensual', 'anual'] as const;

export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

/**
 * The same frequency, said out loud.
 *
 * "Se repite mensual" reads like a form field. The keys are the model's, the phrasing is
 * ours — the same split as the appointment colours and the RRULE.
 */
const PHRASES: Record<RepeatFrequency, string> = {
  diario: 'todos los días',
  laborables: 'de lunes a viernes',
  semanal: 'todas las semanas',
  mensual: 'todos los meses',
  anual: 'todos los años',
};

export function isRepeatFrequency(value: string): value is RepeatFrequency {
  return (REPEAT_FREQUENCIES as readonly string[]).includes(value);
}

export function repeatPhrase(frequency: string): string | null {
  return isRepeatFrequency(frequency) ? PHRASES[frequency] : null;
}

/**
 * Guard against a bad frequency turning into an infinite loop.
 *
 * 500 daily steps is a year and a half: enough to catch up with anything that was left
 * behind, and short of hanging the Worker if a period ever advances by zero.
 */
const MAX_STEPS = 500;

/**
 * The next occurrence after `now`, starting from `from`.
 *
 * It advances by whole periods from the stored date instead of from `now`, and keeps
 * going until it is past `now`: an alert left behind for three days lands back on its
 * own hour, not three days late and not at whatever time the user got round to it.
 *
 * The arithmetic is done on the LOCAL date and the local hour is put back afterwards,
 * never by adding milliseconds. A daily 09:00 alert plus 24 h becomes an 08:00 alert the
 * day the clocks change, and it stays wrong from then on.
 */
export function nextOccurrence(
  from: Date,
  frequency: string,
  now: Date,
  timezone: string,
): Date | null {
  if (!isRepeatFrequency(frequency)) return null;

  const local = localNow(from, timezone);
  let date = local.date;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    date = advance(date, frequency);
    const candidate = zonedInstant(date, local.hour, local.minute, timezone);
    if (candidate === null) return null;
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

function advance(date: string, frequency: RepeatFrequency): string {
  switch (frequency) {
    case 'diario':
      return shiftDate(date, 1);
    case 'semanal':
      return shiftDate(date, 7);
    case 'laborables': {
      // Friday and the weekend all jump to Monday. A "de lunes a viernes" alert that
      // fires on Saturday is one nobody set.
      let next = shiftDate(date, 1);
      while (isWeekend(next)) next = shiftDate(next, 1);
      return next;
    }
    case 'mensual':
      return addMonths(date, 1);
    case 'anual':
      return addMonths(date, 12);
  }
}

/**
 * The weekday of a bare date.
 *
 * Read in UTC on purpose: 'YYYY-MM-DD' is not an instant, so pulling the time zone in
 * here is what would make a Monday come out as a Sunday. Same reason `shiftDate` does
 * not use `Intl` either.
 */
function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The same day, `count` months later, clamped to the length of the month it lands in.
 *
 * The 31st of a month with a 30 comes out as the 30th, and 29 February comes out as the
 * 28th on a non-leap year. Clamping and not overflowing: "el día 31" moved to 1 March is
 * a bill paid in the wrong month, and it would drift a day further every time.
 */
function addMonths(date: string, count: number): string {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];

  const total = (year * 12 + (month - 1)) + count;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const lastDay = daysInMonth(targetYear, targetMonth);

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
