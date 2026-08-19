import type { Config } from './config';
import { Db } from './db/client';
import { resolveIdentity } from './db/identity';
import { logToolCall } from './db/logs';
import type { StoredTurn } from './db/messages';
import { clearHistory, loadHistory, saveTurns, toLLMMessages, toolTurn } from './db/messages';
import type { Deadline } from './lib/deadline';
import { DeadlineExceededError } from './lib/deadline';
import { createProvider } from './llm';
import type { LLMMessage, ToolCall } from './llm/provider';
import { LLMError } from './llm/provider';
import { buildSystemPrompt } from './prompts/system';
import { loadMemories } from './tools/memory';
import type { PendingCall } from './tools/pending';
import { savePending } from './tools/pending';
import { getTool, toolSchemas } from './tools/registry';
import type { ToolContext, ToolResult } from './tools/types';
import { ToolValidationError } from './tools/types';
import type { Env, TelegramUser } from './types';

export interface AgentInput {
  chatId: number;
  from: TelegramUser | undefined;
  text: string;
  /** 'text' by default. Stored in the history for debugging audio. */
  source?: 'text' | 'voice';
  /** What the STT returned, when the message came from audio. */
  transcriptRaw?: string;
}

export interface AgentDeps {
  env: Env;
  config: Config;
  deadline: Deadline;
}

/** Margin reserved for sending the reply before we get cut off. */
const MIN_ROOM_FOR_CALL_MS = 4_000;
const MAX_LLM_CALL_MS = 15_000;

export type AgentResult =
  | { kind: 'text'; text: string }
  /** One or more destructive actions are waiting for confirmation. */
  | { kind: 'confirm'; text: string; token: string };

export class ConfigMissingError extends Error {}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const { env, config, deadline } = deps;
  const db = createDb(env);

  const identity = await resolveIdentity(env, db, input.from, input.chatId, config.defaultTimezone);
  // Two independent queries: in parallel they cost whatever the slower one costs.
  const [history, memories] = await Promise.all([
    loadHistory(db, identity.conversationId, config.historyWindow),
    loadMemories(db, identity.userId),
  ]);

  const toolCtx: ToolContext = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    timezone: identity.timezone,
    db,
    env,
    config,
    deadline,
    userMessage: input.text,
  };

  // New turns from this interaction. They are persisted in one go at the end, not as
  // they happen: a half-saved turn —an assistant with tool_calls but without their
  // results— is context the API rejects with a 400.
  const newTurns: StoredTurn[] = [
    {
      role: 'user',
      content: input.text,
      source: input.source ?? 'text',
      ...(input.transcriptRaw ? { transcriptRaw: input.transcriptRaw } : {}),
    },
  ];

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        timezone: identity.timezone,
        now: new Date(),
        memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
      }),
    },
    ...toLLMMessages(history),
    { role: 'user', content: input.text },
  ];

  const provider = createProvider(env, config);
  const schemas = toolSchemas();

  for (let iteration = 1; iteration <= config.maxAgentIterations; iteration++) {
    // Before starting another round, check there is time. Launching it knowing it does
    // not fit guarantees exactly the silence we are trying to avoid.
    if (!deadline.hasRoomFor(MIN_ROOM_FOR_CALL_MS)) {
      throw new DeadlineExceededError();
    }

    const started = Date.now();
    const response = await provider.chat(messages, schemas, {
      timeoutMs: deadline.budgetFor(MAX_LLM_CALL_MS),
    });

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
      newTurns.push({ role: 'assistant', content: reply });
      await saveTurns(db, identity.conversationId, newTurns);
      return { kind: 'text', text: reply };
    }

    const assistantTurn: StoredTurn = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    };
    messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    // Destructive calls are grouped and asked about at once. Asking one at a time turns
    // "delete them all" into an absurd chain of dialogues.
    const confirmable = response.toolCalls.filter(
      (call) => getTool(call.name)?.requiresConfirmation,
    );

    if (confirmable.length > 0) {
      // Nothing from this turn is persisted: until the person says yes, nothing has
      // happened that the model should remember.
      const prompt = await buildConfirmationPrompt(confirmable, toolCtx);
      const token = await savePending(env, input.chatId, {
        calls: confirmable.map((call) => ({ toolName: call.name, args: parseArguments(call) })),
        prompt,
      });
      return { kind: 'confirm', text: prompt, token };
    }

    newTurns.push(assistantTurn);

    for (const call of response.toolCalls) {
      const result = await executeTool(call, toolCtx);
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      newTurns.push(toolTurn(call.id, result));
    }
  }

  // The iterations ran out. Without this cut-off, a confused model chains calls until it
  // burns the day's quota in a single conversation.
  console.warn(`agente agotó las ${config.maxAgentIterations} iteraciones`);
  return {
    kind: 'text',
    text: 'Me he liado dando vueltas y no he llegado a una respuesta. Prueba a pedírmelo de otra forma.',
  };
}

async function buildConfirmationPrompt(
  calls: ToolCall[],
  ctx: ToolContext,
): Promise<string> {
  const lines = await Promise.all(
    calls.map(async (call) => {
      const tool = getTool(call.name);
      if (!tool?.confirmationPrompt) return `Ejecutar "${call.name}"`;
      return tool.confirmationPrompt(parseArguments(call), ctx);
    }),
  );

  if (lines.length === 1) return lines[0]!;
  return ['¿Confirmas estas acciones?', '', ...lines.map((line) => `• ${line}`)].join('\n');
}

/**
 * Forgets the recent conversation (/reset). Long-term memories are left alone: they are
 * another table and another contract with the user.
 */
export async function forgetConversation(
  input: { chatId: number; from: TelegramUser | undefined },
  deps: AgentDeps,
): Promise<void> {
  const db = createDb(deps.env);
  const identity = await resolveIdentity(
    deps.env,
    db,
    input.from,
    input.chatId,
    deps.config.defaultTimezone,
  );
  await clearHistory(db, identity.conversationId);
}

/** Runs the actions the user has already confirmed. */
export async function executeConfirmed(
  calls: PendingCall[],
  input: { chatId: number; from: TelegramUser | undefined },
  deps: AgentDeps,
): Promise<string> {
  const db = createDb(deps.env);
  const identity = await resolveIdentity(
    deps.env,
    db,
    input.from,
    input.chatId,
    deps.config.defaultTimezone,
  );
  const ctx: ToolContext = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    timezone: identity.timezone,
    db,
    env: deps.env,
    config: deps.config,
    deadline: deps.deadline,
    // No new message: this comes from a confirmation button.
    userMessage: '',
  };

  const failures: string[] = [];
  let done = 0;

  for (const call of calls) {
    const result = await executeTool(
      { id: 'confirmed', name: call.toolName, arguments: JSON.stringify(call.args) },
      ctx,
    );
    if (result.ok) done++;
    else failures.push(result.error);
  }

  if (failures.length === 0) {
    return done === 1 ? 'Hecho, borrado.' : `Hecho, ${done} borradas.`;
  }
  if (done === 0) {
    return `No he podido: ${failures[0]}`;
  }
  return `He completado ${done}, pero ${failures.length} han fallado: ${failures[0]}`;
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
    // Errors go back to the model as a result, not as an exception: that way it can
    // correct itself on the next iteration instead of breaking the conversation.
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

/** Models emit invalid JSON now and then; it must not bring the turn down. */
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

/** The cron uses it too: the secrets check lives in exactly one place. */
export function createDb(env: Env): Db {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ConfigMissingError('Faltan los secrets SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  }
  return new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
