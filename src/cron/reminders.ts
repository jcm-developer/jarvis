import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import { formatShortDateTime, formatTime, localNow } from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';

/**
 * Recordatorios de tareas que vencen.
 *
 * El cron corre cada hora, así que la ventana es de una hora: se avisa de lo que
 * vence antes del siguiente disparo. Con una ventana más corta, una tarea que
 * vence a y media caería entre dos ejecuciones y el aviso llegaría tarde.
 *
 * `reminded_at` es lo que evita repetir el aviso cada hora hasta que la tarea se
 * complete. La primera vez que corre esto, las tareas ya vencidas de antes también
 * entran: son las que más falta hacía recordar.
 */

const HORIZON_MS = 60 * 60 * 1000;

/** Tope por ejecución: un histórico de vencidas no debe llegar como una avalancha. */
const MAX_PER_RUN = 10;

export interface ReminderDeps {
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
}

/** Devuelve de cuántas tareas se avisó. */
export async function sendDueReminders(deps: ReminderDeps): Promise<number> {
  const { db, telegram, target, now } = deps;

  const horizon = new Date(now.getTime() + HORIZON_MS).toISOString();

  const tasks = await db.select<TaskRow>('tasks', {
    filters: {
      user_id: `eq.${target.userId}`,
      status: 'eq.pending',
      // `lte` sobre una columna nula no casa, así que las tareas sin fecha se
      // quedan fuera sin necesidad de filtrarlas aparte.
      due_at: `lte.${horizon}`,
      reminded_at: 'is.null',
    },
    order: 'due_at.asc',
    limit: MAX_PER_RUN,
  });

  if (tasks.length === 0) return 0;

  const text = buildReminderText(tasks, target.timezone, now);
  await telegram.sendMessage(target.chatId, text);

  // Marcar DESPUÉS de enviar, y a propósito: si el envío falla, la tarea sigue sin
  // marcar y el aviso se reintenta a la hora siguiente. Al revés, un fallo de
  // Telegram se traduciría en un recordatorio que nunca llega.
  await markReminded(db, tasks, now);

  // El aviso entra en el historial para que el modelo sepa de qué le hablan si el
  // usuario contesta "hecho" o "posponlo".
  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return tasks.length;
}

async function markReminded(db: Db, tasks: TaskRow[], now: Date): Promise<void> {
  const ids = tasks.map((task) => task.id).join(',');
  try {
    await db.update('tasks', { id: `in.(${ids})` }, { reminded_at: now.toISOString() });
  } catch (error) {
    // Un aviso repetido molesta; perderlo, no. Si esto falla se avisará otra vez
    // dentro de una hora, y eso es el modo de fallo preferible.
    console.error('no se pudo marcar reminded_at:', error);
  }
}

function buildReminderText(tasks: TaskRow[], timezone: string, now: Date): string {
  if (tasks.length === 1) {
    const task = tasks[0]!;
    return `Recordatorio: "${task.title}" ${dueLabel(task, timezone, now)}.`;
  }

  return [
    'Recordatorio de lo que tienes encima:',
    '',
    ...tasks.map((task) => `- ${task.title} (${dueLabel(task, timezone, now)})`),
  ].join('\n');
}

function dueLabel(task: TaskRow, timezone: string, now: Date): string {
  if (!task.due_at) return 'sin fecha';

  const due = new Date(task.due_at);
  const sameDay = localNow(due, timezone).date === localNow(now, timezone).date;
  const when = sameDay
    ? `a las ${formatTime(due, timezone)}`
    : `el ${formatShortDateTime(due, timezone)}`;

  return due.getTime() < now.getTime() ? `venció ${when}` : `vence ${when}`;
}
