import type { Config } from './config';
import { Db } from './db/client';
import { resolveIdentity } from './db/identity';
import { logToolCall } from './db/logs';
import { createProvider } from './llm';
import type { LLMMessage, ToolCall } from './llm/provider';
import { LLMError } from './llm/provider';
import { appendTurns, loadHistory } from './memory/history';
import { buildSystemPrompt } from './prompts/system';
import { loadMemories } from './tools/memory';
import { savePending } from './tools/pending';
import { getTool, toolSchemas } from './tools/registry';
import type { ToolContext, ToolResult } from './tools/types';
import { ToolValidationError } from './tools/types';
import type { Env, TelegramUser } from './types';

export interface AgentInput {
  chatId: number;
  from: TelegramUser | undefined;
  text: string;
}

export interface AgentDeps {
  env: Env;
  config: Config;
}

export type AgentResult =
  | { kind: 'text'; text: string }
  /** Una acción destructiva espera confirmación; el handler pinta los botones. */
  | { kind: 'confirm'; text: string; token: string };

export class ConfigMissingError extends Error {}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const { env, config } = deps;
  const db = createDb(env);

  const identity = await resolveIdentity(env, db, input.from, input.chatId, config.defaultTimezone);
  const [history, memories] = await Promise.all([
    loadHistory(env, input.chatId),
    loadMemories(db, identity.userId),
  ]);

  const toolCtx: ToolContext = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    timezone: identity.timezone,
    db,
  };

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        timezone: identity.timezone,
        now: new Date(),
        memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
      }),
    },
    ...history.map((turn) => ({ role: turn.role, content: turn.content }) as LLMMessage),
    { role: 'user', content: input.text },
  ];

  const provider = createProvider(env, config);
  const schemas = toolSchemas();

  for (let iteration = 1; iteration <= config.maxAgentIterations; iteration++) {
    const started = Date.now();
    const response = await provider.chat(messages, schemas);

    console.info(
      JSON.stringify({
        event: 'llm_call',
        iteration,
        provider: provider.name,
        model: provider.model,
        finish: response.finishReason,
        tool_calls: response.toolCalls.map((call) => call.name),
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        duration_ms: Date.now() - started,
      }),
    );

    if (response.finishReason !== 'tool_calls' || response.toolCalls.length === 0) {
      const reply = response.content?.trim();
      if (!reply) {
        throw new LLMError('malformed', 'el modelo devolvió una respuesta vacía');
      }
      await persist(env, input, history, reply, config.historyWindow);
      return { kind: 'text', text: reply };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const tool = getTool(call.name);

      if (tool?.requiresConfirmation) {
        // Se corta el bucle: nada se ejecuta hasta que la persona diga que sí.
        const args = parseArguments(call);
        const prompt = tool.confirmationPrompt
          ? await tool.confirmationPrompt(args, toolCtx)
          : `¿Confirmas la acción "${tool.name}"?`;
        const token = await savePending(env, input.chatId, {
          toolName: tool.name,
          args,
          prompt,
        });
        return { kind: 'confirm', text: prompt, token };
      }

      const result = await executeTool(call, toolCtx);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Se agotaron las iteraciones. Sin este corte, un modelo confundido encadena
  // llamadas hasta quemar la cuota del día en una sola conversación.
  console.warn(`agente agotó las ${config.maxAgentIterations} iteraciones`);
  return {
    kind: 'text',
    text: 'Me he liado dando vueltas y no he llegado a una respuesta. Prueba a pedírmelo de otra forma.',
  };
}

/** Ejecuta una tool ya confirmada por el usuario. */
export async function executeConfirmed(
  toolName: string,
  args: Record<string, unknown>,
  input: { chatId: number; from: TelegramUser | undefined },
  deps: AgentDeps,
): Promise<string> {
  const tool = getTool(toolName);
  if (!tool) return 'Esa acción ya no existe.';

  const db = createDb(deps.env);
  const identity = await resolveIdentity(
    deps.env,
    db,
    input.from,
    input.chatId,
    deps.config.defaultTimezone,
  );

  const result = await executeTool(
    { id: 'confirmed', name: toolName, arguments: JSON.stringify(args) },
    { userId: identity.userId, conversationId: identity.conversationId, timezone: identity.timezone, db },
  );

  return result.ok ? 'Hecho.' : `No he podido: ${result.error}`;
}

async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(call.name);
  if (!tool) {
    return { ok: false, error: `La herramienta "${call.name}" no existe.` };
  }

  const started = Date.now();
  let result: ToolResult;
  let args: Record<string, unknown> = {};

  try {
    args = parseArguments(call);
    result = await tool.handler(args, ctx);
  } catch (error) {
    // Los errores vuelven al modelo como resultado, no como excepción: así puede
    // corregirse en la siguiente iteración en vez de romper la conversación.
    const message =
      error instanceof ToolValidationError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    result = { ok: false, error: message };
    console.error(`tool_error ${call.name}:`, message);
  }

  await logToolCall(ctx.db, {
    conversationId: ctx.conversationId,
    toolName: call.name,
    args,
    result: result.ok ? result.data : null,
    success: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    durationMs: Date.now() - started,
  });

  return result;
}

/** Los modelos emiten JSON inválido de vez en cuando; no debe tumbar el turno. */
function parseArguments(call: ToolCall): Record<string, unknown> {
  if (!call.arguments.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ToolValidationError(
      'Los argumentos no eran JSON válido. Vuelve a llamar a la herramienta.',
    );
  }
}

function createDb(env: Env): Db {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ConfigMissingError(
      'Faltan los secrets SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

async function persist(
  env: Env,
  input: AgentInput,
  history: Awaited<ReturnType<typeof loadHistory>>,
  reply: string,
  windowSize: number,
): Promise<void> {
  await appendTurns(
    env,
    input.chatId,
    history,
    [
      { role: 'user', content: input.text },
      { role: 'assistant', content: reply },
    ],
    windowSize,
  );
}
