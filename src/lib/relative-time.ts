/**
 * Relative deadlines written in Spanish: "en 5 minutos", "dentro de media hora".
 *
 * This exists because the model cannot be trusted with dates and the prompt rules did
 * not fix it. Measured in production with `gpt-4o-mini`: three consecutive attempts at
 * "remind me in N minutes" ended up dated the following day, ignoring the minutes
 * field that had been added for exactly that.
 *
 * So the deadline is read from the user's own message, which is the authentic source,
 * and used to correct whatever the model decided. CLAUDE.md says as much: relative
 * dates are resolved in the handlers.
 */

/** Spelled-out numbers that actually show up when people talk about deadlines. */
const WORD_NUMBERS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
};

/** Expressions that are not a number followed by a unit. */
const FIXED: Array<[RegExp, number]> = [
  [/\bmedia\s+hora\b/, 30],
  [/\bun\s+cuarto\s+de\s+hora\b/, 15],
  [/\bhora\s+y\s+media\b/, 90],
  [/\bun\s+par\s+de\s+horas\b/, 120],
  [/\bun\s+par\s+de\s+minutos\b/, 2],
];

/**
 * Minutes from now that the message is asking for, or null when it is not relative.
 *
 * Only minutes and hours are recognised: "in three days" is left to the model, which
 * is less wrong with days, and where a concrete date matters more than the delay.
 */
export function parseRelativeMinutes(message: string): number | null {
  // Empty when the action comes from a confirmation button, with no new text.
  if (!message) return null;

  const text = normalize(message);

  // There has to be a delay marker. Without this, "the two-hour meeting" would read
  // as a two-hour delay.
  if (!/\b(en|dentro\s+de|de\s+aqui\s+a|pasados?)\b/.test(text)) return null;

  for (const [pattern, minutes] of FIXED) {
    if (pattern.test(text)) return minutes;
  }

  // The optional "unos" is plural-only on purpose: accepting the singular made "en un
  // minuto" swallow the "un" and then fail to find the amount.
  const match = text.match(
    /\b(?:en|dentro\s+de|de\s+aqui\s+a|pasados?)\s+(?:unos\s+|unas\s+)?([\p{L}]+|\d+)\s*(minutos?|mins?|m|horas?|h)\b/u,
  );
  if (!match) return null;

  const rawAmount = match[1]!;
  const unit = match[2]!;

  const amount = /^\d+$/.test(rawAmount)
    ? Number.parseInt(rawAmount, 10)
    : (WORD_NUMBERS[rawAmount] ?? null);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;

  const minutes = unit.startsWith('h') ? amount * 60 : amount;

  // One year cap, same as the tool fields.
  return minutes > 525_600 ? null : minutes;
}

/**
 * Does the message say which DAY it is talking about?
 *
 * This is the question that decides whether we may correct the model's day. When the
 * user just says "remind me at 13:14", the day is today and there is nothing to
 * argue; if they say "on Thursday" or "on 19 September", the day is theirs and stays
 * untouched.
 *
 * "Today", "this afternoon" and friends count as NO other day: they reinforce today.
 */
export function mentionsAnotherDay(message: string): boolean {
  if (!message) return false;
  const text = normalize(message);

  return (
    /\bmanana\b/.test(text) ||
    /\bpasado\s+manana\b/.test(text) ||
    /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text) ||
    /\b(?:el\s+)?dia\s+\d{1,2}\b/.test(text) ||
    // A day number followed by "de <month>" is already a date, whatever preposition
    // precedes it. This used to require an "el" in front, so "pásalo AL 25 de agosto",
    // "quedamos PARA EL 3 de septiembre" and "la cita DEL 12 de enero" all slipped
    // through: the corrector then believed the user had named no day and moved the
    // date to today.
    /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre)\b/.test(
      text,
    ) ||
    /\b\d{1,2}\/\d{1,2}/.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b(semana|mes|ano)\s+(que\s+viene|siguiente|proximo|proxima)\b/.test(text) ||
    /\bproxim[oa]\s+(semana|mes|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text) ||
    /\ben\s+\d+\s+(dias?|semanas?|meses|anos?)\b/.test(text) ||
    /\bfin\s+de\s+semana\b/.test(text)
  );
}

/** Lowercase and unaccented: the user writes both "aquí" and "aqui". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
