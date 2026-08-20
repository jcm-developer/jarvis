/**
 * The page-reading contract.
 *
 * Separate from `src/search/` because they are separate problems with separate providers:
 * a search returns snippets that fit in a turn, and reading a page does not fit in a turn
 * at all —it rides on a deferred job (§16). Folding them into one interface would tie the
 * two halves to whichever provider happened to do both.
 */
export interface ReadPageResult {
  /** The page's title when the page declares one. */
  title: string | null;
  /** Extracted text, never HTML, already cut to the byte cap. */
  text: string;
  /**
   * Whether the cap cut something off.
   *
   * This flag is the whole reason the result is an object instead of a string. A model
   * that does not know it is reading half a page will happily invent the other half, so
   * whoever summarises has to be told, in words, that the text is partial.
   */
  truncated: boolean;
}

export interface ReadPageOptions {
  timeoutMs?: number;
  /** Hard cap on the extracted text. Bytes, not characters: tokens follow bytes. */
  maxBytes?: number;
}

export interface PageReader {
  readonly name: string;
  read(url: string, options?: ReadPageOptions): Promise<ReadPageResult>;
}

export type ReaderErrorKind = 'auth' | 'blocked' | 'not_found' | 'too_large' | 'upstream';

export class ReaderError extends Error {
  constructor(
    readonly kind: ReaderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ReaderError';
  }

  /**
   * Whether trying again later could plausibly work.
   *
   * The job's retry logic asks this instead of retrying everything: a 404 is not going
   * to become a 200, and three attempts at it are three wasted ticks.
   */
  get retryable(): boolean {
    return this.kind === 'upstream' || this.kind === 'blocked';
  }

  /** Read by the user, through the message the cron sends. Plain, no jargon. */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'no tengo clave para el lector de páginas';
      case 'blocked':
        return 'la página no me deja entrar';
      case 'not_found':
        return 'ese enlace ya no existe';
      case 'too_large':
        return 'la página es demasiado grande';
      case 'upstream':
        return 'el lector de páginas está fallando';
    }
  }
}

/**
 * Cuts text to a byte cap without leaving a broken character at the end.
 *
 * Bytes and not characters because what this is really protecting is the token count,
 * and a slice on a UTF-8 boundary would split an accented letter in half —which in
 * Spanish is most sentences. The decoder turns the orphan tail into U+FFFD and it gets
 * trimmed off.
 */
export function cutToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false };

  const decoded = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return { text: decoded.replace(/�+$/, '').trimEnd(), truncated: true };
}
