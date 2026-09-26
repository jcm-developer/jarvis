import { createCalendarClient } from '../calendar';
import type { CalendarClient, CalendarEventPatch, CalendarEventSummary } from '../calendar/provider';
import {
  formatDay,
  formatDayAndTime,
  formatLongDate,
  formatTime,
  localNow,
  shiftDate,
  startOfLocalDay,
  zonedInstant,
} from '../lib/localtime';
import { REPEAT_FREQUENCIES, repeatPhrase } from '../lib/recurrence';
import { PERIOD_HINT, daysFromToday, periodInstants, relativeDays } from '../lib/periods';
import { EMPTY_SEARCH_NOTE, matchesQuery, parseQuery } from '../lib/text-match';
import type { Interval } from '../lib/slots';
import { overlaps } from '../lib/slots';
import { OFFSET_HINT, cleanTitle, honourUserInstant, resolveOffset } from './guardrails';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import {
  optionalBoolean,
  optionalInt,
  optionalIsoDate,
  optionalString,
  requireString,
} from './types';

/**
 * Cap for every operation against Google: fetching the token plus the API call.
 *
 * Exported because `tools/agenda.ts` talks to the same calendar and has to be held to
 * the same yardstick. Two copies of this number drift apart over time.
 */
export const MAX_CALENDAR_MS = 10_000;

/**
 * Below this it is not even attempted. Telling the user to say it again beats firing
 * off a write that Cloudflare will cancel halfway, leaving us unable to tell whether
 * the event was created.
 */
export const MIN_CALENDAR_MS = 3_000;

/**
 * Cap for the overlap check.
 *
 * Shorter than the rest because it is an extra, not what the user asked for: if it
 * does not fit, the appointment is already created and all that is lost is the warning.
 */
const CONFLICT_MAX_MS = 5_000;

/** Appointments read to check an overlap. There are no more at the same hour. */
const CONFLICT_LIMIT = 10;

/**
 * Minimum room needed to afford the check: what the check itself may take plus what
 * the agent needs **afterwards** to word the reply (the 4 s of MIN_ROOM_FOR_CALL_MS in
 * agent.ts, with a little air).
 *
 * Without this sum, 4 s left was enough to go ahead: the lookup fitted, and the reply
 * that had to report it no longer did. The warning was paid for with silence, which is
 * the failure this project has been avoiding since Phase 1.
 */
const CONFLICT_MIN_ROOM_MS = CONFLICT_MAX_MS + 5_000;

/** How long an appointment lasts when the user does not say until when. */
const DEFAULT_DURATION_MINUTES = 60;

/** `list_events` window when no specific day is requested. */
const DEFAULT_SEARCH_DAYS = 7;

/**
 * Window of a search by name with no day: a year back, half a year ahead.
 *
 * Back is the long side because that is what a name search with no date is usually
 * about —"the last time I went"—, and what is ahead he mostly already knows.
 */
const SEARCH_BACK_DAYS = 365;
const SEARCH_AHEAD_DAYS = 180;

/**
 * Events read from Google for a search by name, to be filtered here.
 *
 * A year and a half of a personal calendar with a weekly series or two fits well under
 * this. It is not higher because every one of them is parsed on the free plan's 10 ms
 * of CPU.
 */
const SEARCH_FETCH_LIMIT = 1000;

/** Longest explicit range `list_events` accepts: "what did I have in March" and more. */
const MAX_RANGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Room needed to retry an empty search over the whole year: the call itself plus what
 * the agent needs afterwards to word the reply. Same sum as CONFLICT_MIN_ROOM_MS, for
 * the same reason.
 */
const WIDEN_MIN_ROOM_MS = MAX_CALENDAR_MS + 5_000;

/** Past times needed before an average gap means anything. Two is one gap, not a habit. */
const MIN_TIMES_FOR_PATTERN = 3;

/** How far a gap may stray from the average and still be "every N days". */
const PATTERN_TOLERANCE = 0.4;

/** Cap on a multi-day event. More than that smells like a model error. */
const MAX_SPAN_DAYS = 90;

/**
 * Category to Google Calendar colour.
 *
 * The model picks the KIND of appointment; the code picks the colour. The other way
 * round —letting it send a `colorId`— would give us trips in a different colour every
 * week: there is no way a model stays consistent with a number between 1 and 11 across
 * months of conversations, and a colour is only useful when it is always the same.
 *
 * The ids are the API's fixed ones: 3 grape, 7 peacock, 6 tangerine, 10 basil,
 * 11 tomato, 5 banana. With no category the event keeps the calendar's default colour,
 * which is what the user has already configured.
 */
const CATEGORY_COLORS: Record<string, string> = {
  viaje: '3',
  trabajo: '7',
  estudios: '6',
  personal: '10',
  salud: '11',
  social: '5',
};

const CATEGORIES = Object.keys(CATEGORY_COLORS);

const CATEGORY_HINT =
  'Tipo de cita, para que se vea de un color propio en el calendario: ' +
  `${CATEGORIES.join(', ')}. Mándalo cuando esté claro (un viaje, una reunión de ` +
  'trabajo, un examen o una clase, el médico); si no encaja en ninguno, no lo mandes.';

/** Colour back to its category, so a listed appointment can say what it is about. */
const COLOR_CATEGORIES: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_COLORS).map(([category, color]) => [color, category]),
);

/**
 * Frequency to recurrence rule.
 *
 * Same split as with the colours, and even more necessary here: an RRULE is a string
 * with its own grammar, and a model writing one by hand produces rules the API accepts
 * and which repeat the birthday on the wrong day for the next twenty years. It picks
 * the frequency from a list; the code writes the string.
 */
const RECURRENCE_RULES: Record<string, string> = {
  anual: 'RRULE:FREQ=YEARLY',
  mensual: 'RRULE:FREQ=MONTHLY',
  semanal: 'RRULE:FREQ=WEEKLY',
  diario: 'RRULE:FREQ=DAILY',
  laborables: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
};

const FREQUENCIES = [...REPEAT_FREQUENCIES];

/**
 * The same frequency, said out loud, lives in [lib/recurrence.ts](../lib/recurrence.ts).
 *
 * It moved there with phase 16: the tasks repeat too now, and two lists of frequencies
 * would have drifted apart the first time one of them gained a word. What stays here is
 * the RRULE, which is Google's and only Google's.
 */

/** What update_event and delete_event act on when the appointment repeats. */
const SCOPES = ['esta', 'serie'];

const SCOPE_HINT =
  'Solo para citas que se repiten: "esta" toca únicamente ese día y "serie" todas las ' +
  'repeticiones. Por defecto "esta". Si el usuario no lo ha dejado claro, PREGÚNTASELO ' +
  'antes: no es lo mismo saltarse un cumpleaños que borrarlo para siempre.';

/**
 * Translates the category into a colour, or null when it is not recognised.
 *
 * An odd value is not an error worth aborting the appointment over: the event is
 * created without a colour, which is exactly what happened before this existed.
 */
function colorFor(args: Record<string, unknown>): string | null {
  const category = optionalString(args, 'category', 20);
  if (category === null) return null;
  return CATEGORY_COLORS[category.toLowerCase()] ?? null;
}

/** The recurrence rule, or null when the appointment happens only once. */
function recurrenceFor(args: Record<string, unknown>): string[] | null {
  const frequency = optionalString(args, 'repeats', 20);
  if (frequency === null) return null;
  const rule = RECURRENCE_RULES[frequency.toLowerCase()];
  return rule ? [rule] : null;
}

/**
 * The id to act on: this occurrence's or the whole series'.
 *
 * A `delete_event` with an occurrence's id deletes that day only. For "delete my
 * sister's birthday" that leaves the other twenty years in place, and the user would
 * not find out until next year.
 */
function targetOf(
  event: CalendarEventSummary,
  args: Record<string, unknown>,
): { id: string; wholeSeries: boolean } {
  const scope = (optionalString(args, 'scope', 10) ?? 'esta').toLowerCase();
  if (scope === 'serie' && event.seriesId !== null) {
    return { id: event.seriesId, wholeSeries: true };
  }
  return { id: event.id, wholeSeries: false };
}

export const NO_TIME = {
  ok: false as const,
  error:
    'No queda tiempo en este mensaje para hablar con el calendario. Dile al usuario que ' +
    'NO se ha hecho nada y que te lo repita.',
};

/**
 * Appointments turned into busy intervals.
 *
 * All-day events do NOT take up time: a birthday or an "I am travelling" fills the day
 * in the calendar without preventing a meeting at eleven. If they blocked, any week
 * with a name day in it would come back without a single free slot and the tool would
 * be useless.
 *
 * Private appointments do take up time even though they arrive with no title: the
 * shared permission we use returns them as an occupied slot, which is exactly the
 * piece of data needed here.
 */
export function busyIntervals(events: CalendarEventSummary[]): Interval[] {
  return events
    .filter((event) => !event.allDay && event.startAt !== null && event.endAt !== null)
    .map((event) => ({ start: Date.parse(event.startAt!), end: Date.parse(event.endAt!) }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end));
}

/**
 * The appointments clashing with the slot a new appointment has just taken.
 *
 * It never throws: a failure here cannot turn into a `create_event` error, because the
 * appointment is already written and telling the model something failed would have it
 * report that to the user as if nothing had been created.
 */
async function overlappingEvents(
  client: CalendarClient,
  slot: Interval,
  createdId: string,
  ctx: ToolContext,
): Promise<CalendarEventSummary[]> {
  if (!ctx.deadline.hasRoomFor(CONFLICT_MIN_ROOM_MS)) return [];

  try {
    const events = await client.listEvents(
      {
        from: new Date(slot.start).toISOString(),
        to: new Date(slot.end).toISOString(),
        limit: CONFLICT_LIMIT,
      },
      ctx.deadline.budgetFor(CONFLICT_MAX_MS),
    );

    return events.filter((event) => {
      // The one just created shows up in its own search, and when it repeats it shows
      // up with the occurrence's id, which is not the one the POST returned: without
      // also checking the series id, a weekly class would warn about clashing with
      // itself.
      if (event.id === createdId || event.seriesId === createdId) return false;
      if (event.allDay || event.startAt === null || event.endAt === null) return false;
      return overlaps(slot, { start: Date.parse(event.startAt), end: Date.parse(event.endAt) });
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'calendar_conflict_check_failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return [];
  }
}

export const createEvent: ToolDefinition = {
  name: 'create_event',
  description:
    'Crea una cita en el calendario del usuario: algo que ocurre a una hora concreta y ' +
    'ocupa un hueco de su día (una reunión, el médico, una comida, un viaje, un ' +
    'cumpleaños). No la uses para un recado que hay que hacer pero no ocupa agenda ' +
    '("comprar pan", "llamar a David"): eso es create_task. Si dudas entre las dos, ' +
    'pregúntaselo. Para cambiar una cita que ya existe usa update_event, no crees otra.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Qué es la cita, en una frase corta. Ej. "Dentista", "Comida con Marta".',
      },
      start_at: {
        type: 'string',
        description:
          'Cuándo empieza, en ISO 8601 con zona horaria, ej. 2026-08-20T10:00:00+02:00. ' +
          'Parte de la fecha de hoy del contexto.',
      },
      start_in_minutes: { type: 'integer', description: `Cuándo empieza. ${OFFSET_HINT}` },
      duration_minutes: {
        type: 'integer',
        description:
          'Cuánto dura. Si el usuario no lo dice, no lo mandes: por defecto son 60 minutos.',
      },
      end_at: {
        type: 'string',
        description:
          'Cuándo acaba, en ISO 8601, solo si el usuario da una hora de fin concreta ' +
          '("de 10 a 11:30"). Si no, usa duration_minutes o déjalo en blanco.',
      },
      all_day: {
        type: 'boolean',
        description:
          'True cuando la cita ocupa el día entero y no tiene hora ("el viaje es el ' +
          'viernes", un cumpleaños). Aun así manda start_at con el día correcto.',
      },
      end_date: {
        type: 'string',
        description:
          'Solo con all_day, y solo si dura varios días: el ÚLTIMO día incluido, en ' +
          'formato YYYY-MM-DD. Para "del 23 al 26" manda el 26; yo me encargo del resto.',
      },
      location: { type: 'string', description: 'Dónde es, si lo dice.' },
      description: { type: 'string', description: 'Detalles adicionales, si los hay.' },
      category: { type: 'string', enum: CATEGORIES, description: CATEGORY_HINT },
      repeats: {
        type: 'string',
        enum: FREQUENCIES,
        description:
          'Si la cita se repite siempre: un cumpleaños es "anual", una clase semanal es ' +
          '"semanal". No lo mandes para algo que pasa una vez. Un cumpleaños va además ' +
          'con all_day.',
      },
    },
    required: ['title'],
  },
  mutates: true,
  requiresConfirmation: false,
  // Read on the photo path, where the appointment is described before being written. A
  // misread day matters more here than on a task: it takes up a slot the user believes
  // is free, and they only find out when they show up.
  confirmationPrompt: async (args, ctx) => {
    const title = cleanTitle(optionalString(args, 'title', 200) ?? 'esa cita');
    const startIso = resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at');
    const start = startIso === null ? null : new Date(startIso);

    // The article belongs to the date and not to the sentence: "el 10 de septiembre" but
    // "del 23 al 26", and neither when there is no date at all.
    let when = '';
    if (start !== null && !Number.isNaN(start.getTime())) {
      if (optionalBoolean(args, 'all_day')) {
        const lastDay = optionalString(args, 'end_date', 10);
        const first = formatDay(start, ctx.timezone);
        // The last day is stated as the user said it, without the +1 Google needs: the
        // question has to read like the trip they described, not like the row. Same
        // wording as list_events, so a trip reads identically in both places.
        when =
          lastDay !== null
            ? ` del ${first} al ${dayName(lastDay, ctx.timezone, false)}, todo el día`
            : ` el ${first}, todo el día`;
      } else {
        when = ` el ${formatDayAndTime(start, ctx.timezone)}`;
      }
    }

    const repeats = optionalString(args, 'repeats', 20)?.toLowerCase() ?? null;
    const phrase = repeats === null ? null : repeatPhrase(repeats);
    const every = phrase ? `, ${phrase}` : '';
    const place = optionalString(args, 'location', 300);

    return `¿Pongo en el calendario "${title}"${when}${place ? ` en ${place}` : ''}${every}?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = cleanTitle(requireString(args, 'title', 200));

    const allDay = optionalBoolean(args, 'all_day');
    const chosen = resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at');

    // Same corrections as for tasks, and for the same reason: the model gets the time
    // right and the day wrong. It hurts more here than on a task, because a misdated
    // event takes up a slot the user believes is free.
    //
    // But NOT on an all-day event. There is no time there, and the corrector's whole
    // premise is that the time is good and the day is not: applied to an "all day" it
    // would end up dragging the appointment to today because it found no day in the
    // message. With bare dates the model gets it right; arithmetic is its weak spot.
    const startAt = allDay ? chosen : honourUserInstant(chosen, ctx, 'start_at');

    if (startAt === null) {
      return {
        ok: false,
        error:
          'Falta cuándo empieza la cita. Manda start_at en ISO 8601, o start_in_minutes si ' +
          'el usuario habló en relativo. Si no lo ha dicho, pregúntaselo.',
      };
    }

    const start = new Date(startAt);

    // An all-day entry travels as dates, not instants, and the end is exclusive: for a
    // single day, that is the next day.
    const startDate = allDay ? localNow(start, ctx.timezone).date : null;
    let endDate = allDay ? shiftDate(startDate!, 1) : null;

    if (allDay) {
      const lastDay = optionalString(args, 'end_date', 10);
      if (lastDay !== null) {
        const span = daysBetween(startDate!, lastDay);
        if (span === null) {
          return {
            ok: false,
            error: `"${lastDay}" no es una fecha válida. Usa el formato YYYY-MM-DD.`,
          };
        }
        if (span < 0) {
          return {
            ok: false,
            error:
              'end_date es anterior al día de inicio. El primer día va en start_at y el ' +
              'último en end_date.',
          };
        }
        if (span > MAX_SPAN_DAYS) {
          return {
            ok: false,
            error: `Eso son más de ${MAX_SPAN_DAYS} días. Confirma las fechas con el usuario.`,
          };
        }
        // +1 because in Google the last day is exclusive: a trip from the 23rd to the
        // 26th is stored as 23 to 27. Without that extra day the calendar paints it
        // ending on the 25th and the user believes they come back a day early.
        endDate = shiftDate(startDate!, span + 1);
      }
    }

    let endAt: string | null = null;
    if (!allDay) {
      const duration = optionalInt(args, 'duration_minutes', 5, 24 * 60);
      endAt =
        optionalIsoDate(args, 'end_at') ??
        new Date(start.getTime() + (duration ?? DEFAULT_DURATION_MINUTES) * 60_000).toISOString();

      if (new Date(endAt).getTime() <= start.getTime()) {
        return {
          ok: false,
          error:
            'La cita acabaría antes de empezar. Revisa end_at, o mándame duration_minutes y ' +
            'yo calculo el final.',
        };
      }
    }

    // The budget comes from the message's clock, not from a cap of its own: that is
    // the rule stopping a new step from eating the time needed to answer.
    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    // Configuration errors and Google's own come out as CalendarError and the agent
    // catches them: they go back to the model as {ok:false, error}, never to the user
    // as an exception.
    const client = createCalendarClient(ctx.env);
    const event = await client.createEvent(
      {
        title,
        description: optionalString(args, 'description'),
        location: optionalString(args, 'location', 300),
        startAt: allDay ? null : startAt,
        endAt,
        startDate,
        endDate,
        colorId: colorFor(args),
        recurrence: recurrenceFor(args),
        timezone: ctx.timezone,
      },
      budget,
    );

    console.info(
      JSON.stringify({
        event: 'calendar_event_created',
        provider: client.name,
        event_id: event.id,
        start: allDay ? startDate : startAt,
        all_day: allDay,
      }),
    );

    // The overlap is checked AFTER the write, on purpose. The appointment is what the
    // user asked for: it cannot end up unwritten because a courtesy lookup ate the
    // message's budget. If there is no time left or Google fails, it is created anyway
    // and nothing is said — the other way round, this would be a regression.
    //
    // And it warns, it does not block: two things at the same hour is something people
    // do on purpose. Returning {ok:false} would send the model hunting for another
    // hour nobody asked for.
    const overlapping =
      allDay || endAt === null
        ? []
        : await overlappingEvents(
            client,
            { start: start.getTime(), end: Date.parse(endAt) },
            event.id,
            ctx,
          );

    // `when` in Spanish so the model repeats the date in its reply and the user can
    // correct it on the spot. Without this it goes back to reciting the ISO string.
    return {
      ok: true,
      data: {
        id: event.id,
        title,
        // The same formatting as list_events is reused: if a trip is stored as "del 23
        // al 26", the user has to read it the same way in both.
        when: allDay
          ? whenOf(
              {
                id: event.id,
                title,
                location: null,
                startAt: null,
                endAt: null,
                startDate,
                endDate,
                allDay: true,
                recurring: false,
                seriesId: null,
                colorId: null,
                url: null,
              },
              ctx.timezone,
            )
          : formatDayAndTime(start, ctx.timezone),
        start_iso: allDay ? startDate : startAt,
        all_day: allDay,
        ...(endAt ? { end_iso: endAt } : {}),
        ...(overlapping.length > 0
          ? {
              overlaps_with: overlapping.map((other) => ({
                title: other.title || '(otra cita, privada)',
                when: hoursOf(other, ctx.timezone),
              })),
              note:
                'La cita SÍ se ha creado. Pero a esa hora ya tenía algo, así que dile con ' +
                'qué se solapa en la misma frase. No la muevas ni la borres: si quiere ' +
                'cambiarla, te lo dirá.',
            }
          : {}),
        ...(event.url ? { url: event.url } : {}),
      },
    };
  },
};

export const listEvents: ToolDefinition = {
  name: 'list_events',
  description:
    'Consulta las citas del calendario del usuario, las que vienen y las que ya pasaron. ' +
    'Úsala cuando pregunte qué tiene un día ("¿qué tengo el jueves?", "¿estoy libre ' +
    'mañana por la tarde?"), cuándo fue o cuándo es algo ("¿cuándo fui al peluquero?", ' +
    '"¿cuándo tengo el dentista?") y SIEMPRE antes de modificar o borrar una cita, ' +
    'porque necesitas su id exacto y no puedes inventarlo.',
  parameters: {
    type: 'object',
    properties: {
      day: {
        type: 'string',
        description:
          'Día por el que empezar, en formato YYYY-MM-DD; puede ser pasado. Sin day y sin ' +
          `query mira los próximos ${DEFAULT_SEARCH_DAYS} días; sin day y con query busca ` +
          `desde hace ${SEARCH_BACK_DAYS} días hasta dentro de ${SEARCH_AHEAD_DAYS}. Si ` +
          'buscas una cita por su nombre y no sabes el día exacto, NO lo mandes.',
      },
      days: {
        type: 'integer',
        description: `Cuántos días mirar a partir de "day". Por defecto 1, máximo ${MAX_RANGE_DAYS}.`,
      },
      period: {
        type: 'string',
        description:
          `En vez de day y days, cuando él nombra el rango ("el mes pasado", "esta semana"). ` +
          PERIOD_HINT,
      },
      query: {
        type: 'string',
        description:
          'Palabras para encontrar una cita por su título o su sitio. No hace falta que ' +
          'coincidan exactas: "peluquero" encuentra "Peluquería". Manda en la misma ' +
          'llamada las formas en que pudo apuntarlo, separadas por comas ' +
          '("peluquería, barbero, corte de pelo"): encaja si coincide cualquiera.',
      },
      limit: { type: 'integer', description: 'Máximo de citas a devolver. Por defecto 20.' },
    },
    required: [],
  },
  mutates: false,
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const day = optionalString(args, 'day', 10);
    const days = optionalInt(args, 'days', 1, MAX_RANGE_DAYS) ?? 1;
    const period = optionalString(args, 'period', 20);
    const query = optionalString(args, 'query', 200);
    const limit = optionalInt(args, 'limit', 1, 50) ?? 20;

    if (day !== null && period !== null) {
      return { ok: false, error: 'Manda day o period, no los dos.' };
    }

    const alternatives = query === null ? [] : parseQuery(query);
    if (query !== null && alternatives.length === 0) {
      return {
        ok: false,
        error:
          `"${query}" no tiene ninguna palabra que distinga una cita. Manda el nombre de la ` +
          'cita, la persona o el sitio ("dentista", "Marta"), o busca por días sin query.',
      };
    }
    const searching = alternatives.length > 0;

    const now = new Date();
    let range: { from: Date; to: Date };

    if (period !== null) {
      const resolved = periodInstants(period, now, ctx.timezone);
      if (resolved === null) {
        return { ok: false, error: `period "${period}" no válido. ${PERIOD_HINT}` };
      }
      range = resolved;
    } else if (day !== null) {
      const resolved = localDayRange(day, days, ctx.timezone);
      if (resolved === null) {
        return { ok: false, error: `"${day}" no es una fecha válida. Usa el formato YYYY-MM-DD.` };
      }
      range = resolved;
    } else if (searching) {
      // Looking for something by name with no dates: "¿cuándo fui al peluquero?" is about
      // the past, and a search that only looked ahead answered it with a confident "there
      // is no such appointment".
      range = searchWindow(now);
    } else {
      // Nothing to look for and no day: from now on. Asking "what do I have?" is not
      // asking about what already happened this morning.
      range = { from: now, to: new Date(now.getTime() + DEFAULT_SEARCH_DAYS * DAY_MS) };
    }

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    // A search reads the whole range and filters it here, so what is fetched is a page big
    // enough for a year of a personal calendar, not what the model asked to see.
    const fetchLimit = searching ? SEARCH_FETCH_LIMIT : limit;
    const client = createCalendarClient(ctx.env);
    const read = async (window: { from: Date; to: Date }, timeoutMs: number) => {
      const fetched = await client.listEvents(
        { from: window.from.toISOString(), to: window.to.toISOString(), limit: fetchLimit },
        timeoutMs,
      );
      return {
        // Google orders by start, so a full page means the end of the range was cut off.
        truncated: fetched.length >= fetchLimit,
        events: searching
          ? fetched.filter((event) =>
              matchesQuery(alternatives, `${event.title} ${event.location ?? ''}`),
            )
          : fetched,
      };
    };

    let found = await read(range, budget);

    // Dates he gave and a name that is not in them: the dates are the likelier mistake
    // ("el mes pasado" when it was the one before). Widening here costs one call to
    // Google; leaving it to the model costs one of its three rounds, and it did not
    // always spend it — it said "no hay" instead.
    let widened = false;
    const explicit = day !== null || period !== null;
    const empty = searching && explicit && found.events.length === 0;
    if (empty && ctx.deadline.hasRoomFor(WIDEN_MIN_ROOM_MS)) {
      try {
        const wide = searchWindow(now);
        const second = await read(wide, ctx.deadline.budgetFor(MAX_CALENDAR_MS));
        if (second.events.length > 0) {
          range = wide;
          found = second;
          widened = true;
        }
      } catch {
        // The first answer stands, with its note. Losing the retry is not worth an error.
      }
    }

    // Worked out over every match, before the cut: the last and the next time are exactly
    // the rows a busy name would lose to it.
    const summary = searching ? occurrences(found.events, now, ctx.timezone) : {};

    let events = found.events;
    if (events.length > limit) {
      // A name that matches too much ("reunión") is cut down to the ones nearest to now,
      // on both sides: the last time and the next time are what gets asked about, not the
      // first one of last October.
      events = [...events]
        .sort((a, b) => distanceFrom(now, a, ctx.timezone) - distanceFrom(now, b, ctx.timezone))
        .slice(0, limit)
        .sort((a, b) => startOf(a, ctx.timezone) - startOf(b, ctx.timezone));
    }

    const dates = rangePhrase(range.from, new Date(range.to.getTime() - 1), ctx.timezone);

    return {
      ok: true,
      data: {
        count: found.events.length,
        // The range travels with the answer so an empty one can be told as what it is:
        // nothing in these dates with these words. Not "it does not exist".
        searched: searching ? `${dates}, con "${query}"` : dates,
        ...summary,
        events: events.map((event) => describe(event, ctx.timezone)),
        ...(widened
          ? {
              note:
                'En las fechas que pediste no había nada; lo he encontrado buscando en todo ' +
                'el año. Díselo así: "no fue entonces, fue el...".',
            }
          : found.truncated
            ? {
                note:
                  'Hay más citas de las que caben en una consulta y el final del rango se ha ' +
                  'quedado fuera. Si buscas algo más adelante, vuelve a llamar con day y un ' +
                  'days más corto.',
              }
            : searching && found.events.length === 0
              ? { note: `${EMPTY_SEARCH_NOTE} Busqué ${dates}.` }
              : {}),
      },
    };
  },
};

export const updateEvent: ToolDefinition = {
  name: 'update_event',
  description:
    'Cambia una cita que ya existe en el calendario: su hora, su día, su título o su ' +
    'sitio. Es la herramienta correcta cuando el usuario cambia de plan sobre una cita ' +
    'ya apuntada ("muévela al viernes", "mejor a las seis", "que es en el otro sitio"). ' +
    'Nunca crees una cita nueva para eso. Necesitas el id exacto: llama antes a ' +
    'list_events. Solo se tocan los campos que envíes.',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'El id devuelto por list_events.' },
      title: { type: 'string', description: 'Nuevo título.' },
      start_at: {
        type: 'string',
        description:
          'Nueva hora de inicio en ISO 8601 con zona horaria. Si no mandas también un ' +
          'final, la cita conserva la duración que ya tenía.',
      },
      start_in_minutes: { type: 'integer', description: `Nueva hora de inicio. ${OFFSET_HINT}` },
      duration_minutes: { type: 'integer', description: 'Nueva duración en minutos.' },
      end_at: { type: 'string', description: 'Nueva hora de fin en ISO 8601.' },
      location: { type: 'string', description: 'Nuevo sitio. Cadena vacía para quitarlo.' },
      description: { type: 'string', description: 'Nuevas notas. Cadena vacía para quitarlas.' },
      category: { type: 'string', enum: CATEGORIES, description: CATEGORY_HINT },
      scope: { type: 'string', enum: SCOPES, description: SCOPE_HINT },
    },
    required: ['event_id'],
  },
  mutates: true,
  requiresConfirmation: false,
  // Worded from the arguments alone, without asking Google for the title the way
  // delete_event does. This one is only reached from a photo, where several calls are
  // confirmed at once: a network round trip per line would spend the message's budget
  // on the question and leave none for the answer.
  confirmationPrompt: async (args, ctx) => {
    const startIso = resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at');
    const when = startIso === null ? null : new Date(startIso);
    const wholeSeries = (optionalString(args, 'scope', 10) ?? 'esta').toLowerCase() === 'serie';
    const target = wholeSeries ? 'esa cita y todas sus repeticiones' : 'esa cita';

    if (when !== null && !Number.isNaN(when.getTime())) {
      return `¿Muevo ${target} al ${formatDayAndTime(when, ctx.timezone)}?`;
    }
    const title = optionalString(args, 'title', 200);
    if (title !== null) return `¿Cambio el título de ${target} a "${cleanTitle(title)}"?`;
    return `¿Cambio ${target}?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const eventId = requireString(args, 'event_id', 1024);

    const patch: CalendarEventPatch = { timezone: ctx.timezone };
    if (args['title'] !== undefined) patch.title = cleanTitle(requireString(args, 'title', 200));
    if (args['location'] !== undefined) patch.location = optionalString(args, 'location', 300);
    if (args['description'] !== undefined) patch.description = optionalString(args, 'description');

    if (args['category'] !== undefined) {
      const color = colorFor(args);
      // An unrecognised category leaves the colour alone instead of clearing it:
      // turning the event grey is not what anybody asked for.
      if (color !== null) patch.colorId = color;
    }

    const touchesStart = args['start_at'] !== undefined || args['start_in_minutes'] !== undefined;
    const touchesEnd = args['end_at'] !== undefined || args['duration_minutes'] !== undefined;
    const wantsSeries = (optionalString(args, 'scope', 10) ?? 'esta').toLowerCase() === 'serie';

    if (!touchesStart && !touchesEnd && Object.keys(patch).length === 1) {
      return {
        ok: false,
        error:
          'No has indicado qué cambiar. Manda al menos uno de: title, start_at, ' +
          'start_in_minutes, duration_minutes, end_at, location o description.',
      };
    }

    // The event has to be read to touch the series: the id the model holds is an
    // occurrence's, and the series id only comes inside the event.
    if (touchesStart || touchesEnd || wantsSeries) {
      // The event has to be read BEFORE deciding the new time, for two reasons. One:
      // moving the start without touching the end would leave an appointment of absurd
      // length, and only Google knows the length it had — "move it to Friday" is the
      // same appointment on another day, not an appointment of a different length. And
      // two: if the event is all-day, the day corrector must not be applied, because
      // there is no time to correct against.
      let budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
      if (budget < MIN_CALENDAR_MS) return NO_TIME;

      const client = createCalendarClient(ctx.env);
      const current = await client.getEvent(eventId, budget);
      if (current === null) return notFound(eventId);

      const target = targetOf(current, args);

      // Changing the TIME of a whole series is something we do not do. Re-anchoring
      // the series from here is where it breaks silently: a rule with fixed days
      // (weekdays) moved onto a Saturday stops matching its own pattern, and the user
      // does not see it until a whole week of appointments is missing.
      if (target.wholeSeries && (touchesStart || touchesEnd)) {
        return {
          ok: false,
          error:
            'No puedo cambiar la hora de toda una serie de una vez. Puedo mover esta ' +
            'repetición (scope="esta"), o cambiarle a la serie el título, el sitio o la ' +
            'categoría. Para reprogramar la serie entera tiene que hacerlo él desde la ' +
            'app del calendario: díselo así.',
        };
      }

      if (touchesStart || touchesEnd) {
        const chosen = touchesStart
          ? (resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at'))
          : null;
        const newStart =
          touchesStart && !current.allDay ? honourUserInstant(chosen, ctx, 'start_at') : chosen;

        if (touchesStart && newStart === null) {
          return {
            ok: false,
            error: 'No he entendido la nueva hora. Manda start_at en ISO 8601 o start_in_minutes.',
          };
        }

        const applied = applyNewTimes(current, newStart, args, ctx);
        if (!applied.ok) return applied;
        Object.assign(patch, applied.patch);
      }

      budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
      if (budget < MIN_CALENDAR_MS) return NO_TIME;

      const updated = await client.updateEvent(target.id, patch, budget);
      return report(target.id, patch, current, ctx, updated.url, target.wholeSeries);
    }

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const updated = await createCalendarClient(ctx.env).updateEvent(eventId, patch, budget);
    return report(eventId, patch, null, ctx, updated.url, false);
  },
};

export const deleteEvent: ToolDefinition = {
  name: 'delete_event',
  description:
    'Borra una cita del calendario de forma permanente. Solo cuando el usuario pida ' +
    'quitarla o cancelarla de verdad; si lo que hace es cambiarla de día o de hora, usa ' +
    'update_event. Necesitas el id exacto: llama antes a list_events.',
  parameters: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'El id devuelto por list_events.' },
      scope: { type: 'string', enum: SCOPES, description: SCOPE_HINT },
    },
    required: ['event_id'],
  },
  mutates: true,
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const eventId = typeof args['event_id'] === 'string' ? args['event_id'] : '';
    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);

    // The question names the title, not the id: nobody actually reviews "delete
    // appointment 7f3a-...?". If it cannot be read, the generic question is asked
    // rather than failing: what must never happen is deleting without asking.
    if (budget >= MIN_CALENDAR_MS && eventId) {
      try {
        const event = await createCalendarClient(ctx.env).getEvent(eventId, budget);
        if (event) {
          const shown = event.title || 'esa cita';
          const target = targetOf(event, args);

          // The scope goes in the question, not in a note afterwards: between
          // deleting this year's birthday and deleting it forever there is no way
          // back, and that is precisely what the button is confirming.
          if (target.wholeSeries) {
            return `¿Borro "${shown}" del calendario con TODAS sus repeticiones, para siempre?`;
          }
          if (event.recurring) {
            return `¿Borro "${shown}" solo el ${whenOf(event, ctx.timezone)}, dejando el resto de las repeticiones?`;
          }
          return `¿Borro del calendario "${shown}" (${whenOf(event, ctx.timezone)})?`;
        }
      } catch {
        // Whatever the reason: fall back to the generic wording.
      }
    }
    return '¿Borro esa cita del calendario?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const eventId = requireString(args, 'event_id', 1024);
    const wantsSeries = (optionalString(args, 'scope', 10) ?? 'esta').toLowerCase() === 'serie';

    let budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const client = createCalendarClient(ctx.env);
    let targetId = eventId;
    let wholeSeries = false;

    // Only read when the series has to be resolved: the series id lives inside the
    // event and the model does not have it.
    if (wantsSeries) {
      const event = await client.getEvent(eventId, budget);
      if (event === null) return notFound(eventId);
      ({ id: targetId, wholeSeries } = targetOf(event, args));

      budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
      if (budget < MIN_CALENDAR_MS) return NO_TIME;
    }

    await client.deleteEvent(targetId, budget);

    console.info(
      JSON.stringify({
        event: 'calendar_event_deleted',
        provider: client.name,
        event_id: targetId,
        whole_series: wholeSeries,
      }),
    );

    return { ok: true, data: { deleted: true, whole_series: wholeSeries } };
  },
};

/**
 * Works out the new start and end while preserving what the user did not ask to change.
 *
 * Three cases: the start moves with no duration given (the old one is preserved), the
 * duration changes without moving the start, and all-day events (the day moves).
 */
function applyNewTimes(
  current: CalendarEventSummary,
  newStart: string | null,
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; patch: Partial<CalendarEventPatch> } | { ok: false; error: string } {
  const duration = optionalInt(args, 'duration_minutes', 5, 24 * 60);
  const explicitEnd = optionalIsoDate(args, 'end_at');

  if (current.allDay) {
    if (newStart === null) {
      return {
        ok: false,
        error:
          'Esa cita ocupa el día entero, así que no tiene duración que cambiar. Manda ' +
          'start_at con el día nuevo si lo que quiere es moverla.',
      };
    }

    // Preserves the days it spanned. Without this, moving a trip from the 23rd to the
    // 26th would collapse it into one day: the user asked to change when it starts, not
    // how long it lasts.
    const nights =
      current.startDate !== null && current.endDate !== null
        ? (daysBetween(current.startDate, current.endDate) ?? 1)
        : 1;

    const startDate = localNow(new Date(newStart), ctx.timezone).date;
    return {
      ok: true,
      patch: { startDate, endDate: shiftDate(startDate, Math.max(1, nights)) },
    };
  }

  const startIso = newStart ?? current.startAt;
  if (startIso === null) {
    return { ok: false, error: 'Esa cita no tiene hora de inicio, así que no puedo recolocarla.' };
  }
  const start = new Date(startIso);

  let endIso: string;
  if (explicitEnd !== null) {
    endIso = explicitEnd;
  } else if (duration !== null) {
    endIso = new Date(start.getTime() + duration * 60_000).toISOString();
  } else {
    // Neither end nor duration: keep the one it had. That is what "move it" means.
    const kept =
      current.startAt !== null && current.endAt !== null
        ? new Date(current.endAt).getTime() - new Date(current.startAt).getTime()
        : DEFAULT_DURATION_MINUTES * 60_000;
    endIso = new Date(start.getTime() + kept).toISOString();
  }

  if (new Date(endIso).getTime() <= start.getTime()) {
    return {
      ok: false,
      error: 'La cita acabaría antes de empezar. Revisa end_at o manda duration_minutes.',
    };
  }

  return { ok: true, patch: { startAt: startIso, endAt: endIso } };
}

function report(
  eventId: string,
  patch: CalendarEventPatch,
  before: CalendarEventSummary | null,
  ctx: ToolContext,
  url: string | null,
  wholeSeries: boolean,
): ToolResult {
  const startIso = patch.startAt ?? null;
  const startDate = patch.startDate ?? null;

  console.info(
    JSON.stringify({
      event: 'calendar_event_updated',
      event_id: eventId,
      start: startIso ?? startDate,
      recurring: before?.recurring ?? null,
      whole_series: wholeSeries,
    }),
  );

  return {
    ok: true,
    data: {
      id: eventId,
      ...(patch.title ? { title: patch.title } : {}),
      ...(startIso ? { when: formatDayAndTime(new Date(startIso), ctx.timezone) } : {}),
      ...(startDate ? { when: `${startDate}, todo el día` } : {}),
      // With singleEvents=true the id belongs to this occurrence, so by default the
      // change does not touch the rest of the series. The user has to know which of
      // the two happened, or they will believe they moved their every-Monday meeting.
      ...(wholeSeries
        ? { note: 'El cambio se ha aplicado a TODAS las repeticiones. Dilo en tu respuesta.' }
        : before?.recurring
          ? {
              note:
                'Es una cita que se repite: el cambio afecta solo a este día, no a toda ' +
                'la serie. Dile esto al usuario.',
            }
          : {}),
      ...(url ? { url } : {}),
    },
  };
}

function describe(event: CalendarEventSummary, timezone: string): Record<string, unknown> {
  return {
    id: event.id,
    // A private event on a shared calendar with hidden details arrives with no title.
    // Saying so keeps the model from inventing what the slot is about.
    title: event.title || '(sin título: la cita es privada)',
    when: whenOf(event, timezone),
    ...(event.allDay ? { all_day: true } : {}),
    ...(event.recurring ? { recurring: true } : {}),
    // Only when the colour is one of ours: the ones the user set by hand from the app
    // mean nothing here, and translating them would be inventing data.
    ...(event.colorId && COLOR_CATEGORIES[event.colorId]
      ? { category: COLOR_CATEGORIES[event.colorId] }
      : {}),
  };
}

/** When an event starts, as an instant. An all-day one counts from its local noon. */
function startOf(event: CalendarEventSummary, timezone: string): number {
  if (event.startAt !== null) return Date.parse(event.startAt);
  if (event.startDate !== null) {
    return zonedInstant(event.startDate, 12, 0, timezone)?.getTime() ?? 0;
  }
  return 0;
}

function distanceFrom(now: Date, event: CalendarEventSummary, timezone: string): number {
  return Math.abs(startOf(event, timezone) - now.getTime());
}

/**
 * 'del 1 al 31 de agosto' is not needed; 'del 26 de septiembre de 2025 al 25 de marzo de
 * 2027' is. The year goes in only when the range crosses one, which a year-long search
 * always does and where "del 26 de septiembre al 25 de marzo" reads backwards.
 */
function rangePhrase(first: Date, last: Date, timezone: string): string {
  const yearOf = (instant: Date) => localNow(instant, timezone).date.slice(0, 4);
  if (yearOf(first) === yearOf(last)) {
    return `del ${formatDay(first, timezone)} al ${formatDay(last, timezone)}`;
  }
  return (
    `del ${formatDay(first, timezone)} de ${yearOf(first)} ` +
    `al ${formatDay(last, timezone)} de ${yearOf(last)}`
  );
}

/** The window of a search by name with no dates: a year back, half a year ahead. */
function searchWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - SEARCH_BACK_DAYS * DAY_MS),
    to: new Date(now.getTime() + SEARCH_AHEAD_DAYS * DAY_MS),
  };
}

/**
 * The answer to "¿cuándo fue la última vez?", "¿cuándo me toca?" and "¿cada cuánto?",
 * worked out here.
 *
 * Each of those is date arithmetic over the list, and handing the list to the model and
 * letting it subtract is what this project stopped doing in phase 1. So the reply carries
 * the last and the next time with how far they are, and —when there are enough past ones
 * and they are regular— the usual gap and when the next would fall. "Sueles ir cada cinco
 * semanas" is only said when it is true: an irregular list gets no pattern at all.
 */
function occurrences(
  events: CalendarEventSummary[],
  now: Date,
  timezone: string,
): Record<string, string> {
  const sorted = [...events].sort((a, b) => startOf(a, timezone) - startOf(b, timezone));
  const past = sorted.filter((event) => startOf(event, timezone) < now.getTime());
  const upcoming = sorted.filter((event) => startOf(event, timezone) >= now.getTime());

  const when = (event: CalendarEventSummary) => {
    const days = daysFromToday(new Date(startOf(event, timezone)), now, timezone);
    return `${event.title || 'cita privada'}, ${whenOf(event, timezone)} (${relativeDays(days)})`;
  };

  const result: Record<string, string> = {};
  const last = past[past.length - 1];
  const next = upcoming[0];
  if (last) result['last'] = when(last);
  if (next) result['next'] = when(next);

  if (past.length >= MIN_TIMES_FOR_PATTERN) {
    const gaps: number[] = [];
    for (let i = 1; i < past.length; i++) {
      gaps.push((startOf(past[i]!, timezone) - startOf(past[i - 1]!, timezone)) / DAY_MS);
    }
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const regular =
      average >= 1 && gaps.every((gap) => Math.abs(gap - average) <= average * PATTERN_TOLERANCE);

    result['times'] = `${past.length} veces en las fechas buscadas`;
    if (regular) {
      const every = Math.round(average);
      result['pattern'] = `de media, cada ${every} días`;
      if (!next && last) {
        const due = new Date(startOf(last, timezone) + every * DAY_MS);
        result['due_around'] =
          `${formatDay(due, timezone)} (${relativeDays(daysFromToday(due, now, timezone))}), ` +
          'si sigue su costumbre. Es una estimación: dilo así y ofrécele apuntarla.';
      }
    }
  }
  return result;
}

/** '14:00 a 15:30' — names what an appointment clashes with, without repeating the day. */
function hoursOf(event: CalendarEventSummary, timezone: string): string {
  if (event.startAt === null || event.endAt === null) return whenOf(event, timezone);
  const from = formatTime(new Date(event.startAt), timezone);
  return `${from} a ${formatTime(new Date(event.endAt), timezone)}`;
}

function whenOf(event: CalendarEventSummary, timezone: string): string {
  if (event.allDay && event.startDate !== null) {
    const first = dayName(event.startDate, timezone);
    const nights = event.endDate !== null ? (daysBetween(event.startDate, event.endDate) ?? 1) : 1;

    // Google stores the last day as exclusive, so the one the user sees is the day
    // before. Saying "23rd to 27th" when they get back on the 26th is worse than
    // saying nothing.
    if (nights > 1) {
      const last = shiftDate(event.startDate, nights - 1);
      return `del ${dayName(event.startDate, timezone, false)} al ${dayName(last, timezone, false)}`;
    }
    return `${first}, todo el día`;
  }
  return event.startAt ? formatDayAndTime(new Date(event.startAt), timezone) : 'sin hora';
}

/**
 * A day in Spanish. With the weekday when it stands alone —"domingo, 23 de agosto"—
 * and without it inside a range, where "del domingo, 23 de agosto al miércoles, 26 de
 * agosto" reads like a form.
 */
function dayName(date: string, timezone: string, withWeekday = true): string {
  const noon = zonedInstant(date, 12, 0, timezone);
  if (noon === null) return date;
  return withWeekday ? formatLongDate(noon, timezone) : formatDay(noon, timezone);
}

/** Days between two 'YYYY-MM-DD' values, or null when either is not a date. */
function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

/**
 * The range of local days `list_events` asks for.
 *
 * The end is computed by adding and then asking for local midnight again, not by
 * adding 24 h per day: the two days a year that last 23 and 25 hours would drift, and
 * the window would either swallow an hour of the next day or drop the last one.
 */
function localDayRange(day: string, days: number, timezone: string): { from: Date; to: Date } | null {
  const from = zonedInstant(day, 0, 0, timezone);
  if (from === null) return null;

  const approx = new Date(from.getTime() + days * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000);
  return { from, to: startOfLocalDay(approx, timezone) };
}

function notFound(eventId: string): ToolResult {
  return {
    ok: false,
    error:
      `No existe ninguna cita con id ${eventId}. Llama a list_events para ver las que hay ` +
      'de verdad, y no reutilices ids de mensajes anteriores: pueden haberse borrado.',
  };
}
