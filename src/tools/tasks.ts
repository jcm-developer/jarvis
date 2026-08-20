import type { TaskRow } from '../db/types';
import { formatDayAndTime } from '../lib/localtime';
import {
  REPEAT_FREQUENCIES,
  isRepeatFrequency,
  nextOccurrence,
  repeatPhrase,
} from '../lib/recurrence';
import { OFFSET_HINT, cleanTitle, honourUserDeadlines, resolveOffset } from './guardrails';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { optionalBoolean, optionalInt, optionalIsoDate, optionalString, requireString } from './types';

const PRIORITY_LABELS: Record<number, string> = { 1: 'alta', 2: 'normal', 3: 'baja' };

export const createTask: ToolDefinition = {
  name: 'create_task',
  description:
    'Crea una tarea o un aviso para el usuario. Úsala cuando pida apuntar algo, ' +
    'recordarle algo, o mencione algo que tiene que hacer. Mira kind para elegir cuál ' +
    'de las dos cosas es. Para una fecha concreta usa ISO 8601 partiendo de la fecha de ' +
    'hoy del contexto; para un plazo relativo ("en diez minutos", "esta tarde"), usa ' +
    'los campos en minutos y deja que yo calcule.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Qué hay que hacer, en una frase corta.' },
      notes: { type: 'string', description: 'Detalles adicionales, si los hay.' },
      kind: {
        type: 'string',
        enum: ['task', 'reminder'],
        description:
          'Por defecto "task". Usa "reminder" cuando lo único que quiere es que le avise a ' +
          'una hora y ahí se acabe ("recuérdame a las nueve que saque la basura", "avísame ' +
          'en cinco minutos"): el aviso sale y desaparece de sus pendientes, así que hace ' +
          'falta la hora. Usa "task" cuando lo que importa es que quede hecho y quiera ' +
          'verlo en la lista hasta entonces ("pagar el IBI antes del viernes"). Si dudas, ' +
          '"task": una tarea de más se ve en la lista, un aviso de más desaparece solo.',
      },
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
      repeat: {
        type: 'string',
        enum: [...REPEAT_FREQUENCIES],
        description:
          'Solo si lo que hay que hacer se repite siempre ("saca la basura los martes", ' +
          '"el alquiler el día 1", "la pastilla todos los días a las nueve"). Manda la ' +
          'frecuencia y una hora, y yo me encargo de la siguiente vez: NO crees una tarea ' +
          'por cada repetición ni calcules tú la próxima fecha. Sin frecuencia, la tarea ' +
          'es de una sola vez.',
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
  mutates: true,
  requiresConfirmation: false,
  // Only read on the photo path, where nothing gets written without being read back
  // first. It names the date the way the reply would, which is what lets the user catch
  // a day taken off a letter wrong before it becomes a row.
  confirmationPrompt: async (args, ctx) => {
    const title = cleanTitle(optionalString(args, 'title', 200) ?? 'eso');
    const isReminder = (optionalString(args, 'kind', 20) ?? 'task') === 'reminder';

    const remindAt = resolveOffset(args, 'remind_in_minutes') ?? optionalIsoDate(args, 'remind_at');
    const dueAt = resolveOffset(args, 'due_in_minutes') ?? optionalIsoDate(args, 'due_at');
    const when = whenPhrase(remindAt ?? dueAt, ctx.timezone);

    const phrase = repeatPhrase(optionalString(args, 'repeat', 20)?.toLowerCase() ?? '');
    const every = phrase ? `, ${phrase}` : '';

    if (isReminder) {
      return when
        ? `¿Te aviso de "${title}" el ${when}${every}?`
        : `¿Te pongo un aviso de "${title}"${every}?`;
    }
    return when
      ? `¿Apunto "${title}" para el ${when}${every}?`
      : `¿Apunto "${title}"${every}?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const title = cleanTitle(requireString(args, 'title', 200));

    const kind = optionalString(args, 'kind', 20) ?? 'task';
    if (kind !== 'task' && kind !== 'reminder') {
      return { ok: false, error: `kind "${kind}" no válido. Usa "task" o "reminder".` };
    }

    // The relative offset wins over the ISO date: the Worker computed it against the
    // real clock. And above both of them, whatever the user said in their message.
    let { dueAt, remindAt } = honourUserDeadlines(
      {
        dueAt: resolveOffset(args, 'due_in_minutes') ?? optionalIsoDate(args, 'due_at'),
        remindAt: resolveOffset(args, 'remind_in_minutes') ?? optionalIsoDate(args, 'remind_at'),
      },
      ctx,
    );

    if (kind === 'reminder') {
      // An alert's time belongs in remind_at, never in due_at: from due_at the cron
      // announces it an hour early, which is the right courtesy for a deadline and plain
      // wrong for "remind me at 12:10". The model mixes the two fields up, so the value
      // is moved here instead of being asked for again.
      if (remindAt === null && dueAt !== null) {
        remindAt = dueAt;
        dueAt = null;
      }
      // A reminder with no time never fires, and it is not on the pending list either:
      // it would be a row nobody ever hears about again.
      if (remindAt === null) {
        return {
          ok: false,
          error:
            'Un aviso sin hora no llegaría nunca. Si el usuario ha dicho cuándo, repite la ' +
            'llamada con remind_at o remind_in_minutes. Si no lo ha dicho, pregúntaselo; y ' +
            'si en realidad es algo que hay que hacer y no un aviso, mándalo con ' +
            'kind="task".',
        };
      }
    }

    const repeat = optionalString(args, 'repeat', 20)?.toLowerCase() ?? null;
    if (repeat !== null && !isRepeatFrequency(repeat)) {
      return {
        ok: false,
        error:
          `repeat "${repeat}" no válido. Usa una de estas: ${REPEAT_FREQUENCIES.join(', ')}. ` +
          'Si la repetición que pide no está en la lista, dile que puedes apuntarla una ' +
          'sola vez y que la otra tendría que ponerla él en su calendario.',
      };
    }
    // Something that repeats and has no date has nothing to advance: it would be a
    // frequency stored on a row that never fires and never rolls over.
    if (repeat !== null && dueAt === null && remindAt === null) {
      return {
        ok: false,
        error:
          'Para que algo se repita necesito una fecha u hora de partida. Si el usuario ha ' +
          'dicho cuándo es la primera vez, repite la llamada con due_at o remind_at; si no ' +
          'lo ha dicho, pregúntaselo.',
      };
    }

    // Duplicate control is for tasks only. Two alerts with the same title are two
    // different alerts —the pill at 09:00 and the pill at 21:00— so blocking the second
    // one would lose it; and an alert that has already gone out is closed, so it cannot
    // block anything either way.
    if (kind === 'task' && !optionalBoolean(args, 'force')) {
      const duplicate = await findSimilarPending(title, ctx);
      if (duplicate) {
        // An error instead of a new row. The model ignores the prompt rule telling it
        // to update rather than duplicate, so here it is not asked to comply: it is
        // not allowed to, and the error explains what to do with the id in hand.
        return {
          ok: false,
          error:
            `Ya existe la tarea "${duplicate.title}" (id ${duplicate.id}). No crees otra: ` +
            'usa update_task con ese id para cambiarle la fecha o ponerle hora de aviso. ' +
            'Si no tienes claro si quiere cambiar esa o apuntar algo nuevo, pregúntaselo. ' +
            'Y si es evidente que son cosas distintas, repite la llamada con force=true.',
        };
      }
    }

    const task = await ctx.db.insert<TaskRow>('tasks', {
      user_id: ctx.userId,
      title,
      notes: optionalString(args, 'notes'),
      kind,
      due_at: dueAt,
      remind_at: remindAt,
      priority: optionalInt(args, 'priority', 1, 3) ?? 2,
      recurrence: repeat,
    });

    return { ok: true, data: summarize(task, ctx.timezone) };
  },
};

/**
 * Looks for a pending task about the same thing.
 *
 * It compares significant words, not strings: "Recordar llamar a David" and "Llamar a
 * David a las seis" look nothing alike as text and are the same thing. It is enough
 * for every word of the shorter title to appear in the other one.
 */
async function findSimilarPending(title: string, ctx: ToolContext): Promise<TaskRow | null> {
  const words = significantWords(title);
  if (words.length === 0) return null;

  const pending = await ctx.db.select<TaskRow>('tasks', {
    columns: 'id,title',
    filters: { user_id: `eq.${ctx.userId}`, status: 'eq.pending', kind: 'eq.task' },
    order: 'created_at.desc',
    limit: 50,
  });

  for (const candidate of pending) {
    const other = significantWords(candidate.title);
    if (other.length === 0) continue;
    const [shorter, longer] = words.length <= other.length ? [words, other] : [other, words];

    // One word in common is not enough: "comprar pan" and "comprar leche" share
    // "comprar" and are two different errands. There the titles must match outright;
    // from two words up, the short one's words must all be in the long one.
    const same =
      shorter.length === 1
        ? longer.length === 1 && longer[0] === shorter[0]
        : shorter.every((word) => longer.includes(word));

    if (same) return candidate;
  }
  return null;
}

/** Words of four letters or more, unaccented: the ones that tell tasks apart. */
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
    'también antes de modificar, completar o borrar algo, para obtener el id correcto. ' +
    'Los avisos no salen aquí salvo que pidas kind="reminder".',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'done', 'cancelled'],
        description: 'Por defecto "pending".',
      },
      kind: {
        type: 'string',
        enum: ['task', 'reminder'],
        description:
          'Por defecto "task". Manda "reminder" solo si pregunta por los avisos que tiene ' +
          'puestos o quiere cambiar o quitar uno. Los avisos que ya han salido no ' +
          'aparecen: están gastados.',
      },
      due_before: {
        type: 'string',
        description: 'Solo tareas con vencimiento anterior a esta fecha ISO 8601.',
      },
      limit: { type: 'integer', description: 'Máximo de tareas a devolver. Por defecto 20.' },
    },
    required: [],
  },
  mutates: false,
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const status = optionalString(args, 'status') ?? 'pending';
    if (!['pending', 'done', 'cancelled'].includes(status)) {
      return { ok: false, error: `status "${status}" no válido. Usa pending, done o cancelled.` };
    }

    const kind = optionalString(args, 'kind', 20) ?? 'task';
    if (kind !== 'task' && kind !== 'reminder') {
      return { ok: false, error: `kind "${kind}" no válido. Usa "task" o "reminder".` };
    }

    const filters: Record<string, string> = {
      user_id: `eq.${ctx.userId}`,
      status: `eq.${status}`,
      kind: `eq.${kind}`,
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
      repeat: {
        type: 'string',
        enum: [...REPEAT_FREQUENCIES, ''],
        description:
          'Nueva frecuencia, si el usuario cambia cada cuánto se repite. Cadena vacía para ' +
          'que deje de repetirse y se quede en una sola vez.',
      },
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
  mutates: true,
  requiresConfirmation: false,
  confirmationPrompt: async (args, ctx) => {
    const title = await titleOf(args, ctx);
    const when = whenPhrase(
      resolveOffset(args, 'remind_in_minutes') ??
        optionalIsoDate(args, 'remind_at') ??
        resolveOffset(args, 'due_in_minutes') ??
        optionalIsoDate(args, 'due_at'),
      ctx.timezone,
    );
    const newTitle = optionalString(args, 'title', 200);

    if (when) return `¿Paso ${title} al ${when}?`;
    if (newTitle) return `¿Cambio ${title} a "${cleanTitle(newTitle)}"?`;
    return `¿Cambio ${title}?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    // Field presence is what gets checked, not its value: the validators return null
    // both for "not sent" and for "sent empty", and here those mean different things —
    // leave it alone versus wipe the value.
    const patch: Record<string, unknown> = {};

    if (args['title'] !== undefined) patch['title'] = requireString(args, 'title', 200);
    if (args['notes'] !== undefined) patch['notes'] = optionalString(args, 'notes');
    if (args['priority'] !== undefined) {
      patch['priority'] = optionalInt(args, 'priority', 1, 3) ?? 2;
    }

    // Changing either date reopens the reminder. Without this, postponing a task that
    // was already announced would leave it without a reminder forever, because the
    // cron only looks at the ones whose reminded_at is null.
    const touchesDue = args['due_in_minutes'] !== undefined || args['due_at'] !== undefined;
    const touchesRemind = args['remind_in_minutes'] !== undefined || args['remind_at'] !== undefined;

    if (touchesDue || touchesRemind) {
      const corrected = honourUserDeadlines(
        {
          dueAt: touchesDue
            ? (resolveOffset(args, 'due_in_minutes') ?? optionalIsoDate(args, 'due_at'))
            : null,
          remindAt: touchesRemind
            ? (resolveOffset(args, 'remind_in_minutes') ?? optionalIsoDate(args, 'remind_at'))
            : null,
        },
        ctx,
      );

      // Only what the model touched gets written: no dates are invented here that the
      // user never asked to change.
      if (touchesDue) patch['due_at'] = corrected.dueAt;
      if (touchesRemind) patch['remind_at'] = corrected.remindAt;
      patch['reminded_at'] = null;
    }

    if (args['repeat'] !== undefined) {
      // The empty string is how a frequency is removed, the same convention the notes and
      // the dates already use here: not sent means "leave it alone", sent empty means
      // "wipe it".
      const repeat = optionalString(args, 'repeat', 20)?.toLowerCase() ?? null;
      if (repeat !== null && !isRepeatFrequency(repeat)) {
        return {
          ok: false,
          error:
            `repeat "${repeat}" no válido. Usa una de estas: ${REPEAT_FREQUENCIES.join(', ')}, ` +
            'o cadena vacía para quitar la repetición.',
        };
      }
      patch['recurrence'] = repeat;
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
  mutates: true,
  requiresConfirmation: false,
  confirmationPrompt: async (args, ctx) => `¿Marco ${await titleOf(args, ctx)} como hecha?`,
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    // Something that repeats is not closed when it is done: it moves to its next date.
    // Otherwise "sacar la basura los martes" would have to be created again every week,
    // which is the chore the frequency exists to remove.
    const [existing] = await ctx.db.select<TaskRow>('tasks', {
      filters: { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
      limit: 1,
    });
    if (existing?.recurrence) {
      return rollForward(existing, ctx);
    }

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
  mutates: true,
  requiresConfirmation: true,
  confirmationPrompt: async (args, ctx) => {
    const taskId = typeof args['task_id'] === 'string' ? args['task_id'] : '';
    const rows = await ctx.db.select<TaskRow>('tasks', {
      filters: { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
      limit: 1,
    });
    const task = rows[0];
    if (!task) return '¿Borro definitivamente esa tarea?';

    // One row holds every future occurrence, so deleting it is not "this week's bins":
    // it is all of them. Saying so is what makes it a confirmation and not a trap.
    const phrase = task.recurrence ? repeatPhrase(task.recurrence) : null;
    return phrase
      ? `"${task.title}" se repite ${phrase}. ¿La borro del todo y dejo de avisarte?`
      : `¿Borro definitivamente la tarea "${task.title}"?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const taskId = requireString(args, 'task_id', 64);

    // The user_id filter is not decorative: it prevents deleting someone else's tasks
    // if there is ever more than one authorised user.
    const deleted = await ctx.db.delete<TaskRow>('tasks', {
      id: `eq.${taskId}`,
      user_id: `eq.${ctx.userId}`,
    });

    const task = deleted[0];
    if (!task) return notFound(taskId);

    return { ok: true, data: { deleted: true, title: task.title } };
  },
};

/**
 * Moves a recurring task to its next occurrence instead of closing it.
 *
 * **One row rolled forward, not a row per occurrence.** A row per occurrence needs an
 * insert plus a close, and those are two writes that can half-happen: the insert landing
 * with the close failing is a duplicate, the other way round is a repetition that
 * disappears silently. Rolling forward is a single patch, which is the same argument the
 * postpone button is built on (§12).
 *
 * What is given up is the history of "I did it in August", and it is not lost: every
 * `complete_task` is in `tool_call_logs` with its arguments. Phase 13 was already going
 * to read postponements from there, so it is not a new dependency.
 */
async function rollForward(task: TaskRow, ctx: ToolContext): Promise<ToolResult> {
  const now = new Date();
  const frequency = task.recurrence!;

  // Both dates advance, each from its own value: a task due on the 1st that warns on the
  // 28th has to keep those three days between them.
  const patch: Record<string, unknown> = { reminded_at: null };
  let announced: Date | null = null;

  for (const field of ['due_at', 'remind_at'] as const) {
    const current = task[field];
    if (current === null) continue;
    const next = nextOccurrence(new Date(current), frequency, now, ctx.timezone);
    if (next === null) {
      return {
        ok: false,
        error:
          `No he podido calcular la siguiente vez de "${task.title}" (se repite ` +
          `${frequency}). No la he tocado: dile que hay que revisar esa repetición.`,
      };
    }
    patch[field] = next.toISOString();
    // What gets said out loud is the alert's date when it has one of its own, and the
    // deadline otherwise: that is the one the user is going to hear about next.
    if (field === 'remind_at' || announced === null) announced = next;
  }

  const updated = await ctx.db.update<TaskRow>(
    'tasks',
    { id: `eq.${task.id}`, user_id: `eq.${ctx.userId}` },
    patch,
  );

  const rolled = updated[0];
  if (!rolled) return notFound(task.id);

  return {
    ok: true,
    data: {
      ...summarize(rolled, ctx.timezone),
      done_this_time: true,
      // Named on its own so the model says it: "hecho, la siguiente el 27 de agosto" is
      // what tells the user the repetition is still alive.
      next: announced ? formatDayAndTime(announced, ctx.timezone) : null,
    },
  };
}

/**
 * The date, worded the way the reminders are (§12): "21 de agosto a las 10:00", never
 * an ISO string. What goes into a question the user has to read in a chat.
 */
function whenPhrase(iso: string | null, timezone: string): string | null {
  if (iso === null) return null;
  const instant = new Date(iso);
  return Number.isNaN(instant.getTime()) ? null : formatDayAndTime(instant, timezone);
}

/**
 * The task's title, for a question about a task that already exists.
 *
 * Costs a SELECT, same as the one `delete_task` has always paid: "¿marco 7f3a-... como
 * hecha?" is not a question anybody can answer, and the id is all the model sends.
 */
async function titleOf(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const taskId = typeof args['task_id'] === 'string' ? args['task_id'] : '';
  if (!taskId) return 'esa tarea';

  const rows = await ctx.db.select<TaskRow>('tasks', {
    columns: 'id,title',
    filters: { id: `eq.${taskId}`, user_id: `eq.${ctx.userId}` },
    limit: 1,
  });
  const task = rows[0];
  return task ? `"${task.title}"` : 'esa tarea';
}

function notFound(taskId: string): ToolResult {
  return {
    ok: false,
    error: `No existe ninguna tarea con id ${taskId}. Llama a list_tasks para ver los ids reales.`,
  };
}

/** Compact and readable: what the model sees on the next iteration. */
function summarize(task: TaskRow, timezone: string) {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    // Only said out loud when it is an alert: 'task' is the norm and naming it on every
    // row of a twenty-task list is tokens spent on every following message.
    ...(task.kind === 'reminder' ? { kind: 'aviso' } : {}),
    due: task.due_at ? formatDate(task.due_at, timezone) : null,
    due_iso: task.due_at,
    // Only when there is a reminder of its own: across twenty tasks, one extra field
    // per row is tokens spent on every following message.
    ...(task.remind_at ? { remind: formatDate(task.remind_at, timezone) } : {}),
    priority: PRIORITY_LABELS[task.priority] ?? 'normal',
    // Only when it repeats, and said the way a person would. The model has to be able to
    // tell the user that completing this one will not make it go away.
    ...(task.recurrence ? { repeats: repeatPhrase(task.recurrence) ?? task.recurrence } : {}),
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
