import { ConfigMissingError } from '../agent';
import { DbError } from '../db/client';
import { DeadlineExceededError } from '../lib/deadline';
import { LLMError } from '../llm/provider';

/**
 * Turns exceptions into something a person can read.
 *
 * It lived in `telegram/handler.ts` and nothing in it was about Telegram: the four classes
 * it knows come from the core, and the sentences it returns are the same ones whichever
 * channel reads them out. It is here so a second channel cannot drift into a different
 * wording —or into leaking a stack trace— for the same failure.
 *
 * The final `throw` is the point of the function and not a gap: only these four are
 * understood. Anything else is a bug, and a bug has to reach the logs as an unhandled
 * error instead of being flattened into a polite sentence.
 */
export function describeError(error: unknown): string {
  if (error instanceof DeadlineExceededError) {
    console.warn('presupuesto agotado antes de terminar');
    return error.userMessage;
  }
  if (error instanceof LLMError) {
    console.error(`llm_error kind=${error.kind} status=${error.status ?? '-'}`, error.message);
    return error.userMessage;
  }
  if (error instanceof ConfigMissingError) {
    console.error('config incompleta:', error.message);
    return 'Me falta la configuración de la base de datos. Revisa los secrets de Supabase.';
  }
  if (error instanceof DbError) {
    console.error('db_error:', error.message);
    return 'No he podido hablar con la base de datos. Lo tienes en los logs.';
  }
  throw error;
}
