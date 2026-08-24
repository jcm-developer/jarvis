import type { Config } from './config';
import type { Db } from './db/client';
import { createProvider } from './llm';
import { LLMError } from './llm/provider';
import type { Deadline } from './lib/deadline';
import { buildSystemPrompt } from './prompts/system';
import { punchConfigured, createPunchClient } from './timeclock';
import { TimeclockError } from './timeclock/provider';
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
 *   the diagnosis: same latency means the provider is slow, and a much slower second one
 *   means the payload is what costs.
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
  const lines: string[] = ['Diagnóstico', ''];

  // Cheapest and most deterministic first, so a slow model cannot eat the budget of the
  // steps that would have answered.
  lines.push(await timed('Supabase', MAX_DB_MS, deps, () => checkDb(deps)));

  if (punchConfigured(env)) {
    lines.push(await timed('ficharweb', MAX_PORTAL_MS, deps, () => checkPortal(deps)));
  } else {
    lines.push('ficharweb       sin credenciales');
  }

  lines.push('', `Modelo ${config.llmProvider}/${config.llmModel}`);

  const ping = await measure(MAX_PING_MS, deps, () => pingModel(deps));
  lines.push(`  ping           ${format(ping)}`);

  const loaded = await measure(MAX_LOADED_MS, deps, () => loadedModel(deps));
  lines.push(`  carga real     ${format(loaded)}`);

  const verdict = diagnose(ping, loaded);
  if (verdict) lines.push('', verdict);

  lines.push(
    '',
    `Tardado ${seconds(Date.now() - started)} s, quedaban ${seconds(deadline.remainingMs())} s de presupuesto.`,
  );
  return lines.join('\n');
}

interface Measurement {
  ms: number;
  detail: string;
  /** Set when the step could not run or failed. */
  problem?: string;
}

/** One step, its stopwatch, and its excuse when there was no room for it. */
async function measure(
  maxMs: number,
  deps: SelfTestDeps,
  step: (budget: number) => Promise<string>,
): Promise<Measurement> {
  const budget = deps.deadline.budgetFor(maxMs);
  if (budget < MIN_STEP_MS) return { ms: 0, detail: '', problem: 'sin tiempo en este mensaje' };

  const started = Date.now();
  try {
    // The await goes on its own line and not inside the object literal: the properties of
    // a literal are evaluated in order, so `ms` computed alongside `detail` is measured
    // before the step has run and every number comes out as zero. It did.
    const detail = await step(budget);
    return { ms: Date.now() - started, detail };
  } catch (error) {
    return { ms: Date.now() - started, detail: '', problem: describe(error) };
  }
}

async function timed(
  label: string,
  maxMs: number,
  deps: SelfTestDeps,
  step: (budget: number) => Promise<string>,
): Promise<string> {
  const result = await measure(maxMs, deps, step);
  return `${label.padEnd(15)} ${format(result)}`;
}

function format(result: Measurement): string {
  if (result.problem) return `falla        ${result.problem}`;
  return `${seconds(result.ms).padStart(5)} s${result.detail ? `  ${result.detail}` : ''}`;
}

/** One decimal. Milliseconds in a chat message are noise. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

async function checkDb(deps: SelfTestDeps): Promise<string> {
  const rows = await deps.db.select<{ id: string }>('users', { columns: 'id', limit: 1 });
  return rows.length > 0 ? 'ok' : 'responde, pero no hay usuarios';
}

/**
 * The portal, read-only.
 *
 * It doubles as the check that the button wording is still the one the adapter knows: what
 * it reports is which of the four actions it recognised, so a reworded portal shows up here
 * instead of at nine in the morning.
 */
async function checkPortal(deps: SelfTestDeps): Promise<string> {
  const state = await createPunchClient(deps.env).readState({
    timeoutMs: deps.deadline.budgetFor(MAX_PORTAL_MS),
  });
  if (state.available.length === 0) {
    return `NO reconozco ningún botón. La página ofrece: ${state.labels.slice(0, 4).join(' / ') || 'nada'}`;
  }
  return `ofrece ${state.available.join(', ')}`;
}

/**
 * The smallest possible call: no system prompt, no tools, one word back.
 *
 * This is the provider's own latency floor. If this is already slow, nothing we do to our
 * request is going to help.
 */
async function pingModel(deps: SelfTestDeps): Promise<string> {
  const response = await createProvider(deps.env, deps.config).chat(
    [{ role: 'user', content: 'Contesta solo: ok' }],
    undefined,
    { timeoutMs: deps.deadline.budgetFor(MAX_PING_MS) },
  );
  return `${response.usage.promptTokens} tok de entrada`;
}

/**
 * The request as the assistant really sends it.
 *
 * Same system prompt and same tool schemas as a normal message, which is where the tokens
 * are: the prompt is a tenth of it and the seventeen schemas are the rest. The model is
 * told not to use them and whatever it asks for is discarded — nothing is executed from
 * here.
 */
async function loadedModel(deps: SelfTestDeps): Promise<string> {
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
    toolSchemas(deps.env),
    { timeoutMs: deps.deadline.budgetFor(MAX_LOADED_MS) },
  );
  return `${response.usage.promptTokens} tok de entrada`;
}

/**
 * The point of the whole command: the two model numbers side by side.
 *
 * Stated as a sentence and not left to the reader, because the useful comparison is not
 * "is it slow" but "is it slow because of the size", and those two have different fixes:
 * one is waiting for the provider, the other is trimming what we send.
 */
function diagnose(ping: Measurement, loaded: Measurement): string | null {
  if (ping.problem && loaded.problem) return 'El modelo no contesta ni a lo mínimo. Es el proveedor.';
  if (ping.problem) return 'Falla incluso el ping mínimo: es el proveedor, no lo que enviamos.';
  if (loaded.problem) {
    return (
      'El ping va bien y la petición real se cae: lo que pesa es el prompt más los ' +
      'esquemas de las herramientas, no el proveedor.'
    );
  }

  if (ping.ms > 6_000) return 'Lento con cualquier petición: es el proveedor.';
  if (loaded.ms > 6_000 && loaded.ms > ping.ms * 3) {
    return 'La lentitud aparece con el tamaño de la petición, no con el proveedor.';
  }
  if (loaded.ms > 6_000) return 'Lento en la petición real. Vuelve a probar en un rato.';
  return 'El modelo responde bien ahora mismo.';
}

function describe(error: unknown): string {
  if (error instanceof LLMError) return `${error.kind}${error.status ? ` (${error.status})` : ''}`;
  if (error instanceof TimeclockError) return error.kind;
  return error instanceof Error ? error.message.slice(0, 80) : String(error);
}
