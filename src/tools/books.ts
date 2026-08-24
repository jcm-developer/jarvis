import type { BookRow } from '../db/types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { optionalInt, optionalString, requireString } from './types';

/**
 * The reading log (phase 24).
 *
 * It looks like another CRUD domain and that is not the point of it. A row here is only
 * worth its tokens if it makes the NEXT recommendation better, and that is what decides
 * the whole shape: no ISBN, no page count, no publisher —metadata anybody can look up—
 * and instead the mark, what the user said about it and what it was about.
 *
 * There is no `recommend_books` tool either, and that was deliberate. Recommending is not
 * an operation on the database: it is the model reading the list and arguing from it. A
 * tool would have to return the same rows `list_books` already returns and the
 * recommendation would still be the model's. What the prompt rules add instead is the
 * part that actually fails —forcing the list to be read BEFORE recommending— because a
 * recommendation made from the conversation alone repeats a book from four months ago.
 */

const STATUSES = ['read', 'reading', 'pending', 'abandoned'] as const;
type BookStatus = (typeof STATUSES)[number];

const STATUS_HINT =
  '"read" leído, "reading" leyéndolo ahora, "pending" quiere leerlo, ' +
  '"abandoned" lo dejó a medias.';

function isStatus(value: string): value is BookStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export const logBook: ToolDefinition = {
  name: 'log_book',
  description:
    'Apunta un libro en su biblioteca: lo que ha leído, lo que está leyendo o lo que ' +
    'quiere leer. Úsala en cuanto mencione que ha leído algo, aunque no te pida ' +
    'guardarlo, y también para ponerle nota o cambiarle el estado después. Si el libro ' +
    'ya está apuntado no se duplica: se actualiza con lo que mandes. Rellena topics ' +
    'siempre que puedas, que es lo que luego te deja recomendarle bien.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'El título, tal como se publica.' },
      author: { type: 'string', description: 'El autor, si lo sabes o lo ha dicho.' },
      status: {
        type: 'string',
        enum: [...STATUSES],
        description: `Por defecto "read". ${STATUS_HINT}`,
      },
      rating: {
        type: 'integer',
        description:
          'Del 1 al 5, solo si él lo ha valorado. Si ha dado una nota en otra escala ' +
          '("un ocho", "un diez"), pásala a esta. Si no ha valorado nada no lo mandes: ' +
          'no deduzcas la nota de lo contento que parezca.',
      },
      topics: {
        type: 'string',
        description:
          'De qué va, dos o tres temas en minúscula separados por comas, ej. ' +
          '"ciencia ficción, distopía" o "historia, segunda guerra mundial". Los pones tú ' +
          'con lo que sepas del libro; no se los preguntes.',
      },
      notes: {
        type: 'string',
        description:
          'Lo que ha dicho del libro, con sus palabras ("se le hizo largo el principio", ' +
          '"le encantó el final"). Es lo que te permite afinar luego las recomendaciones.',
      },
    },
    required: ['title'],
  },
  mutates: true,
  requiresConfirmation: false,
  // Only read on the photo path —una portada, una estantería— where nothing is written
  // before the user has read back what was understood.
  confirmationPrompt: async (args) => {
    const title = optionalString(args, 'title', 200) ?? 'ese libro';
    const status = optionalString(args, 'status', 20)?.toLowerCase() ?? 'read';
    if (status === 'pending') return `¿Te apunto "${title}" para leerlo?`;
    if (status === 'reading') return `¿Apunto que estás leyendo "${title}"?`;
    if (status === 'abandoned') return `¿Apunto que dejaste "${title}"?`;
    return `¿Apunto que has leído "${title}"?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = requireString(args, 'title', 200);

    const status = optionalString(args, 'status', 20)?.toLowerCase() ?? null;
    if (status !== null && !isStatus(status)) {
      return {
        ok: false,
        error: `status "${status}" no válido. Usa read, reading, pending o abandoned.`,
      };
    }

    const rating = optionalInt(args, 'rating', 1, 5);

    // Only what the model sent gets written, the same convention as update_task: a second
    // call putting a mark on a book must not wipe the topics the first one wrote.
    const patch: Record<string, unknown> = {};
    if (args['author'] !== undefined) patch['author'] = optionalString(args, 'author', 150);
    if (args['topics'] !== undefined) patch['topics'] = optionalString(args, 'topics', 200);
    if (args['notes'] !== undefined) patch['notes'] = optionalString(args, 'notes', 500);
    if (rating !== null) patch['rating'] = rating;
    if (status !== null) patch['status'] = status;

    // A mark means it was read. The model sends the rating and leaves the status alone,
    // which would keep "le doy un 5 a Dune" sitting in the wants-to-read pile and coming
    // back later as a recommendation.
    if (rating !== null && status === null) patch['status'] = 'read';

    const existing = await findBook(title, ctx);
    if (existing) {
      const updated = await ctx.db.update<BookRow>(
        'books',
        { id: `eq.${existing.id}`, user_id: `eq.${ctx.userId}` },
        // An empty patch is not an error here: mentioning again a book already logged is
        // the common case, and the row comes back untouched for the model to say so.
        Object.keys(patch).length > 0 ? patch : { updated_at: new Date().toISOString() },
      );
      const book = updated[0];
      if (!book) {
        return { ok: false, error: `No he podido actualizar el libro "${existing.title}".` };
      }
      return { ok: true, data: { ...summarize(book), already_logged: true } };
    }

    const book = await ctx.db.insert<BookRow>('books', {
      user_id: ctx.userId,
      title,
      status: 'read',
      ...patch,
    });

    return { ok: true, data: summarize(book) };
  },
};

export const listBooks: ToolDefinition = {
  name: 'list_books',
  description:
    'Su biblioteca: lo que ha leído con sus notas y sus temas, lo que está leyendo y lo ' +
    'que tiene pendiente. Llámala SIEMPRE antes de recomendarle un libro, y sin filtros: ' +
    'sin ella no sabes qué le gusta ni qué se ha leído ya. Úsala también para conseguir ' +
    'el id antes de borrar, o cuando pregunte qué ha leído de un tema.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...STATUSES],
        description:
          `Filtra por estado. ${STATUS_HINT} Para recomendar NO lo mandes: también ` +
          'necesitas los que dejó a medias y los que ya tiene pendientes.',
      },
      query: {
        type: 'string',
        description:
          'Busca en título, autor, temas y notas. Para un tema concreto ("¿qué he leído ' +
          'de historia?"), una palabra suelta y en singular.',
      },
      limit: { type: 'integer', description: 'Máximo de libros a devolver. Por defecto 30.' },
    },
    required: [],
  },
  mutates: false,
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const status = optionalString(args, 'status', 20)?.toLowerCase() ?? null;
    if (status !== null && !isStatus(status)) {
      return {
        ok: false,
        error: `status "${status}" no válido. Usa read, reading, pending o abandoned.`,
      };
    }

    const filters: Record<string, string> = { user_id: `eq.${ctx.userId}` };
    if (status !== null) filters['status'] = `eq.${status}`;

    const query = optionalString(args, 'query', 100);
    if (query) {
      // Substring search, case insensitive, like recall(): same reasoning and at this
      // volume it is enough. Characters that are syntax inside a PostgREST `or` are
      // dropped rather than escaped.
      const escaped = query.replace(/[%,()]/g, ' ').trim();
      if (escaped) {
        filters['or'] =
          `(title.ilike.*${escaped}*,author.ilike.*${escaped}*,` +
          `topics.ilike.*${escaped}*,notes.ilike.*${escaped}*)`;
      }
    }

    const books = await ctx.db.select<BookRow>('books', {
      filters,
      // Best first, and that is not cosmetic: this list is read to work out a taste, so
      // when the limit cuts it what has to survive is the part that says what he likes.
      order: 'rating.desc.nullslast,updated_at.desc',
      limit: optionalInt(args, 'limit', 1, 100) ?? 30,
    });

    return {
      ok: true,
      data: {
        count: books.length,
        books: books.map(summarize),
      },
    };
  },
};

export const deleteBook: ToolDefinition = {
  name: 'delete_book',
  description:
    'Borra un libro de su biblioteca. Es para cuando se apuntó mal o no era ese: si lo ' +
    'que pasa es que lo ha dejado a medias, eso es log_book con status="abandoned". ' +
    'Necesitas el id exacto: llama antes a list_books.',
  parameters: {
    type: 'object',
    properties: {
      book_id: { type: 'string', description: 'El id (uuid) devuelto por list_books.' },
    },
    required: ['book_id'],
  },
  mutates: true,
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const bookId = typeof args['book_id'] === 'string' ? args['book_id'] : '';
    const rows = await ctx.db.select<BookRow>('books', {
      columns: 'id,title',
      filters: { id: `eq.${bookId}`, user_id: `eq.${ctx.userId}` },
      limit: 1,
    });
    const book = rows[0];
    return book ? `¿Quito "${book.title}" de tus libros?` : '¿Quito ese libro de tu lista?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const bookId = requireString(args, 'book_id', 64);

    // The user_id filter is not decorative: same reason as in delete_task.
    const deleted = await ctx.db.delete<BookRow>('books', {
      id: `eq.${bookId}`,
      user_id: `eq.${ctx.userId}`,
    });

    const book = deleted[0];
    if (!book) {
      return {
        ok: false,
        error: `No existe ningún libro con id ${bookId}. Llama a list_books para ver los reales.`,
      };
    }

    return { ok: true, data: { deleted: true, title: book.title } };
  },
};

/**
 * The book already on the shelf, when there is one.
 *
 * Titles are compared normalised —accents and punctuation stripped— instead of with an
 * `ilike` filter, because the second mention of a book is rarely spelled like the first:
 * case an `ilike` would forgive, but "Los pilares de la tierra" typed without the accent
 * does not match one at all.
 *
 * Containment counts from six characters up. Below that it is a trap —"It" is inside
 * dozens of titles— while "El nombre del viento" and "El nombre del viento (Crónica del
 * asesino de reyes 1)" are the same book said twice.
 */
async function findBook(title: string, ctx: ToolContext): Promise<BookRow | null> {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;

  const books = await ctx.db.select<BookRow>('books', {
    columns: 'id,title',
    filters: { user_id: `eq.${ctx.userId}` },
    order: 'updated_at.desc',
    limit: 100,
  });

  for (const candidate of books) {
    const other = normalizeTitle(candidate.title);
    if (!other) continue;
    if (other === wanted) return candidate;

    const [shorter, longer] = wanted.length <= other.length ? [wanted, other] : [other, wanted];
    if (shorter.length >= 6 && longer.includes(shorter)) return candidate;
  }
  return null;
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Compact and readable: what the model reads to argue a recommendation from. */
function summarize(book: BookRow) {
  return {
    id: book.id,
    title: book.title,
    ...(book.author ? { author: book.author } : {}),
    status: book.status,
    // The optional fields are only named when they exist: across a thirty-book list, an
    // empty field per row is tokens paid on every message that follows.
    ...(book.rating !== null ? { rating: book.rating } : {}),
    ...(book.topics ? { topics: book.topics } : {}),
    ...(book.notes ? { notes: book.notes } : {}),
  };
}
