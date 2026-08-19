import type { Env } from '../types';
import { getAccessToken } from './google-auth';
import type { CalendarClient, CalendarEvent, CalendarEventInput } from './provider';
import { CalendarError } from './provider';

/**
 * Google Calendar por su API REST, con `fetch` directo.
 *
 * Sin `googleapis`: el SDK arrastra medio Node al bundle del Worker y de toda la
 * API usamos un POST.
 */

const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/** Tope de la autenticación dentro del presupuesto total de la operación. */
const AUTH_MAX_MS = 5_000;

/** Por debajo de esto no merece la pena lanzar la escritura: no va a llegar. */
const MIN_WRITE_MS = 1_500;

export class GoogleCalendar implements CalendarClient {
  readonly name = 'google';

  constructor(
    private readonly env: Env,
    private readonly calendarId: string,
  ) {}

  async createEvent(input: CalendarEventInput, timeoutMs: number): Promise<CalendarEvent> {
    // Autenticación y escritura comparten un solo presupuesto en vez de tener
    // cada una el suyo. Es la lección del audio (§10): dos pasos que cumplen su
    // tope individual se salen del conjunto sin que nadie lo note.
    const started = Date.now();
    const token = await getAccessToken(this.env, Math.min(AUTH_MAX_MS, timeoutMs));
    const left = timeoutMs - (Date.now() - started);

    if (left < MIN_WRITE_MS) {
      throw new CalendarError('me quedé sin tiempo tras autenticar contra Google');
    }

    const url = `${API_BASE}/${encodeURIComponent(this.calendarId)}/events`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toGoogleEvent(input)),
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
          event: 'calendar_insert_failed',
          status: response.status,
          calendar_id: this.calendarId,
          body: text.slice(0, 300),
        }),
      );
      throw new CalendarError(explain(response.status), response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CalendarError('Google Calendar devolvió algo que no era JSON');
    }

    const created = parsed as { id?: unknown; htmlLink?: unknown };
    if (typeof created.id !== 'string') {
      throw new CalendarError('Google Calendar no devolvió el id del evento');
    }

    return {
      id: created.id,
      url: typeof created.htmlLink === 'string' ? created.htmlLink : null,
    };
  }
}

/**
 * Traduce los códigos que de verdad vamos a ver la primera vez que esto corra.
 *
 * El mensaje vuelve al modelo como `{ok:false, error}` y acaba en el chat, así que
 * dice qué revisar sin inventarse la causa. No puedo probar esto desde local: sin
 * `.dev.vars` con las credenciales, el primer intento real es en producción.
 */
function explain(status: number): string {
  if (status === 404) {
    return (
      'Google no encuentra ese calendario. Revisa el secret GOOGLE_CALENDAR_ID y que el ' +
      'calendario esté compartido con la service account: cuando no tiene acceso, la API ' +
      'responde 404 y no 403, porque para ella ese calendario no existe.'
    );
  }
  if (status === 403) {
    return (
      'Google no me deja escribir en ese calendario. El permiso compartido tiene que ser ' +
      '"Hacer cambios en los eventos", y la Google Calendar API estar habilitada en el proyecto.'
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
    ...when,
    // Los avisos del evento los da Google con la configuración del propio
    // calendario. Nuestro cron no toca esto: solo sabe de la tabla `tasks`.
    reminders: { useDefault: true },
  };
}
