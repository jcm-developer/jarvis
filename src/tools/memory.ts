import type { MemoryRow } from '../db/types';
import type { ToolDefinition, ToolResult } from './types';
import { requireString } from './types';

/**
 * Long-term memory. This is what separates a chatbot from an assistant: the
 * conversation history expires, this does not.
 */

export const remember: ToolDefinition = {
  name: 'remember',
  description:
    'Guarda un dato duradero sobre el usuario: su trabajo, sus preferencias, ' +
    'nombres de personas de su entorno, cómo le gusta que le respondas. Úsala ' +
    'cuando cuente algo que convenga recordar en futuras conversaciones, sin ' +
    'que tenga que pedírtelo. No la uses para cosas puntuales o del momento.',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'Identificador corto en snake_case, ej. "trabajo", "jefe", "prefiere_respuestas_cortas". ' +
          'Reutiliza la misma clave para actualizar un dato existente.',
      },
      value: { type: 'string', description: 'El dato, en una frase.' },
    },
    required: ['key', 'value'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const key = requireString(args, 'key', 80)
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');

    if (!key) {
      return { ok: false, error: 'La clave debe contener letras o números.' };
    }

    const memory = await ctx.db.upsert<MemoryRow>(
      'memories',
      {
        user_id: ctx.userId,
        key,
        value: requireString(args, 'value', 500),
        updated_at: new Date().toISOString(),
      },
      'user_id,key',
    );

    return { ok: true, data: { key: memory.key, value: memory.value } };
  },
};

export const recall: ToolDefinition = {
  name: 'recall',
  description:
    'Busca en lo que recuerdas sobre el usuario. Las memorias más relevantes ya ' +
    'te llegan en el contexto, así que solo la necesitas para buscar algo concreto ' +
    'que no esté ahí.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Texto a buscar en las claves y los valores.',
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  handler: async (args, ctx): Promise<ToolResult> => {
    const query = requireString(args, 'query', 100);

    // ilike with wildcards: substring search, case insensitive. Good enough while
    // there are few memories; at volume this will call for pgvector.
    const escaped = query.replace(/[%,()]/g, ' ').trim();
    const memories = await ctx.db.select<MemoryRow>('memories', {
      filters: {
        user_id: `eq.${ctx.userId}`,
        or: `(key.ilike.*${escaped}*,value.ilike.*${escaped}*)`,
      },
      limit: 10,
    });

    return {
      ok: true,
      data: {
        count: memories.length,
        memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
      },
    };
  },
};

/** Injected into every conversation's context, without spending a tool call. */
export async function loadMemories(
  db: import('../db/client').Db,
  userId: string,
  limit = 30,
): Promise<MemoryRow[]> {
  return db.select<MemoryRow>('memories', {
    filters: { user_id: `eq.${userId}` },
    order: 'updated_at.desc',
    limit,
  });
}
