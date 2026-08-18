import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import {
  formatDayAndTime,
  formatTime,
  localNow,
  localTomorrow,
  localYesterday,
} from '../lib/localtime';
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

/**
 * El texto del aviso, escrito como lo escribiría una persona.
 *
 * La primera versión era una plantilla —`Recordatorio: "X" venció a las 13:25`— y en
 * el chat se leía como una alarma de sistema: comillas alrededor del título, el verbo
 * "vencer" y la hora repetida aunque fuese la de ahora mismo. Un aviso que llega a la
 * hora pedida no es un incumplimiento, así que ya no se anuncia como tal.
 *
 * Se compone aquí y no con el modelo: cuesta cero tokens, no puede inventarse una
 * tarea y no depende de que el LLM esté disponible cuando salta el cron.
 */
const OPENERS = ['Acuérdate de', 'No te olvides de', 'Oye, acuérdate de', 'Recuerda'];

const COUNT_WORDS = ['', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'];

/** Margen dentro del cual la hora es "ahora" y no hace falta decirla. */
const IMMINENT_MS = 20 * 60 * 1000;

function buildReminderText(tasks: TaskRow[], timezone: string, now: Date): string {
  if (tasks.length === 1) {
    const task = tasks[0]!;
    const overdue = isOverdue(task, now);
    const when = whenSuffix(task, timezone, now);

    if (overdue) {
      return `Se te ha pasado ${lowerFirst(task.title)}${when ? `, era ${when}` : ''}.`;
    }

    // El saludo se elige por el id de la tarea: varía entre tareas y no cambia si el
    // mismo aviso se repite, que quedaría raro.
    const opener = OPENERS[hash(task.id) % OPENERS.length]!;
    const connector = opener.endsWith('de') ? '' : ':';
    return `${opener}${connector} ${lowerFirst(task.title)}${when ? ` ${when}` : ''}.`;
  }

  const count = COUNT_WORDS[tasks.length] ?? String(tasks.length);
  return [
    `Tienes ${count} cosas encima:`,
    '',
    ...tasks.map((task) => {
      const when = whenSuffix(task, timezone, now);
      const mark = isOverdue(task, now) ? ' (se te ha pasado)' : '';
      return `- ${lowerFirst(task.title)}${when ? ` ${when}` : ''}${mark}`;
    }),
  ].join('\n');
}

function isOverdue(task: TaskRow, now: Date): boolean {
  return task.due_at !== null && new Date(task.due_at).getTime() < now.getTime() - IMMINENT_MS;
}

/**
 * "a las 18:00", "ayer a las 09:00", "el 20 de agosto a las 09:00" o nada.
 *
 * Devuelve nada cuando la hora no aporta: si es dentro del margen de ahora mismo, o
 * si el propio título ya la lleva —"Llamar a David a las seis" con un "a las 13:25"
 * detrás es más confuso que decir solo el título—.
 */
function whenSuffix(task: TaskRow, timezone: string, now: Date): string | null {
  if (!task.due_at) return null;
  if (/\ba\s+las?\s+/i.test(task.title)) return null;

  const due = new Date(task.due_at);
  if (Math.abs(due.getTime() - now.getTime()) <= IMMINENT_MS) return null;

  const day = localNow(due, timezone).date;
  const hour = formatTime(due, timezone);

  if (day === localNow(now, timezone).date) return `a las ${hour}`;
  if (day === localYesterday(now, timezone)) return `ayer a las ${hour}`;
  if (day === localTomorrow(now, timezone)) return `mañana a las ${hour}`;
  return `el ${formatDayAndTime(due, timezone)}`;
}

/** "Llamar a David" → "llamar a David", que es como se dice dentro de una frase. */
function lowerFirst(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

/** Hash barato y estable. Solo se usa para elegir una frase, no para nada sensible. */
function hash(value: string): number {
  let total = 0;
  for (let i = 0; i < value.length; i++) total = (total + value.charCodeAt(i)) % 997;
  return total;
}
