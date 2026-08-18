/**
 * Fecha y hora en la zona del usuario.
 *
 * El cron de Cloudflare dispara en UTC, pero un briefing "de las 8 de la mañana"
 * solo tiene sentido en hora local, y España cambia de horario dos veces al año.
 * Así que nada de sumar offsets fijos: todo sale de `Intl`, que sí sabe cuándo
 * empieza el verano.
 *
 * Sin dependencias de fechas a propósito: son cuatro operaciones y `date-fns-tz`
 * pesa más que todo el Worker.
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
  /** 'YYYY-MM-DD' en la zona del usuario. Sirve de clave "una vez al día". */
  date: string;
  /** Hora local, 0-23. */
  hour: number;
}

export function localNow(instant: Date, timezone: string): LocalNow {
  const parts = zonedParts(instant, timezone);
  return { date: isoDate(parts), hour: parts.hour };
}

/**
 * Instante en que empieza el día local que contiene `instant`.
 *
 * Se calcula por aproximación y una corrección: se aplica el offset de la zona en
 * `instant` y luego el de la medianoche estimada. La segunda pasada importa los
 * dos días del año en que el offset cambia justo en medio.
 */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  const parts = zonedParts(instant, timezone);
  const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);

  const firstGuess = midnightAsUtc - offsetMs(instant, timezone);
  const corrected = midnightAsUtc - offsetMs(new Date(firstGuess), timezone);
  return new Date(corrected);
}

/**
 * Instante en que acaba el día local: la medianoche siguiente.
 *
 * Se salta 26 h desde el inicio del día y se vuelve a pedir su medianoche, en vez
 * de sumar 24 h a pelo. Un día con cambio de hora dura 23 o 25 h, y sumar 24
 * dejaría fuera la última hora del día o metería la primera del siguiente.
 */
export function endOfLocalDay(instant: Date, timezone: string): Date {
  const start = startOfLocalDay(instant, timezone);
  return startOfLocalDay(new Date(start.getTime() + 26 * 60 * 60 * 1000), timezone);
}

/**
 * El instante en ISO 8601 con el desplazamiento del usuario:
 * '2026-08-18T12:27:00+02:00'.
 *
 * Va al system prompt como plantilla. El modelo copia formatos mucho mejor que
 * calcula fechas, y sin un ISO delante escribía el día siguiente.
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

/** 'YYYY-MM-DD' del día local siguiente. Para anclar "mañana" en el prompt. */
export function localTomorrow(instant: Date, timezone: string): string {
  return localNow(endOfLocalDay(instant, timezone), timezone).date;
}

/** 'mar, 19 de agosto' — para encabezar el briefing. */
export function formatLongDate(instant: Date, timezone: string): string {
  return format(instant, timezone, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** '10:30' */
export function formatTime(instant: Date, timezone: string): string {
  return format(instant, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** '17 ago, 10:30' — para lo que venció otro día. */
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
    // Una zona horaria inválida en la base de datos no debe tumbar el cron.
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
  // Se redondea al segundo porque `instant` puede traer milisegundos y las
  // partes formateadas no.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Descompone un instante en la zona indicada.
 *
 * `hourCycle: 'h23'` no es opcional: sin él, algunos entornos devuelven "24" a
 * medianoche y el resto del cálculo se va un día entero.
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
    console.warn(`zona horaria inválida "${timezone}", se usa UTC`);
    return 'UTC';
  }
}

function isoDate(parts: Parts): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}
