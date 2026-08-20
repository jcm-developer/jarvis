import type { CalendarEventSummary } from '../calendar/provider';

/**
 * Reading appointments out loud, for the messages the cron writes on its own.
 *
 * It lives apart because the briefing and the pre-appointment alert say the same things
 * about the same events and must not drift: an appointment named one way in the morning
 * and another way fifteen minutes before is the kind of detail that makes the assistant
 * feel like two different programs.
 *
 * The tools do NOT share this. `list_events` and `what_now` write for the model, and
 * there the private appointment is spelled out —"(sin título: la cita es privada)"— so
 * it does not invent what the slot is about. Here it is written for a person, who needs
 * no explanation of why the title is missing.
 */

/**
 * The appointments that hold a slot, in the order Google returned them.
 *
 * All-day ones come out because they take up no time: a birthday does not start at an
 * hour, so it cannot be announced fifteen minutes ahead, and in the briefing it goes in
 * a list of its own. The same distinction §14's free gaps make.
 */
export function timedEvents(events: CalendarEventSummary[]): CalendarEventSummary[] {
  return events.filter(
    (event) => !event.allDay && event.startAt !== null && event.endAt !== null,
  );
}

/**
 * A private appointment arrives with no title —the shared permission returns the
 * occupied slot and nothing else (§13)— so it gets named as what it is. There is no
 * model in these messages to invent a title, and there must not be a line inventing one
 * either.
 *
 * It is worded to work both inside a list ("- 13:00-14:00 una cita privada") and inside
 * a sentence ("dentro de 13 minutos: una cita privada").
 */
export function eventLabel(event: CalendarEventSummary): string {
  return event.title || 'una cita privada';
}
