import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import { formatShortDateTime, formatTime, localNow } from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';

/**
 * Recordatorios de tareas que vencen.
 *
 * Hay dos clases de aviso y no se pueden medir con la misma vara:
 *
 * - **A la hora pedida** (`remind_at`): "recuérdamelo a las 12:10" tiene que llegar
 *   a las 12:10, no cuando venga bien. La precisión la marca el periodo del cron.
 * - **Antes de vencer** (`due_at` sin `remind_at`): aquí interesa el margen. Avisar
 *   justo al vencer no sirve de nada, así que se avisa con una hora de antelación.
 *
 * Esto costó un fallo real: con el cron cada hora en punto, un aviso pedido a las
 * 12:10 desde un mensaje de las 12:07 no podía llegar antes de las 13:00. Por eso
 * el cron pasó a cada cinco minutos.
 *
 * `reminded_at` es lo que evita repetir el aviso en cada disparo hasta que la tarea
 * se complete. La primera vez que corre esto, las tareas ya vencidas de antes
 * también entran: son las que más falta hacía recordar.
 */

/** Igual que el periodo del cron: el aviso llega dentro de esos cinco minutos. */
const PRECISE_HORIZON_MS = 5 * 60 * 1000;

/** Antelación de cortesía para las tareas que solo tienen fecha límite. */
const DUE_HORIZON_MS = 60 * 60 * 1000;

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

  const base = {
    user_id: `eq.${target.userId}`,
    status: 'eq.pending',
    reminded_at: 'is.null',
  };

  // Dos consultas en paralelo en vez de una con `or`: los dos conjuntos son
  // disjuntos —una exige remind_at, la otra que sea nulo—, así que no hay nada que
  // deduplicar, y cada filtro usa sintaxis que ya está probada en el resto del código.
  //
  // `lte` sobre una columna nula no casa nunca, así que las tareas sin fecha se
  // quedan fuera solas, sin filtrarlas aparte.
  const [requested, upcoming] = await Promise.all([
    db.select<TaskRow>('tasks', {
      filters: {
        ...base,
        remind_at: `lte.${new Date(now.getTime() + PRECISE_HORIZON_MS).toISOString()}`,
      },
      order: 'remind_at.asc',
      limit: MAX_PER_RUN,
    }),
    db.select<TaskRow>('tasks', {
      filters: {
        ...base,
        remind_at: 'is.null',
        due_at: `lte.${new Date(now.getTime() + DUE_HORIZON_MS).toISOString()}`,
      },
      order: 'due_at.asc',
      limit: MAX_PER_RUN,
    }),
  ]);

  // El Map deduplica por id. Los dos conjuntos no deberían solaparse nunca, pero si
  // algún día uno de los filtros cambia y sí lo hacen, el fallo sería un aviso
  // repetido en el mismo mensaje: barato de evitar, feo de leer en el chat.
  const tasks = [...new Map([...requested, ...upcoming].map((task) => [task.id, task])).values()]
    .sort((a, b) => alarmTime(a) - alarmTime(b))
    .slice(0, MAX_PER_RUN);

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

/** Cuándo toca avisar de esta tarea: su aviso propio, o su vencimiento. */
function alarmTime(task: TaskRow): number {
  const iso = task.remind_at ?? task.due_at;
  return iso ? new Date(iso).getTime() : 0;
}

function buildReminderText(tasks: TaskRow[], timezone: string, now: Date): string {
  if (tasks.length === 1) {
    const task = tasks[0]!;
    const label = dueLabel(task, timezone, now);
    // Una tarea con aviso propio y sin fecha límite no tiene nada que añadir: el
    // usuario pidió que le avisáramos ahora, y ya está.
    return label ? `Recordatorio: "${task.title}" ${label}.` : `Recordatorio: "${task.title}".`;
  }

  return [
    'Recordatorio de lo que tienes encima:',
    '',
    ...tasks.map((task) => {
      const label = dueLabel(task, timezone, now);
      return label ? `- ${task.title} (${label})` : `- ${task.title}`;
    }),
  ].join('\n');
}

function dueLabel(task: TaskRow, timezone: string, now: Date): string | null {
  if (!task.due_at) return null;

  const due = new Date(task.due_at);
  const sameDay = localNow(due, timezone).date === localNow(now, timezone).date;
  const when = sameDay
    ? `a las ${formatTime(due, timezone)}`
    : `el ${formatShortDateTime(due, timezone)}`;

  return due.getTime() < now.getTime() ? `venció ${when}` : `vence ${when}`;
}
