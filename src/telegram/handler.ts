import type { Config } from '../config';
import type { Env, TelegramMessage, TelegramUpdate } from '../types';
import type { Actor } from './guard';
import { TelegramClient } from './client';

export interface HandlerContext {
  env: Env;
  config: Config;
  telegram: TelegramClient;
  actor: Actor;
}

/**
 * Punto de entrada del procesamiento en background.
 *
 * Fase 0: responde para verificar el circuito completo (webhook → guard → respuesta).
 * A partir de la Fase 1 esto delega en el agente.
 */
export async function handleUpdate(update: TelegramUpdate, ctx: HandlerContext): Promise<void> {
  if (update.callback_query) {
    // Los botones inline llegan aquí. Se usan desde la Fase 2 (confirmaciones).
    await ctx.telegram.answerCallbackQuery(update.callback_query.id, 'Aún no disponible');
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  await ctx.telegram.sendChatAction(ctx.actor.chatId, 'typing');

  const reply = await buildReply(message, ctx);
  await ctx.telegram.sendMessage(ctx.actor.chatId, reply);
}

async function buildReply(message: TelegramMessage, ctx: HandlerContext): Promise<string> {
  const text = message.text?.trim();

  if (text?.startsWith('/')) {
    return handleCommand(text, ctx);
  }

  if (text) {
    return `Recibido: "${text}"\n\nAún no razono — eso llega en la Fase 1. De momento confirmo que el circuito funciona.`;
  }

  const voice = message.voice ?? message.audio;
  if (voice) {
    return `Audio recibido (${voice.duration} s). La transcripción entra en la Fase 3.`;
  }

  return 'Por ahora solo entiendo texto y audio.';
}

function handleCommand(text: string, ctx: HandlerContext): string {
  // "/tasks@mi_bot arg" → "tasks"
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  switch (command) {
    case 'start':
      return [
        'Jarvis en línea.',
        '',
        'Estás en la lista de autorizados, así que el circuito funciona de extremo a extremo.',
        'Ahora mismo solo hago eco: el razonamiento y las tareas llegan en las siguientes fases.',
        '',
        'Escribe /help para ver qué hay disponible.',
      ].join('\n');

    case 'help':
      return [
        'Comandos disponibles:',
        '',
        '/start — comprobar que estoy vivo',
        '/help — esta ayuda',
        '/ping — latencia y estado',
        '',
        'Próximamente: conversación real (Fase 1), tareas (Fase 2), audios (Fase 3).',
      ].join('\n');

    case 'ping':
      return [
        'pong',
        '',
        `chat: ${ctx.actor.chatId}`,
        `usuario: ${ctx.actor.telegramUserId}`,
        `zona horaria: ${ctx.config.defaultTimezone}`,
      ].join('\n');

    default:
      return `No conozco el comando /${command}. Prueba /help.`;
  }
}
