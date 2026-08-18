/**
 * Cliente mínimo de PostgREST (la API REST de Supabase).
 *
 * Se implementa a mano en vez de usar `@supabase/supabase-js` por el mismo motivo
 * que en la capa de LLM: el Worker solo necesita cuatro operaciones sobre seis
 * tablas, y el SDK arrastra peso y dependencias de Node al bundle.
 *
 * Entra siempre con `service_role`, que se salta RLS. Es la única credencial que
 * puede tocar estas tablas, y vive exclusivamente como secret en Cloudflare.
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

/** Filtros en sintaxis PostgREST: { status: 'eq.pending' }. */
export type Filters = Record<string, string>;

export interface SelectOptions {
  filters?: Filters;
  /** Ej. 'due_at.asc.nullslast' */
  order?: string;
  limit?: number;
  columns?: string;
}

const TIMEOUT_MS = 10_000;

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

  /** Upsert por la columna con restricción única indicada en `onConflict`. */
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

  async delete<T>(table: string, filters: Filters): Promise<T[]> {
    const params = new URLSearchParams(filters);
    return this.request<T[]>(`${table}?${params.toString()}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
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

    // DELETE y PATCH sin representación devuelven cuerpo vacío.
    const text = await response.text();
    if (!text) return [] as unknown as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DbError('Supabase devolvió algo que no era JSON');
    }
  }
}
