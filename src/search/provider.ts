/**
 * The web-search contract. Same criterion as the LLM and STT layers: the rest of the
 * code does not know who searches.
 *
 * This is the first third party we do not control sitting inside a message's budget, and
 * the interface is shaped by that: the result is bounded by design —a handful of results,
 * each a snippet— because "a page" is not something a 27 s turn can afford to read.
 */
export interface SearchResult {
  title: string;
  url: string;
  /** An extract the provider already pulled out for us. Never the whole page. */
  snippet: string;
  /** When the provider knows it. Rule 4 of §7: say the date, do not imply "now". */
  publishedAt: string | null;
}

export interface SearchOptions {
  /** Cap for this call. Set by the message's global budget. */
  timeoutMs?: number;
  maxResults?: number;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export type SearchErrorKind = 'auth' | 'quota' | 'upstream';

export class SearchError extends Error {
  constructor(
    readonly kind: SearchErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }

  /**
   * What the MODEL reads, not the user. It comes back as `{ok:false, error}` so the
   * model can word its own excuse and offer what it can still do.
   */
  get toolMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'No puedo buscar en internet: falta la clave del buscador en la configuración.';
      case 'quota':
        return 'Se ha agotado la cuota mensual de búsquedas. No puedo buscar hasta que se renueve.';
      case 'upstream':
        return 'El buscador está fallando ahora mismo. Dilo y ofrécele intentarlo más tarde.';
    }
  }
}
