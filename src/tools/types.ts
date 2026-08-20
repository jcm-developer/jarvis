import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Deadline } from '../lib/deadline';
import type { Env } from '../types';

export interface ToolContext {
  userId: string;
  conversationId: string;
  timezone: string;
  db: Db;
  /**
   * Secrets and bindings. Arrived with create_event, the first tool to talk to an
   * outside service on its own: until then the agent resolved everything external and
   * `db` was all the handlers needed.
   */
  env: Env;
  /**
   * The env already parsed and validated. Arrived with find_free_slots: the day's
   * time window is the user's decision, not the model's, and it lives in the config
   * like the briefing hour does. Re-parsing the env inside each handler would mean
   * two different readings of the same var.
   */
  config: Config;
  /**
   * The message's time budget. A tool that goes over the network asks here for its
   * cap instead of setting its own, which is what already cost us a phase (§11).
   */
  deadline: Deadline;
  /**
   * The message the user wrote on this turn.
   *
   * Handlers read it to resolve relative deadlines themselves, because the model gets
   * the day wrong and no prompt fixes that. Empty when the action comes from a
   * confirmation button, where there is no new text.
   */
  userMessage: string;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolDefinition {
  name: string;
  /** The model picks the tool by reading this. Being explicit beats being brief. */
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /**
   * Whether running it changes anything.
   *
   * Not the same question as `requiresConfirmation`, which is about the irreversible.
   * This one exists for the photo path: with an image there is no user text for the
   * date guardrails to lean on, so everything that writes waits behind one button,
   * while the lookups the model needs to word itself run as usual.
   */
  mutates: boolean;
  /**
   * When true the agent does NOT execute: it asks the user for confirmation with
   * buttons. Reserved for the irreversible.
   */
  requiresConfirmation: boolean;
  /**
   * Whether this deployment can actually run it. Absent means always.
   *
   * Arrived with search_web, the first tool whose provider is optional: without the
   * key the prompt goes back to saying it cannot search, and sending the schema anyway
   * would leave the model reading a contradiction —a tool it has just been told it does
   * not have. It is a function of the env and not of a provider instance, because
   * asking must not require the key to exist.
   */
  available?: (env: Env) => boolean;
  /**
   * The sentence shown when asking for confirmation. It is async and receives the
   * context so it can hit the database: asking "delete 'Comprar pan'?" is far safer
   * than "delete task 7f3a-...?", which nobody actually reviews.
   *
   * Every tool that writes needs one, not just the destructive ones: on a photo it is
   * this sentence that the user reads to catch a wrong date before anything is stored,
   * and "Ejecutar create_task" is not something anybody can review. It states what the
   * ARGUMENTS say, without applying the guardrails: what the handler ends up correcting
   * is reported afterwards, once written, which is the moment the date is certain.
   */
  confirmationPrompt?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/* ------------------------------------------------------------------ *
 * Argument validation.
 *
 * The arguments come from a language model, so they have to be treated as untrusted
 * input: they can be missing, arrive with the wrong type, or carry a string where a
 * number was expected. Validated by hand rather than with Zod, to avoid adding a
 * dependency for a handful of tools.
 *
 * Errors are thrown as ToolValidationError and the agent hands them back to the model
 * as the result, so it corrects itself on the next iteration.
 * ------------------------------------------------------------------ */

export class ToolValidationError extends Error {}

export function requireString(
  args: Record<string, unknown>,
  field: string,
  maxLength = 500,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolValidationError(`El campo "${field}" es obligatorio y debe ser texto.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ToolValidationError(`El campo "${field}" no puede pasar de ${maxLength} caracteres.`);
  }
  return trimmed;
}

export function optionalString(
  args: Record<string, unknown>,
  field: string,
  maxLength = 2000,
): string | null {
  const value = args[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ToolValidationError(`El campo "${field}" debe ser texto.`);
  }
  return value.trim().slice(0, maxLength);
}

export function optionalBoolean(args: Record<string, unknown>, field: string): boolean {
  const value = args[field];
  // Models send booleans as text just as readily as they send them as bools.
  return value === true || value === 'true';
}

export function optionalInt(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | null {
  const value = args[field];
  if (value === undefined || value === null) return null;

  // Models often send numbers as strings; accepting that is more useful than
  // rejecting it and spending an iteration on the correction.
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ToolValidationError(`El campo "${field}" debe ser un número.`);
  }
  if (parsed < min || parsed > max) {
    throw new ToolValidationError(`El campo "${field}" debe estar entre ${min} y ${max}.`);
  }
  return parsed;
}

/** Accepts ISO 8601 and returns normalised ISO, or null when absent. */
export function optionalIsoDate(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ToolValidationError(`El campo "${field}" debe ser una fecha ISO 8601.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ToolValidationError(
      `"${value}" no es una fecha válida. Usa ISO 8601, por ejemplo 2026-08-20T09:00:00+02:00.`,
    );
  }
  return parsed.toISOString();
}
