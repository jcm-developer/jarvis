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
  /** Por defecto 'text'. Se guarda en el historial para depurar audios. */
  source?: 'text' | 'voice';
  /** Lo que devolvió el STT, cuando el mensaje venía de un audio. */
  transcriptRaw?: string;
}

export interface AgentDeps {
  env: Env;
  config: Config;
  deadline: Deadline;
}

/** Margen que se reserva para enviar la respuesta antes de que nos corten. */
const MIN_ROOM_FOR_CALL_MS = 4_000;
const MAX_LLM_CALL_MS = 15_000;

export type AgentResult =
  | { kind: 'text'; text: string }
  /** Una o varias acciones destructivas esperan confirmación. */
  | { kind: 'confirm'; text: string; token: string };

export class ConfigMissingError extends Error {}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const { env, config, deadline } = deps;
  const db = createDb(env);

  const identity = await resolveIdentity(env, db, input.from, input.chatId, config.defaultTimezone);
  // Dos consultas independientes: en paralelo cuestan lo que la más lenta.
  const [history, memories] = await Promise.all([
    loadHistory(db, identity.conversationId, config.historyWindow),
    loadMemories(db, identity.userId),
  ]);

  const toolCtx: ToolContext = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    timezone: identity.timezone,
    db,
  };

  // Turnos nuevos de esta interacción. Se persisten de golpe al final, no a
  // medida que ocurren: un turno a medio guardar —un assistant con tool_calls
  // sin sus resultados— es contexto que la API rechaza con un 400.
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
    // Antes de empezar otra vuelta, comprobar que da tiempo. Lanzarla sabiendo
    // que no cabe garantiza el silencio que precisamente queremos evitar.
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

    // Las destructivas se agrupan y se preguntan de una vez. Preguntarlas de una
    // en una convierte "bórralas todas" en una cadena de diálogos absurda.
    const confirmable = response.toolCalls.filter(
      (call) => getTool(call.name)?.requiresConfirmation,
    );

    if (confirmable.length > 0) {
      // No se persiste nada de este turno: hasta que la persona diga que sí, no
      // ha pasado nada que el modelo deba recordar.
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

  // Se agotaron las iteraciones. Sin este corte, un modelo confundido encadena
  // llamadas hasta quemar la cuota del día en una sola conversación.
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
 * Olvida la conversación reciente (/reset). Las memorias de largo plazo no se
 * tocan: son de otra tabla y de otro contrato con el usuario.
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

/** Ejecuta las acciones ya confirmadas por el usuario. */
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
    throw new ConfigMissingError('Faltan los secrets SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  }
  return new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
