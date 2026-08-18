import { ConfigMissingError, executeConfirmed, forgetConversation, runAgent } from '../agent';
import type { Config } from '../config';
import { DbError } from '../db/client';
import type { Deadline } from '../lib/deadline';
import { DeadlineExceededError } from '../lib/deadline';
import { LLMError } from '../llm/provider';
import { createTranscriber } from '../stt';
import { SttError } from '../stt/provider';
import { takePending } from '../tools/pending';
import type { Env, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from '../types';
import type { Actor } from './guard';
import { MAX_DOWNLOAD_BYTES, TelegramClient } from './client';

export interface HandlerContext {
  env: Env;
  config: Config;
  telegram: TelegramClient;
  actor: Actor;
  deadline: Deadline;
}

/**
 * Topes por paso, acotados además por el presupuesto global.
 *
 * La descarga se lleva la porción grande porque medido en producción es el paso
 * más lento y el que peor escala: el servidor de ficheros de Telegram tarda
 * varios segundos con notas de voz de más de 15 s.
 */
const MAX_DOWNLOAD_MS = 15_000;
const MAX_STT_MS = 10_000;

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

  const voice = message.voice ?? message.audio;
  if (!text && !voice) {
    return { kind: 'text', text: 'Por ahora solo entiendo texto y audio.' };
  }

  try {
    if (text?.startsWith('/')) {
      return { kind: 'text', text: await handleCommand(text, message, ctx) };
    }

    const prompt = text ?? (await transcribeVoice(voice!, ctx));
    // La transcripción devuelve un Reply ya formateado si falla.
    if (typeof prompt !== 'string') return prompt;

    // El historial guarda de dónde salió el mensaje: cuando el agente entiende
    // algo raro, lo primero que se mira es si venía de un audio.
    const origin = text
      ? { source: 'text' as const }
      : { source: 'voice' as const, transcriptRaw: prompt };

    return await runAgent(
      { chatId: ctx.actor.chatId, from: message.from, text: prompt, ...origin },
      ctx,
    );
  } catch (error) {
    return { kind: 'text', text: describeError(error) };
  }
}

type VoiceLike = { file_id: string; duration: number; mime_type?: string; file_size?: number };

/** Devuelve el texto transcrito, o un Reply ya formateado si algo falla. */
async function transcribeVoice(voice: VoiceLike, ctx: HandlerContext): Promise<string | Reply> {
  if ((voice.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    return { kind: 'text', text: new SttError('too_large', 'supera el límite').userMessage };
  }

  try {
    const started = Date.now();
    const audio = await ctx.telegram.downloadFile(
      voice.file_id,
      ctx.deadline.budgetFor(MAX_DOWNLOAD_MS),
    );
    const downloaded = Date.now();

    const transcriber = createTranscriber(ctx.env, ctx.config);
    const transcript = await transcriber.transcribe(audio, voice.mime_type ?? 'audio/ogg', {
      timeoutMs: ctx.deadline.budgetFor(MAX_STT_MS),
    });

    // Desglosado por etapas: cuando algo se pasa de presupuesto, esto dice dónde.
    console.info(
      JSON.stringify({
        event: 'transcription',
        provider: transcriber.name,
        audio_seconds: voice.duration,
        bytes: audio.byteLength,
        chars: transcript.length,
        download_ms: downloaded - started,
        stt_ms: Date.now() - downloaded,
        budget_left_ms: ctx.deadline.remainingMs(),
      }),
    );

    if (!transcript) {
      // Nunca mandar una cadena vacía al modelo: respondería cualquier cosa.
      return { kind: 'text', text: new SttError('empty', 'sin texto').userMessage };
    }
    return transcript;
  } catch (error) {
    if (error instanceof SttError) {
      console.error(`stt_error kind=${error.kind}`, error.message);
      return { kind: 'text', text: error.userMessage };
    }
    console.error('fallo descargando el audio:', error);
    // Casi siempre es un timeout con audios largos: el plan free de Cloudflare da
    // 30 s en total y el servidor de ficheros de Telegram se lleva buena parte.
    // Decirle qué hacer es más útil que informarle de que algo falló.
    return {
      kind: 'text',
      text: 'No he podido descargar ese audio a tiempo. Suele pasar con los largos: mándamelo en trozos de menos de 20 segundos.',
    };
  }
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
      pending.calls,
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
  if (error instanceof DeadlineExceededError) {
    console.warn('presupuesto agotado antes de terminar');
    return error.userMessage;
  }
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

async function handleCommand(
  text: string,
  message: TelegramMessage,
  ctx: HandlerContext,
): Promise<string> {
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
      await forgetConversation({ chatId: ctx.actor.chatId, from: message.from }, ctx);
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
