import { enqueueJob } from '../db/jobs';
import { createSearchProvider, searchConfigured } from '../search';
import { SearchError } from '../search/provider';
import { formatDayAndTime } from '../lib/localtime';
import type { ToolDefinition, ToolResult } from './types';
import { optionalInt, optionalString, requireString } from './types';

/**
 * Web search, in the two halves phase 20 is split into.
 *
 * The split is the whole design. A search that returns snippets is one request with its
 * token count bounded in advance, and that fits inside a message. Reading a page does
 * not: it is somebody else's latency plus tens of thousands of tokens of HTML, and no
 * amount of tuning makes that fit in 27 s shared with three model rounds. So the first
 * half runs in the turn and the second half becomes a job (§16).
 *
 * What that buys is the honest answer in both cases: an answer now, or "I'll tell you
 * in a minute" and a message that actually arrives.
 */

/**
 * Cap for the search call.
 *
 * Deliberately below the calendar's 10 s: a search is almost never the last thing that
 * happens in a turn —the model still has to read the results and write the reply— so it
 * has to leave a whole round behind it. MAX_AGENT_ITERATIONS is 3 in production, and a
 * search eats one of them.
 */
const MAX_SEARCH_MS = 8_000;

/**
 * Below this it is not attempted. Firing off a search that gets cancelled halfway spends
 * a credit and a round and returns nothing, which is strictly worse than saying so.
 */
const MIN_SEARCH_MS = 3_000;

/** Results asked for by default. Five is what fits in a reply nobody scrolls. */
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 8;

/**
 * Cap per snippet.
 *
 * The token budget of a search is `results × this`, decided here and not left to
 * whatever the provider feels like returning. Five results at 400 characters is about
 * 500 tokens, which a turn can pay for.
 */
const MAX_SNIPPET_CHARS = 400;

export const searchWeb: ToolDefinition = {
  name: 'search_web',
  description:
    'Busca en internet y te devuelve un puñado de resultados con un extracto de cada ' +
    'uno. Úsala cuando te pregunte algo que no puedes saber: datos que cambian ' +
    '(precios, resultados, horarios, quién ganó), cosas posteriores a tu ' +
    'entrenamiento, o cualquier cosa que él espere que esté actualizada. NO devuelve ' +
    'páginas enteras: si un resultado no basta y hace falta leer la página, usa ' +
    'read_url. Cada resultado trae su url y, cuando se sabe, su fecha: cítalas y no ' +
    'presentes como de hoy algo que no lo es.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Lo que hay que buscar, escrito como se escribiría en un buscador. Sin ' +
          'preguntas largas ni cortesías.',
      },
      max_results: {
        type: 'integer',
        description: `Cuántos resultados quieres, de 1 a ${MAX_RESULTS}. Por defecto ${DEFAULT_RESULTS}.`,
      },
    },
    required: ['query'],
  },
  mutates: false,
  requiresConfirmation: false,
  available: searchConfigured,
  handler: async (args, ctx): Promise<ToolResult> => {
    const query = requireString(args, 'query', 300);
    const maxResults = optionalInt(args, 'max_results', 1, MAX_RESULTS) ?? DEFAULT_RESULTS;

    const budget = ctx.deadline.budgetFor(MAX_SEARCH_MS);
    if (budget < MIN_SEARCH_MS) {
      return {
        ok: false,
        error: 'No me queda tiempo en este mensaje para buscar. Dile que se lo repita.',
      };
    }

    let results;
    try {
      results = await createSearchProvider(ctx.env).search(query, {
        timeoutMs: budget,
        maxResults,
      });
    } catch (error) {
      // Configuration and provider failures come back to the model as a result, never to
      // the user as an exception: it is the model that has to say it cannot search and
      // offer what it can still do.
      if (error instanceof SearchError) return { ok: false, error: error.toolMessage };
      throw error;
    }

    if (results.length === 0) {
      return {
        ok: true,
        data: {
          query,
          count: 0,
          results: [],
          note: 'La búsqueda no ha devuelto nada. Dilo tal cual; no rellenes con lo que creas saber.',
        },
      };
    }

    return {
      ok: true,
      data: {
        query,
        count: results.length,
        // Rule 4 of §7 in the domain where it bites hardest. A search result is a
        // snapshot, and presenting Friday's number as "now" on a Sunday is the same lie
        // as an invented day.
        searched_at: formatDayAndTime(new Date(), ctx.timezone),
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet.slice(0, MAX_SNIPPET_CHARS),
          published_at: result.publishedAt,
        })),
      },
    };
  },
};

export const readUrl: ToolDefinition = {
  name: 'read_url',
  description:
    'Encarga la lectura de una página web. NO te devuelve el texto: deja el encargo ' +
    'apuntado y el sistema le manda un mensaje aparte con el resumen en unos minutos. ' +
    'Úsala cuando te mande un enlace y quiera saber qué dice, o cuando un resultado de ' +
    'search_web no baste y haya que entrar. Al usarla, dile que se lo cuentas en un ' +
    'rato: no te inventes el contenido ni digas que ya lo has leído.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'La dirección completa de la página, empezando por http:// o https://.',
      },
      question: {
        type: 'string',
        description:
          'Qué quiere saber de esa página, si lo ha dicho. Ej. "cuánto cuesta", "qué ' +
          'días abre". Déjalo vacío si solo quiere saber de qué va.',
      },
    },
    required: ['url'],
  },
  // It writes a row, so on the photo path it waits behind the same button as everything
  // else that writes (§7). Queuing a link read off a poster is harmless, but the field
  // says "does it write", and it does.
  mutates: true,
  requiresConfirmation: false,
  confirmationPrompt: async (args) => {
    const url = optionalString(args, 'url', 2_000);
    return url ? `¿Te leo ${url} y te cuento?` : '¿Te leo ese enlace y te cuento?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const raw = requireString(args, 'url', 2_000);

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {
        ok: false,
        error: `"${raw}" no es una dirección válida. Necesito la url completa, con http:// o https://.`,
      };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        error: 'Solo puedo leer páginas web (http o https).',
      };
    }

    // The fetch happens on the reader provider's side, not ours, so this is not about
    // protecting our network: it is about catching a model that has invented a local
    // address instead of asking for the real link.
    if (isLocalHost(url.hostname)) {
      return {
        ok: false,
        error:
          'Esa dirección es local y no existe fuera de su máquina. Pídele el enlace ' +
          'completo, tal como lo tenga.',
      };
    }

    const job = await enqueueJob(ctx.db, {
      userId: ctx.userId,
      kind: 'read_url',
      payload: {
        url: url.toString(),
        question: optionalString(args, 'question', 300),
      },
    });

    return {
      ok: true,
      data: {
        queued: true,
        url: url.toString(),
        // Said out loud so the model does not promise it for "ahora mismo". The cron
        // runs every five minutes and jobs go last in the tick.
        note: 'Encargado. Le llegará en unos minutos, en un mensaje aparte. Dile eso y no esperes el texto aquí.',
        job_id: job.id,
      },
    };
  },
};

/** Hostnames that only mean something inside the machine that typed them. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}
