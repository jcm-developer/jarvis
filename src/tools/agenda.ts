import { createCalendarClient } from '../calendar';
import type { CalendarEventSummary } from '../calendar/provider';
import type { TaskRow } from '../db/types';
import {
  endOfLocalDay,
  formatLongDate,
  formatTime,
  localNow,
  localTomorrow,
  shiftDate,
  zonedInstant,
} from '../lib/localtime';
import type { Interval } from '../lib/slots';
import { freeGaps } from '../lib/slots';
import { MAX_CALENDAR_MS, MIN_CALENDAR_MS, NO_TIME, busyIntervals } from './calendar';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { optionalInt, optionalString } from './types';

/**
 * The two tools that cross the calendar with the task list: free slots (Phase 8) and
 * "what should I do now?" (Phase 9).
 *
 * They live together, and apart from calendar.ts, because they share the same idea —
 * the one this project keeps coming back to: **the model asks, the code computes**. A
 * free slot and the minutes left until the next appointment are hour arithmetic, and
 * that is what an LLM gets wrong without raising any error: it invents a plausible
 * gap and reports it as confidently as when it gets it right.
 */

/** Longest range a slot search may span. Beyond this it becomes bulk reading. */
const MAX_SLOT_DAYS = 14;

/** Default minimum gap: anything under half an hour is no use for anything. */
const DEFAULT_SLOT_MINUTES = 30;

/** Appointments read to compute the gaps across the whole range. */
const BUSY_EVENT_LIMIT = 100;

/** Today's appointments read by what_now. A single day never has more. */
const TODAY_EVENT_LIMIT = 20;

/** Gaps start on a 5-minute mark: "12:35 to 14:00" reads, "12:33" does not. */
const ROUND_UP_MS = 5 * 60_000;

/** Tasks scanned to decide what to suggest. The query already sorts them. */
const TASK_SCAN_LIMIT = 25;

/** How many get suggested. Dumping the whole list is what makes it stop being useful. */
const MAX_SUGGESTIONS = 3;

export const findFreeSlots: ToolDefinition = {
  name: 'find_free_slots',
  description:
    'Busca los huecos libres del calendario del usuario: los ratos en los que no tiene ' +
    'ninguna cita. Úsala cuando pregunte cuándo tiene tiempo, si está libre a una hora o ' +
    'cuando haya que proponerle un momento para algo ("¿cuándo tengo dos horas esta ' +
    'semana?", "¿qué tardes tengo libres?", "¿me cabe el fisio el martes?"). NUNCA ' +
    'deduzcas los huecos tú mirando list_events: la aritmética de horas la hago yo.',
  parameters: {
    type: 'object',
    properties: {
      day: {
        type: 'string',
        description: 'Día por el que empezar, en formato YYYY-MM-DD. Si no lo mandas, desde hoy.',
      },
      days: {
        type: 'integer',
        description:
          'Cuántos días mirar a partir de "day". Por defecto 1. Para "esta semana", 7. ' +
          `Máximo ${MAX_SLOT_DAYS}.`,
      },
      minutes: {
        type: 'integer',
        description:
          'Duración mínima del hueco, en minutos. Mándala cuando el usuario diga para qué ' +
          `es ("dos horas" son 120). Por defecto ${DEFAULT_SLOT_MINUTES}.`,
      },
      from_hour: {
        type: 'integer',
        description:
          'Hora local (0-23) desde la que buscar, solo si el usuario limita la franja: ' +
          '"por la tarde" es 15, "a partir de las diez" es 10. Si no lo dice, no lo mandes ' +
          'y uso su horario normal.',
      },
      to_hour: {
        type: 'integer',
        description:
          'Hora local (1-24) hasta la que buscar, con el mismo criterio: "por la mañana" es ' +
          '14. 24 es la medianoche.',
      },
    },
    required: [],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const now = new Date();
    const firstDay = optionalString(args, 'day', 10) ?? localNow(now, ctx.timezone).date;
    const days = optionalInt(args, 'days', 1, MAX_SLOT_DAYS) ?? 1;
    const minutes = optionalInt(args, 'minutes', 5, 12 * 60) ?? DEFAULT_SLOT_MINUTES;
    const fromHour = optionalInt(args, 'from_hour', 0, 23) ?? ctx.config.dayStartHour;
    const toHour = optionalInt(args, 'to_hour', 1, 24) ?? ctx.config.dayEndHour;

    if (fromHour >= toHour) {
      return {
        ok: false,
        error:
          `La franja está al revés: from_hour (${fromHour}) tiene que ser menor que to_hour ` +
          `(${toHour}). Si el usuario quería otra cosa, pregúntaselo.`,
      };
    }

    const windows: { date: string; window: Interval }[] = [];
    for (let index = 0; index < days; index += 1) {
      const date = shiftDate(firstDay, index);
      const opens = zonedInstant(date, fromHour, 0, ctx.timezone);
      // A window ending "at 24" ends at the next day's midnight. It is requested as
      // such instead of 23:59, which would leave a minute out of every single day.
      const closes =
        toHour === 24
          ? zonedInstant(shiftDate(date, 1), 0, 0, ctx.timezone)
          : zonedInstant(date, toHour, 0, ctx.timezone);

      if (opens === null || closes === null) {
        return {
          ok: false,
          error: `"${firstDay}" no es una fecha válida. Usa el formato YYYY-MM-DD.`,
        };
      }

      // A gap that already went by is not a gap: for today, only what is left counts.
      // And it gets rounded up because "12:35 to 14:00" reads like a person talking,
      // while "12:33 to 14:00" reads like machine output.
      const opensAt = Math.max(
        opens.getTime(),
        Math.ceil(now.getTime() / ROUND_UP_MS) * ROUND_UP_MS,
      );
      if (closes.getTime() - opensAt >= minutes * 60_000) {
        windows.push({ date, window: { start: opensAt, end: closes.getTime() } });
      }
    }

    if (windows.length === 0) {
      return {
        ok: true,
        data: {
          count: 0,
          slots: [],
          notes: [
            'Esa franja ya ha pasado, o es más corta que el hueco que se busca. Ofrécele ' +
              'mirar otro día o un rato más corto, y no te inventes ningún hueco.',
          ],
        },
      };
    }

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const client = createCalendarClient(ctx.env);
    const events = await client.listEvents(
      {
        from: new Date(windows[0]!.window.start).toISOString(),
        to: new Date(windows[windows.length - 1]!.window.end).toISOString(),
        query: null,
        limit: BUSY_EVENT_LIMIT,
      },
      budget,
    );

    const busy = busyIntervals(events);
    const slots = windows.flatMap(({ date, window }) =>
      freeGaps(window, busy, minutes * 60_000).map((gap) => ({
        day: dayLabel(date, now, ctx.timezone),
        from: formatTime(new Date(gap.start), ctx.timezone),
        to: formatTime(new Date(gap.end), ctx.timezone),
        minutes: Math.round((gap.end - gap.start) / 60_000),
      })),
    );

    const notes: string[] = [];
    if (slots.length === 0) {
      notes.push(
        `No hay ningún hueco de ${minutes} minutos en esa franja. Dilo tal cual y ofrece ` +
          'mirar otros días o un rato más corto.',
      );
    }
    // Without this, a range holding more appointments than fit in one page would be
    // reported as "I checked everything" having checked half of it.
    if (events.length >= BUSY_EVENT_LIMIT) {
      notes.push(
        `Había ${BUSY_EVENT_LIMIT} citas o más en el rango y solo he mirado las primeras, ` +
          'así que puede que me falte ocupación. Dile que pregunte por menos días de golpe.',
      );
    }

    return {
      ok: true,
      data: {
        count: slots.length,
        searched: `${padHour(fromHour)}:00-${padHour(toHour)}:00`,
        minimum_minutes: minutes,
        slots,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  },
};

export const whatNow: ToolDefinition = {
  name: 'what_now',
  description:
    'Responde a "¿qué hago ahora?": cuánto rato libre le queda hasta su próxima cita y ' +
    'qué tiene pendiente que encaje. Úsala cuando pregunte qué hacer, qué es lo ' +
    'siguiente, si le da tiempo a algo, o cuando diga que tiene un rato muerto. Ya viene ' +
    'todo cruzado: no llames además a list_tasks ni a list_events.',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresConfirmation: false,
  handler: async (_args, ctx): Promise<ToolResult> => {
    const now = new Date();
    const endOfDay = endOfLocalDay(now, ctx.timezone);

    const pending = await ctx.db.select<TaskRow>('tasks', {
      filters: { user_id: `eq.${ctx.userId}`, status: 'eq.pending' },
      order: 'due_at.asc.nullslast,priority.asc',
      limit: TASK_SCAN_LIMIT,
    });

    const relevant = whatFitsNow(pending, now, endOfDay);
    const agenda = await todaysAgenda(now, endOfDay, ctx);

    const notes: string[] = [
      // The Phase 9 example was "two of your pending things fit", and that cannot be
      // asserted: a task carries no estimated duration, so "it fits" is a hunch, not
      // a calculation. Suggesting is fine; passing off as measured what was never
      // measured is not. Same rule that forbids inventing a date.
      'Las tareas no llevan duración, así que no digas cuántas "le caben" como si lo ' +
        'hubieras calculado: dile el rato libre que tiene y qué opciones hay.',
    ];

    if (agenda === null) {
      notes.push(
        'No he podido leer el calendario, así que esto solo cuenta sus tareas. Dilo en la ' +
          'respuesta en vez de dar por hecho que no tiene citas.',
      );
    }
    if (relevant.length === 0) {
      notes.push(
        'No tiene nada pendiente para hoy. Dilo en una frase y no le propongas tareas que ' +
          'no te haya dado yo.',
      );
    } else if (relevant.length > MAX_SUGGESTIONS) {
      notes.push(
        `Le quedan ${relevant.length - MAX_SUGGESTIONS} cosas más para hoy además de estas; ` +
          'no las enumeres si no las pide.',
      );
    }

    return {
      ok: true,
      data: {
        time: formatTime(now, ctx.timezone),
        ...(agenda ?? {}),
        pending: relevant.slice(0, MAX_SUGGESTIONS).map((entry) => ({
          id: entry.task.id,
          title: entry.task.title,
          why: entry.why,
        })),
        notes,
      },
    };
  },
};

/**
 * What makes sense to suggest right now, in order.
 *
 * Same criteria as the briefing, for the same reason: what is overdue, what is due
 * today, and what matters with no date on it. A task with neither a date nor a
 * priority stays out — that is the inventory, not the day — and dumping the whole
 * thing is what makes the user stop asking.
 */
function whatFitsNow(
  tasks: TaskRow[],
  now: Date,
  endOfDay: Date,
): { task: TaskRow; why: string }[] {
  const overdue: { task: TaskRow; why: string }[] = [];
  const today: { task: TaskRow; why: string }[] = [];
  const important: { task: TaskRow; why: string }[] = [];

  for (const task of tasks) {
    const due = task.due_at === null ? null : Date.parse(task.due_at);
    if (due !== null && Number.isFinite(due)) {
      if (due < now.getTime()) overdue.push({ task, why: 'se le pasó' });
      else if (due <= endOfDay.getTime()) today.push({ task, why: 'vence hoy' });
      continue;
    }
    if (task.priority === 1) important.push({ task, why: 'prioridad alta, sin fecha' });
  }

  return [...overdue, ...today, ...important];
}

/**
 * What is going on right now and what comes next, today.
 *
 * Returns null when the calendar cannot be read, and that does NOT abort the tool:
 * it is the same split as in the cron, where every job carries its own try so that
 * one failure does not leave the user without the other. On a "what should I do?",
 * losing the tasks because Google returned a 500 would trade a useful answer for an
 * error.
 */
async function todaysAgenda(
  now: Date,
  endOfDay: Date,
  ctx: ToolContext,
): Promise<Record<string, unknown> | null> {
  const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
  if (budget < MIN_CALENDAR_MS) return null;

  let events: CalendarEventSummary[];
  try {
    const client = createCalendarClient(ctx.env);
    events = await client.listEvents(
      {
        from: now.toISOString(),
        to: endOfDay.toISOString(),
        query: null,
        limit: TODAY_EVENT_LIMIT,
      },
      budget,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'what_now_calendar_failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }

  const timed = events.filter(
    (event) => !event.allDay && event.startAt !== null && event.endAt !== null,
  );
  const inProgress = timed.find(
    (event) =>
      Date.parse(event.startAt!) <= now.getTime() && Date.parse(event.endAt!) > now.getTime(),
  );
  const next = timed.find((event) => Date.parse(event.startAt!) > now.getTime());

  // All-day entries take up no slot, but knowing the user is travelling today changes
  // what makes sense to suggest, so they travel as context and not as busy time.
  const allDay = events.filter((event) => event.allDay).map((event) => titleOf(event));

  return {
    ...(inProgress
      ? {
          in_progress: {
            title: titleOf(inProgress),
            until: formatTime(new Date(inProgress.endAt!), ctx.timezone),
          },
        }
      : {}),
    next: next
      ? {
          title: titleOf(next),
          at: formatTime(new Date(next.startAt!), ctx.timezone),
          free_minutes: Math.floor((Date.parse(next.startAt!) - now.getTime()) / 60_000),
        }
      : null,
    ...(next === undefined ? { nothing_else_today: true } : {}),
    ...(allDay.length > 0 ? { all_day_today: allDay } : {}),
  };
}

/**
 * A private event arrives with no title, and saying so keeps the model from making up
 * what the slot is about. Same convention as list_events.
 */
function titleOf(event: CalendarEventSummary): string {
  return event.title || '(sin título: la cita es privada)';
}

/** 'hoy', 'mañana' or 'jueves, 21 de agosto'. Nobody says "2026-08-21". */
function dayLabel(date: string, now: Date, timezone: string): string {
  if (date === localNow(now, timezone).date) return 'hoy';
  if (date === localTomorrow(now, timezone)) return 'mañana';

  // Noon to name the day: any hour would do, and 12:00 never slips into the previous
  // or the next day in any time zone.
  const noon = zonedInstant(date, 12, 0, timezone);
  return noon === null ? date : formatLongDate(noon, timezone);
}

function padHour(hour: number): string {
  return String(hour).padStart(2, '0');
}
