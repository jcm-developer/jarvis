import { runAgent } from '../agent';
import type { Config } from '../config';
import { LLMError } from '../llm/provider';
import { clearHistory } from '../memory/history';
import type { Env, TelegramMessage, TelegramUpdate } from '../types';
import type { Actor } from './guard';
import { TelegramClient } from './client';

export interface HandlerContext {
  env: Env;
  config: Config;
  telegram: TelegramClient;
  actor: Actor;
}

export async function handleUpdate(update: TelegramUpdate, ctx: HandlerContext): Promise<void> {
  if (update.callback_query) {
    // Los botones inline se usan desde la Fase 2 (confirmaciones).
    await ctx.telegram.answerCallbackQuery(update.callback_query.id, 'Aún no disponible');
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const reply = await withTyping(ctx, () => buildReply(message, ctx));
  await ctx.telegram.sendMessage(ctx.actor.chatId, reply);
}

async function buildReply(message: TelegramMessage, ctx: HandlerContext): Promise<string> {
  const text = message.text?.trim();

  if (text?.startsWith('/')) {
    return handleCommand(text, ctx);
  }

  if (text) {
    try {
      return await runAgent({ chatId: ctx.actor.chatId, text }, ctx);
    } catch (error) {
      // Los fallos del modelo son esperables (cuota, timeout, clave). Se traducen
      // a algo legible en vez de dejar que suban y disparen el mensaje genérico.
      if (error instanceof LLMError) {
        console.error(`llm_error kind=${error.kind} status=${error.status ?? '-'}`, error.message);
        return error.userMessage;
      }
      throw error;
    }
  }

  const voice = message.voice ?? message.audio;
  if (voice) {
    return `Audio recibido (${voice.duration} s). La transcripción entra en la Fase 3.`;
  }

  return 'Por ahora solo entiendo texto y audio.';
}

async function handleCommand(text: string, ctx: HandlerContext): Promise<string> {
  // "/reset@mi_bot arg" → "reset"
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  switch (command) {
    case 'start':
      return [
        'Jarvis en línea.',
        '',
        'Escríbeme lo que quieras y te contesto. Recuerdo los últimos mensajes de la',
        'conversación, así que puedes seguir el hilo sin repetir contexto.',
        '',
        '/help para ver los comandos.',
      ].join('\n');

    case 'help':
      return [
        'Comandos:',
        '',
        '/ping — estado y latencia',
        '/reset — olvidar la conversación y empezar de cero',
        '/help — esto',
        '',
        'Para todo lo demás, escríbeme normal.',
        'Próximamente: tareas (Fase 2) y audios (Fase 3).',
      ].join('\n');

    case 'reset':
      await clearHistory(ctx.env, ctx.actor.chatId);
      return 'Hecho, he olvidado la conversación.';

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
