import type { Db } from '../db/client';
import type { CronTarget } from '../db/identity';
import { saveTurns } from '../db/messages';
import type { TaskRow } from '../db/types';
import {
  endOfLocalDay,
  formatLongDate,
  formatShortDateTime,
  formatTime,
  localNow,
} from '../lib/localtime';
import type { TelegramClient } from '../telegram/client';
import type { Env } from '../types';

/**
 * Briefing diario: lo que hay hoy, una vez al día y a la hora local del usuario.
 *
 * El texto se compone aquí, sin pasar por el modelo. Es una lista de tareas con
 * fechas: el LLM no añadiría nada y sí añadiría coste, latencia y la posibilidad
 * de inventarse una tarea que no existe. El briefing debe ser aburrido y exacto.
 */

/** La marca de "ya enviado hoy" caduca sola; no hace falta limpiarla. */
const MARKER_TTL_SECONDS = 172_800; // 48 h

/**
 * Ancho de la ventana de envío, en horas. Con BRIEFING_HOUR=8: 8, 9 o 10.
 *
 * El cron puede no dispararse a su hora, y comparando la hora exacta ese día
 * simplemente no habría briefing. Con ventana se recupera; sin límite llegaría un
 * "buenos días" a las once de la noche.
 */
const WINDOW_HOURS = 3;

/** Suficiente para un día cargado, y acota el tamaño del mensaje. */
const MAX_TASKS = 25;

export interface BriefingDeps {
  env: Env;
  db: Db;
  telegram: TelegramClient;
  target: CronTarget;
  now: Date;
  briefingHour: number;
}

/** Devuelve true si se envió. */
export async function sendBriefingIfDue(deps: BriefingDeps): Promise<boolean> {
  const { env, db, telegram, target, now, briefingHour } = deps;

  const local = localNow(now, target.timezone);
  const hoursLate = local.hour - briefingHour;
  if (hoursLate < 0 || hoursLate >= WINDOW_HOURS) return false;

  // La clave lleva la fecha LOCAL, no la UTC: es la que define "hoy" para quien
  // lee el mensaje. Una escritura al día en KV, que del presupuesto de 1.000 no
  // se nota.
  const marker = `briefing:${target.userId}:${local.date}`;
  if (await env.STATE.get(marker)) return false;

  const tasks = await db.select<TaskRow>('tasks', {
    filters: { user_id: `eq.${target.userId}`, status: 'eq.pending' },
    order: 'due_at.asc.nullslast,priority.asc',
    limit: MAX_TASKS,
  });

  const text = buildBriefingText(tasks, target.timezone, now);
  await telegram.sendMessage(target.chatId, text);

  // La marca se pone tras enviar: si Telegram falla, se reintenta al disparo
  // siguiente mientras siga dentro de la ventana.
  await env.STATE.put(marker, '1', { expirationTtl: MARKER_TTL_SECONDS });

  await saveTurns(db, target.conversationId, [{ role: 'assistant', content: text }]);

  return true;
}

function buildBriefingText(tasks: TaskRow[], timezone: string, now: Date): string {
  const endOfDay = endOfLocalDay(now, timezone).getTime();

  const overdue: TaskRow[] = [];
  const today: TaskRow[] = [];
  const undatedUrgent: TaskRow[] = [];

  for (const task of tasks) {
    if (!task.due_at) {
      // Las tareas sin fecha y sin prioridad no entran: el briefing es lo de hoy,
      // no el inventario completo de pendientes.
      if (task.priority === 1) undatedUrgent.push(task);
      continue;
    }
    const due = new Date(task.due_at).getTime();
    if (due < now.getTime()) overdue.push(task);
    else if (due < endOfDay) today.push(task);
  }

  const header = `${greeting(localNow(now, timezone).hour)}. Hoy es ${formatLongDate(now, timezone)}.`;

  if (overdue.length === 0 && today.length === 0 && undatedUrgent.length === 0) {
    return `${header} No tienes nada apuntado para hoy.`;
  }

  const lines = [header];

  if (overdue.length > 0) {
    lines.push('', 'Vencidas:');
    for (const task of overdue) {
      lines.push(`- ${task.title} (${formatShortDateTime(new Date(task.due_at!), timezone)})`);
    }
  }

  if (today.length > 0) {
    lines.push('', 'Hoy:');
    for (const task of today) {
      lines.push(`- ${formatTime(new Date(task.due_at!), timezone)} ${task.title}${flag(task)}`);
    }
  }

  if (undatedUrgent.length > 0) {
    lines.push('', 'Sin fecha, prioridad alta:');
    for (const task of undatedUrgent) {
      lines.push(`- ${task.title}`);
    }
  }

  return lines.join('\n');
}

function flag(task: TaskRow): string {
  return task.priority === 1 ? ' (alta)' : '';
}

/** BRIEFING_HOUR es configurable, así que el saludo no puede dar por hecha la mañana. */
function greeting(hour: number): string {
  if (hour < 14) return 'Buenos días';
  if (hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}
