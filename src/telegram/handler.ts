import {
  createDb,
  executeConfirmed,
  forgetConversation,
  runAgent,
  snoozeReminder,
} from '../agent';
import type { Config } from '../config';
import { describeError } from '../core/errors';
import type { Principal } from '../core/principal';
import { runPunchCommand } from '../punch';
import type { Deadline } from '../lib/deadline';
import { seesImages } from '../llm';
import { createTranscriber } from '../stt';
import { SttError } from '../stt/provider';
import { takePending } from '../tools/pending';
import { parseSnooze } from '../tools/snooze';
import { runPageDump, runSelfTest } from '../selftest';
import type {
  Env,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
} from '../types';
import type { Actor } from './guard';
import { isTimeout, MAX_DOWNLOAD_BYTES, TelegramClient } from './client';
import { PHOTO_MIME_TYPE, pickPhotoSize } from './photos';

export interface HandlerContext {
  env: Env;
  config: Config;
  telegram: TelegramClient;
  actor: Actor;
  deadline: Deadline;
}

/**
 * Per-step caps, further bounded by the global budget.
 *
 * The download used to get 15 s on the assumption that long notes take longer. That does
 * not hold: Telegram sends voice notes as OGG/Opus at ~16 kbps, so a minute of audio is
 * about 120 KB and comes down in under a second. When the download fails it is not about
 * size, it is a momentary spike on the file server. Waiting 15 s for a 120 KB file does
 * not fix that and leaves the model without budget; cutting sooner and retrying does.
 */
const MAX_DOWNLOAD_MS = 6_000;
const MAX_STT_MS = 10_000;

/**
 * The photo's own caps.
 *
 * A little more time to come down than a voice note —Telegram's 1280 px version is
 * 150-300 KB against the ~120 KB of a minute of audio— and clearly more reserved for what
 * comes after: a call carrying an image is slower than a text one, and a photo with
 * several things in it spends a second iteration wording the confirmation.
 */
const MAX_PHOTO_DOWNLOAD_MS = 8_000;
const MIN_PHOTO_ANSWER_MS = 10_000;

/**
 * What has to be left for the agent after transcribing in order to afford retrying the
 * download. Same minimum as `MIN_ROOM_FOR_CALL_MS` in agent.ts: below that the agent
 * does not even try to call the model.
 */
const MIN_AGENT_MS = 4_000;

const CONFIRM_PREFIX = 'ok:';
const CANCEL_PREFIX = 'no:';

/**
 * Telegram's user object, cut down to what the core actually reads.
 *
 * This is the whole boundary in four lines. `resolveIdentity` wants an id, a username and
 * a first name; `is_bot` and `language_code` are wire noise it has no business seeing.
 * Converting here and not there is what lets a second entry point exist without forging a
 * `TelegramUser` to get past the types.
 */
function asPrincipal(user: TelegramUser | undefined): Principal | undefined {
  if (!user) return undefined;
  return { id: user.id, username: user.username, firstName: user.first_name };
}

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
  const photo = message.photo?.length ? message.photo : undefined;
  if (!text && !voice && !photo) {
    return { kind: 'text', text: 'Por ahora solo entiendo texto, audio y fotos.' };
  }

  try {
    if (text?.startsWith('/')) {
      return { kind: 'text', text: await handleCommand(text, message, ctx) };
    }

    // A photo carries its text in `caption`, not in `text`, so it is checked before the
    // audio branch and never mixed with it: a message is one thing or the other.
    if (photo) return await replyToPhoto(photo, message, ctx);

    const prompt = text ?? (await transcribeVoice(voice!, ctx));
    // Transcription returns an already formatted Reply when it fails.
    if (typeof prompt !== 'string') return prompt;

    // The history records where the message came from: when the agent understands
    // something odd, the first thing to check is whether it came from audio.
    const origin = text
      ? { source: 'text' as const }
      : { source: 'voice' as const, transcriptRaw: prompt };

    return await runAgent(
      { chatId: ctx.actor.chatId, from: asPrincipal(message.from), text: prompt, ...origin },
      ctx,
    );
  } catch (error) {
    return { kind: 'text', text: describeError(error) };
  }
}

/**
 * A photo, from Telegram to the model.
 *
 * The whole phase in one function: pick which of Telegram's versions to download, bring
 * it down inside the budget, and hand it to the agent with the caption as the message's
 * text. What comes out is not a reply yet: it is a confirmation, because with a photo
 * nothing gets written before the user reads what was understood (see agent.ts).
 */
async function replyToPhoto(
  sizes: TelegramPhotoSize[],
  message: TelegramMessage,
  ctx: HandlerContext,
): Promise<Reply> {
  // Asked before downloading anything: with a text-only model the photo would come down,
  // spend the budget, and come back as a 400 from the provider.
  if (!seesImages(ctx.config)) {
    return {
      kind: 'text',
      text:
        `No puedo ver fotos con el modelo que tengo puesto (${ctx.config.llmModel}). ` +
        'Cuéntamelo por escrito y te lo apunto igual.',
    };
  }

  const size = pickPhotoSize(sizes);
  if (!size) {
    return { kind: 'text', text: 'Esa foto me ha llegado vacía. Vuelve a mandármela.' };
  }

  const started = Date.now();
  let bytes: ArrayBuffer;
  try {
    bytes = await downloadFileWithRetry(
      size.file_id,
      MAX_PHOTO_DOWNLOAD_MS,
      MIN_PHOTO_ANSWER_MS,
      ctx,
    );
  } catch (error) {
    const timedOut = isTimeout(error);
    // Same fields as the audio failure, and for the same reason: a bare AbortError does
    // not say whether getFile hung, the download did, or there was no budget left.
    console.error(
      JSON.stringify({
        event: 'photo_download_failed',
        timed_out: timedOut,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        width: size.width,
        height: size.height,
        bytes: size.file_size ?? null,
        elapsed_ms: Date.now() - started,
        budget_left_ms: ctx.deadline.remainingMs(),
      }),
    );
    return {
      kind: 'text',
      text: timedOut
        ? 'Telegram ha tardado demasiado en darme esa foto. Vuelve a mandármela.'
        : 'Telegram no me ha dejado descargar esa foto. Vuelve a mandármela.',
    };
  }

  console.info(
    JSON.stringify({
      event: 'photo_received',
      width: size.width,
      height: size.height,
      bytes: bytes.byteLength,
      has_caption: Boolean(message.caption?.trim()),
      download_ms: Date.now() - started,
      budget_left_ms: ctx.deadline.remainingMs(),
    }),
  );

  return runAgent(
    {
      chatId: ctx.actor.chatId,
      from: asPrincipal(message.from),
      // The caption is user text and does feed the date guardrails. Empty when there is
      // none, which is precisely the case the confirmation exists for.
      text: message.caption?.trim() ?? '',
      source: 'photo',
      image: { mimeType: PHOTO_MIME_TYPE, data: bytes, ref: size.file_id },
    },
    ctx,
  );
}

type VoiceLike = { file_id: string; duration: number; mime_type?: string; file_size?: number };

/** Returns the transcribed text, or an already formatted Reply when something fails. */
async function transcribeVoice(voice: VoiceLike, ctx: HandlerContext): Promise<string | Reply> {
  if ((voice.file_size ?? 0) > MAX_DOWNLOAD_BYTES) {
    return { kind: 'text', text: new SttError('too_large', 'supera el límite').userMessage };
  }

  const started = Date.now();
  let audio: ArrayBuffer;
  try {
    audio = await downloadFileWithRetry(
      voice.file_id,
      MAX_DOWNLOAD_MS,
      MAX_STT_MS + MIN_AGENT_MS,
      ctx,
    );
  } catch (error) {
    const timedOut = isTimeout(error);
    // The failure is logged with the same data as the success. Only the exception used
    // to be dumped, and a bare AbortError does not say whether getFile got stuck, the
    // download did, or there was simply no budget left by the time we got here.
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

    // Broken down by stage: when something blows the budget, this says where.
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
      // Never send an empty string to the model: it would answer anything.
      return { kind: 'text', text: new SttError('empty', 'sin texto').userMessage };
    }
    return transcript;
  } catch (error) {
    if (error instanceof SttError) {
      console.error(`stt_error kind=${error.kind}`, error.message);
      return { kind: 'text', text: error.userMessage };
    }
    // Anything that is not about transcription propagates: this catch once swallowed
    // every STT failure and answered that the audio could not be downloaded, sending
    // people to look in the wrong place.
    throw error;
  }
}

/**
 * Download with one retry.
 *
 * This is the fix for the "sometimes it works and sometimes it does not": the typical
 * failure is not the file, it is a momentary spike on Telegram's file server, and the
 * second attempt usually answers instantly. It only retries when there is budget left
 * afterwards to do something with what comes down; otherwise a message now beats being
 * cut off halfway by Cloudflare.
 *
 * `reserveMs` is what the rest of the turn needs: transcribing and answering for a voice
 * note, reading the image and answering for a photo.
 */
async function downloadFileWithRetry(
  fileId: string,
  maxMs: number,
  reserveMs: number,
  ctx: HandlerContext,
): Promise<ArrayBuffer> {
  try {
    return await ctx.telegram.downloadFile(fileId, ctx.deadline.budgetFor(maxMs));
  } catch (error) {
    if (!ctx.deadline.hasRoomFor(maxMs + reserveMs)) throw error;
    console.warn('reintentando la descarga del fichero:', error);
    return ctx.telegram.downloadFile(fileId, ctx.deadline.budgetFor(maxMs));
  }
}

async function handleCallback(query: TelegramCallbackQuery, ctx: HandlerContext): Promise<void> {
  const data = query.data ?? '';

  // Answer as soon as possible: otherwise Telegram leaves the button spinning for 30 s.
  await ctx.telegram.answerCallbackQuery(query.id).catch(() => {});

  // Postponing comes first because it is the cheap path: no pending call in KV, no
  // model, one patch. The confirmation flow below is the one that needs a token.
  const snooze = parseSnooze(data);
  if (snooze) {
    try {
      const outcome = await snoozeReminder(
        { chatId: ctx.actor.chatId, from: asPrincipal(query.from), ...snooze },
        ctx,
      );
      await ctx.telegram.sendMessage(ctx.actor.chatId, outcome);
    } catch (error) {
      await ctx.telegram.sendMessage(ctx.actor.chatId, describeError(error));
    }
    return;
  }

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
      pending,
      { chatId: ctx.actor.chatId, from: asPrincipal(query.from) },
      ctx,
    );
    await ctx.telegram.sendMessage(ctx.actor.chatId, outcome);
  } catch (error) {
    await ctx.telegram.sendMessage(ctx.actor.chatId, describeError(error));
  }
}

async function handleCommand(
  text: string,
  message: TelegramMessage,
  ctx: HandlerContext,
): Promise<string> {
  // "/reset@my_bot arg" -> "reset"
  const command = text.split(/\s+/)[0]!.slice(1).split('@')[0]!.toLowerCase();

  switch (command) {
    case 'start':
      return [
        'Jarvis en línea.',
        '',
        'Escríbeme lo que quieras. Puedo apuntarte tareas, decirte qué tienes pendiente y recordar cosas sobre ti para conversaciones futuras.',
        '',
        'Prueba con algo como "recuérdame llamar al banco mañana a las 10".',
        ...(seesImages(ctx.config)
          ? [
              '',
              'También puedes mandarme una foto: una carta del colegio, un cartel, la pizarra de una reunión. Saco lo que haya que apuntar y te lo enseño antes de guardar nada.',
            ]
          : []),
        '',
        '/help para ver los comandos.',
      ].join('\n');

    case 'help':
      return [
        'Comandos:',
        '',
        '/ping — estado y configuración',
        '/test — mide qué va lento: base de datos, ficharweb y el modelo',
        '/test html — enseña la página de ficharweb tal como llega',
        '/punch — cómo va el fichaje de hoy, sin fichar nada',
        '/punch in | lunch | back | out — ficha eso ahora',
        '/reset — olvidar la conversación reciente',
        '/help — esto',
        '',
        'También escribo yo: por la mañana con lo que tienes ese día, cuando algo está a punto de vencer y un rato antes de cada cita.',
        'Los avisos llevan botones para posponerlos sin escribir nada.',
        '',
        ...(seesImages(ctx.config)
          ? ['Con una foto saco lo que haya que apuntar, y te lo enseño antes de guardarlo.', '']
          : []),
        'Para todo lo demás, escríbeme normal.',
        'Lo que recuerdo de ti a largo plazo no se borra con /reset.',
      ].join('\n');

    case 'reset':
      await forgetConversation({ chatId: ctx.actor.chatId, from: asPrincipal(message.from) }, ctx);
      return 'Hecho, he olvidado la conversación reciente. Lo que sé de ti sigue ahí.';

    case 'test': {
      // `/test html` dumps the timeclock page instead of measuring: when the parsing is
      // what is broken, the page itself is the only useful answer.
      const html = /\bhtml\b[ ]*(.*)$/i.exec(text.trim());
      if (html) {
        const at = html[1]!.trim();
        return withTyping(ctx, () =>
          runPageDump({
            env: ctx.env,
            config: ctx.config,
            db: createDb(ctx.env),
            deadline: ctx.deadline,
            timezone: ctx.config.defaultTimezone,
          }, at || undefined),
        );
      }
      return withTyping(ctx, () =>
        runSelfTest({
          env: ctx.env,
          config: ctx.config,
          db: createDb(ctx.env),
          deadline: ctx.deadline,
          timezone: ctx.config.defaultTimezone,
        }),
      );
    }

    case 'punch': {
      // Everything after the command word, so "/punch lunch" arrives with its argument.
      const arg = text.trim().slice(text.trim().indexOf(command) + command.length).trim();
      return withTyping(ctx, () =>
        runPunchCommand(
          {
            env: ctx.env,
            config: ctx.config,
            deadline: ctx.deadline,
            chatId: ctx.actor.chatId,
            from: asPrincipal(message.from),
          },
          arg || undefined,
        ),
      );
    }

    case 'ping':
      return [
        'pong',
        '',
        `chat: ${ctx.actor.chatId}`,
        `modelo: ${ctx.config.llmModel}`,
        `proveedor: ${ctx.config.llmProvider}`,
        `zona horaria: ${ctx.config.defaultTimezone}`,
        `fotos: ${seesImages(ctx.config) ? 'sí' : 'no, el modelo no las lee'}`,
        `briefing: ${String(ctx.config.briefingHour).padStart(2, '0')}:00 hora local`,
        `aviso de citas: ${
          ctx.config.eventAlertMinutes > 0
            ? `${ctx.config.eventAlertMinutes} min antes`
            : 'desactivado'
        }`,
      ].join('\n');

    default:
      return `No conozco el comando /${command}. Prueba /help.`;
  }
}

/** Telegram drops the "typing…" indicator after 5 s, and the model takes longer. */
const TYPING_REFRESH_MS = 4_000;

async function withTyping<T>(ctx: HandlerContext, work: () => Promise<T>): Promise<T> {
  const ping = () => {
    ctx.telegram.sendChatAction(ctx.actor.chatId, 'typing').catch(() => {
      // A failing indicator must not abort the reply.
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
