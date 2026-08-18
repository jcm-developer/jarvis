/**
 * Plazos relativos escritos en castellano: "en 5 minutos", "dentro de media hora".
 *
 * Existe porque el modelo no es de fiar con las fechas y las reglas del prompt no
 * lo arreglaron. Medido en producción con `gpt-4o-mini`: tres intentos seguidos de
 * "avísame en N minutos" acabaron con la fecha del día siguiente, ignorando el
 * campo en minutos que se añadió justo para eso.
 *
 * Así que el plazo se lee del mensaje del usuario, que es la fuente auténtica, y
 * se usa para corregir lo que haya decidido el modelo. Lo dice CLAUDE.md: las
 * fechas relativas se resuelven en los handlers.
 */

/** Números escritos con letra que aparecen de verdad al hablar de plazos. */
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

/** Expresiones que no son un número por delante de la unidad. */
const FIXED: Array<[RegExp, number]> = [
  [/\bmedia\s+hora\b/, 30],
  [/\bun\s+cuarto\s+de\s+hora\b/, 15],
  [/\bhora\s+y\s+media\b/, 90],
  [/\bun\s+par\s+de\s+horas\b/, 120],
  [/\bun\s+par\s+de\s+minutos\b/, 2],
];

/**
 * Minutos desde ahora que pide el mensaje, o null si no habla en relativo.
 *
 * Solo reconoce minutos y horas: "en tres días" se deja al modelo, que con los
 * días no se equivoca tanto y donde una fecha concreta importa más que el plazo.
 */
export function parseRelativeMinutes(message: string): number | null {
  // Vacío cuando la acción viene de un botón de confirmación, sin texto nuevo.
  if (!message) return null;

  const text = normalize(message);

  // Tiene que haber una marca de plazo. Sin esto, "la reunión de las dos horas"
  // se leería como un plazo de dos horas.
  if (!/\b(en|dentro\s+de|de\s+aqui\s+a|pasados?)\b/.test(text)) return null;

  for (const [pattern, minutes] of FIXED) {
    if (pattern.test(text)) return minutes;
  }

  // El "unos" opcional va solo en plural a propósito: aceptando el singular, en
  // "en un minuto" se comía el "un" y luego no encontraba la cantidad.
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

  // Un año de tope, igual que los campos de las herramientas.
  return minutes > 525_600 ? null : minutes;
}

/**
 * ¿El mensaje dice de qué DÍA habla?
 *
 * Es la pregunta que decide si podemos corregirle el día al modelo. Cuando el
 * usuario dice "avísame a las 13:14" sin más, el día es hoy y no hay discusión; si
 * dice "el jueves" o "el 19 de septiembre", el día lo pone él y no se toca.
 *
 * "Hoy", "esta tarde" y compañía cuentan como que NO hay otro día: refuerzan hoy.
 */
export function mentionsAnotherDay(message: string): boolean {
  if (!message) return false;
  const text = normalize(message);

  return (
    /\bmanana\b/.test(text) ||
    /\bpasado\s+manana\b/.test(text) ||
    /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text) ||
    /\b(?:el\s+)?dia\s+\d{1,2}\b/.test(text) ||
    /\bel\s+\d{1,2}\s+de\s+[a-z]+/.test(text) ||
    /\b\d{1,2}\/\d{1,2}/.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b(semana|mes|ano)\s+(que\s+viene|siguiente|proximo|proxima)\b/.test(text) ||
    /\bproxim[oa]\s+(semana|mes|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text) ||
    /\ben\s+\d+\s+(dias?|semanas?|meses|anos?)\b/.test(text) ||
    /\bfin\s+de\s+semana\b/.test(text)
  );
}

/** Minúsculas y sin acentos: el usuario escribe "aquí" y también "aqui". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}
