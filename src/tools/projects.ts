import type { Db } from '../db/client';
import type { ProjectLink, ProjectRow } from '../db/types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { ToolValidationError, optionalInt, optionalString, requireString } from './types';

/**
 * The project register (phase 26).
 *
 * It is the second domain that is not about time, and unlike the books one it is not
 * read on demand: the whole point is that "el de la web" resolves without asking. So the
 * feature is split the way memories are —an index injected into every message, the
 * detail behind a tool— and not the way books are, where nothing reaches the model until
 * it calls for it.
 *
 * What gets injected is the name and one line of each ACTIVE project, and nothing else.
 * Links, notes and the finished ones would cost tokens on every message for the two
 * questions a week that need them, which is exactly what §11 is about; `list_projects`
 * is one round and that is the right price for them.
 */

const STATUSES = ['idea', 'active', 'paused', 'done'] as const;
type ProjectStatus = (typeof STATUSES)[number];

const STATUS_HINT =
  '"idea" solo la idea, "active" está en marcha, "paused" parado, "done" terminado.';

/** Enough for a real project, and a ceiling on what one row can ever cost to read. */
const MAX_LINKS = 8;

function isStatus(value: string): value is ProjectStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export const saveProject: ToolDefinition = {
  name: 'save_project',
  description:
    'Apunta o actualiza un proyecto suyo: qué es, en qué punto está y sus enlaces ' +
    '(repo, docs, staging, el tablero). Úsala cuando te cuente que empieza algo, cuando ' +
    'te pase un enlace de algo en lo que trabaja o cuando cambie de estado, sin que te ' +
    'lo pida. Si el proyecto ya existe no se duplica: se actualiza con lo que mandes, y ' +
    'lo que no mandes se queda como estaba. Ojo: un proyecto NO es una tarea. "Terminar ' +
    'el login" es create_task; el proyecto es la cosa a la que pertenece esa tarea y ' +
    'dura mucho más que ella.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Cómo lo llama él, corto y tal cual lo dice ("Jarvis", "la web de Codegenia"). ' +
          'Es lo que usarás para encontrarlo después: no lo reescribas cada vez.',
      },
      description: {
        type: 'string',
        description:
          'Qué es, en una o dos frases: para quién, con qué y para qué. Esto es lo que ' +
          'te llega en el contexto de cada mensaje, así que dilo denso y sin relleno.',
      },
      status: {
        type: 'string',
        enum: [...STATUSES],
        description: `Por defecto "active". ${STATUS_HINT}`,
      },
      links: {
        type: 'array',
        description:
          `Sus enlaces, máximo ${MAX_LINKS}. La etiqueta es la clave: mandar otra vez ` +
          '"repo" con otra url corrige la que había, y una etiqueta nueva se suma a las ' +
          'que ya tenía. No borra las que no mandes.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Una palabra en minúscula: repo, docs, staging, prod, tablero.',
            },
            url: { type: 'string', description: 'La url completa, con http:// o https://.' },
          },
          required: ['label', 'url'],
        },
      },
      notes: {
        type: 'string',
        description:
          'Lo que conviene recordar del proyecto, con sus palabras: en qué punto está, ' +
          'qué le falta, con quién lo lleva, qué decidió y por qué.',
      },
    },
    required: ['name'],
  },
  mutates: true,
  requiresConfirmation: false,
  confirmationPrompt: async (args) => {
    const name = optionalString(args, 'name', 120) ?? 'ese proyecto';
    return `¿Apunto el proyecto "${name}"?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const name = requireString(args, 'name', 120);

    const status = optionalString(args, 'status', 20)?.toLowerCase() ?? null;
    if (status !== null && !isStatus(status)) {
      return {
        ok: false,
        error: `status "${status}" no válido. Usa idea, active, paused o done.`,
      };
    }

    // Only what the model sent is written, the same convention as update_task and
    // log_book: a call that moves a project to "paused" must not wipe its description.
    const patch: Record<string, unknown> = {};
    if (args['description'] !== undefined) {
      patch['description'] = optionalString(args, 'description', 600);
    }
    if (args['notes'] !== undefined) patch['notes'] = optionalString(args, 'notes', 1_000);
    if (status !== null) patch['status'] = status;

    const incoming = parseLinks(args['links']);

    const match = await findProject(name, ctx);
    if (match.ambiguous.length > 0) {
      // Guessing here creates a second row for a project that already exists, and from
      // then on half the links live in each. The model can ask; it has the names.
      return {
        ok: false,
        error:
          `"${name}" encaja con varios proyectos suyos: ` +
          `${match.ambiguous.map((project) => project.name).join(', ')}. ` +
          'Pregúntale a cuál se refiere y vuelve a llamarme con el nombre exacto.',
      };
    }

    const existing = match.project;
    if (existing) {
      if (incoming.length > 0) patch['links'] = mergeLinks(existing.links, incoming);
      // Touched even when the patch is empty: mentioning a project is what keeps it at
      // the top of the injected index, and that ordering is the whole point of it.
      patch['updated_at'] = new Date().toISOString();

      const updated = await ctx.db.update<ProjectRow>(
        'projects',
        { id: `eq.${existing.id}`, user_id: `eq.${ctx.userId}` },
        patch,
      );
      const project = updated[0];
      if (!project) {
        return { ok: false, error: `No he podido actualizar el proyecto "${existing.name}".` };
      }
      return { ok: true, data: { ...summarize(project), already_saved: true } };
    }

    const project = await ctx.db.insert<ProjectRow>('projects', {
      user_id: ctx.userId,
      name,
      status: 'active',
      links: incoming,
      ...patch,
    });

    return { ok: true, data: summarize(project) };
  },
};

export const listProjects: ToolDefinition = {
  name: 'list_projects',
  description:
    'Sus proyectos con todo lo guardado: descripción, estado, enlaces y notas. Los que ' +
    'tiene en marcha ya te llegan resumidos en el contexto, así que llámala para lo que ' +
    'ahí no está: un enlace concreto, las notas de uno, los que están parados o ' +
    'terminados, o el id antes de borrar. Nunca te inventes una url: si no sale aquí, no ' +
    'la tienes.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...STATUSES],
        description: `Filtra por estado. ${STATUS_HINT} Sin filtro salen todos.`,
      },
      query: {
        type: 'string',
        description:
          'Busca en el nombre, la descripción y las notas. Una palabra suelta, no una frase.',
      },
      limit: { type: 'integer', description: 'Máximo de proyectos a devolver. Por defecto 20.' },
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
        error: `status "${status}" no válido. Usa idea, active, paused o done.`,
      };
    }

    const filters: Record<string, string> = { user_id: `eq.${ctx.userId}` };
    if (status !== null) filters['status'] = `eq.${status}`;

    const query = optionalString(args, 'query', 100);
    if (query) {
      // Same substring search as recall() and list_books. The links are deliberately out
      // of it: a url matches on its domain and would drag in every project hosted on the
      // same one.
      const escaped = query.replace(/[%,()]/g, ' ').trim();
      if (escaped) {
        filters['or'] =
          `(name.ilike.*${escaped}*,description.ilike.*${escaped}*,notes.ilike.*${escaped}*)`;
      }
    }

    const projects = await ctx.db.select<ProjectRow>('projects', {
      filters,
      order: 'updated_at.desc',
      limit: optionalInt(args, 'limit', 1, 50) ?? 20,
    });

    return {
      ok: true,
      data: {
        count: projects.length,
        projects: projects.map(summarize),
      },
    };
  },
};

export const deleteProject: ToolDefinition = {
  name: 'delete_project',
  description:
    'Borra un proyecto y con él sus enlaces y sus notas. Es para lo que se apuntó mal o ' +
    'nunca existió: si lo que pasa es que lo ha terminado o lo ha aparcado, eso es ' +
    'save_project con status="done" o "paused", que es como se conserva lo que hizo. ' +
    'Necesitas el id exacto: llama antes a list_projects.',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'El id (uuid) devuelto por list_projects.' },
    },
    required: ['project_id'],
  },
  mutates: true,
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const projectId = typeof args['project_id'] === 'string' ? args['project_id'] : '';
    const rows = await ctx.db.select<ProjectRow>('projects', {
      columns: 'id,name',
      filters: { id: `eq.${projectId}`, user_id: `eq.${ctx.userId}` },
      limit: 1,
    });
    const project = rows[0];
    return project
      ? `¿Borro el proyecto "${project.name}" con sus enlaces y sus notas?`
      : '¿Borro ese proyecto?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const projectId = requireString(args, 'project_id', 64);

    // The user_id filter is not decorative: same reason as in delete_task.
    const deleted = await ctx.db.delete<ProjectRow>('projects', {
      id: `eq.${projectId}`,
      user_id: `eq.${ctx.userId}`,
    });

    const project = deleted[0];
    if (!project) {
      return {
        ok: false,
        error: `No existe ningún proyecto con id ${projectId}. Llama a list_projects para ver los reales.`,
      };
    }

    return { ok: true, data: { deleted: true, name: project.name } };
  },
};

/**
 * The project a name refers to, when there is one.
 *
 * Names are compared normalised and BY WORDS, not by character containment the way book
 * titles are: a project called "Jarvis" gets mentioned as "el Jarvis", so what has to
 * match is one token set containing the other. By characters, "web" would match "la web
 * de Codegenia" and also every other project with "web" in the name.
 *
 * When more than one fits, none is returned. A wrong guess here is not a wrong answer,
 * it is a second row for a project that already exists, with half the links in each.
 */
async function findProject(
  name: string,
  ctx: ToolContext,
): Promise<{ project: ProjectRow | null; ambiguous: ProjectRow[] }> {
  const wanted = tokenize(name);
  if (wanted.length === 0) return { project: null, ambiguous: [] };

  const projects = await ctx.db.select<ProjectRow>('projects', {
    columns: 'id,name,links',
    filters: { user_id: `eq.${ctx.userId}` },
    order: 'updated_at.desc',
    limit: 100,
  });

  const partial: ProjectRow[] = [];
  for (const candidate of projects) {
    const other = tokenize(candidate.name);
    if (other.length === 0) continue;
    if (other.join(' ') === wanted.join(' ')) return { project: candidate, ambiguous: [] };
    if (contains(wanted, other) || contains(other, wanted)) partial.push(candidate);
  }

  const only = partial[0];
  if (partial.length === 1 && only) return { project: only, ambiguous: [] };
  if (partial.length > 1) return { project: null, ambiguous: partial };
  return { project: null, ambiguous: [] };
}

/**
 * Whether every meaningful word of `inner` is in `outer`.
 *
 * Words of one or two letters do not count towards a match —"la", "de", "el"— because on
 * their own they are what turns "la web" and "el de la tienda" into the same project.
 */
function contains(inner: string[], outer: string[]): boolean {
  const meaningful = inner.filter((word) => word.length > 2);
  if (meaningful.length === 0) return false;
  return meaningful.every((word) => outer.includes(word));
}

function tokenize(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * The links the model sent, validated.
 *
 * An invented url is the worst thing this domain can store: it is not obviously wrong
 * until somebody clicks it, and by then it has been read back as fact for weeks. So
 * anything that does not parse as http(s) goes back to the model as an error instead of
 * being saved and repeated.
 */
function parseLinks(raw: unknown): ProjectLink[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ToolValidationError('El campo "links" debe ser una lista de {label, url}.');
  }
  if (raw.length > MAX_LINKS) {
    throw new ToolValidationError(`No mandes más de ${MAX_LINKS} enlaces por proyecto.`);
  }

  const links: ProjectLink[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ToolValidationError('Cada enlace es un objeto con "label" y "url".');
    }
    const entry = item as Record<string, unknown>;

    const rawUrl = typeof entry['url'] === 'string' ? entry['url'].trim() : '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ToolValidationError(
        `"${rawUrl}" no es una url válida. Necesito la dirección completa, con http:// o https://.`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolValidationError('Los enlaces tienen que ser http o https.');
    }

    const label = typeof entry['label'] === 'string' ? entry['label'].trim().slice(0, 40) : '';
    links.push({
      // With no label the host is a better key than nothing: it still corrects itself the
      // next time the same site is sent.
      label: (label || url.hostname.replace(/^www\./, '')).toLowerCase(),
      url: url.toString(),
    });
  }
  return links;
}

/** Upsert by label, the same contract as `remember`: same key, new value, one row. */
function mergeLinks(current: ProjectLink[], incoming: ProjectLink[]): ProjectLink[] {
  const merged = Array.isArray(current) ? [...current] : [];
  for (const link of incoming) {
    const at = merged.findIndex((existing) => existing.label === link.label);
    if (at >= 0) merged[at] = link;
    else merged.push(link);
  }
  return merged.slice(0, MAX_LINKS);
}

/** What the model reads. Empty fields are not named: see `summarize` in books.ts. */
function summarize(project: ProjectRow) {
  const links = Array.isArray(project.links) ? project.links : [];
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    ...(project.description ? { description: project.description } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(project.notes ? { notes: project.notes } : {}),
  };
}

/**
 * The projects injected into every message: the ones in progress, and only their line.
 *
 * The finished and the parked ones are left out on purpose. They are the majority after
 * a year and they get asked about once a month, which is the trade §11 already settled
 * for the books: what earns a place in the prompt is what the next message is likely to
 * mention.
 */
export async function loadActiveProjects(
  db: Db,
  userId: string,
  limit = 12,
): Promise<ProjectRow[]> {
  return db.select<ProjectRow>('projects', {
    columns: 'id,name,description,status',
    filters: { user_id: `eq.${userId}`, status: 'eq.active' },
    order: 'updated_at.desc',
    limit,
  });
}
