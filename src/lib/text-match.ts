/**
 * Loose matching of what he says against what the calendar says.
 *
 * This replaced Google's own `q`, which matches whole words: asked for "peluquero", it
 * did not find an event titled "Peluquería", and the model reported with total
 * confidence that there was no such appointment. It was found only when he dictated the
 * exact title, which defeats the point of asking. What he says and what he once typed
 * on his phone are never the same word; they share a root, and that is what is compared.
 */

/**
 * Words that say nothing about which appointment it is. Without this list "la cita con
 * el peluquero" would demand an event containing "cita", which none of them do.
 */
const STOPWORDS = new Set([
  'a', 'al', 'con', 'de', 'del', 'el', 'en', 'la', 'las', 'lo', 'los', 'mi', 'mis',
  'para', 'por', 'su', 'un', 'una', 'y', 'cita', 'citas', 'evento', 'eventos',
]);

/** Below this a shared start is chance, not a root: "mart" is in "Marta" and "martes". */
const MIN_ROOT = 5;

/**
 * Letters two forms of one word may differ by at the end: peluquer-o / peluquer-ía,
 * médic-o / médic-a, reunión / reunion-es.
 */
const MAX_ENDING = 3;

/** Lowercase, no accents, punctuation turned into spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/**
 * The alternatives in a query, each one a list of words that must all appear.
 *
 * Commas and bars separate alternatives so the model can send the synonyms it would
 * otherwise try one per round —"peluquería, peluquero, barbero"— and it only has three
 * rounds. An alternative made only of stopwords is dropped, not turned into match-all.
 */
export function parseQuery(query: string): string[][] {
  return query
    .split(/[,|]/)
    .map((part) => normalize(part).split(' ').filter((word) => word && !STOPWORDS.has(word)))
    .filter((words) => words.length > 0);
}

/** Whether any alternative has all its words somewhere in `text`. */
export function matchesQuery(alternatives: string[][], text: string): boolean {
  const tokens = normalize(text).split(' ').filter(Boolean);
  return alternatives.some((words) =>
    words.every((word) => tokens.some((token) => sameWord(word, token))),
  );
}

/**
 * Rows a small table is read in full to be searched here instead of with `ilike`.
 *
 * `ilike *frase*` looked for the model's whole sentence as one substring, and with its
 * accents: "Pilares de la Tierra" missed "Los pilares de la tierra" typed without them,
 * and "el trabajo de mi hermana" missed "hermana: trabaja en...". Memories, books and
 * projects are tens of rows, so reading them all costs less than the round a miss costs.
 */
export const MAX_SEARCHED_ROWS = 300;

/**
 * What an empty search is told to the model, by every tool that searches.
 *
 * The failure it answers was never the search, it was the reading: an empty result was
 * repeated to him as "you have no such thing", twice, while it was there.
 */
export const EMPTY_SEARCH_NOTE =
  'Nada con esas palabras. Eso no prueba que no exista: pudo decirlo o apuntarlo con ' +
  'otras. Antes de decirle que no está, prueba con otras palabras que pudo usar; si ' +
  'tampoco sale, dile qué has buscado, no "no tienes ninguno".';

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  // Short words only match exactly: "pan" must not find "Panamá".
  if (shorter < 4) return false;

  let common = 0;
  while (common < shorter && a[common] === b[common]) common++;

  // One is the other with something added: "cumple" in "cumpleaños", "dentista" in
  // "dentistas".
  if (common === shorter) return true;
  return common >= MIN_ROOT && common >= shorter - MAX_ENDING;
}
