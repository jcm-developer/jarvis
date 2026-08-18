import { ConfigMissingError, executeConfirmed, runAgent } from '../agent';
import type { Config } from '../config';
import { DbError } from '../db/client';
import { LLMError } from '../llm/provider';
import { clearHistory } from '../memory/history';
import { takePending } from '../tools/pending';
import type { Env, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '../types';
import type { Actor } from './guard';
import { TelegramClient } from './client';

export interface HandlerContext {
  env: Env;
  config: Config;
  telegram: TelegramClient;
  actor: Actor;
}

const CONFIRM_PREFIX = 'ok:';
const CANCEL_PREFIX = 'no:';

export async function handleUpdate(update: TelegramUpdate, ctx: HandlerContext): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query, ctx);
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const result = await withTyping(ctx, () => buildReply(message, ctx));

  if (result.kind === 'confirm') {
    await ctx.telegram.sendMessage(ctx.actor.chatId, result.text, {
      inlineKeyboard: [
        [
          { text: '✅ Confirmar', callback_data: `${CONFIRM_PREFIX}${result.token}` },
          { text: '❌ Cancelar', callback_data: `${CANCEL_PREFIX}${result.token}` },
        ],
      ],
    });
    return;
  }

  await ctx.telegram.sendMessage(ctx.actor.chatId, result.text);
}

type Reply = { kind: 'text'; text: string } | { kind: 'confirm'; text: string; token: string };

async function buildReply(message: TelegramMessage, ctx: HandlerContext): Promise<Reply> {
  const text = message.text?.trim();

  if (text?.startsWith('/')) {
    return { kind: 'text', text: await handleCommand(text, ctx) };
  }

  if (text) {
    try {
      return await runAgent({ chatId: ctx.actor.chatId, from: message.from, text }, ctx);
    } catch (error) {
      return { kind: 'text', text: describeError(error) };
    }
  }

  const voice = message.voice ?? message.audio;
  if (voice) {
    return {
      kind: 'text',
      text: `Audio recibido (${voice.duration} s). La transcripción entra en la Fase 3.`,
    };
  }

  return { kind: 'text', text: 'Por ahora solo entiendo texto y audio.' };
}

async function handleCallback(query: TelegramCallbackQuery, ctx: HandlerContext): Promise<void> {
  const data = query.data ?? '';

  // Responder cuanto antes: si no, Telegram deja el botón girando 30 segundos.
  await ctx.telegram.answerCallbackQuery(query.id).catch(() => {});

  const isConfirm = data.startsWith(CONFIRM_PREFIX);
  const isCancel = data.startsWith(CANCEL_PREFIX);
  if (!isConfirm && !isCancel) return;

  const token = data.slice((isConfirm ? CONFIRM_PREFIX : CANCEL_PREFIX).length);
  const pending = await takePending(ctx.env, ctx.actor.chatId, token);

  if (!pending) {
    await ctx.telegram.sendMessage(
      ctx.actor.chatId,
      'Esa confirmación ha caducado o ya se usó. Pídemelo otra vez si sigue haciendo falta.',
    );
    return;
  }

  if (isCancel) {
    await ctx.telegram.sendMessage(ctx.actor.chatId, 'Cancelado, no he tocado nada.');
    return;
  }

  try {
    const outcome = await executeConfirmed(
      pending.toolName,
      pending.args,
      { chatId: ctx.actor.chatId, from: query.from },
      ctx,
    );
    await ctx.telegram.sendMessage(ctx.actor.chatId, outcome);
  } catch (error) {
    await ctx.telegram.sendMessage(ctx.actor.chatId, describeError(error));
  }
}

/** Traduce excepciones a algo que una persona pueda leer en un chat. */
function describeError(error: unknown): string {
  if (error instanceof LLMError) {
    console.error(`llm_error kind=${error.kind} status=${error.status ?? '-'}`, error.message);
    return error.userMessage;
  }
  if (error instanceof ConfigMissingError) {
    console.error('config incompleta:', error.message);
    return 'Me falta la configuración de la base de datos. Revisa los secrets de Supabase.';
  }
  if (error instanceof DbError) {
    console.error('db_error:', error.message);
    return 'No he podido hablar con la base de datos. Lo tienes en los logs.';
  }
  throw error;
}

async function handleCommand(text: string, ctx: HandlerContext): Promise<string> {
  // "/reset@mi_bot arg" → "reset"
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  switch (command) {
    case 'start':
      return [
        'Jarvis en línea.',
        '',
        'Escríbeme lo que quieras. Puedo apuntarte tareas, decirte qué tienes pendiente y recordar cosas sobre ti para conversaciones futuras.',
        '',
        'Prueba con algo como "recuérdame llamar al banco mañana a las 10".',
        '',
        '/help para ver los comandos.',
      ].join('\n');

    case 'help':
      return [
        'Comandos:',
        '',
        '/ping — estado y configuración',
        '/reset — olvidar la conversación reciente',
        '/help — esto',
        '',
        'Para todo lo demás, escríbeme normal.',
        'Lo que recuerdo de ti a largo plazo no se borra con /reset.',
      ].join('\n');

    case 'reset':
      await clearHistory(ctx.env, ctx.actor.chatId);
      return 'Hecho, he olvidado la conversación reciente. Lo que sé de ti sigue ahí.';

    case 'ping':
      return [
        'pong',
        '',
        `chat: ${ctx.actor.chatId}`,
        `modelo: ${ctx.config.llmModel}`,
        `proveedor: ${ctx.config.llmProvider}`,
        `zona horaria: ${ctx.config.defaultTimezone}`,
      ].join('\n');

    default:
      return `No conozco el comando /${command}. Prueba /help.`;
  }
}

/** Telegram descarta el indicador "escribiendo…" a los 5 s, y el modelo tarda más. */
const TYPING_REFRESH_MS = 4_000;

async function withTyping<T>(ctx: HandlerContext, work: () => Promise<T>): Promise<T> {
  const ping = () => {
    ctx.telegram.sendChatAction(ctx.actor.chatId, 'typing').catch(() => {
      // Que falle el indicador no debe abortar la respuesta.
    });
  };

  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
