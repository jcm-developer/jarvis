import type { Env } from '../types';
import { GoogleCalendar } from './google';
import type { CalendarClient } from './provider';
import { CalendarError } from './provider';

/**
 * Selección de proveedor de calendario.
 *
 * Hoy solo hay uno, así que no hay var de entorno que elegir: añadir
 * CALENDAR_PROVIDER con un único valor posible sería configuración muerta. Cuando
 * entre el CalDAV de iCloud que ARCHITECTURE.md tiene como plan B, la rama va
 * aquí y la herramienta no se enterará.
 */
export function createCalendarClient(env: Env): CalendarClient {
  const calendarId = env.GOOGLE_CALENDAR_ID?.trim();
  if (!calendarId) {
    throw new CalendarError(
      'El calendario no está configurado: falta el secret GOOGLE_CALENDAR_ID en el Worker.',
    );
  }

  // 'primary' significa "el calendario de quien llama", y quien llama es la service
  // account, no el usuario. Apuntando ahí escribiríamos en un calendario que nadie
  // mira y Google devolvería 200: un fallo silencioso, que es el peor de todos.
  if (calendarId === 'primary') {
    throw new CalendarError(
      'GOOGLE_CALENDAR_ID no puede ser "primary": tiene que ser el id del calendario ' +
        'compartido con la service account, normalmente el email del usuario.',
    );
  }

  return new GoogleCalendar(env, calendarId);
}
