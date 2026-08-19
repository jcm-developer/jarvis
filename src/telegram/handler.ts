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
import { isTimeout, MAX_DOWNLOAD_BYTES, TelegramClient } from './client';

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
 * La descarga tenía 15 s partiendo de que las notas largas tardan más. No se
 * sostiene: Telegram manda las notas de voz en OGG/Opus a ~16 kbps, así que un
 * minuto de audio son unos 120 KB y bajan en menos de un segundo. Cuando la
 * descarga falla no es por el tamaño, es un pico puntual del servidor de
 * ficheros. Esperar 15 s a un fichero de 120 KB no lo arregla y deja al modelo
 * sin presupuesto; cortar antes y reintentar, sí.
 */
const MAX_DOWNLOAD_MS = 6_000;
const MAX_STT_MS = 10_000;

/**
 * Lo que hay que dejarle al agente después de transcribir para poder reintentar
 * la descarga. Es el mismo mínimo que `MIN_ROOM_FOR_CALL_MS` en agent.ts: por
 * debajo de eso el agente ni intenta llamar al modelo.
 */
const MIN_AGENT_MS = 4_000;

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

  const started = Date.now();
  let audio: ArrayBuffer;
  try {
    audio = await downloadVoice(voice, ctx);
  } catch (error) {
    const timedOut = isTimeout(error);
    // El fallo se registra con los mismos datos que el éxito. Antes solo se
    // volcaba la excepción, y un AbortError pelado no dice si se atascó getFile,
    // la descarga, o si simplemente ya no quedaba presupuesto al llegar aquí.
    console.error(
      JSON.stringify({
        event: 'voice_download_failed',
        timed_out: timedOut,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        audio_seconds: voice.duration,
        bytes: voice.file_size ?? null,
        elapsed_ms: Date.now() - started,
        budget_left_ms: ctx.deadline.remainingMs(),
      }),
    );
    return {
      kind: 'text',
      text: timedOut
        ? 'Telegram ha tardado demasiado en darme ese audio. No es cosa de lo que dijeras ni de lo largo que fuera: vuelve a mandármelo tal cual.'
        : 'Telegram no me ha dejado descargar ese audio. Vuelve a mandármelo.',
    };
  }
  const downloaded = Date.now();

  try {
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
    // Lo que no sea de transcripción sube: este catch llegó a tragarse cualquier
    // fallo del STT y contestaba que no se había podido descargar el audio,
    // mandando a mirar donde no era.
    throw error;
  }
}

/**
 * Descarga con un reintento.
 *
 * Es el arreglo del "unas veces sí y otras no": el fallo típico no es el audio,
 * es un pico puntual del servidor de ficheros de Telegram, y al segundo intento
 * suele responder al instante. Solo se reintenta si después queda presupuesto
 * para transcribir y contestar; si no, mejor un mensaje ahora que quedarse a
 * medias cuando Cloudflare corte.
 */
async function downloadVoice(voice: VoiceLike, ctx: HandlerContext): Promise<ArrayBuffer> {
  try {
    return await ctx.telegram.downloadFile(voice.file_id, ctx.deadline.budgetFor(MAX_DOWNLOAD_MS));
  } catch (error) {
    if (!ctx.deadline.hasRoomFor(MAX_DOWNLOAD_MS + MAX_STT_MS + MIN_AGENT_MS)) throw error;
    console.warn('reintentando la descarga del audio:', error);
    return ctx.telegram.downloadFile(voice.file_id, ctx.deadline.budgetFor(MAX_DOWNLOAD_MS));
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
        'También escribo yo: por la mañana con lo que tienes ese día, y cuando algo está a punto de vencer.',
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
        `briefing: ${String(ctx.config.briefingHour).padStart(2, '0')}:00 hora local`,
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
