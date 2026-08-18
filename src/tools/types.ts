import type { Db } from '../db/client';

export interface ToolContext {
  userId: string;
  conversationId: string;
  timezone: string;
  db: Db;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolDefinition {
  name: string;
  /** El modelo elige la herramienta leyendo esto. Ser explícito importa más que ser breve. */
  description: string;
  /** JSON Schema de los argumentos. */
  parameters: Record<string, unknown>;
  /**
   * Si es true, el agente NO ejecuta: pide confirmación al usuario con botones.
   * Reservado para lo irreversible.
   */
  requiresConfirmation: boolean;
  /**
   * Frase que se muestra al pedir confirmación. Es async y recibe el contexto
   * para poder consultar la base de datos: preguntar "¿borro 'Comprar pan'?" es
   * mucho más seguro que "¿borro la tarea 7f3a-...?", donde nadie revisa nada.
   */
  confirmationPrompt?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/* ------------------------------------------------------------------ *
 * Validación de argumentos.
 *
 * Los argumentos vienen de un modelo de lenguaje, así que hay que tratarlos como
 * entrada no confiable: pueden faltar, venir con el tipo cambiado o traer un
 * string donde se esperaba un número. Se valida a mano en vez de con Zod para no
 * añadir dependencia por siete herramientas.
 *
 * Los errores se lanzan como ToolValidationError y el agente los devuelve al
 * modelo como resultado, para que se corrija solo en la siguiente iteración.
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

export function optionalInt(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | null {
  const value = args[field];
  if (value === undefined || value === null) return null;

  // Los modelos mandan números como string con frecuencia; aceptarlo es más útil
  // que rechazarlo y gastar una iteración en que se corrija.
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new ToolValidationError(`El campo "${field}" debe ser un número.`);
  }
  if (parsed < min || parsed > max) {
    throw new ToolValidationError(`El campo "${field}" debe estar entre ${min} y ${max}.`);
  }
  return parsed;
}

/** Acepta ISO 8601 y devuelve ISO normalizado, o null si no venía. */
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
