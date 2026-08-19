/**
 * Date and time in the user's zone.
 *
 * Cloudflare's cron fires in UTC, but an "8 in the morning" briefing only makes sense
 * in local time, and Spain shifts its clocks twice a year. So no adding fixed
 * offsets: everything comes from `Intl`, which does know when summer time starts.
 *
 * No date library on purpose: this is four operations, and `date-fns-tz` weighs more
 * than the whole Worker.
 */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface LocalNow {
  /** 'YYYY-MM-DD' in the user's zone. Doubles as the "once a day" key. */
  date: string;
  /** Local hour, 0-23. */
  hour: number;
  /** Local minute, 0-59. */
  minute: number;
}

export function localNow(instant: Date, timezone: string): LocalNow {
  const parts = zonedParts(instant, timezone);
  return { date: isoDate(parts), hour: parts.hour, minute: parts.minute };
}

/**
 * The instant matching a local hour on a local day.
 *
 * Used to rebuild "13:14 today" from the hour the model picked and the day that
 * actually applies. Same two-pass trick as `startOfLocalDay`: the first pass
 * approximates with the current offset, the second corrects it with the offset of
 * the result itself, which is what saves the clock-change days.
 */
export function zonedInstant(
  date: string,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const asUtc = Date.UTC(
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10) - 1,
    Number.parseInt(match[3]!, 10),
    hour,
    minute,
    0,
  );

  const firstGuess = asUtc - offsetMs(new Date(asUtc), timezone);
  return new Date(asUtc - offsetMs(new Date(firstGuess), timezone));
}

/**
 * The instant the local day containing `instant` begins.
 *
 * Computed by approximation plus one correction: the zone offset at `instant` is
 * applied first, then the offset at the estimated midnight. That second pass matters
 * on the two days a year when the offset changes right in the middle.
 */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  const parts = zonedParts(instant, timezone);
  const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);

  const firstGuess = midnightAsUtc - offsetMs(instant, timezone);
  const corrected = midnightAsUtc - offsetMs(new Date(firstGuess), timezone);
  return new Date(corrected);
}

/**
 * The instant the local day ends: the next midnight.
 *
 * It jumps 26 h from the start of the day and asks for that day's midnight again,
 * instead of adding a flat 24 h. A clock-change day lasts 23 or 25 h, and adding 24
 * would either drop the day's last hour or pull in the next day's first one.
 */
export function endOfLocalDay(instant: Date, timezone: string): Date {
  const start = startOfLocalDay(instant, timezone);
  return startOfLocalDay(new Date(start.getTime() + 26 * 60 * 60 * 1000), timezone);
}

/**
 * The instant in ISO 8601 with the user's offset: '2026-08-18T12:27:00+02:00'.
 *
 * It goes into the system prompt as a template. The model copies formats far better
 * than it computes dates, and without an ISO string in front of it, it wrote the
 * following day.
 */
export function isoLocal(instant: Date, timezone: string): string {
  const p = zonedParts(instant, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = offsetMs(instant, timezone);
  const sign = offset < 0 ? '-' : '+';
  const total = Math.abs(Math.round(offset / 60_000));

  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`
  );
}

/** 'YYYY-MM-DD' of the next local day. Anchors "tomorrow" in the prompt. */
export function localTomorrow(instant: Date, timezone: string): string {
  return localNow(endOfLocalDay(instant, timezone), timezone).date;
}

/** 'YYYY-MM-DD' of the previous local day. Two hours before midnight is yesterday. */
export function localYesterday(instant: Date, timezone: string): string {
  const beforeMidnight = startOfLocalDay(instant, timezone).getTime() - 2 * 60 * 60 * 1000;
  return localNow(new Date(beforeMidnight), timezone).date;
}

/**
 * Adds days to a 'YYYY-MM-DD' and returns another 'YYYY-MM-DD'.
 *
 * `Intl` is deliberately NOT involved: a bare date is not an instant, so the days
 * are added in UTC and formatted back. Dragging the time zone into this is exactly
 * what makes a trip start a day early.
 */
export function shiftDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** '23 de agosto' — a bare day, no time and no weekday. Used inside ranges. */
export function formatDay(instant: Date, timezone: string): string {
  return format(instant, timezone, { day: 'numeric', month: 'long' });
}

/** '17 de agosto a las 09:00' — another day without sounding like a form field. */
export function formatDayAndTime(instant: Date, timezone: string): string {
  return `${formatDay(instant, timezone)} a las ${formatTime(instant, timezone)}`;
}

/** 'mar, 19 de agosto' — the briefing's heading. */
export function formatLongDate(instant: Date, timezone: string): string {
  return format(instant, timezone, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** '10:30' */
export function formatTime(instant: Date, timezone: string): string {
  return format(instant, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** '17 ago, 10:30' — for whatever fell due on some other day. */
export function formatShortDateTime(instant: Date, timezone: string): string {
  return format(instant, timezone, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function format(instant: Date, timezone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('es-ES', { timeZone: timezone, ...options }).format(instant);
  } catch {
    // An invalid time zone in the database must not bring the cron down.
    return instant.toISOString();
  }
}

function offsetMs(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Rounded to the second because `instant` may carry milliseconds while the
  // formatted parts do not.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Breaks an instant into parts in the given zone.
 *
 * `hourCycle: 'h23'` is not optional: without it some runtimes return "24" at
 * midnight and the rest of the calculation drifts a whole day.
 */
function zonedParts(instant: Date, timezone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const found: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') found[part.type] = Number.parseInt(part.value, 10);
  }

  return {
    year: found['year'] ?? instant.getUTCFullYear(),
    month: found['month'] ?? instant.getUTCMonth() + 1,
    day: found['day'] ?? instant.getUTCDate(),
    hour: found['hour'] ?? instant.getUTCHours(),
    minute: found['minute'] ?? instant.getUTCMinutes(),
    second: found['second'] ?? instant.getUTCSeconds(),
  };
}

function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    console.warn(`invalid time zone "${timezone}", falling back to UTC`);
    return 'UTC';
  }
}

function isoDate(parts: Parts): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}
