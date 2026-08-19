import type { Env } from '../types';
import { GoogleCalendar } from './google';
import type { CalendarClient } from './provider';
import { CalendarError } from './provider';

/**
 * Calendar provider selection.
 *
 * There is only one today, so there is no environment variable to choose from: adding
 * CALENDAR_PROVIDER with a single possible value would be dead configuration. When
 * iCloud's CalDAV —the plan B ARCHITECTURE.md keeps— arrives, the branch goes here and
 * the tools will not notice.
 */
export function createCalendarClient(env: Env): CalendarClient {
  const calendarId = env.GOOGLE_CALENDAR_ID?.trim();
  if (!calendarId) {
    throw new CalendarError(
      'El calendario no está configurado: falta el secret GOOGLE_CALENDAR_ID en el Worker.',
    );
  }

  // 'primary' means "the caller's calendar", and the caller is the service account,
  // not the user. Pointing there would write into a calendar nobody looks at and
  // Google would return 200: a silent failure, which is the worst kind.
  if (calendarId === 'primary') {
    throw new CalendarError(
      'GOOGLE_CALENDAR_ID no puede ser "primary": tiene que ser el id del calendario ' +
        'compartido con la service account, normalmente el email del usuario.',
    );
  }

  return new GoogleCalendar(env, calendarId);
}
