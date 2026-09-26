/**
 * "El mes pasado", "esta semana", "en marzo": named ranges of days, resolved here.
 *
 * Until this existed the model turned them into `day` and `days` by itself, and it is
 * the same model that dates tasks to the wrong day (§7). Asked about "el mes pasado" on
 * 24 September it searched "el mes anterior a agosto". It picks the name, which it hears;
 * the code does the calendar, which it knows.
 */
import { localNow, localWeekday, shiftDate, zonedInstant } from './localtime';

export const PERIODS = [
  'hoy',
  'ayer',
  'manana',
  'esta_semana',
  'semana_pasada',
  'semana_que_viene',
  'este_mes',
  'mes_pasado',
  'mes_que_viene',
  'este_ano',
  'ano_pasado',
] as const;

export type Period = (typeof PERIODS)[number];

/** For the tool schemas, so every tool describes the same list in the same words. */
export const PERIOD_HINT =
  `Un rango con nombre, y yo calculo las fechas: ${PERIODS.join(', ')}; o un mes ` +
  'concreto como YYYY-MM ("en marzo" es el marzo más reciente que ya ha empezado). ' +
  'Las semanas van de lunes a domingo.';

/** Local days `[first, end)` as 'YYYY-MM-DD', end exclusive, like Google's all-day events. */
export interface DayRange {
  first: string;
  end: string;
}

/** The range a period names, or null when it is not one. */
export function periodDays(period: string, now: Date, timezone: string): DayRange | null {
  const today = localNow(now, timezone).date;
  // Monday-based: 0 on Monday, 6 on Sunday.
  const monday = shiftDate(today, -((localWeekday(now, timezone) + 6) % 7));
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

  switch (period) {
    case 'hoy':
      return { first: today, end: shiftDate(today, 1) };
    case 'ayer':
      return { first: shiftDate(today, -1), end: today };
    case 'manana':
      return { first: shiftDate(today, 1), end: shiftDate(today, 2) };
    case 'esta_semana':
      return { first: monday, end: shiftDate(monday, 7) };
    case 'semana_pasada':
      return { first: shiftDate(monday, -7), end: monday };
    case 'semana_que_viene':
      return { first: shiftDate(monday, 7), end: shiftDate(monday, 14) };
    case 'este_mes':
      return monthRange(year, month);
    case 'mes_pasado':
      return monthRange(year, month - 1);
    case 'mes_que_viene':
      return monthRange(year, month + 1);
    case 'este_ano':
      return { first: `${year}-01-01`, end: `${year + 1}-01-01` };
    case 'ano_pasado':
      return { first: `${year - 1}-01-01`, end: `${year}-01-01` };
  }

  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const m = Number(match[2]);
    if (m >= 1 && m <= 12) return monthRange(Number(match[1]), m);
  }
  return null;
}

/** The same range as instants: local midnight to local midnight. */
export function periodInstants(
  period: string,
  now: Date,
  timezone: string,
): { from: Date; to: Date } | null {
  const days = periodDays(period, now, timezone);
  if (days === null) return null;
  const from = zonedInstant(days.first, 0, 0, timezone);
  const to = zonedInstant(days.end, 0, 0, timezone);
  return from && to ? { from, to } : null;
}

/**
 * Local days from today to `instant`: negative in the past. Counted on calendar dates,
 * not on hours, so last night at 23:00 is "ayer" and not "hace 0 días".
 */
export function daysFromToday(instant: Date, now: Date, timezone: string): number {
  const today = Date.parse(`${localNow(now, timezone).date}T00:00:00Z`);
  const that = Date.parse(`${localNow(instant, timezone).date}T00:00:00Z`);
  return Math.round((that - today) / (24 * 60 * 60 * 1000));
}

/**
 * 'hace 26 días', 'mañana', 'dentro de 3 semanas'.
 *
 * Written by the code and handed over with the date: "the last time was 26 days ago" is a
 * subtraction, and the model is the part of the system that does not subtract dates.
 */
export function relativeDays(days: number): string {
  if (days === 0) return 'hoy';
  if (days === -1) return 'ayer';
  if (days === 1) return 'mañana';
  const n = Math.abs(days);
  const amount =
    n >= 60 ? `${Math.round(n / 30)} meses` : n >= 14 ? `${Math.round(n / 7)} semanas` : `${n} días`;
  return days < 0 ? `hace ${amount}` : `dentro de ${amount}`;
}

/** A month that may have run off either end of the year: month 0 is last December. */
function monthRange(year: number, month: number): DayRange {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { first: first.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
