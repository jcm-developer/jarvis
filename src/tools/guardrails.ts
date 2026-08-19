import { localNow, localTomorrow, zonedInstant } from '../lib/localtime';
import { mentionsAnotherDay, parseRelativeMinutes } from '../lib/relative-time';
import type { ToolContext } from './types';
import { optionalInt } from './types';

/**
 * Lo que hay que corregirle al modelo antes de escribir nada en ningún sitio.
 *
 * Vivía dentro de tasks.ts hasta que create_event necesitó las mismas
 * correcciones. La lección de la fase de pruebas —una regla que el modelo cumple
 * voluntariamente no es una garantía— vale igual para una cita que para una
 * tarea, y tener dos copias de esto garantizaría que se separasen a la primera.
 */

/** Un año. Tope de los desplazamientos relativos: más allá huele a error del modelo. */
export const MAX_OFFSET_MINUTES = 525_600;

/** Margen que se le perdona al modelo antes de corregirle un plazo relativo. */
export const DRIFT_TOLERANCE_MS = 10 * 60 * 1000;

export const OFFSET_HINT =
  'Minutos desde ahora, para cuando el usuario habla en relativo ("en 5 minutos", ' +
  '"dentro de media hora"). Preferible a calcular la fecha tú. Manda esto o el ISO, no ambos.';

/**
 * Resuelve un desplazamiento en minutos a una fecha ISO.
 *
 * Existe porque el modelo se equivocaba de día. Pedirle "en 5 minutos" en ISO le
 * obliga a hacer aritmética de calendario, y con eso falla: acertaba la hora y
 * escribía la fecha de mañana, copiada de otra tarea del historial. El offset lo
 * calcula el Worker, que sí sabe qué hora es.
 */
export function resolveOffset(args: Record<string, unknown>, field: string): string | null {
  const minutes = optionalInt(args, field, 1, MAX_OFFSET_MINUTES);
  return minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString();
}

export interface Deadlines {
  dueAt: string | null;
  remindAt: string | null;
}

/**
 * Corrige las fechas del modelo con lo que dijo el usuario en su mensaje.
 *
 * Las reglas del prompt no bastaron: `gpt-4o-mini` fechaba "avísame en 3 minutos" al
 * día siguiente incluso teniendo un campo en minutos para no calcular nada, y con
 * "avísame a las 13:14" hacía lo mismo. El mensaje del usuario es la fuente
 * auténtica, así que gana él.
 *
 * Solo se corrige cuando la desviación pasa de diez minutos: si el modelo acertó, no
 * hay nada que tocar.
 */
export function honourUserDeadlines(chosen: Deadlines, ctx: ToolContext): Deadlines {
  const minutes = parseRelativeMinutes(ctx.userMessage);

  if (minutes !== null) {
    // El plazo describe el aviso cuando hay aviso; la fecha límite solo si no lo
    // hay. "Llamar a David a las seis, avísame en cinco minutos" son dos horas
    // distintas y el plazo es una de ellas, no las dos.
    if (chosen.remindAt !== null || chosen.dueAt === null) {
      return {
        dueAt: correctDay(chosen.dueAt, ctx, 'due_at'),
        remindAt: applyOffset(minutes, chosen.remindAt, 'remind_at'),
      };
    }
    return { dueAt: applyOffset(minutes, chosen.dueAt, 'due_at'), remindAt: null };
  }

  return {
    dueAt: correctDay(chosen.dueAt, ctx, 'due_at'),
    remindAt: correctDay(chosen.remindAt, ctx, 'remind_at'),
  };
}

/**
 * La misma corrección para un único instante.
 *
 * Una cita no tiene el par fecha-límite/aviso de una tarea: empieza a una hora y
 * ya está. El reparto que hace `honourUserDeadlines` entre los dos campos aquí no
 * aplica, pero las dos correcciones —el plazo relativo del mensaje y el día que
 * el modelo se inventa— sí.
 */
export function honourUserInstant(
  chosen: string | null,
  ctx: ToolContext,
  field: string,
): string | null {
  const minutes = parseRelativeMinutes(ctx.userMessage);
  if (minutes !== null) return applyOffset(minutes, chosen, field);
  return correctDay(chosen, ctx, field);
}

function applyOffset(minutes: number, chosen: string | null, field: string): string {
  const target = Date.now() + minutes * 60_000;
  if (chosen !== null && Math.abs(new Date(chosen).getTime() - target) <= DRIFT_TOLERANCE_MS) {
    return chosen;
  }
  return correct(field, chosen, new Date(target), { user_minutes: minutes });
}

/**
 * Si el usuario no dijo de qué día habla, el día es hoy.
 *
 * Este es el caso que se llevó tres intentos: el modelo acierta la hora ("13:14",
 * "17:30") y escribe la fecha de mañana. Aquí se le respeta la hora —que es lo que
 * hace bien— y se le cambia el día al que el usuario tenía en la cabeza.
 *
 * Si el mensaje sí menciona otro día ("el jueves", "el 19 de septiembre"), no se
 * toca nada: ahí el día lo pone él y nosotros no tenemos nada que aportar.
 */
function correctDay(chosen: string | null, ctx: ToolContext, field: string): string | null {
  if (chosen === null) return null;
  // Sin mensaje no hay nada que interpretar: esto viene de un botón de confirmación
  // y corregir a ciegas sería inventarse la intención del usuario.
  if (!ctx.userMessage) return chosen;
  if (mentionsAnotherDay(ctx.userMessage)) return chosen;

  const now = new Date();
  const clock = localNow(new Date(chosen), ctx.timezone);
  const today = localNow(now, ctx.timezone).date;

  let target = zonedInstant(today, clock.hour, clock.minute, ctx.timezone);
  if (target === null) return chosen;

  // Esa hora ya pasó hoy: entonces hablaba de mañana. "Avísame a las 8" dicho a
  // las once de la noche es mañana a las 8, no dentro de un año.
  if (target.getTime() < now.getTime() - DRIFT_TOLERANCE_MS) {
    const tomorrow = localTomorrow(now, ctx.timezone);
    target = zonedInstant(tomorrow, clock.hour, clock.minute, ctx.timezone) ?? target;
  }

  if (Math.abs(target.getTime() - new Date(chosen).getTime()) <= DRIFT_TOLERANCE_MS) {
    return chosen;
  }

  return correct(field, chosen, target, { user_time_of_day: `${clock.hour}:${clock.minute}` });
}

function correct(
  field: string,
  chosen: string | null,
  target: Date,
  detail: Record<string, unknown>,
): string {
  const corrected = target.toISOString();
  // Se registra siempre: es la única forma de saber cuánto se equivoca el modelo
  // sin depender de que el usuario lo note.
  console.warn(
    JSON.stringify({
      event: 'deadline_corrected',
      field,
      ...detail,
      model_value: chosen,
      corrected_to: corrected,
    }),
  );
  return corrected;
}

/**
 * Quita el "recordar" del título.
 *
 * El prompt prohíbe los títulos tipo "Recordar llamar a David" y el modelo los
 * escribe igual. La tarea es llamar a David; recordarlo es lo que hace el cron.
 */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(
    /^\s*(?:recordatorio(?:\s+de)?|recordarme|recordar|acordarme(?:\s+de)?|avisarme(?:\s+de)?|avisar(?:\s+de)?)\s+(?:que\s+)?/i,
    '',
  );
  if (cleaned.length === 0) return title;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
