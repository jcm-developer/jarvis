import type { Env } from '../types';
import { JinaReader } from './jina';
import type { PageReader } from './provider';

/**
 * Page-reader selection.
 *
 * One provider today and no environment variable to pick it, for the same reason as the
 * calendar: `READER_PROVIDER` with a single possible value is dead configuration.
 *
 * Unlike search, there is nothing to check before using it: Jina works without a key, so
 * reading a link never depends on a secret being set. That is why `read_url` is offered
 * unconditionally while `search_web` is not.
 */
export function createPageReader(env: Env): PageReader {
  return new JinaReader(env.JINA_API_KEY?.trim() || undefined);
}
