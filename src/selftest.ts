import type { Config } from './config';
import type { Db } from './db/client';
import { createProvider } from './llm';
import { LLMError } from './llm/provider';
import type { Deadline } from './lib/deadline';
import { buildSystemPrompt } from './prompts/system';
import { createPunchClient, punchConfigured } from './timeclock';
import { ACTION_NAMES, TimeclockError } from './timeclock/provider';
import { toolSchemas } from './tools/registry';
import type { Env } from './types';

/**
 * `/test`: what is slow, measured instead of guessed.
 *
 * It exists because of a real morning. Four messages in a row came back with "el modelo ha
 * tardado demasiado" and there was no way, from the chat, to tell a slow provider from a
 * request of ours that had grown too big — the answer had to be dug out of `wrangler tail`
 * and a token count done by hand.
 *
 * Two rules make it useful precisely when everything else is broken:
 *
 * - **The report is composed in code.** No model call decides what it says, so it answers
 *   when the model is exactly the thing that is failing. Same reason the cron's messages
 *   are written in code (§12).
 * - **It measures the two model calls separately.** A bare ping and then the request as the
 *   assistant really sends it, prompt and tool schemas included. The gap between the two is
 *   the diagnosis: both slow means the provider is slow, and only the second one slow means
 *   the payload is what costs.
 *
 * It writes nothing anywhere and it never runs a tool: the model is offered the schemas so
 * the request weighs what it really weighs, and whatever it asks for is thrown away.
 */

/** Caps per step. They add up to more than the budget on purpose: what does not fit is skipped. */
const MAX_DB_MS = 4_000;
const MAX_PORTAL_MS = 8_000;
const MAX_PING_MS = 8_000;
const MAX_LOADED_MS = 10_000;

/** Under this, a step is not started: a cut-off measurement is worse than no measurement. */
const MIN_STEP_MS = 2_500;

/** Past this a step is reported as slow rather than fine. A message has 27 s for everything. */
const SLOW_MS = 6_000;

export interface SelfTestDeps {
  env: Env;
  config: Config;
  db: Db;
  deadline: Deadline;
  timezone: string;
}

export async function runSelfTest(deps: SelfTestDeps): Promise<string> {
  const { env, config, deadline } = deps;
  const started = Date.now();

  // Cheapest and most deterministic first, so a slow model cannot eat the budget of the
  // steps that would have answered.
  const db = await measure(MAX_DB_MS, deps, () => checkDb(deps));
  const portal = punchConfigured(env)
    ? await measure(MAX_PORTAL_MS, deps, () => checkPortal(deps))
    : notRun('no hay credenciales configuradas');
  const ping = await measure(MAX_PING_MS, deps, () => pingModel(deps));
  const loaded = await measure(MAX_LOADED_MS, deps, () => loadedModel(deps));

  // One label per line with its detail indented underneath, and no columns padded with
  // spaces: Telegram renders plain text in a proportional font, so aligned columns are
  // aligned nowhere and the numbers end up glued to the labels. That is what the first
  // version of this got wrong.
  return [
    'DIAGNÓSTICO',
    '',
    ...block('Base de datos', db, MAX_DB_MS),
    ...block('Ficharweb', portal, MAX_PORTAL_MS),
    '',
    `MODELO — ${config.llmProvider}, ${config.llmModel}`,
    ...block('Petición mínima', ping, MAX_PING_MS, 2),
    ...block('Petición real', loaded, MAX_LOADED_MS, 2),
    '',
    `CONCLUSIÓN: ${diagnose(ping, loaded)}`,
    '',
    `Comprobado en ${secs(Date.now() - started)} s de los 27 que tiene un mensaje; ` +
      `quedaban ${secs(deadline.remainingMs())} s.`,
  ].join('\n');
}

/**
 * What a step reports back.
 *
 * `verdict` exists because a step can succeed technically and still be bad news: reading the
 * portal fine and not recognising a single action on it came out as "Ficharweb: bien" with a
 * detail underneath saying the opposite. Only the step knows which of the two it is.
 */
interface StepResult {
  verdict?: string;
  details: string[];
}

interface Measurement {
  ms: number;
  /** Lines shown under the verdict. Empty when there is nothing to add. */
  details: string[];
  /** Set by the step when "bien" would be a lie. */
  verdict?: string;
  /** Why it was not run at all. */
  notRun?: string;
  /** Set when it failed. `timedOut` is the case worth its own wording in the report. */
  problem?: string;
  timedOut?: boolean;
}

function notRun(reason: string): Measurement {
  return { ms: 0, details: [], notRun: reason };
}

/** One step, its stopwatch, and its excuse when there was no room for it. */
async function measure(
  maxMs: number,
  deps: SelfTestDeps,
  step: (budget: number) => Promise<StepResult>,
): Promise<Measurement> {
  const budget = deps.deadline.budgetFor(maxMs);
  if (budget < MIN_STEP_MS) return notRun('no quedaba tiempo en este mensaje');

  const started = Date.now();
  try {
    // The await goes on its own line and not inside the returned object literal: a
    // literal's properties are evaluated in order, so an `ms` computed next to the result
    // is measured before the step has run and every number comes out as zero. It did.
    const outcome = await step(budget);
    return { ms: Date.now() - started, ...outcome };
  } catch (error) {
    return {
      ms: Date.now() - started,
      details: [],
      problem: describe(error),
      timedOut: error instanceof LLMError && error.kind === 'timeout',
    };
  }
}

/**
 * One check as a person reads it: name, verdict in words, time, then the detail indented.
 *
 * The verdict goes before the number on purpose — "bien" or "no contesta" is what is being
 * looked for at a glance, and the seconds are what gets compared afterwards.
 */
function block(label: string, result: Measurement, capMs: number, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  return [
    `${pad}${label}: ${verdictOf(result, capMs)}`,
    ...result.details.map((detail) => `${pad}  ${detail}`),
  ];
}

function verdictOf(result: Measurement, capMs: number): string {
  if (result.notRun) return `sin comprobar, ${result.notRun}`;
  if (result.timedOut) return `NO CONTESTA, cortada a los ${secs(capMs)} s`;
  if (result.problem) return `FALLA tras ${secs(result.ms)} s — ${result.problem}`;
  if (result.verdict) return `${result.verdict}, ${secs(result.ms)} s`;
  if (result.ms > SLOW_MS) return `LENTA, ${secs(result.ms)} s`;
  return `bien, ${secs(result.ms)} s`;
}

/** One decimal and a comma: this is read by a person, in Spanish. */
function secs(ms: number): string {
  return (ms / 1000).toFixed(1).replace('.', ',');
}

/**
 * Thousands separator by hand.
 *
 * `toLocaleString('es-ES')` would be the obvious way and it is not portable enough here:
 * the same call groups differently depending on how much ICU data the runtime ships, so
 * the number read in the chat would not match the one read in a test.
 */
function tokens(count: number): string {
  return String(count).replace(/(\d)(?=(\d{3})+$)/g, '$1.');
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function checkDb(deps: SelfTestDeps): Promise<StepResult> {
  const rows = await deps.db.select<{ id: string }>('users', { columns: 'id', limit: 1 });
  if (rows.length > 0) return { details: [] };
  return { verdict: 'responde pero está vacía', details: ['No hay ningún usuario dado de alta.'] };
}

/**
 * The portal, read-only.
 *
 * It doubles as the check that the page is still one the adapter knows how to read, so a
 * reworded portal shows up when you ask instead of at nine in the morning.
 */
async function checkPortal(deps: SelfTestDeps): Promise<StepResult> {
  const state = await createPunchClient(deps.env).readState({
    timeoutMs: deps.deadline.budgetFor(MAX_PORTAL_MS),
  });

  if (state.available.length > 0) {
    const names = state.available.map((action) => ACTION_NAMES[action]).join(', ');
    const details = [`Ahora mismo puedo fichar: ${names}.`];
    if (state.lastMovement) {
      const { time, label } = state.lastMovement;
      details.push(`Lo último que registró el portal: ${label}, a las ${time}.`);
    }
    return { details };
  }

  // The empty-handed case, over several lines because each shape points somewhere
  // different and the one-line version was unreadable in the chat.
  const { url, sawLoginForm, inputs, controls, snippet } = state.diagnosis;
  const lines = [`Página: ${url}`];

  if (sawLoginForm) {
    lines.push('Sigue en el login: o las credenciales no valen, o no he sabido rellenarlo.');
  } else if (inputs === 0 && controls === 0) {
    lines.push('No parece la aplicación: no trae ni formulario ni botones.');
    if (snippet) lines.push(`Dice: "${snippet}"`);
  } else {
    lines.push(
      `Tiene ${plural(inputs, 'campo')} y ${plural(controls, 'botón', 'botones')}, ` +
        'ninguno con el texto que espero.',
    );
    if (state.labels.length > 0) lines.push(`Botones: ${state.labels.slice(0, 6).join(' / ')}`);
    if (state.reasons.length > 0) lines.push(`Motivos: ${state.reasons.slice(0, 6).join(' / ')}`);
  }
  return { verdict: 'NO LA ENTIENDO', details: lines };
}

/**
 * The smallest possible call: no system prompt, no tools, one word back.
 *
 * This is the provider's own latency floor. If this is already slow, nothing we do to our
 * own request is going to help.
 */
async function pingModel(deps: SelfTestDeps): Promise<StepResult> {
  const response = await createProvider(deps.env, deps.config).chat(
    [{ role: 'user', content: 'Contesta solo: ok' }],
    undefined,
    { timeoutMs: deps.deadline.budgetFor(MAX_PING_MS) },
  );
  return {
    details: [`Sin prompt ni herramientas: ${tokens(response.usage.promptTokens)} tokens de entrada.`],
  };
}

/**
 * The request as the assistant really sends it.
 *
 * Same system prompt and same tool schemas as a normal message, which is where the tokens
 * are: the prompt is about a tenth of it and the schemas are the rest. The model is told
 * not to use them and whatever it asks for is discarded — nothing is executed from here.
 */
async function loadedModel(deps: SelfTestDeps): Promise<StepResult> {
  const schemas = toolSchemas(deps.env);
  const response = await createProvider(deps.env, deps.config).chat(
    [
      {
        role: 'system',
        content: buildSystemPrompt({
          timezone: deps.timezone,
          now: new Date(),
          canSeeImages: true,
          eventAlertMinutes: deps.config.eventAlertMinutes,
          canSearchWeb: true,
          canPunch: punchConfigured(deps.env),
        }),
      },
      { role: 'user', content: 'Contesta solo: ok. No uses ninguna herramienta.' },
    ],
    schemas,
    { timeoutMs: deps.deadline.budgetFor(MAX_LOADED_MS) },
  );
  return {
    details: [
      `Con el prompt y las ${schemas.length} herramientas: ` +
        `${tokens(response.usage.promptTokens)} tokens de entrada.`,
    ],
  };
}

/**
 * The point of the whole command: the two model numbers turned into a sentence.
 *
 * Stated rather than left to the reader, because the useful question is not "is it slow"
 * but "is it slow because of what we send", and those two have different fixes: one is
 * waiting for the provider, the other is trimming the request.
 */
function diagnose(ping: Measurement, loaded: Measurement): string {
  if (ping.notRun || loaded.notRun) {
    return 'no he podido medir las dos llamadas, así que no puedo comparar. Repite el /test.';
  }

  const pingFailed = Boolean(ping.problem);
  const loadedFailed = Boolean(loaded.problem);
  if (pingFailed && loadedFailed) return 'el modelo no contesta ni a lo mínimo. Es el proveedor.';
  if (pingFailed) return 'falla incluso la llamada mínima: es el proveedor, no lo que enviamos.';
  if (loadedFailed) {
    return (
      'la llamada mínima va bien y la real se cae, así que lo que pesa es lo que enviamos ' +
      '(el prompt y los esquemas de las herramientas), no el proveedor.'
    );
  }

  if (ping.ms > SLOW_MS) return 'lento con cualquier llamada. Es el proveedor.';
  if (loaded.ms > SLOW_MS && loaded.ms > ping.ms * 3) {
    return 'la lentitud aparece con el tamaño de la petición, no con el proveedor.';
  }
  if (loaded.ms > SLOW_MS) return 'la petición real va lenta. Vuelve a probar en un rato.';
  return 'todo responde bien ahora mismo.';
}

function describe(error: unknown): string {
  if (error instanceof LLMError) {
    return `${error.kind}${error.status ? ` ${error.status}` : ''}`;
  }
  if (error instanceof TimeclockError) return error.userMessage;
  return error instanceof Error ? error.message.slice(0, 80) : String(error);
}
