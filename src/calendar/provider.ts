/**
 * The calendar interface.
 *
 * Same reason as in llm/ and stt/: anything reaching outwards sits behind an interface
 * so that switching providers is an environment variable and not surgery. That is not
 * theory here: ARCHITECTURE.md keeps iCloud's CalDAV noted as the plan B should Google
 * turn impossible, and it would be another file in this directory without touching the
 * tools.
 *
 * Phase 6 was write-only. Phase 7 added reading, modifying and deleting, because
 * without those a badly placed appointment could only be fixed from the phone. What
 * remains out is *bulk* reading for the briefing: that one does drag in incremental
 * sync tokens and recurrence expansion, and is another project. Searching for
 * "Thursday's dentist" over a date range drags in none of that.
 */

export interface CalendarEventInput {
  title: string;
  description: string | null;
  location: string | null;
  /** ISO instant of the start. Null on an all-day event. */
  startAt: string | null;
  endAt: string | null;
  /** 'YYYY-MM-DD' when it is all-day. The end is exclusive. */
  startDate: string | null;
  endDate: string | null;
  /** The user's zone. Google stores it with the event and decides how to show it. */
  timezone: string;
  /**
   * The event's colour in the provider's app. Chosen by the code from the category,
   * not by the model: see CATEGORY_COLORS in tools/calendar.ts.
   */
  colorId: string | null;
  /**
   * Recurrence rule in RRULE format, already built by the code. The model picks the
   * frequency from a closed list and never writes the string: see RECURRENCE_RULES in
   * tools/calendar.ts.
   */
  recurrence: string[] | null;
}

/** Only the fields sent get touched; the rest of the event stays as it is. */
export interface CalendarEventPatch {
  title?: string;
  description?: string | null;
  location?: string | null;
  startAt?: string;
  endAt?: string;
  startDate?: string;
  endDate?: string;
  colorId?: string;
  timezone: string;
}

export interface CalendarEvent {
  id: string;
  /** Link to the event on the provider's site, when it returns one. */
  url: string | null;
}

export interface CalendarEventSummary extends CalendarEvent {
  /**
   * Empty when the event is private and the shared permission is the one hiding the
   * details: there Google returns the occupied slot without its title.
   */
  title: string;
  startAt: string | null;
  endAt: string | null;
  /** 'YYYY-MM-DD' when it takes up the whole day. */
  startDate: string | null;
  /**
   * 'YYYY-MM-DD' **exclusive**, as Google returns it: a trip from the 23rd to the 26th
   * arrives with `endDate` = 27. Needed to preserve its length when moving it.
   */
  endDate: string | null;
  allDay: boolean;
  /** The colour it is stored with, when it has one of its own. */
  colorId: string | null;
  /**
   * The event is one occurrence of a series. It matters because modifying this
   * instance does not touch the others, and the user has to be told.
   */
  recurring: boolean;
  /**
   * Id of the series this occurrence belongs to, when it is one. It is the id that
   * touches the whole birthday instead of just this year's.
   */
  seriesId: string | null;
}

export interface CalendarSearch {
  /** ISO instant to search from. */
  from: string;
  to: string;
  /** Free text Google searches in title, description and location. */
  query: string | null;
  limit: number;
}

export interface CalendarClient {
  readonly name: string;
  /**
   * `timeoutMs` is the TOTAL budget for the operation, authentication included. It is
   * passed down from the message's `Deadline`: no caps are set here, which is the trap
   * that already cost us a phase (see §11 of ARCHITECTURE.md).
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
