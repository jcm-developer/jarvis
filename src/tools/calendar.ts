import { createCalendarClient } from '../calendar';
import type { CalendarClient, CalendarEventPatch, CalendarEventSummary } from '../calendar/provider';
import {
  formatDay,
  formatDayAndTime,
  formatLongDate,
  localNow,
  startOfLocalDay,
  zonedInstant,
} from '../lib/localtime';
import { OFFSET_HINT, cleanTitle, honourUserInstant, resolveOffset } from './guardrails';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import {
  optionalBoolean,
  optionalInt,
  optionalIsoDate,
  optionalString,
  requireString,
} from './types';

/** Tope de cada operación contra Google: pedir el token y la llamada a la API. */
const MAX_CALENDAR_MS = 10_000;

/**
 * Por debajo de esto no se intenta. Decirle al usuario que lo repita es mejor que
 * lanzar una escritura que Cloudflare va a cancelar a mitad, dejándonos sin saber
 * si el evento se creó o no.
 */
const MIN_CALENDAR_MS = 3_000;

/** Lo que dura una cita cuando el usuario no dice hasta cuándo. */
const DEFAULT_DURATION_MINUTES = 60;

/** Ventana de `list_events` cuando no se pide un día concreto. */
const DEFAULT_SEARCH_DAYS = 7;

/** Tope de un evento de varios días. Más que eso huele a error del modelo. */
const MAX_SPAN_DAYS = 90;

/**
 * Categoría → color de Google Calendar.
 *
 * El modelo elige el TIPO de cita; el color lo elige el código. Al revés —dejarle
 * mandar un `colorId`— tendríamos los viajes de un color distinto cada semana: no
 * hay forma de que un modelo sea consistente con un número entre 1 y 11 a lo largo
 * de meses de conversaciones, y el color solo sirve si siempre es el mismo.
 *
 * Los ids son los fijos de la API: 3 uva, 7 pavo real, 6 mandarina, 10 albahaca,
 * 11 tomate, 5 banana. Sin categoría, el evento se queda con el color por defecto
 * del calendario, que es lo que el usuario ya tiene configurado.
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

/** El color de vuelta a su categoría, para poder decir de qué es una cita al listarla. */
const COLOR_CATEGORIES: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_COLORS).map(([category, color]) => [color, category]),
);

/**
 * Traduce la categoría a color, o null si no la reconoce.
 *
 * Un valor raro no es un error que merezca cortar la cita: el evento se crea sin
 * color, que es exactamente lo que pasaba antes de que esto existiera.
 */
function colorFor(args: Record<string, unknown>): string | null {
  const category = optionalString(args, 'category', 20);
  if (category === null) return null;
  return CATEGORY_COLORS[category.toLowerCase()] ?? null;
}

const NO_TIME = {
  ok: false as const,
  error:
    'No queda tiempo en este mensaje para hablar con el calendario. Dile al usuario que ' +
    'NO se ha hecho nada y que te lo repita.',
};

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
    },
    required: ['title'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = cleanTitle(requireString(args, 'title', 200));

    const allDay = optionalBoolean(args, 'all_day');
    const chosen = resolveOffset(args, 'start_in_minutes') ?? optionalIsoDate(args, 'start_at');

    // Mismas correcciones que en las tareas, y por el mismo motivo: el modelo
    // acierta la hora y falla el día. Aquí duele más que en una tarea, porque un
    // evento mal fechado ocupa un hueco de la agenda que el usuario cree libre.
    //
    // Pero NO en un evento de día completo. Ahí no hay hora, y el corrector parte
    // justamente de que la hora es buena y el día no: aplicado a un "todo el día"
    // acabaría trayéndose la cita a hoy porque no encontró un día en el mensaje.
    // Con fechas sueltas el modelo acierta; es la aritmética lo que se le da mal.
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

    // Un día completo se manda como fechas, no como instantes, y el fin es
    // exclusivo: para un solo día, el día siguiente.
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
        // +1 porque en Google el último día es exclusivo: un viaje del 23 al 26 se
        // guarda como 23 → 27. Sin ese día de más, el calendario lo pinta acabando
        // el 25 y el usuario se cree que vuelve un día antes.
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

    // El presupuesto sale del reloj del mensaje, no de un tope propio: es la regla
    // que impide que un paso nuevo se coma el tiempo de responder.
    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

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
        colorId: colorFor(args),
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
        id: event.id,
        title,
        // Se reutiliza el mismo formateo que list_events: si un viaje se guarda
        // como "del 23 al 26", el usuario tiene que leerlo igual en las dos.
        when: allDay
          ? whenOf(
              {
                id: event.id,
                title,
                startAt: null,
                endAt: null,
                startDate,
                endDate,
                allDay: true,
                recurring: false,
                colorId: null,
                url: null,
              },
              ctx.timezone,
            )
          : formatDayAndTime(start, ctx.timezone),
        start_iso: allDay ? startDate : startAt,
        all_day: allDay,
        ...(endAt ? { end_iso: endAt } : {}),
        ...(event.url ? { url: event.url } : {}),
      },
    };
  },
};

export const listEvents: ToolDefinition = {
  name: 'list_events',
  description:
    'Consulta las citas del calendario del usuario en un rango de días. Úsala cuando ' +
    'pregunte qué tiene un día ("¿qué tengo el jueves?", "¿estoy libre mañana por la ' +
    'tarde?") y SIEMPRE antes de modificar o borrar una cita, porque necesitas su id ' +
    'exacto y no puedes inventarlo.',
  parameters: {
    type: 'object',
    properties: {
      day: {
        type: 'string',
        description:
          'Día por el que empezar, en formato YYYY-MM-DD. Si no lo mandas, busca desde ' +
          'ahora en los próximos 7 días.',
      },
      days: {
        type: 'integer',
        description: 'Cuántos días mirar a partir de "day". Por defecto 1.',
      },
      query: {
        type: 'string',
        description:
          'Texto para filtrar por título o sitio ("dentista", "Marta"). Útil cuando el ' +
          'usuario se refiere a una cita concreta y no sabes qué día es.',
      },
      limit: { type: 'integer', description: 'Máximo de citas a devolver. Por defecto 20.' },
    },
    required: [],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const day = optionalString(args, 'day', 10);
    const days = optionalInt(args, 'days', 1, 62) ?? 1;

    let from: Date;
    let to: Date;

    if (day === null) {
      // Sin día, desde ahora: preguntar "¿qué tengo?" no es preguntar por lo que ya
      // ha pasado esta mañana.
      from = new Date();
      to = new Date(from.getTime() + DEFAULT_SEARCH_DAYS * 24 * 60 * 60 * 1000);
    } else {
      const range = localDayRange(day, days, ctx.timezone);
      if (range === null) {
        return { ok: false, error: `"${day}" no es una fecha válida. Usa el formato YYYY-MM-DD.` };
      }
      ({ from, to } = range);
    }

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const client = createCalendarClient(ctx.env);
    const events = await client.listEvents(
      {
        from: from.toISOString(),
        to: to.toISOString(),
        query: optionalString(args, 'query', 100),
        limit: optionalInt(args, 'limit', 1, 50) ?? 20,
      },
      budget,
    );

    return {
      ok: true,
      data: {
        count: events.length,
        events: events.map((event) => describe(event, ctx.timezone)),
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
    },
    required: ['event_id'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const eventId = requireString(args, 'event_id', 1024);

    const patch: CalendarEventPatch = { timezone: ctx.timezone };
    if (args['title'] !== undefined) patch.title = cleanTitle(requireString(args, 'title', 200));
    if (args['location'] !== undefined) patch.location = optionalString(args, 'location', 300);
    if (args['description'] !== undefined) patch.description = optionalString(args, 'description');

    if (args['category'] !== undefined) {
      const color = colorFor(args);
      // Una categoría que no reconocemos no cambia el color en vez de ponerlo a
      // vacío: dejar el evento gris no es lo que pedía nadie.
      if (color !== null) patch.colorId = color;
    }

    const touchesStart = args['start_at'] !== undefined || args['start_in_minutes'] !== undefined;
    const touchesEnd = args['end_at'] !== undefined || args['duration_minutes'] !== undefined;

    if (!touchesStart && !touchesEnd && Object.keys(patch).length === 1) {
      return {
        ok: false,
        error:
          'No has indicado qué cambiar. Manda al menos uno de: title, start_at, ' +
          'start_in_minutes, duration_minutes, end_at, location o description.',
      };
    }

    if (touchesStart || touchesEnd) {
      // Hay que leer el evento ANTES de decidir la hora nueva, por dos razones.
      // Una: mover el inicio sin tocar el final dejaría una cita de duración
      // absurda, y la que tenía solo la sabe Google —"muévela al viernes" es la
      // misma cita otro día, no una cita de otra longitud—. Y dos: si el evento es
      // de día completo no hay que aplicarle el corrector de día, porque no tiene
      // hora sobre la que corregir.
      let budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
      if (budget < MIN_CALENDAR_MS) return NO_TIME;

      const client = createCalendarClient(ctx.env);
      const current = await client.getEvent(eventId, budget);
      if (current === null) return notFound(eventId);

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

      budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
      if (budget < MIN_CALENDAR_MS) return NO_TIME;

      const updated = await client.updateEvent(eventId, patch, budget);
      return report(eventId, patch, current, ctx, updated.url);
    }

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const updated = await createCalendarClient(ctx.env).updateEvent(eventId, patch, budget);
    return report(eventId, patch, null, ctx, updated.url);
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
    },
    required: ['event_id'],
  },
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const eventId = typeof args['event_id'] === 'string' ? args['event_id'] : '';
    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);

    // Se pregunta por el título, no por el id: "¿borro la cita 7f3a-...?" no lo
    // revisa nadie. Si no se puede leer, se pregunta en genérico antes que fallar:
    // lo que no puede pasar es borrar sin preguntar.
    if (budget >= MIN_CALENDAR_MS && eventId) {
      try {
        const event = await createCalendarClient(ctx.env).getEvent(eventId, budget);
        if (event) {
          const shown = event.title || 'esa cita';
          return `¿Borro del calendario "${shown}" (${whenOf(event, ctx.timezone)})?`;
        }
      } catch {
        // Da igual por qué: se cae al texto genérico.
      }
    }
    return '¿Borro esa cita del calendario?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const eventId = requireString(args, 'event_id', 1024);

    const budget = ctx.deadline.budgetFor(MAX_CALENDAR_MS);
    if (budget < MIN_CALENDAR_MS) return NO_TIME;

    const client = createCalendarClient(ctx.env);
    await client.deleteEvent(eventId, budget);

    console.info(
      JSON.stringify({ event: 'calendar_event_deleted', provider: client.name, event_id: eventId }),
    );

    return { ok: true, data: { deleted: true } };
  },
};

/**
 * Calcula el nuevo inicio y fin conservando lo que el usuario no ha pedido cambiar.
 *
 * Tres casos: mueve el inicio y no dice duración (se conserva la que tenía), cambia
 * la duración sin mover el inicio, y evento de día completo (se mueve el día).
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

    // Conserva los días que ocupaba. Sin esto, mover un viaje del 23 al 26 lo
    // dejaría en un solo día: el usuario pide cambiar cuándo empieza, no cuánto dura.
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
    // Ni fin ni duración: conserva la que tenía. Es lo que quiere decir "muévela".
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
): ToolResult {
  const startIso = patch.startAt ?? null;
  const startDate = patch.startDate ?? null;

  console.info(
    JSON.stringify({
      event: 'calendar_event_updated',
      event_id: eventId,
      start: startIso ?? startDate,
      recurring: before?.recurring ?? null,
    }),
  );

  return {
    ok: true,
    data: {
      id: eventId,
      ...(patch.title ? { title: patch.title } : {}),
      ...(startIso ? { when: formatDayAndTime(new Date(startIso), ctx.timezone) } : {}),
      ...(startDate ? { when: `${startDate}, todo el día` } : {}),
      // Con singleEvents=true el id es el de esta repetición, así que el cambio no
      // toca el resto de la serie. El usuario tiene que saberlo o creerá que ha
      // movido su reunión de todos los lunes.
      ...(before?.recurring
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
    // Un evento privado en un calendario compartido con detalles ocultos llega sin
    // título. Decirlo evita que el modelo se invente de qué es el hueco.
    title: event.title || '(sin título: la cita es privada)',
    when: whenOf(event, timezone),
    ...(event.allDay ? { all_day: true } : {}),
    ...(event.recurring ? { recurring: true } : {}),
    // Solo si el color es uno de los nuestros: los que el usuario haya puesto a mano
    // desde la app no significan nada aquí y traducirlos sería inventarse un dato.
    ...(event.colorId && COLOR_CATEGORIES[event.colorId]
      ? { category: COLOR_CATEGORIES[event.colorId] }
      : {}),
  };
}

function whenOf(event: CalendarEventSummary, timezone: string): string {
  if (event.allDay && event.startDate !== null) {
    const first = dayName(event.startDate, timezone);
    const nights = event.endDate !== null ? (daysBetween(event.startDate, event.endDate) ?? 1) : 1;

    // Google guarda el último día en exclusivo, así que el que ve el usuario es el
    // anterior. Decir "del 23 al 27" cuando vuelve el 26 es peor que no decir nada.
    if (nights > 1) {
      const last = shiftDate(event.startDate, nights - 1);
      return `del ${dayName(event.startDate, timezone, false)} al ${dayName(last, timezone, false)}`;
    }
    return `${first}, todo el día`;
  }
  return event.startAt ? formatDayAndTime(new Date(event.startAt), timezone) : 'sin hora';
}

/**
 * Un día en castellano. Con el día de la semana cuando va solo —"domingo, 23 de
 * agosto"— y sin él en un rango, donde "del domingo, 23 de agosto al miércoles, 26
 * de agosto" se lee como un formulario.
 */
function dayName(date: string, timezone: string, withWeekday = true): string {
  const noon = zonedInstant(date, 12, 0, timezone);
  if (noon === null) return date;
  return withWeekday ? formatLongDate(noon, timezone) : formatDay(noon, timezone);
}

/**
 * Aritmética de fechas sueltas, sin zona horaria.
 *
 * Un 'YYYY-MM-DD' no es un instante, así que aquí no hay que pasar por `Intl`: se
 * suman días en UTC y se vuelve a formatear. Meter la zona en medio es lo que hace
 * que un viaje amanezca un día antes.
 */
function shiftDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Días entre dos 'YYYY-MM-DD', o null si alguna no es una fecha. */
function daysBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

/**
 * El rango de días locales que pide `list_events`.
 *
 * El final se calcula sumando y volviendo a pedir la medianoche local, no sumando
 * 24 h por día: los dos días del año que duran 23 y 25 horas se descuadrarían y la
 * ventana se comería una hora del día siguiente o dejaría fuera la última.
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
