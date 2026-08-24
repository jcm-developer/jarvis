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
const MAX_PING_MS = 5_000;
const MAX_PROMPT_MS = 7_000;
const MAX_LOADED_MS = 9_000;

/** Under this, a step is not started: a cut-off measurement is worse than no measurement. */
const MIN_STEP_MS = 2_500;

/** How much of the page `/test html` shows, and how much context before the anchor. */
const HTML_WINDOW = 1_400;
const HTML_BEFORE = 200;

/** Past this a step is reported as slow rather than fine. A message has 27 s for everything. */
const SLOW_MS = 6_000;

/**
 * What the model may write back in these probes.
 *
 * Enough for "ok" and not one token more: what is being measured is how long the provider
 * takes to answer, not how long it takes to type.
 */
const MAX_ANSWER_TOKENS = 16;

export interface SelfTestDeps {
  env: Env;
  config: Config;
  db: Db;
  deadline: Deadline;
  timezone: string;
}

/**
 * `/test html`: the register page as it comes, around the part that matters.
 *
 * A window and not the whole page —Telegram caps a message at 4 KB— centred on the first
 * radio, because what has been impossible to guess from outside is how the page ties each
 * option to its text.
 */
export async function runPageDump(deps: SelfTestDeps): Promise<string> {
  if (!punchConfigured(deps.env)) return 'No hay credenciales de ficharweb configuradas.';

  let page: { url: string; html: string };
  try {
    page = await createPunchClient(deps.env).readPage({
      timeoutMs: deps.deadline.budgetFor(MAX_PORTAL_MS),
    });
  } catch (error) {
    return `No he podido llegar a la página: ${describe(error)}`;
  }

  const anchor = anchorIndex(page.html);
  const from = Math.max(0, anchor - HTML_BEFORE);
  const window = page.html.slice(from, from + HTML_WINDOW);

  return [
    page.url,
    `${page.html.length} caracteres en total; te enseño ${window.length} desde el ${from}.`,
    '',
    window,
  ].join('\n');
}

/** Where to centre the window: the first radio, or the reason panel, or the top. */
function anchorIndex(html: string): number {
  const radio = /<input\b[^>]*type=['"]?radio/i.exec(html);
  if (radio) return radio.index;
  const panel = html.toLowerCase().indexOf('motivo');
  return panel >= 0 ? panel : 0;
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
  // Three calls and not two, and the middle one is the one that earns its place: it carries
  // the system prompt WITHOUT the tool schemas. Two measurements can only say "it is the
  // size"; three say which half of the size, and the two halves have different fixes.
  const ping = await measure(MAX_PING_MS, deps, () => askModel(deps, { prompt: false, tools: false }));
  const prompted = await measure(MAX_PROMPT_MS, deps, () => askModel(deps, { prompt: true, tools: false }));
  const loaded = await measure(MAX_LOADED_MS, deps, () => askModel(deps, { prompt: true, tools: true }));

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
    ...block('Sin nada', ping, MAX_PING_MS, 2),
    ...block('Con el prompt', prompted, MAX_PROMPT_MS, 2),
    ...block('Con prompt y herramientas', loaded, MAX_LOADED_MS, 2),
    '',
    `CONCLUSIÓN: ${diagnose(ping, prompted, loaded, toolSchemas(env).length)}`,
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
  const { url, sawLoginForm, inputs, controls, snippet, trail } = state.diagnosis;
  const lines = [`Página: ${url}`];
  // The route, not just the destination: with three hops, which one went wrong is the
  // whole question.
  if (trail.length > 0) lines.push(`Ruta: ${trail.join(' -> ')}`);

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
 * One model call, with as much or as little of our own baggage as asked for.
 *
 * The three variants are the measurement: nothing, the prompt, and the prompt with the tool
 * schemas. Whatever the model answers is thrown away, and no tool is ever run — the schemas
 * travel only so the request weighs what a real one weighs.
 */
async function askModel(
  deps: SelfTestDeps,
  carry: { prompt: boolean; tools: boolean },
): Promise<StepResult> {
  const schemas = carry.tools ? toolSchemas(deps.env) : undefined;
  const messages = [
    ...(carry.prompt
      ? [
          {
            role: 'system' as const,
            content: buildSystemPrompt({
              timezone: deps.timezone,
              now: new Date(),
              canSeeImages: true,
              eventAlertMinutes: deps.config.eventAlertMinutes,
              canSearchWeb: true,
              canPunch: punchConfigured(deps.env),
            }),
          },
        ]
      : []),
    {
      role: 'user' as const,
      content: carry.tools ? 'Contesta solo: ok. No uses ninguna herramienta.' : 'Contesta solo: ok',
    },
  ];

  const cap = carry.tools ? MAX_LOADED_MS : carry.prompt ? MAX_PROMPT_MS : MAX_PING_MS;
  const response = await createProvider(deps.env, deps.config).chat(messages, schemas, {
    timeoutMs: deps.deadline.budgetFor(cap),
    // Bounded so the three numbers are comparable. Without this the call carrying the
    // system prompt is free to write up to 800 tokens —eight seconds of typing— while the
    // bare one answers "ok" in two, and the difference reads as latency when it is not.
    maxTokens: MAX_ANSWER_TOKENS,
  });

  const what = schemas ? `y ${schemas.length} herramientas` : 'y sin herramientas';
  return {
    details: [
      `${tokens(response.usage.promptTokens)} tokens de entrada ` +
        `(${carry.prompt ? 'con prompt' : 'sin prompt'} ${what}), ` +
        `${response.usage.completionTokens} de salida.`,
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
function diagnose(
  ping: Measurement,
  prompted: Measurement,
  loaded: Measurement,
  toolCount: number,
): string {
  if (ping.notRun || prompted.notRun || loaded.notRun) {
    return 'no he podido medir las tres llamadas, así que no puedo comparar. Repite el /test.';
  }

  const bad = (result: Measurement) => Boolean(result.problem) || result.ms > SLOW_MS;

  if (bad(ping)) return 'lento o caído hasta con la llamada más pequeña. Es el proveedor.';
  if (bad(prompted)) {
    return (
      'sin herramientas ya va mal, así que lo que pesa es el tamaño de la entrada en ' +
      'general y no los esquemas. Toca recortar el prompt o cambiar de proveedor.'
    );
  }
  if (bad(loaded)) {
    return (
      'con el prompt va bien y solo se cae al añadir los esquemas de las herramientas: ' +
      `son las ${toolCount} herramientas lo que no traga, no el proveedor ni el prompt.`
    );
  }
  return 'todo responde bien ahora mismo.';
}

function describe(error: unknown): string {
  if (error instanceof LLMError) {
    return `${error.kind}${error.status ? ` ${error.status}` : ''}`;
  }
  // The technical message and not `userMessage`: this command IS the technical channel, and
  // the polite sentence ("the portal does not respond") hid which hop had failed.
  if (error instanceof TimeclockError) {
    const route = error.trail.length > 0 ? ` | ruta: ${error.trail.join(' -> ')}` : '';
    return `${error.kind}: ${error.message}${route}`;
  }
  return error instanceof Error ? error.message.slice(0, 80) : String(error);
}
