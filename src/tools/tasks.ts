import type { TaskRow } from '../db/types';
import { parseRelativeMinutes } from '../lib/relative-time';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { optionalBoolean, optionalInt, optionalIsoDate, optionalString, requireString } from './types';

const PRIORITY_LABELS: Record<number, string> = { 1: 'alta', 2: 'normal', 3: 'baja' };

/** Un año. Tope de los desplazamientos relativos: más allá huele a error del modelo. */
const MAX_OFFSET_MINUTES = 525_600;

/**
 * Resuelve un desplazamiento en minutos a una fecha ISO.
 *
 * Existe porque el modelo se equivocaba de día. Pedirle "en 5 minutos" en ISO le
 * obliga a hacer aritmética de calendario, y con eso falla: acertaba la hora y
 * escribía la fecha de mañana, copiada de otra tarea del historial. El offset lo
 * calcula el Worker, que sí sabe qué hora es.
 */
function resolveOffset(args: Record<string, unknown>, field: string): string | null {
  const minutes = optionalInt(args, field, 1, MAX_OFFSET_MINUTES);
  return minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Margen que se le perdona al modelo antes de corregirle un plazo relativo. */
const DRIFT_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * Corrige la fecha cuando el usuario ha dicho un plazo y el modelo se ha ido lejos.
 *
 * Las reglas del prompt no bastaron: `gpt-4o-mini` seguía fechando "avísame en 3
 * minutos" al día siguiente, incluso teniendo un campo en minutos para no calcular
 * nada. El plazo del mensaje del usuario es la fuente auténtica, así que gana él.
 *
 * Solo corrige cuando la desviación pasa de diez minutos: si el modelo acertó, no
 * hay nada que tocar.
 */
function honourUserDeadline(
  chosen: string | null,
  ctx: ToolContext,
  field: string,
): string | null {
  const minutes = parseRelativeMinutes(ctx.userMessage);
  if (minutes === null) return chosen;

  const target = Date.now() + minutes * 60_000;
  if (chosen !== null && Math.abs(new Date(chosen).getTime() - target) <= DRIFT_TOLERANCE_MS) {
    return chosen;
  }

  const corrected = new Date(target).toISOString();
  console.warn(
    JSON.stringify({
      event: 'deadline_corrected',
      field,
      user_minutes: minutes,
      model_value: chosen,
      corrected_to: corrected,
    }),
  );
  return corrected;
}

const OFFSET_HINT =
  'Minutos desde ahora, para cuando el usuario habla en relativo ("en 5 minutos", ' +
  '"dentro de media hora"). Preferible a calcular la fecha tú. Manda esto o el ISO, no ambos.';

export const createTask: ToolDefinition = {
  name: 'create_task',
  description:
    'Crea una tarea o recordatorio para el usuario. Úsala cuando pida apuntar algo, ' +
    'recordarle algo, o mencione algo que tiene que hacer. Para una fecha concreta usa ' +
    'ISO 8601 partiendo de la fecha de hoy del contexto; para un plazo relativo ("en ' +
    'diez minutos", "esta tarde"), usa los campos en minutos y deja que yo calcule.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Qué hay que hacer, en una frase corta.' },
      notes: { type: 'string', description: 'Detalles adicionales, si los hay.' },
      due_at: {
        type: 'string',
        description: 'Fecha límite en ISO 8601 con zona horaria, ej. 2026-08-20T09:00:00+02:00.',
      },
      due_in_minutes: { type: 'integer', description: `Fecha límite. ${OFFSET_HINT}` },
      remind_at: {
        type: 'string',
        description:
          'Cuándo avisar, en ISO 8601, si el usuario pide el aviso a una hora distinta ' +
          'de la fecha límite. Si no se indica, el aviso sale al acercarse due_at.',
      },
      remind_in_minutes: { type: 'integer', description: `Hora del aviso. ${OFFSET_HINT}` },
      priority: {
        type: 'integer',
        description: 'Prioridad: 1 alta, 2 normal, 3 baja. Por defecto 2.',
      },
      force: {
        type: 'boolean',
        description:
          'Solo si te he dicho que ya existe una tarea parecida y de verdad es otra cosa ' +
          'distinta. No lo mandes por defecto.',
      },
    },
    required: ['title'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = cleanTitle(requireString(args, 'title', 200));

    // El relativo manda sobre el ISO: lo ha calculado el Worker con la hora real.
    // Y por encima de los dos, el plazo que dijo el usuario.
    let dueAt = resolveOffset(args, 'due_in_minutes') ?? optionalIsoDate(args, 'due_at');
    let remindAt = resolveOffset(args, 'remind_in_minutes') ?? optionalIsoDate(args, 'remind_at');

    // Si el usuario pidió un plazo y el modelo no puso ninguna fecha, es un aviso.
    if (dueAt === null && remindAt === null) {
      remindAt = honourUserDeadline(null, ctx, 'remind_at');
    } else if (remindAt !== null) {
      remindAt = honourUserDeadline(remindAt, ctx, 'remind_at');
    } else {
      dueAt = honourUserDeadline(dueAt, ctx, 'due_at');
    }

    if (!optionalBoolean(args, 'force')) {
      const duplicate = await findSimilarPending(title, ctx);
      if (duplicate) {
        // Error en vez de fila nueva. El modelo ignora la regla del prompt que le
        // dice que actualice en vez de duplicar, así que aquí no se le pide: no se
        // le deja, y el error le explica qué hacer con el id en la mano.
        return {
          ok: false,
          error:
            `Ya existe la tarea "${duplicate.title}" (id ${duplicate.id}). No crees otra: ` +
            'usa update_task con ese id para cambiarle la fecha o ponerle hora de aviso. ' +
            'Si de verdad es algo distinto, repite la llamada con force=true.',
        };
      }
    }

    const task = await ctx.db.insert<TaskRow>('tasks', {
      user_id: ctx.userId,
      title,
      notes: optionalString(args, 'notes'),
      due_at: dueAt,
      remind_at: remindAt,
      priority: optionalInt(args, 'priority', 1, 3) ?? 2,
    });

    return { ok: true, data: summarize(task, ctx.timezone) };
  },
};

/**
 * Quita el "recordar" del título.
 *
 * El prompt prohíbe los títulos tipo "Recordar llamar a David" y el modelo los
 * escribe igual. La tarea es llamar a David; recordarlo es lo que hace el cron.
 */
function cleanTitle(title: string): string {
  const cleaned = title.replace(
    /^\s*(?:recordatorio(?:\s+de)?|recordarme|recordar|acordarme(?:\s+de)?|avisarme(?:\s+de)?|avisar(?:\s+de)?)\s+(?:que\s+)?/i,
    '',
  );
  if (cleaned.length === 0) return title;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Busca una tarea pendiente que hable de lo mismo.
 *
 * Compara palabras significativas, no cadenas: "Recordar llamar a David" y "Llamar
 * a David a las seis" no se parecen como texto y son la misma cosa. Basta con que
 * las palabras del título más corto estén todas en el otro.
 */
async function findSimilarPending(title: string, ctx: ToolContext): Promise<TaskRow | null> {
  const words = significantWords(title);
  if (words.length === 0) return null;

  const pending = await ctx.db.select<TaskRow>('tasks', {
    columns: 'id,title',
    filters: { user_id: `eq.${ctx.userId}`, status: 'eq.pending' },
    order: 'created_at.desc',
    limit: 50,
  });

  for (const candidate of pending) {
    const other = significantWords(candidate.title);
    if (other.length === 0) continue;
    const [shorter, longer] = words.length <= other.length ? [words, other] : [other, words];

    // Con una sola palabra en común no basta: "comprar pan" y "comprar leche"
    // comparten "comprar" y son dos recados distintos. Ahí se exige que sean el
    // mismo título; a partir de dos palabras, que las del corto estén en el largo.
    const same =
      shorter.length === 1
        ? longer.length === 1 && longer[0] === shorter[0]
        : shorter.every((word) => longer.includes(word));

    if (same) return candidate;
  }
  return null;
}

/** Palabras de cuatro letras o más, sin acentos: las que distinguen una tarea. */
function significantWords(title: string): string[] {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

export const listTasks: ToolDefinition = {
  name: 'list_tasks',
  description:
    'Lista las tareas del usuario. Úsala cuando pregunte qué tiene pendiente, y ' +
    'también antes de modificar, completar o borrar algo, para obtener el id correcto.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'done', 'cancelled'],
        description: 'Por defecto "pending".',
      },
      due_before: {
        type: 'string',
        description: 'Solo tareas con vencimiento anterior a esta fecha ISO 8601.',
      },
      limit: { type: 'integer', description: 'Máximo de tareas a devolver. Por defecto 20.' },
    },
    required: [],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const status = optionalString(args, 'status') ?? 'pending';
    if (!['pending', 'done', 'cancelled'].includes(status)) {
      return { ok: false, error: `status "${status}" no válido. Usa pending, done o cancelled.` };
    }

    const filters: Record<string, string> = {
      user_id: `eq.${ctx.userId}`,
      status: `eq.${status}`,
    };

    const dueBefore = optionalIsoDate(args, 'due_before');
    if (dueBefore) filters['due_at'] = `lt.${dueBefore}`;

    const tasks = await ctx.db.select<TaskRow>('tasks', {
      filters,
      order: 'due_at.asc.nullslast,priority.asc',
      limit: optionalInt(args, 'limit', 1, 100) ?? 20,
    });

    return {
      ok: true,
      data: {
        count: tasks.length,
        tasks: tasks.map((task) => summarize(task, ctx.timezone)),
      },
    };
  },
};

export const updateTask: ToolDefinition = {
  name: 'update_task',
  description:
    'Modifica una tarea que ya existe: su fecha límite, su título, sus notas, su ' +
    'prioridad o su estado. Es la herramienta correcta cuando el usuario cambia de ' +
    'plan sobre algo ya apuntado ("mejor a las seis", "pásalo al viernes", "ya no ' +
    'hace falta"). Solo se tocan los campos que envíes. Necesitas el id exacto: si ' +
    'no lo tienes, llama antes a list_tasks.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'El id (uuid) devuelto por list_tasks.' },
      title: { type: 'string', description: 'Nuevo título.' },
      notes: {
        type: 'string',
        description: 'Nuevas notas. Cadena vacía para dejarla sin notas.',
      },
      due_at: {
        type: 'string',
        description:
          'Nueva fecha límite en ISO 8601 con zona horaria. Cadena vacía para quitarle la fecha.',
      },
      due_in_minutes: { type: 'integer', description: `Nueva fecha límite. ${OFFSET_HINT}` },
      remind_at: {
        type: 'string',
        description:
          'Cuándo avisar, en ISO 8601, cuando el usuario pide el aviso a una hora distinta ' +
          'de la fecha límite ("recuérdamelo a las 12:10"). Cadena vacía para volver al ' +
          'aviso normal, el de la fecha límite.',
      },
      remind_in_minutes: { type: 'integer', description: `Nueva hora del aviso. ${OFFSET_HINT}` },
      priority: { type: 'integer', description: 'Nueva prioridad: 1 alta, 2 normal, 3 baja.' },
      status: {
        type: 'string',
        enum: ['pending', 'done', 'cancelled'],
        description:
          'Nuevo estado. Usa "pending" para reabrir una tarea completada por error; ' +
          'para darla por hecha basta complete_task.',
      },
    },
    required: ['task_id'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    // Se mira la presencia del campo, no su valor: los validadores devuelven null
    // tanto para "no lo mandó" como para "lo mandó vacío", y aquí significan cosas
    // distintas —no tocar, frente a borrar el dato—.
    const patch: Record<string, unknown> = {};

    if (args['title'] !== undefined) patch['title'] = requireString(args, 'title', 200);
    if (args['notes'] !== undefined) patch['notes'] = optionalString(args, 'notes');
    if (args['priority'] !== undefined) {
      patch['priority'] = optionalInt(args, 'priority', 1, 3) ?? 2;
    }

    // Cambiar cualquiera de las dos fechas reabre el aviso. Sin esto, una tarea de
    // la que ya se avisó se aplazaría al día siguiente y el recordatorio no volvería
    // a salir nunca, porque el cron solo mira las que tienen reminded_at a null.
    if (args['due_in_minutes'] !== undefined || args['due_at'] !== undefined) {
      const chosen =
        resolveOffset(args, 'due_in_minutes') ??
        (args['due_at'] !== undefined ? optionalIsoDate(args, 'due_at') : null);
      // Solo se corrige lo que el modelo ha tocado: aquí no se inventan fechas que
      // el usuario no ha pedido cambiar.
      patch['due_at'] = chosen === null ? null : honourUserDeadline(chosen, ctx, 'due_at');
      patch['reminded_at'] = null;
    }

    if (args['remind_in_minutes'] !== undefined || args['remind_at'] !== undefined) {
      const chosen =
        resolveOffset(args, 'remind_in_minutes') ??
        (args['remind_at'] !== undefined ? optionalIsoDate(args, 'remind_at') : null);
      patch['remind_at'] = chosen === null ? null : honourUserDeadline(chosen, ctx, 'remind_at');
      patch['reminded_at'] = null;
    }

    if (args['status'] !== undefined) {
      const status = requireString(args, 'status', 20);
      if (!['pending', 'done', 'cancelled'].includes(status)) {
        return { ok: false, error: `status "${status}" no válido. Usa pending, done o cancelled.` };
      }
      patch['status'] = status;
      patch['completed_at'] = status === 'done' ? new Date().toISOString() : null;
    }

    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        error:
          'No has indicado qué cambiar. Manda al menos uno de: title, notes, due_at, ' +
          'due_in_minutes, remind_at, remind_in_minutes, priority o status.',
      };
    }

    const updated = await ctx.db.update<TaskRow>(
      'tasks',
      { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
      patch,
    );

    const task = updated[0];
    if (!task) return notFound(taskId);

    return { ok: true, data: summarize(task, ctx.timezone) };
  },
};

export const completeTask: ToolDefinition = {
  name: 'complete_task',
  description:
    'Marca una tarea como hecha, solo cuando el usuario ya la ha hecho de verdad. ' +
    'Si lo que hace es cambiarla de fecha o de plan, usa update_task en su lugar. ' +
    'Necesitas el id exacto: si no lo tienes, llama antes a list_tasks.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'El id (uuid) devuelto por list_tasks.' },
    },
    required: ['task_id'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    const updated = await ctx.db.update<TaskRow>(
      'tasks',
      { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
      { status: 'done', completed_at: new Date().toISOString() },
    );

    const task = updated[0];
    if (!task) return notFound(taskId);

    return { ok: true, data: summarize(task, ctx.timezone) };
  },
};

export const deleteTask: ToolDefinition = {
  name: 'delete_task',
  description:
    'Elimina una tarea de forma permanente. Solo si el usuario pide borrarla de ' +
    'verdad; para darla por hecha usa complete_task.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'El id (uuid) devuelto por list_tasks.' },
    },
    required: ['task_id'],
  },
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const taskId = typeof args['task_id'] === 'string' ? args['task_id'] : '';
    const rows = await ctx.db.select<TaskRow>('tasks', {
      filters: { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
      limit: 1,
    });
    const task = rows[0];
    return task
      ? `¿Borro definitivamente la tarea "${task.title}"?`
      : '¿Borro definitivamente esa tarea?';
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    // El filtro por user_id no es decorativo: impide borrar tareas ajenas si
    // algún día hay más de un usuario autorizado.
    const deleted = await ctx.db.delete<TaskRow>('tasks', {
      id: `eq.${taskId}`,
      user_id: `eq.${ctx.userId}`,
    });

    const task = deleted[0];
    if (!task) return notFound(taskId);

    return { ok: true, data: { deleted: true, title: task.title } };
  },
};

function notFound(taskId: string): ToolResult {
  return {
    ok: false,
    error: `No existe ninguna tarea con id ${taskId}. Llama a list_tasks para ver los ids reales.`,
  };
}

/** Forma compacta y legible: lo que ve el modelo en la siguiente iteración. */
function summarize(task: TaskRow, timezone: string) {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    due: task.due_at ? formatDate(task.due_at, timezone) : null,
    due_iso: task.due_at,
    // Solo cuando hay un aviso propio: en una lista de veinte tareas, un campo más
    // por fila son tokens en cada mensaje siguiente.
    ...(task.remind_at ? { remind: formatDate(task.remind_at, timezone) } : {}),
    priority: PRIORITY_LABELS[task.priority] ?? 'normal',
    status: task.status,
  };
}

function formatDate(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
