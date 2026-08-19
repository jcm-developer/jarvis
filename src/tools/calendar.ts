import { createCalendarClient } from '../calendar';
import { formatDayAndTime, formatLongDate, localNow, localTomorrow } from '../lib/localtime';
import { OFFSET_HINT, cleanTitle, honourUserInstant, resolveOffset } from './guardrails';
import type { ToolDefinition, ToolResult } from './types';
import {
  optionalBoolean,
  optionalInt,
  optionalIsoDate,
  optionalString,
  requireString,
} from './types';

/** Tope de toda la operación contra Google: pedir el token y escribir el evento. */
const MAX_CALENDAR_MS = 10_000;

/**
 * Por debajo de esto no se intenta. Decirle al usuario que lo repita es mejor que
 * lanzar una escritura que Cloudflare va a cancelar a mitad, dejándonos sin saber
 * si el evento se creó o no.
 */
const MIN_CALENDAR_MS = 3_000;

/** Lo que dura una cita cuando el usuario no dice hasta cuándo. */
const DEFAULT_DURATION_MINUTES = 60;

export const createEvent: ToolDefinition = {
  name: 'create_event',
  description:
    'Crea una cita en el calendario del usuario: algo que ocurre a una hora concreta y ' +
    'ocupa un hueco de su día (una reunión, el médico, una comida, un viaje, un ' +
    'cumpleaños). No la uses para un recado que hay que hacer pero no ocupa agenda ' +
    '("comprar pan", "llamar a David"): eso es create_task. Si dudas entre las dos, ' +
    'pregúntaselo. Solo puedes añadir citas: no puedes consultar ni modificar lo que ' +
    'ya hay en el calendario.',
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
      location: { type: 'string', description: 'Dónde es, si lo dice.' },
      description: { type: 'string', description: 'Detalles adicionales, si los hay.' },
    },
    required: ['title'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = cleanTitle(requireString(args, 'title', 200));

    // Mismas correcciones que en las tareas, y por el mismo motivo: el modelo
    // acierta la hora y falla el día. Aquí duele más que en una tarea, porque un
    // evento mal fechado ocupa un hueco de la agenda que el usuario cree libre.
    const startAt = honourUserInstant(
      resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at'),
      ctx,
      'start_at',
    );

    if (startAt === null) {
      return {
        ok: false,
        error:
          'Falta cuándo empieza la cita. Manda start_at en ISO 8601, o start_in_minutes si ' +
          'el usuario habló en relativo. Si no lo ha dicho, pregúntaselo.',
      };
    }

    const allDay = optionalBoolean(args, 'all_day');
    const start = new Date(startAt);

    // Un día completo se manda como fechas, no como instantes, y el fin es
    // exclusivo: para un solo día, el día siguiente.
    const startDate = allDay ? localNow(start, ctx.timezone).date : null;
    const endDate = allDay ? localTomorrow(start, ctx.timezone) : null;

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

    // El presupuesto sale del reloj del mensaje, no de un tope propio: es la regla
    // que impide que un paso nuevo se coma el tiempo de responder.
    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) {
      return {
        ok: false,
        error:
          'No queda tiempo en este mensaje para escribir en el calendario. Dile al usuario que ' +
          'la cita NO se ha creado y que te la repita.',
      };
    }

    // Los errores de configuración y los de Google salen como CalendarError y los
    // recoge el agente: vuelven al modelo como {ok:false, error}, nunca al usuario
    // como excepción.
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

    // `when` en castellano para que el modelo repita la fecha en su respuesta y el
    // usuario pueda corregirla en el acto. Sin esto vuelve a recitar el ISO.
    return {
      ok: true,
      data: {
        title,
        when: allDay
          ? `${formatLongDate(start, ctx.timezone)}, todo el día`
          : formatDayAndTime(start, ctx.timezone),
        start_iso: allDay ? startDate : startAt,
        all_day: allDay,
        ...(endAt ? { end_iso: endAt } : {}),
        ...(event.url ? { url: event.url } : {}),
      },
    };
  },
};
