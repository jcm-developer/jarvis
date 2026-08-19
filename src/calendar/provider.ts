/**
 * Interfaz del calendario.
 *
 * Mismo motivo que en llm/ y stt/: lo que sale hacia fuera va detrás de una
 * interfaz para que cambiar de proveedor sea una variable de entorno y no una
 * cirugía. Aquí no es teoría: ARCHITECTURE.md tiene el CalDAV de iCloud apuntado
 * como plan B por si Google se pone imposible, y sería otro fichero en este
 * directorio sin tocar la herramienta.
 *
 * Solo escritura, a propósito. Leer el calendario —que el briefing cuente las
 * reuniones del día— arrastra tokens de sincronización incremental, expansión de
 * eventos recurrentes y zonas horarias de las recurrencias. Es otro proyecto.
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

export interface CalendarEvent {
  id: string;
  /** Enlace al evento en la web del proveedor, si lo devuelve. */
  url: string | null;
}

export interface CalendarClient {
  readonly name: string;
  /**
   * `timeoutMs` es el presupuesto TOTAL de la operación, autenticación incluida.
   * Se pasa desde el `Deadline` del mensaje: aquí no se fijan topes propios, que
   * es la trampa que ya nos costó una fase (ver §11 de ARCHITECTURE.md).
   */
  createEvent(input: CalendarEventInput, timeoutMs: number): Promise<CalendarEvent>;
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
