/**
 * Interfaz del calendario.
 *
 * Mismo motivo que en llm/ y stt/: lo que sale hacia fuera va detrás de una
 * interfaz para que cambiar de proveedor sea una variable de entorno y no una
 * cirugía. Aquí no es teoría: ARCHITECTURE.md tiene el CalDAV de iCloud apuntado
 * como plan B por si Google se pone imposible, y sería otro fichero en este
 * directorio sin tocar las herramientas.
 *
 * La Fase 6 fue solo escritura. La Fase 7 añadió leer, modificar y borrar porque
 * sin eso una cita mal puesta solo se arreglaba desde el móvil. Lo que sigue
 * fuera es la lectura *masiva* para el briefing: eso sí arrastra tokens de
 * sincronización incremental y expansión de recurrentes, y es otro proyecto.
 * Buscar "el dentista del jueves" en un rango de fechas no arrastra nada de eso.
 */

export interface CalendarEventInput {
  title: string;
  description: string | null;
  location: string | null;
  /** Instante ISO del inicio. Null en un evento de día completo. */
  startAt: string | null;
  endAt: string | null;
  /** 'YYYY-MM-DD' cuando es de día completo. El fin es exclusivo. */
  startDate: string | null;
  endDate: string | null;
  /** Zona del usuario. Google la guarda con el evento y decide cómo mostrarlo. */
  timezone: string;
}

/** Solo los campos que se envían se tocan; el resto del evento se queda como está. */
export interface CalendarEventPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  timezone: string;
}

export interface CalendarEvent {
  id: string;
  /** Enlace al evento en la web del proveedor, si lo devuelve. */
  url: string | null;
}

export interface CalendarEventSummary extends CalendarEvent {
  /**
   * Vacío cuando el evento es privado y el permiso compartido es el que oculta
   * los detalles: ahí Google devuelve el hueco ocupado sin su título.
   */
  title: string;
  startAt: string | null;
  endAt: string | null;
  /** 'YYYY-MM-DD' si ocupa el día entero. */
  startDate: string | null;
  allDay: boolean;
  /**
   * El evento es una repetición de una serie. Importa porque modificar esta
   * instancia no toca las demás, y hay que decírselo al usuario.
   */
  recurring: boolean;
}

export interface CalendarSearch {
  /** Instante ISO desde el que buscar. */
  from: string;
  to: string;
  /** Texto libre que Google busca en título, descripción y sitio. */
  query: string | null;
  limit: number;
}

export interface CalendarClient {
  readonly name: string;
  /**
   * `timeoutMs` es el presupuesto TOTAL de la operación, autenticación incluida.
   * Se pasa desde el `Deadline` del mensaje: aquí no se fijan topes propios, que
   * es la trampa que ya nos costó una fase (ver §11 de ARCHITECTURE.md).
   */
  createEvent(input: CalendarEventInput, timeoutMs: number): Promise<CalendarEvent>;
  listEvents(search: CalendarSearch, timeoutMs: number): Promise<CalendarEventSummary[]>;
  getEvent(eventId: string, timeoutMs: number): Promise<CalendarEventSummary | null>;
  updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    timeoutMs: number,
  ): Promise<CalendarEvent>;
  deleteEvent(eventId: string, timeoutMs: number): Promise<void>;
}

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}
