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
 * Google Calendar over its REST API, with plain `fetch`.
 *
 * No `googleapis`: the SDK drags half of Node into the Worker bundle, and out of the
 * whole API we use four calls.
 */

const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/** Cap for authentication inside the operation's total budget. */
const AUTH_MAX_MS = 5_000;

/** Below this the request is not worth firing: it will not make it. */
const MIN_REQUEST_MS = 1_500;

/**
 * What was being attempted when Google said no.
 *
 * A 404 means two different things depending on the operation —the calendar is not
 * shared, or the event does not exist— and sending the user to check the wrong secret
 * costs an afternoon. It already happened to us.
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
      // Expands series into their concrete occurrences. That is what allows modifying
      // "Monday's standup" without touching the rest of the series: the id it returns
      // belongs to that instance, not to the pattern.
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
      // Not existing is not a failure: it is an answer, and the caller decides what to
      // say. Every other error does propagate.
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
    // Authentication and request share a single budget instead of each having its own.
    // That is the lesson from the audio path (§10): two steps honouring their individual
    // caps blow the combined one without anybody noticing.
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

    // DELETE returns 204 with no body.
    if (!text) return null as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CalendarError('Google Calendar devolvió algo que no era JSON');
    }
  }
}

/**
 * Translates the status codes we are actually going to see.
 *
 * The message goes back to the model as `{ok:false, error}` and ends up in the chat, so
 * it says what to check without inventing the cause.
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
 * All-day events travel with `date` and timed ones with `dateTime`; mixing the two
 * fields is a 400.
 *
 * `timeZone` is sent even when the `dateTime` already carries an offset: it is what
 * Google stores with the event and what decides how it is shown to whoever opens it.
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
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    ...when,
    // The event's reminders come from Google, using the calendar's own settings. Our
    // cron does not touch this: it only knows about the `tasks` table.
    reminders: { useDefault: true },
  };
}

/**
 * Only the fields present in the patch travel.
 *
 * A `PATCH` with the whole object would blank out whatever the user set from their
 * phone —the description, the location, the guests— without anyone asking. `undefined`
 * means "leave it alone" and `null` means "clear it", which in Google's API is the
 * empty string.
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
  // With singleEvents=true the cancelled instances of a series show up too. Handing
  // those to the model would be offering it something that is no longer there.
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
    seriesId: typeof raw['recurringEventId'] === 'string' ? raw['recurringEventId'] : null,
    url: typeof raw['htmlLink'] === 'string' ? raw['htmlLink'] : null,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
