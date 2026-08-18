import type { TaskRow } from '../db/types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { optionalInt, optionalIsoDate, optionalString, requireString } from './types';

const PRIORITY_LABELS: Record<number, string> = { 1: 'alta', 2: 'normal', 3: 'baja' };

export const createTask: ToolDefinition = {
  name: 'create_task',
  description:
    'Crea una tarea o recordatorio para el usuario. Úsala cuando pida apuntar algo, ' +
    'recordarle algo, o mencione algo que tiene que hacer. Si menciona una fecha o ' +
    'plazo, conviértelo a ISO 8601 usando la fecha actual del contexto.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Qué hay que hacer, en una frase corta.' },
      notes: { type: 'string', description: 'Detalles adicionales, si los hay.' },
      due_at: {
        type: 'string',
        description: 'Fecha límite en ISO 8601 con zona horaria, ej. 2026-08-20T09:00:00+02:00.',
      },
      priority: {
        type: 'integer',
        description: 'Prioridad: 1 alta, 2 normal, 3 baja. Por defecto 2.',
      },
    },
    required: ['title'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const task = await ctx.db.insert<TaskRow>('tasks', {
      user_id: ctx.userId,
      title: requireString(args, 'title', 200),
      notes: optionalString(args, 'notes'),
      due_at: optionalIsoDate(args, 'due_at'),
      priority: optionalInt(args, 'priority', 1, 3) ?? 2,
    });

    return { ok: true, data: summarize(task, ctx.timezone) };
  },
};

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

    if (args['due_at'] !== undefined) {
      patch['due_at'] = optionalIsoDate(args, 'due_at');
      // Mover la fecha reabre el aviso. Sin esto, una tarea de la que ya se avisó
      // se aplazaría al día siguiente y el recordatorio no volvería a salir nunca,
      // porque el cron solo mira las que tienen reminded_at a null.
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
          'No has indicado qué cambiar. Manda al menos uno de: title, notes, due_at, priority o status.',
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
