/**
 * A minimal PostgREST client (Supabase's REST API).
 *
 * Written by hand instead of using `@supabase/supabase-js` for the same reason as in
 * the LLM layer: the Worker only needs four operations across six tables, and the SDK
 * drags weight and Node dependencies into the bundle.
 *
 * It always connects as `service_role`, which bypasses RLS. That is the only credential
 * allowed to touch these tables, and it lives exclusively as a secret in Cloudflare.
 */

export class DbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

/** Filters in PostgREST syntax: { status: 'eq.pending' }. */
export type Filters = Record<string, string>;

export interface SelectOptions {
  filters?: Filters;
  /** E.g. 'due_at.asc.nullslast' */
  order?: string;
  limit?: number;
  columns?: string;
}

/** Deliberately low: several queries in a row must fit the global budget. */
const TIMEOUT_MS = 6_000;

export class Db {
  private readonly restUrl: string;

  constructor(
    url: string,
    private readonly serviceRoleKey: string,
  ) {
    this.restUrl = `${url.replace(/\/+$/, '')}/rest/v1`;
  }

  async select<T>(table: string, options: SelectOptions = {}): Promise<T[]> {
    const params = new URLSearchParams();
    params.set('select', options.columns ?? '*');
    for (const [column, expression] of Object.entries(options.filters ?? {})) {
      params.set(column, expression);
    }
    if (options.order) params.set('order', options.order);
    if (options.limit !== undefined) params.set('limit', String(options.limit));

    return this.request<T[]>(`${table}?${params.toString()}`, { method: 'GET' });
  }

  async insert<T>(table: string, row: Record<string, unknown>): Promise<T> {
    const rows = await this.request<T[]>(table, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    const inserted = rows[0];
    if (!inserted) throw new DbError(`insert en ${table} no devolvió fila`);
    return inserted;
  }

  /**
   * Inserts several rows in a single request.
   *
   * `return=minimal`: they are not asked back. One conversation turn is five or six
   * rows we already hold in memory; fetching them again only adds latency.
   */
  async insertMany(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.request<unknown>(table, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    });
  }

  /** Upsert on the uniquely constrained column named in `onConflict`. */
  async upsert<T>(table: string, row: Record<string, unknown>, onConflict: string): Promise<T> {
    const rows = await this.request<T[]>(`${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
    const upserted = rows[0];
    if (!upserted) throw new DbError(`upsert en ${table} no devolvió fila`);
    return upserted;
  }

  async update<T>(table: string, filters: Filters, patch: Record<string, unknown>): Promise<T[]> {
    const params = new URLSearchParams(filters);
    return this.request<T[]>(`${table}?${params.toString()}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
  }

  /**
   * Deletes and returns the deleted rows.
   *
   * `returning: 'minimal'` for bulk deletes: purging a long history would return
   * hundreds of rows nobody is going to read.
   */
  async delete<T>(
    table: string,
    filters: Filters,
    options: { returning?: 'representation' | 'minimal' } = {},
  ): Promise<T[]> {
    const params = new URLSearchParams(filters);
    return this.request<T[]>(`${table}?${params.toString()}`, {
      method: 'DELETE',
      headers: { Prefer: `return=${options.returning ?? 'representation'}` },
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.restUrl}/${path}`, {
        ...init,
        headers: {
          apikey: this.serviceRoleKey,
          Authorization: `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DbError(`no se pudo alcanzar Supabase: ${detail}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DbError(`Supabase ${response.status}: ${detail.slice(0, 300)}`, response.status);
    }

    // DELETE and PATCH without representation return an empty body.
    const text = await response.text();
    if (!text) return [] as unknown as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DbError('Supabase devolvió algo que no era JSON');
    }
  }
}
