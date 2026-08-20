import type { SearchOptions, SearchProvider, SearchResult } from './provider';
import { SearchError } from './provider';

const ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Search with Tavily.
 *
 * Picked over the alternatives for one reason that is not about result quality: its free
 * tier is recurring —1.000 credits that come back every month, no card— and the others
 * are not. Serper hands out 2.500 queries once, Google's Custom Search closed to new
 * customers, and Brave's free tier became metered billing with no spending cap. A
 * welcome credit means the assistant goes mute on some random Tuesday three months in,
 * which is the failure mode this project has been avoiding since phase 1.
 *
 * `search_depth: 'basic'` costs 1 credit against advanced's 2, and it is what returns
 * snippets rather than long extracts. That is the shape the turn can pay for.
 */
export class TavilySearch implements SearchProvider {
  readonly name = 'tavily';

  constructor(private readonly apiKey: string) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          max_results: options?.maxResults ?? 5,
          // No `include_answer`. Tavily can hand back a written answer, and taking it
          // would mean relaying another model's summary as fact through ours, with no
          // way to tell the user which of the two got it wrong. Our model gets the
          // snippets and cites them.
          include_answer: false,
          include_raw_content: false,
        }),
        signal: AbortSignal.timeout(Math.max(1_000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SearchError('upstream', `tavily: ${detail}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SearchError('auth', 'tavily: clave rechazada');
    }
    // 429 is the monthly credit running out as well as a rate limit. They are the same
    // thing from here: no search this time, and it is not the user's fault.
    if (response.status === 429) {
      throw new SearchError('quota', 'tavily: sin credits o rate limit');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new SearchError('upstream', `tavily ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string; published_date?: string }[];
    };

    return (body.results ?? [])
      .filter((result): result is { url: string } & typeof result => Boolean(result.url))
      .map((result) => ({
        title: (result.title ?? result.url).trim(),
        url: result.url,
        snippet: (result.content ?? '').trim(),
        publishedAt: result.published_date?.trim() || null,
      }));
  }
}
