import { listSchedules, listPunchesForDay, logPunch } from '../db/timeclock';
import { createPunchClient, punchConfigured } from '../timeclock';
import {
  ACTION_NAMES,
  TimeclockError,
  isPunchAction,
  PUNCH_ACTIONS,
} from '../timeclock/provider';
import { formatTime, localNow } from '../lib/localtime';
import type { ToolDefinition, ToolResult } from './types';
import { requireString } from './types';

/**
 * Fichaje by hand and the state of the day (phase 22).
 *
 * The scheduler covers the normal day; these two are for when it does not. `punch_status`
 * exists because an unattended automation that writes to a legal record has to be
 * auditable from the chat, and `punch_now` because the answer to "it did not go out" has
 * to be something other than opening the portal.
 *
 * Both read the state from the PORTAL and not from our tables: the user can clock in from
 * the web whenever they like, and the site is the only thing that knows.
 */

/** Cap for a punch: three requests to somebody else's portal. */
const MAX_PUNCH_MS = 12_000;

/** Cap for reading the state: two requests, no writes. */
const MAX_STATE_MS = 10_000;

/**
 * Below this it is not attempted.
 *
 * A punch cut off halfway is the worst possible outcome —it may have registered— so it is
 * better to say there is no time and let the user ask again. Deliberately high for the
 * same reason.
 */
const MIN_PUNCH_MS = 7_000;

const MIN_STATE_MS = 4_000;

export const punchNow: ToolDefinition = {
  name: 'punch_now',
  description:
    'Ficha AHORA en ficharweb la acción que le digas: entrada al trabajo, salida a ' +
    'comer, vuelta de comer o salida del trabajo. Úsala solo si te lo pide ' +
    'explícitamente ("fícham" la entrada, "fíchame la salida"). El fichaje ' +
    'automático de los cuatro horarios lo hace el sistema por su cuenta: no lo ' +
    'adelantes tú. Si el portal no ofrece esa acción es que ya está fichada o que no ' +
    'le toca todavía, y te lo dirá en el error: cuéntaselo tal cual y NO lo reintentes.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...PUNCH_ACTIONS],
        description:
          'entrada = entrada al trabajo. salida = salida del trabajo, la de irse a casa. ' +
          'salida_descanso = salida a comer o al descanso. entrada_descanso = vuelta del ' +
          'descanso o de comer.',
      },
    },
    required: ['action'],
  },
  mutates: true,
  // Not behind a button: it is a punch the user has just asked for out loud, and a
  // confirmation would only add a tap. The prompt below is still needed for the photo
  // path, where there is no text to lean on (§7).
  requiresConfirmation: false,
  available: punchConfigured,
  confirmationPrompt: async (args) => {
    const raw = typeof args['action'] === 'string' ? args['action'] : '';
    const action = isPunchAction(raw) ? ACTION_NAMES[raw] : 'ese fichaje';
    return `¿Ficho la ${action} ahora mismo?`;
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const raw = requireString(args, 'action', 40);
    if (!isPunchAction(raw)) {
      return {
        ok: false,
        error: `"${raw}" no es una acción de fichaje. Son: ${PUNCH_ACTIONS.join(', ')}.`,
      };
    }

    const budget = ctx.deadline.budgetFor(MAX_PUNCH_MS);
    if (budget < MIN_PUNCH_MS) {
      return {
        ok: false,
        error:
          'No me queda tiempo en este mensaje para fichar y no lo empiezo a medias: un ' +
          'fichaje cortado por la mitad no se sabe si ha entrado. Dile que te lo repita.',
      };
    }

    const now = new Date();
    try {
      const result = await createPunchClient(ctx.env).punch(raw, { timeoutMs: budget });

      await logPunch(ctx.db, {
        userId: ctx.userId,
        action: raw,
        source: 'manual',
        registeredAt: result.registeredAt,
        localDay: localNow(now, ctx.timezone).date,
      });

      return {
        ok: true,
        data: {
          action: raw,
          what: ACTION_NAMES[raw],
          // The portal's clock when it gives one, ours when it does not, and said which is
          // which: rule 4 of §7 —say the time you actually stored— on a legal record.
          registered_at: result.registeredAt,
          note: result.registeredAt
            ? `El portal lo ha registrado a las ${result.registeredAt}.`
            : `Hecho. El portal no ha dicho la hora; era alrededor de las ${formatTime(now, ctx.timezone)}.`,
        },
      };
    } catch (error) {
      if (error instanceof TimeclockError) return { ok: false, error: error.userMessage };
      throw error;
    }
  },
};

export const punchStatus: ToolDefinition = {
  name: 'punch_status',
  description:
    'Mira en ficharweb cómo va el fichaje de hoy: qué acción ofrece el portal ahora ' +
    'mismo, qué ha fichado el sistema y qué horarios quedan pendientes. No ficha nada. ' +
    'Úsala cuando pregunte si ha fichado, si está fichada la entrada o la salida, o qué ' +
    'le queda. El portal solo ofrece la acción que TOCA: si no ofrece la entrada es que ' +
    'ya está fichada, la haya fichado él a mano o el sistema.',
  parameters: { type: 'object', properties: {} },
  mutates: false,
  requiresConfirmation: false,
  available: punchConfigured,
  handler: async (_args, ctx): Promise<ToolResult> => {
    const budget = ctx.deadline.budgetFor(MAX_STATE_MS);
    if (budget < MIN_STATE_MS) {
      return { ok: false, error: 'No me queda tiempo para consultar el portal en este mensaje.' };
    }

    const today = localNow(new Date(), ctx.timezone).date;

    let state;
    try {
      state = await createPunchClient(ctx.env).readState({ timeoutMs: budget });
    } catch (error) {
      if (error instanceof TimeclockError) return { ok: false, error: error.userMessage };
      throw error;
    }

    // Ours, and clearly labelled as ours: the user's own punches from the web are not in
    // here, which is exactly why `portal_offers` is the field that answers the question.
    const [mine, schedules] = await Promise.all([
      listPunchesForDay(ctx.db, ctx.userId, today),
      listSchedules(ctx.db, ctx.userId),
    ]);

    return {
      ok: true,
      data: {
        date: today,
        portal_offers: state.available.map((action) => ({ action, what: ACTION_NAMES[action] })),
        // The portal stating what it last recorded, which covers the punches the user made
        // from the web himself. Ours is the other half, below.
        last_movement: state.lastMovement
          ? `${state.lastMovement.time} — ${state.lastMovement.label}`
          : null,
        punched_by_jarvis: mine.map((punch) => ({
          action: punch.action,
          what: ACTION_NAMES[punch.action],
          registered_at: punch.registered_at,
          source: punch.source,
        })),
        schedules: schedules
          .filter((schedule) => schedule.enabled)
          .map((schedule) => ({
            action: schedule.action,
            what: ACTION_NAMES[schedule.action],
            at: schedule.at_time,
            hecho_hoy: schedule.fired_on === today,
          })),
        note:
          'portal_offers y last_movement son la verdad: el sitio solo ofrece la fase que ' +
          'toca y dice a qué hora registró lo último, lo haya fichado él a mano o yo. ' +
          'punched_by_jarvis son solo los míos.',
      },
    };
  },
};
