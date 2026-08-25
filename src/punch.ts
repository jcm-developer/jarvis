import type { Config } from './config';
import type { Principal } from './core/principal';
import { createDb } from './agent';
import { resolveIdentity } from './db/identity';
import { listPunchesForDay, logPunch } from './db/timeclock';
import type { Deadline } from './lib/deadline';
import { formatTime, localNow } from './lib/localtime';
import { createPunchClient, punchConfigured } from './timeclock';
import { ACTION_NAMES, TimeclockError, type PunchAction, type PunchState } from './timeclock/provider';
import type { Env } from './types';


/**
 * `/punch`: the portal's state, and a punch, without going through the model.
 *
 * It exists for the day the punch did not happen. `punch_status` and `punch_now` already
 * cover both jobs, and both of them are tools — so they need the model to decide to call
 * them, and on the morning this was written the model was timing out on every message. The
 * result was a feature that writes to an attendance record and could only be questioned
 * through the one component that was broken.
 *
 * Same rule as `/test` (§12): composed in code, no model call anywhere, so it answers when
 * everything else does not. Bare `/punch` writes nothing; only an explicit action punches.
 */

/** Cap for a punch: three requests against somebody else's portal. */
const MAX_PUNCH_MS = 12_000;

/** Below this a punch is not started: one cut off halfway may have registered. */
const MIN_PUNCH_MS = 7_000;

const MAX_STATE_MS = 10_000;
const MIN_STATE_MS = 4_000;

export interface PunchCommandDeps {
  env: Env;
  config: Config;
  deadline: Deadline;
  chatId: number;
  from: Principal | undefined;
}

/**
 * The word after `/punch`, and which stage it means.
 *
 * `back` before `lunch` is not alphabetical, it is the whole care taken here: matching is by
 * containment, so with the other order "back from lunch" would punch the START of the break.
 * That is the opposite end of lunch, written into a record that is not ours to correct.
 */
const WORDS: readonly { say: string; action: PunchAction }[] = [
  { say: 'back', action: 'break_end' },
  { say: 'lunch', action: 'break_start' },
  { say: 'in', action: 'clock_in' },
  { say: 'out', action: 'clock_out' },
];

/** The four stages as the reply names them, so the help does not read like a config file. */
const USAGE = [
  '/punch — cómo va el día, sin fichar nada',
  '/punch in — entrada al trabajo',
  '/punch lunch — salida a comer',
  '/punch back — vuelta de comer',
  '/punch out — salida del trabajo',
];

export async function runPunchCommand(deps: PunchCommandDeps, arg?: string): Promise<string> {
  if (!punchConfigured(deps.env)) return 'No hay credenciales de ficharweb configuradas.';

  const wanted = arg?.trim().toLowerCase();
  if (!wanted || wanted === 'status') return reportState(deps);

  // Exact and not by containment, unlike everywhere else in this file: "in" appears inside
  // half the words a person might type, and a fuzzy match here punches the wrong stage.
  const match = WORDS.find((word) => word.say === wanted);
  if (!match) return [`No sé qué es "${arg}".`, '', ...USAGE].join('\n');

  return punchNow(deps, match.action);
}

/** One read, no writes. What the portal offers and what our own log says. */
async function reportState(deps: PunchCommandDeps): Promise<string> {
  const budget = deps.deadline.budgetFor(MAX_STATE_MS);
  if (budget < MIN_STATE_MS) return 'No me queda tiempo en este mensaje para consultar el portal.';

  let state: PunchState;
  try {
    state = await createPunchClient(deps.env).readState({ timeoutMs: budget });
  } catch (error) {
    return `No he podido leer el portal: ${detail(error)}`;
  }

  const lines = ['FICHAJE', ''];

  if (state.lastMovement) {
    const { time, label } = state.lastMovement;
    lines.push(`Lo último que registró el portal: ${label}, a las ${time}.`);
  } else {
    lines.push('El portal no dice cuál fue su último movimiento.');
  }

  lines.push(
    state.available.length > 0
      ? `Puedo fichar ahora: ${state.available.map((action) => ACTION_NAMES[action]).join(', ')}.`
      : 'Ahora mismo no hay nada que yo pueda fichar.',
  );

  // The whole reason this command exists: "its turn has come and I will not do it" used to
  // be indistinguishable from "nothing to do" from the outside.
  if (state.blocked.length > 0) {
    lines.push(
      `Le toca pero no puedo yo: ${state.blocked
        .map((action) => ACTION_NAMES[action])
        .join(', ')} — el motivo pide un comentario escrito.`,
    );
  }

  if (state.reasons.length > 0) lines.push('', `Motivos en pantalla: ${state.reasons.join(' / ')}`);

  const mine = await ownPunches(deps);
  lines.push('', mine);

  return lines.join('\n');
}

/**
 * What the automation itself registered today, straight from our table.
 *
 * Separate from the portal's line and labelled as ours, because they answer different
 * questions and merging them is how "you clocked in at 09:00" got said about a punch that
 * never happened: `punch_schedules` holds the plan, `punches` holds the facts.
 */
async function ownPunches(deps: PunchCommandDeps): Promise<string> {
  try {
    const db = createDb(deps.env);
    const identity = await resolveIdentity(
      deps.env,
      db,
      deps.from,
      deps.chatId,
      deps.config.defaultTimezone,
    );
    const today = localNow(new Date(), identity.timezone).date;
    const mine = await listPunchesForDay(db, identity.userId, today);
    if (mine.length === 0) return 'Yo no he fichado nada hoy. Lo que haya en el portal lo fichaste tú.';
    return `Yo he fichado hoy: ${mine
      .map((punch) => `${ACTION_NAMES[punch.action]}${punch.registered_at ? ` a las ${punch.registered_at}` : ''}`)
      .join(', ')}.`;
  } catch (error) {
    return `No he podido leer mi propio registro: ${detail(error)}`;
  }
}

/** A punch asked for out loud, logged the same way the tool logs one. */
async function punchNow(deps: PunchCommandDeps, action: PunchAction): Promise<string> {
  const budget = deps.deadline.budgetFor(MAX_PUNCH_MS);
  if (budget < MIN_PUNCH_MS) {
    return (
      'No me queda tiempo en este mensaje para fichar, y no lo empiezo a medias: un fichaje ' +
      'cortado no se sabe si ha entrado. Repítemelo.'
    );
  }

  const now = new Date();
  try {
    const result = await createPunchClient(deps.env).punch(action, { timeoutMs: budget });

    // The punch landed; the log is bookkeeping. So a failure writing it down is reported and
    // does NOT turn into "it did not work", which would invite a second punch.
    let logged = '';
    try {
      const db = createDb(deps.env);
      const identity = await resolveIdentity(
        deps.env,
        db,
        deps.from,
        deps.chatId,
        deps.config.defaultTimezone,
      );
      await logPunch(db, {
        userId: identity.userId,
        action,
        source: 'manual',
        registeredAt: result.registeredAt,
        localDay: localNow(now, identity.timezone).date,
      });
    } catch (error) {
      logged = `\n(Ojo: ha entrado pero no he podido anotarlo en mi registro: ${detail(error)})`;
    }

    const when = result.registeredAt
      ? `El portal lo ha registrado a las ${result.registeredAt}.`
      : `El portal no ha dicho la hora; eran alrededor de las ${formatTime(now, deps.config.defaultTimezone)}.`;
    return `Fichada la ${ACTION_NAMES[action]}. ${when}${logged}`;
  } catch (error) {
    // The technical message and not `userMessage`: this command is the technical channel,
    // same as /test. Through `detail()` so the trail comes with it — the state report has
    // printed the route since the day it was written, and this one, the half that actually
    // writes, was the half answering "500" and nothing else.
    return `No he fichado la ${ACTION_NAMES[action]}: ${detail(error)}`;
  }
}

function detail(error: unknown): string {
  if (error instanceof TimeclockError) {
    const route = error.trail.length > 0 ? ` | ruta: ${error.trail.join(' -> ')}` : '';
    return `${error.kind}: ${error.message}${route}`;
  }
  return error instanceof Error ? error.message.slice(0, 120) : String(error);
}
