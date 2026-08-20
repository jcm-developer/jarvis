import type { Env } from '../types';
import type { SearchProvider } from './provider';
import { SearchError } from './provider';
import { TavilySearch } from './tavily';

/**
 * Search provider selection.
 *
 * There is only one today, so the list exists for what happens next rather than for what
 * is here: these free tiers move fast —Brave's was the recommended one six months ago and
 * is now metered billing— and the point of the interface is that swapping is a variable
 * and a key, not a refactor.
 */
export const SEARCH_PROVIDERS = ['tavily'] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

export function isSearchProviderName(value: string): value is SearchProviderName {
  return (SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether search is usable at all.
 *
 * Asked before building the prompt: with no key the assistant has to go back to saying
 * it cannot search, and promising a search it cannot run is worse than not having the
 * feature. Same reasoning as `canSeeImages` (§15).
 */
export function searchConfigured(env: Env): boolean {
  return Boolean(env.TAVILY_API_KEY?.trim());
}

export function createSearchProvider(env: Env): SearchProvider {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new SearchError(
      'auth',
      'Falta el secret TAVILY_API_KEY para buscar en internet.',
    );
  }
  return new TavilySearch(apiKey);
}
