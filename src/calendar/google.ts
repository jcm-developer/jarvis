import type { Env } from '../types';
import { getAccessToken } from './google-auth';
import type {
  CalendarClient,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarEventSummary,
  CalendarSearch,
} from './provider';
import { CalendarError } from './provider';

/**
 * Google Calendar por su API REST, con `fetch` directo.
 *
 * Sin `googleapis`: el SDK arrastra medio Node al bundle del Worker y de toda la
 * API usamos cuatro llamadas.
 */

const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/** Tope de la autenticación dentro del presupuesto total de la operación. */
const AUTH_MAX_MS = 5_000;

/** Por debajo de esto no merece la pena lanzar la petición: no va a llegar. */
const MIN_REQUEST_MS = 1_500;

/**
 * Qué se estaba haciendo cuando Google dijo que no.
 *
 * Un 404 significa dos cosas distintas según la operación —el calendario no está
 * compartido, o el evento no existe— y mandar al usuario a revisar el secret
 * equivocado cuesta una tarde. Ya nos pasó.
 */
type Operation = 'calendar' | 'event';

export class GoogleCalendar implements CalendarClient {
  readonly name = 'google';

  constructor(
    private readonly env: Env,
    private readonly calendarId: string,
  ) {}

  async createEvent(input: CalendarEventInput, timeoutMs: number): Promise<CalendarEvent> {
    const created = await this.call<Record<string, unknown>>(
      { method: 'POST', path: '', body: toGoogleEvent(input), operation: 'calendar' },
      timeoutMs,
    );
    return toEvent(created);
  }

  async listEvents(search: CalendarSearch, timeoutMs: number): Promise<CalendarEventSummary[]> {
    const params = new URLSearchParams({
      timeMin: search.from,
      timeMax: search.to,
      // Expande las series en sus repeticiones concretas. Es lo que permite
      // modificar "el standup del lunes" sin tocar el resto de la serie: el id
      // que devuelve es el de esa instancia, no el del patrón.
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(search.limit),
    });
    if (search.query) params.set('q', search.query);

    const page = await this.call<Record<string, unknown>>(
      { method: 'GET', path: `?${params.toString()}`, body: null, operation: 'calendar' },
      timeoutMs,
    );

    const items = Array.isArray(page['items']) ? page['items'] : [];
    return items
      .map((item) => toSummary(item))
      .filter((event): event is CalendarEventSummary => event !== null);
  }

  async getEvent(eventId: string, timeoutMs: number): Promise<CalendarEventSummary | null> {
    try {
      const raw = await this.call<Record<string, unknown>>(
        { method: 'GET', path: `/${encodeURIComponent(eventId)}`, body: null, operation: 'event' },
        timeoutMs,
      );
      return toSummary(raw);
    } catch (error) {
      // Que no exista no es un fallo: es una respuesta, y quien llama decide qué
      // decir. Los demás errores sí suben.
      if (error instanceof CalendarError && (error.status === 404 || error.status === 410)) {
        return null;
      }
      throw error;
    }
  }

  async updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    timeoutMs: number,
  ): Promise<CalendarEvent> {
    const updated = await this.call<Record<string, unknown>>(
      {
        method: 'PATCH',
        path: `/${encodeURIComponent(eventId)}`,
        body: toGooglePatch(patch),
        operation: 'event',
      },
      timeoutMs,
    );
    return toEvent(updated);
  }

  async deleteEvent(eventId: string, timeoutMs: number): Promise<void> {
    await this.call<null>(
      { method: 'DELETE', path: `/${encodeURIComponent(eventId)}`, body: null, operation: 'event' },
      timeoutMs,
    );
  }

  private async call<T>(
    request: {
      method: string;
      path: string;
      body: Record<string, unknown> | null;
      operation: Operation;
    },
    timeoutMs: number,
  ): Promise<T> {
    // Autenticación y petición comparten un solo presupuesto en vez de tener cada
    // una el suyo. Es la lección del audio (§10): dos pasos que cumplen su tope
    // individual se salen del conjunto sin que nadie lo note.
    const started = Date.now();
    const token = await getAccessToken(this.env, Math.min(AUTH_MAX_MS, timeoutMs));
    const left = timeoutMs - (Date.now() - started);

    if (left < MIN_REQUEST_MS) {
      throw new CalendarError('me quedé sin tiempo tras autenticar contra Google');
    }

    const url = `${API_BASE}/${encodeURIComponent(this.calendarId)}/events${request.path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(left),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CalendarError(`no se pudo alcanzar Google Calendar: ${detail}`);
    }

    const text = await response.text();

    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: 'calendar_request_failed',
          method: request.method,
          status: response.status,
          calendar_id: this.calendarId,
          body: text.slice(0, 300),
        }),
      );
      throw new CalendarError(explain(response.status, request.operation), response.status);
    }

    // DELETE devuelve 204 sin cuerpo.
    if (!text) return null as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CalendarError('Google Calendar devolvió algo que no era JSON');
    }
  }
}

/**
 * Traduce los códigos que de verdad vamos a ver.
 *
 * El mensaje vuelve al modelo como `{ok:false, error}` y acaba en el chat, así que
 * dice qué revisar sin inventarse la causa.
 */
function explain(status: number, operation: Operation): string {
  if (status === 404 || status === 410) {
    if (operation === 'event') {
      return (
        'Ese evento ya no existe en el calendario. Puede que se borrara desde el móvil, o ' +
        'que el id no sea bueno: llama a list_events para ver los que hay de verdad.'
      );
    }
    return (
      'Google no encuentra ese calendario. Revisa el secret GOOGLE_CALENDAR_ID y que el ' +
      'calendario esté compartido con la service account: cuando no tiene acceso, la API ' +
      'responde 404 y no 403, porque para ella ese calendario no existe.'
    );
  }
  if (status === 403) {
    return (
      'Google no me deja tocar ese calendario. El permiso compartido tiene que ser de ' +
      'escritura ("Make changes"), y la Google Calendar API estar habilitada en el proyecto.'
    );
  }
  if (status === 401) {
    return 'Google rechazó el token. Revisa GOOGLE_SA_EMAIL y GOOGLE_SA_PRIVATE_KEY.';
  }
  return `Google Calendar devolvió ${status}`;
}

/**
 * Los eventos de día completo van con `date` y los de hora con `dateTime`; mezclar
 * los dos campos es un 400.
 *
 * `timeZone` se manda aunque el `dateTime` ya lleve desplazamiento: es lo que
 * guarda Google con el evento y lo que decide cómo se muestra a quien lo abre.
 */
function toGoogleEvent(input: CalendarEventInput): Record<string, unknown> {
  const when =
    input.startDate !== null
      ? { start: { date: input.startDate }, end: { date: input.endDate ?? input.startDate } }
      : {
          start: { dateTime: input.startAt, timeZone: input.timezone },
          end: { dateTime: input.endAt, timeZone: input.timezone },
        };

  return {
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.colorId ? { colorId: input.colorId } : {}),
    ...when,
    // Los avisos del evento los da Google con la configuración del propio
    // calendario. Nuestro cron no toca esto: solo sabe de la tabla `tasks`.
    reminders: { useDefault: true },
  };
}

/**
 * Solo viajan los campos presentes en el patch.
 *
 * Un `PATCH` con el objeto entero sobrescribiría con vacío lo que el usuario tenga
 * puesto desde el móvil —la descripción, el sitio, los invitados— sin haberlo
 * pedido. `undefined` significa "no lo toques" y `null` "bórralo", que en la API
 * de Google es la cadena vacía.
 */
function toGooglePatch(patch: CalendarEventPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (patch.title !== undefined) body['summary'] = patch.title;
  if (patch.description !== undefined) body['description'] = patch.description ?? '';
  if (patch.location !== undefined) body['location'] = patch.location ?? '';
  if (patch.colorId !== undefined) body['colorId'] = patch.colorId;

  if (patch.startDate !== undefined) body['start'] = { date: patch.startDate };
  else if (patch.startAt !== undefined) {
    body['start'] = { dateTime: patch.startAt, timeZone: patch.timezone };
  }

  if (patch.endDate !== undefined) body['end'] = { date: patch.endDate };
  else if (patch.endAt !== undefined) {
    body['end'] = { dateTime: patch.endAt, timeZone: patch.timezone };
  }

  return body;
}

function toEvent(raw: Record<string, unknown>): CalendarEvent {
  if (typeof raw['id'] !== 'string') {
    throw new CalendarError('Google Calendar no devolvió el id del evento');
  }
  return {
    id: raw['id'],
    url: typeof raw['htmlLink'] === 'string' ? raw['htmlLink'] : null,
  };
}

function toSummary(value: unknown): CalendarEventSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw['id'] !== 'string') return null;
  // Con singleEvents=true aparecen también las instancias canceladas de una serie.
  // Ofrecérselas al modelo sería ofrecerle mover algo que ya no está.
  if (raw['status'] === 'cancelled') return null;

  const start = asObject(raw['start']);
  const end = asObject(raw['end']);
  const allDay = typeof start['date'] === 'string';

  return {
    id: raw['id'],
    title: typeof raw['summary'] === 'string' ? raw['summary'] : '',
    startAt: !allDay && typeof start['dateTime'] === 'string' ? start['dateTime'] : null,
    endAt: !allDay && typeof end['dateTime'] === 'string' ? end['dateTime'] : null,
    startDate: allDay && typeof start['date'] === 'string' ? start['date'] : null,
    endDate: allDay && typeof end['date'] === 'string' ? end['date'] : null,
    allDay,
    colorId: typeof raw['colorId'] === 'string' ? raw['colorId'] : null,
    recurring: typeof raw['recurringEventId'] === 'string',
    url: typeof raw['htmlLink'] === 'string' ? raw['htmlLink'] : null,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
