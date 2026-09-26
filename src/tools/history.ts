import { formatDayAndTime } from '../lib/localtime';
import { PERIOD_HINT, daysFromToday, periodInstants, relativeDays } from '../lib/periods';
import { EMPTY_SEARCH_NOTE, matchesQuery, parseQuery } from '../lib/text-match';
import type { ToolDefinition, ToolResult } from './types';
import { optionalString, requireString } from './types';

/**
 * Searching what was said, beyond the window the model is replayed.
 *
 * The model sees the last HISTORY_WINDOW turns and nothing older, so "¿qué te dije el
 * martes del piso?" was answered from nothing: either "no lo sé" or, worse, a guess. The
 * whole conversation is already in `messages` (§5), so this is a read, not a feature
 * with storage of its own.
 *
 * `/reset` deletes the rows for real, and that is kept: what he asked to forget does not
 * come back through here.
 */

/** How far back a search with no period goes. */
const DEFAULT_BACK_DAYS = 180;

/**
 * Messages read to be matched here. Text only —no tool rows— at a few hundred characters
 * each, which keeps the parse far from the 10 ms of CPU.
 */
const MAX_MESSAGES = 400;

/** Matches handed back. Enough to find the one he means; more is noise in the context. */
const MAX_MATCHES = 8;

/** A message is cut to this: the model needs the gist and the date, not the paragraph. */
const MAX_TEXT = 280;

const DAY_MS = 24 * 60 * 60 * 1000;

interface HistoryRow {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export const searchHistory: ToolDefinition = {
  name: 'search_history',
  description:
    'Busca en lo que habéis hablado antes, más allá de los últimos mensajes que ves. ' +
    'Úsala cuando pregunte qué te dijo o qué le dijiste ("¿qué te conté del piso?", ' +
    '"¿cómo se llamaba el restaurante que te dije?") y no esté en la conversación que ' +
    'tienes delante. Lo que borró con /reset no está.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Palabras a buscar, sin necesidad de que coincidan exactas. Varias alternativas ' +
          'separadas por comas: "piso, alquiler, casero".',
      },
      period: {
        type: 'string',
        description: `Cuándo se habló, si lo dice. ${PERIOD_HINT} Sin él, los últimos ${DEFAULT_BACK_DAYS} días.`,
      },
    },
    required: ['query'],
  },
  mutates: false,
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const query = requireString(args, 'query', 200);
    const alternatives = parseQuery(query);
    if (alternatives.length === 0) {
      return { ok: false, error: `"${query}" no tiene ninguna palabra que buscar.` };
    }

    const now = new Date();
    const period = optionalString(args, 'period', 20);
    let range = { from: new Date(now.getTime() - DEFAULT_BACK_DAYS * DAY_MS), to: now };
    if (period !== null) {
      const resolved = periodInstants(period, now, ctx.timezone);
      if (resolved === null) {
        return { ok: false, error: `period "${period}" no válido. ${PERIOD_HINT}` };
      }
      range = resolved;
    }

    const rows = await ctx.db.select<HistoryRow>('messages', {
      columns: 'role,content,created_at',
      filters: {
        conversation_id: `eq.${ctx.conversationId}`,
        // Tool rows are JSON the model already turned into words in the assistant turn
        // after them; matching them would return every search twice, the second time
        // unreadable.
        role: 'in.(user,assistant)',
        content: 'not.is.null',
        and: `(created_at.gte.${range.from.toISOString()},created_at.lt.${range.to.toISOString()})`,
      },
      order: 'created_at.desc',
      limit: MAX_MESSAGES,
    });

    const matches = rows
      .filter((row) => matchesQuery(alternatives, row.content))
      .slice(0, MAX_MATCHES)
      .map((row) => {
        const at = new Date(row.created_at);
        const text = row.content.replace(/\s+/g, ' ').trim();
        return {
          // Who said it matters more than it looks: "what did I tell you" and "what did
          // you tell me" are different questions with the same keywords.
          who: row.role === 'user' ? 'él' : 'tú',
          when: `${formatDayAndTime(at, ctx.timezone)} (${relativeDays(
            daysFromToday(at, now, ctx.timezone),
          )})`,
          text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text,
        };
      });

    return {
      ok: true,
      data: {
        count: matches.length,
        // Newest first: the last time something was said is usually the one that holds.
        messages: matches,
        ...(matches.length === 0 ? { note: EMPTY_SEARCH_NOTE } : {}),
        ...(rows.length >= MAX_MESSAGES
          ? {
              note_range:
                `Solo he mirado los ${MAX_MESSAGES} mensajes más recientes de ese rango. Si ` +
                'buscas algo más antiguo, manda un period.',
            }
          : {}),
      },
    };
  },
};
