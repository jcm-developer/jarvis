import { createDb } from '../agent';
import type { Config } from '../config';
import { listCronTargets } from '../db/identity';
import type { Deadline } from '../lib/deadline';
import { TelegramClient } from '../telegram/client';
import type { Env } from '../types';
import { sendBriefingIfDue } from './briefing';
import { sendDueReminders } from './reminders';

/**
 * Lo que corre en cada disparo del cron (cada hora, en UTC).
 *
 * Aquí el asistente deja de ser reactivo: nadie ha escrito nada y sin embargo hay
 * que decidir si toca hablar. Las dos decisiones —briefing y recordatorios— se
 * toman con datos de Supabase, no con el modelo.
 *
 * La hora del disparo no dice nada por sí sola: el cron va en UTC y lo que importa
 * es la hora local de cada usuario, que la calcula `lib/localtime.ts`.
 */

/** Sin sitio para una consulta y un envío, mejor no empezar con el siguiente usuario. */
const MIN_ROOM_MS = 6_000;

export async function runScheduled(env: Env, config: Config, deadline: Deadline): Promise<void> {
  const started = Date.now();
  const now = new Date();

  const db = createDb(env);
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const targets = await listCronTargets(db, config.allowedTelegramIds, config.defaultTimezone);

  let reminded = 0;
  let briefings = 0;
  let failures = 0;

  for (const target of targets) {
    if (!deadline.hasRoomFor(MIN_ROOM_MS)) {
      console.warn('cron: presupuesto agotado, quedan usuarios sin procesar');
      break;
    }

    // Cada bloque va con su try: que falle el recordatorio de uno no debe dejar al
    // resto sin briefing, ni al mismo usuario sin la otra mitad de su aviso.
    //
    // Una tarea que vence en la misma hora del briefing sale en los dos mensajes.
    // Se acepta: son cosas distintas —planificar el día y avisar de lo inminente— y
    // suprimir el recordatorio dejaría sin aviso justo a lo más urgente del día.
    try {
      reminded += await sendDueReminders({ db, telegram, target, now });
    } catch (error) {
      failures++;
      console.error(`cron: fallo en recordatorios de ${target.telegramId}:`, error);
    }

    try {
      const sent = await sendBriefingIfDue({
        env,
        db,
        telegram,
        target,
        now,
        briefingHour: config.briefingHour,
      });
      if (sent) briefings++;
    } catch (error) {
      failures++;
      console.error(`cron: fallo en el briefing de ${target.telegramId}:`, error);
    }
  }

  // Una línea por ejecución. El cron no tiene a nadie mirando: si no queda en los
  // logs que corrió y no hizo nada, no hay forma de distinguirlo de que no corrió.
  console.info(
    JSON.stringify({
      event: 'cron_run',
      targets: targets.length,
      reminded_tasks: reminded,
      briefings_sent: briefings,
      failures,
      duration_ms: Date.now() - started,
      budget_left_ms: deadline.remainingMs(),
    }),
  );
}
