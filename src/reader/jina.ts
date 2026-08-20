import type { PageReader, ReadPageOptions, ReadPageResult } from './provider';
import { ReaderError, cutToBytes } from './provider';

const ENDPOINT = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 16_000;

/**
 * Reading a page with Jina Reader.
 *
 * It is a URL prefix: `https://r.jina.ai/<url>` comes back as markdown, extraction
 * included. No SDK, no dependency, and the extraction —the part that would otherwise mean
 * parsing HTML inside the Worker— happens on their side.
 *
 * The key is optional and that is not an oversight: keyless works with a lower rate
 * limit, which for a personal inbox of forwarded links is enough. With a key the limit
 * goes up, so it is read when present.
 *
 * Known limit, and it is the honest one to state: it does not fight anti-bot systems. A
 * page behind Cloudflare's challenge or a paywall comes back as an error, and the job
 * reports that instead of pretending it read something.
 */
export class JinaReader implements PageReader {
  readonly name = 'jina';

  constructor(private readonly apiKey?: string) {}

  async read(url: string, options?: ReadPageOptions): Promise<ReadPageResult> {
    let response: Response;
    try {
      response = await fetch(`${ENDPOINT}${url}`, {
        headers: {
          // Markdown rather than their default: it keeps headings and lists, which is
          // most of what tells a summary where the article actually starts.
          Accept: 'text/plain',
          'X-Return-Format': 'markdown',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(Math.max(1_000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReaderError('upstream', `jina: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      // 403 here is ambiguous: it is either our key or the target site refusing. Treated
      // as 'blocked' when there is no key to be wrong about.
      throw this.apiKey
        ? new ReaderError('auth', 'jina: clave rechazada')
        : new ReaderError('blocked', 'jina: acceso denegado a la página');
    }
    if (response.status === 404 || response.status === 410) {
      throw new ReaderError('not_found', `jina: la página devolvió ${response.status}`);
    }
    if (response.status === 451 || response.status === 429) {
      throw new ReaderError('blocked', `jina: bloqueado con ${response.status}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ReaderError('upstream', `jina ${response.status}: ${detail.slice(0, 200)}`);
    }

    const body = await response.text();
    if (!body.trim()) {
      throw new ReaderError('blocked', 'jina: la página no devolvió texto');
    }

    const cut = cutToBytes(body.trim(), options?.maxBytes ?? DEFAULT_MAX_BYTES);
    return {
      title: extractTitle(body),
      text: cut.text,
      truncated: cut.truncated,
    };
  }
}

/**
 * The title out of Jina's own header block.
 *
 * Its markdown opens with `Title: ...` before the content. Read with a regex rather than
 * a parser: it is one line in a known position, and a dependency for that would be
 * absurd. Falls back to the first markdown heading, then to nothing.
 */
function extractTitle(body: string): string | null {
  const header = /^Title:\s*(.+)$/m.exec(body.slice(0, 500));
  if (header?.[1]) return header[1].trim().slice(0, 200);

  const heading = /^#{1,2}\s+(.+)$/m.exec(body.slice(0, 2_000));
  return heading?.[1] ? heading[1].trim().slice(0, 200) : null;
}
