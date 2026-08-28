import type { Config } from './config';
import type { Principal } from './core/principal';
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
import { searchConfigured } from './search';
import { loadMemories } from './tools/memory';
import { loadActiveProjects } from './tools/projects';
import type { PendingAction } from './tools/pending';
import { savePending } from './tools/pending';
import { getTool, toolSchemas } from './tools/registry';
import { applySnooze } from './tools/snooze';
import type { ToolContext, ToolResult } from './tools/types';
import { ToolValidationError } from './tools/types';
import type { Channel, Env } from './types';

/**
 * A photo attached to the message.
 *
 * The bytes live for exactly one request: what gets persisted is `ref`, the Telegram
 * file id. Storing the base64 in `messages` would put one photo's worth of tokens into
 * every following turn and fill the history window on its own.
 */
export interface AgentImage {
  mimeType: string;
  data: ArrayBuffer;
  /** Telegram's file_id, so an odd reading can be traced back to the actual photo. */
  ref: string;
}

export interface AgentInput {
  chatId: number;
  from: Principal | undefined;
  /** What the user wrote. A photo's caption counts, and may be empty. */
  text: string;
  /** 'text' by default. Stored in the history for debugging audio and photos. */
  source?: 'text' | 'voice' | 'photo';
  /** What the STT returned, when the message came from audio. */
  transcriptRaw?: string;
  image?: AgentImage;
}

export interface AgentDeps {
  env: Env;
  config: Config;
  deadline: Deadline;
  /**
   * Which surface the turn arrived through.
   *
   * It is in the deps and not in the input because it is a property of the transport, not
   * of the message: the same is true of a button press, where there is no input at all.
   * It decides two things and no more —which tools are offered and how the prompt opens—
   * so both channels keep sharing one conversation, one history and one set of rules.
   */
  channel: Channel;
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
  const [history, memories, projects] = await Promise.all([
    loadHistory(db, identity.conversationId, config.historyWindow),
    loadMemories(db, identity.userId),
    // Third query, and it is worth one: what it loads goes into every message, so
    // fetching it on demand would mean a round trip the model has to decide to spend,
    // for the thing it is least likely to know it needs (phase 26).
    loadActiveProjects(db, identity.userId),
  ]);

  const toolCtx: ToolContext = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    timezone: identity.timezone,
    chatId: input.chatId,
    channel: deps.channel,
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
      // With a photo the stored text carries a marker. Without it the caption would be
      // read back on the following turns as though it had arrived on its own, and the
      // model would have no idea where the three tasks it created came from.
      content: input.image ? photoLabel(input.text) : input.text,
      source: input.source ?? 'text',
      ...(input.transcriptRaw ? { transcriptRaw: input.transcriptRaw } : {}),
      ...(input.image ? { attachmentRef: input.image.ref } : {}),
    },
  ];

  const provider = createProvider(env, config);

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        timezone: identity.timezone,
        now: new Date(),
        memories: memories.map((memory) => ({ key: memory.key, value: memory.value })),
        projects: projects.map((project) => ({
          name: project.name,
          description: project.description,
        })),
        // Asked of the provider that is going to answer, not of the config: the list of
        // limits must not promise what this model cannot do, and with a text-only one the
        // prompt has to keep saying it cannot see photos.
        canSeeImages: provider.supportsImages,
        // Same idea, read from the config: with the job off the prompt has to go back to
        // saying that the calendar's own app is the one that warns him.
        eventAlertMinutes: config.eventAlertMinutes,
        // And the same again for search: with no key the tool is not even offered
        // (`toolSchemas`), so the prompt has to go back to saying it cannot search.
        // Both readings come from the same place or they drift apart.
        canSearchWeb: searchConfigured(env),
        // And the fourth of the family, this one not constant for the deployment: the
        // prompt opens by saying where the conversation is happening, and on the voice
        // page that sentence was a lie the model then defended out loud.
        channel: deps.channel,
      }),
    },
    ...toLLMMessages(history),
    {
      role: 'user',
      content: input.text || null,
      // How the photo is written on the wire is the adapter's business (src/llm): from
      // here it is bytes with a mime type.
      ...(input.image
        ? { images: [{ mimeType: input.image.mimeType, data: input.image.data }] }
        : {}),
    },
  ];

  const schemas = toolSchemas(env, deps.channel);

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
    //
    // With a photo, EVERYTHING that writes waits for the same button, destructive or
    // not. Two reasons that compound: a photo with five things in it fires five calls in
    // one turn, and there is no user text for the date corrector of §7 to hold on to
    // —the same hole as the confirmation-button path—, so the day the model reads off a
    // poster goes in uncorrected. One question before writing is slower, and it is what
    // stops five badly dated rows landing at once.
    const confirmable = response.toolCalls.filter((call) => {
      const tool = getTool(call.name);
      if (!tool) return false;
      return tool.requiresConfirmation || (input.image !== undefined && tool.mutates);
    });

    if (confirmable.length > 0) {
      // Nothing from this turn is persisted: until the person says yes, nothing has
      // happened that the model should remember.
      const prompt = await buildConfirmationPrompt(confirmable, toolCtx, input.image !== undefined);
      const token = await savePending(env, input.chatId, {
        calls: confirmable.map((call) => ({ toolName: call.name, args: parseArguments(call) })),
        prompt,
        // The caption travels with the pending action so the corrector still has it when
        // the button gets pressed. Without it the guardrails would see an empty message,
        // and a "pásalo al jueves" written under the photo would be lost between the
        // question and the answer.
        userMessage: input.text,
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
  fromPhoto = false,
): Promise<string> {
  const lines = await Promise.all(
    calls.map(async (call) => {
      const tool = getTool(call.name);
      if (!tool?.confirmationPrompt) return `Ejecutar "${call.name}"`;
      try {
        return await tool.confirmationPrompt(parseArguments(call), ctx);
      } catch (error) {
        // Wording the question is not worth the turn. A prompt builder validates the
        // model's arguments to word itself, and a throw here would leave the user with
        // an internal error instead of a button on an action that may well be fine.
        console.warn(`no se pudo redactar la confirmación de ${call.name}:`, error);
        return `Ejecutar "${call.name}"`;
      }
    }),
  );

  if (lines.length === 1) return lines[0]!;

  // The heading says where this came from. On a photo the list IS the summary of what
  // was understood, and the point of the phase is that the user reads it before
  // anything gets written.
  const heading = fromPhoto ? 'De la foto saco esto:' : '¿Confirmas estas acciones?';
  return [heading, '', ...lines.map((line) => `• ${line}`)].join('\n');
}

/**
 * What the history keeps of a photo message.
 *
 * The bytes never get here —that is the point— so the marker is what tells the model, on
 * the following turns, that there was an image and that the caption belonged to it.
 */
function photoLabel(caption: string): string {
  return caption ? `[foto] ${caption}` : '[foto]';
}

/**
 * Forgets the recent conversation (/reset). Long-term memories are left alone: they are
 * another table and another contract with the user.
 */
export async function forgetConversation(
  input: { chatId: number; from: Principal | undefined },
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
/**
 * Postpones an alert from the button on the alert itself.
 *
 * It sits next to `executeConfirmed` because it is the same shape of thing: a button
 * press, no model involved, and the identity resolved from the actor —cached in KV, so it
 * is not a query per press. What it must NOT do is go through the agent: paying for a
 * model call to move a date by ten minutes is exactly what the button is for.
 */
export async function snoozeReminder(
  input: { chatId: number; from: Principal | undefined; taskId: string; code: string },
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

  return applySnooze({
    db,
    userId: identity.userId,
    conversationId: identity.conversationId,
    taskId: input.taskId,
    code: input.code,
    now: new Date(),
    timezone: identity.timezone,
  });
}

export async function executeConfirmed(
  action: PendingAction,
  input: { chatId: number; from: Principal | undefined },
  deps: AgentDeps,
): Promise<string> {
  const calls = action.calls;
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
    chatId: input.chatId,
    channel: deps.channel,
    db,
    env: deps.env,
    config: deps.config,
    deadline: deps.deadline,
    // Normally empty: pressing a button carries no new text. A photo's caption is the
    // exception and travels with the pending action, so the date guardrails see exactly
    // the same message they saw when the question was worded.
    userMessage: action.userMessage ?? '',
  };

  const failures: string[] = [];
  const stored: string[] = [];
  let done = 0;

  for (const call of calls) {
    const result = await executeTool(
      { id: 'confirmed', name: call.toolName, arguments: JSON.stringify(call.args) },
      ctx,
    );
    if (result.ok) {
      done++;
      const line = describeStored(result.data);
      if (line) stored.push(line);
    } else {
      failures.push(result.error);
    }
  }

  if (failures.length === 0) {
    // Deletions say so and nothing else: naming what has just stopped existing reads
    // like an offer to undo it, and there is none.
    if (calls.every((call) => call.toolName.startsWith('delete_'))) {
      return done === 1 ? 'Hecho, borrado.' : `Hecho, ${done} borradas.`;
    }
    // Everything else states the date it stored. Same rule the prompt puts on the model
    // (§7): what the user reads back is their chance to catch a wrong day, and on this
    // path there is no model reply to carry it.
    if (stored.length === 0) return 'Hecho.';
    if (stored.length === 1) return `Hecho: ${stored[0]}`;
    return ['Hecho:', '', ...stored.map((line) => `- ${line}`)].join('\n');
  }
  if (done === 0) {
    return `No he podido: ${failures[0]}`;
  }
  return `He completado ${done}, pero ${failures.length} han fallado: ${failures[0]}`;
}

/**
 * One line naming what a tool has just written, read off its own result.
 *
 * It leans on the shape the handlers already return —`title` plus a Spanish date in
 * `when` or `due`— instead of a per-tool description: those fields exist precisely so
 * the model can repeat the date in its reply, and here they serve the same purpose with
 * no model in the middle.
 */
function describeStored(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const row = data as Record<string, unknown>;

  const title = typeof row['title'] === 'string' ? row['title'] : null;
  if (title === null) {
    // remember() returns key and value, no title.
    const key = typeof row['key'] === 'string' ? row['key'] : null;
    const value = typeof row['value'] === 'string' ? row['value'] : null;
    return key && value ? `${key}: ${value}` : null;
  }

  const when =
    typeof row['when'] === 'string'
      ? row['when']
      : typeof row['due'] === 'string'
        ? row['due']
        : typeof row['remind'] === 'string'
          ? row['remind']
          : null;

  return when ? `${title} — ${when}` : title;
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
