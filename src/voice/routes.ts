import type { Hono } from 'hono';

import { ConfigError, loadConfig, type Config } from '../config';
import { describeError } from '../core/errors';
import type { Principal } from '../core/principal';
import { timingSafeEqual } from '../core/secret';
import { Deadline, DeadlineExceededError } from '../lib/deadline';
import { SttError } from '../stt/provider';
import type { Env } from '../types';
import {
  runVoiceConfirm,
  runVoiceText,
  runVoiceTurn,
  type VoiceContext,
  type VoiceOutcome,
} from './handler';
import { APP_ICON_192, APP_ICON_512 } from './app-icons';
import { VOICE_TEST_PAGE } from './page';

/**
 * Total budget of a spoken turn.
 *
 * Longer than the webhook's 27 s and picked for a completely different reason. There the
 * number is imposed: `waitUntil` gets cancelled. Here the client is a browser holding the
 * connection open and Cloudflare imposes nothing, so the cap is a product decision — how
 * long somebody stands in front of a microphone before deciding it is broken. Thirty
 * seconds fits a turn with tool calls and is short enough that a hung provider becomes an
 * error message instead of a wait.
 */
const VOICE_BUDGET_MS = 30_000;

/**
 * The upload cap, well under what anything else would enforce.
 *
 * Cloudflare would take 100 MB and OpenAI's transcription 25 MB. Five is about three
 * minutes of Opus, far more than anybody says into a push-to-talk button, and the point of
 * the low number is that a bug in the browser —a recorder that never stops— gets a 413
 * instead of a bill.
 */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** A typed turn is a person at a keyboard, not a paste of a novel. */
const MAX_TEXT_CHARS = 2_000;

/**
 * What the browser is allowed to send.
 *
 * `webm` and `mp4` lead the list because they are what `MediaRecorder` actually produces —
 * Opus inside WebM on Chrome and Firefox, AAC inside MP4 on Safari — and OpenAI's
 * transcription endpoint documents both among `mp3, mp4, mpeg, mpga, m4a, wav, webm`.
 * Nothing is converted in the Worker: transcoding audio in an isolate with a 10 ms CPU
 * budget is not something you do twice.
 */
const ACCEPTED_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/m4a',
  'audio/x-m4a',
]);

/**
 * Registers the voice channel.
 *
 * One honest note about `VOICE_ENABLED`: a Worker has no environment at module scope, so
 * the routes cannot literally be left unregistered. The switch is read per request and the
 * handlers answer with Hono's own 404 before touching anything else. From outside that is
 * indistinguishable from a route that does not exist: same status, same body, no header
 * and no timing that says otherwise.
 */
export function registerVoiceRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/voice/test', (c) => {
    const config = enabledConfig(c.env);
    if (!config) return c.notFound();
    // The page carries no secret. The token is typed in by a person and kept in that
    // browser's localStorage, so serving this to a stranger leaks the shape of the API and
    // nothing else: with no token, /voice answers 401.
    return c.html(VOICE_TEST_PAGE);
  });

  app.post('/voice', async (c) => {
    const config = enabledConfig(c.env);
    if (!config) return c.notFound();
    if (!authorized(c.req.raw, c.env)) return unauthorized();

    const type = baseContentType(c.req.header('content-type'));

    // A typed turn. Not a feature of the channel, a control: it is the only way to tell a
    // truncated recording from a model that ignored the message, and both fail identically
    // from the outside.
    if (type === 'application/json') {
      const ctx = contextFor(c.env, config);
      let body: { text?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return problem(400, 'El cuerpo no era JSON válido.');
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return problem(400, 'Falta el campo "text".');
      if (text.length > MAX_TEXT_CHARS) {
        return problem(413, `Ese mensaje tiene ${text.length} caracteres y el tope son ${MAX_TEXT_CHARS}.`);
      }
      try {
        const outcome = await runVoiceText(text, ctx);
        logTurn(outcome, 0, 'text', ctx);
        return respond(outcome);
      } catch (error) {
        return failure(error, ctx, text);
      }
    }

    if (!ACCEPTED_TYPES.has(type)) {
      return problem(415, `Formato no soportado: ${type || 'sin Content-Type'}.`);
    }

    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) return problem(400, 'El cuerpo venía vacío.');
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      return problem(
        413,
        `Ese audio pesa ${Math.round(audio.byteLength / 1024)} KB y el tope son 5 MB.`,
      );
    }

    const ctx = contextFor(c.env, config);
    try {
      const outcome = await runVoiceTurn(audio, type, ctx);
      logTurn(outcome, audio.byteLength, type, ctx);
      return respond(outcome);
    } catch (error) {
      return failure(error, ctx);
    }
  });

  app.post('/voice/confirm', async (c) => {
    const config = enabledConfig(c.env);
    if (!config) return c.notFound();
    if (!authorized(c.req.raw, c.env)) return unauthorized();

    let body: { token?: unknown; action?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return problem(400, 'El cuerpo no era JSON válido.');
    }

    const token = typeof body.token === 'string' ? body.token : '';
    const action = body.action === 'cancel' ? 'cancel' : 'ok';
    if (!token) return problem(400, 'Falta el token de confirmación.');

    const ctx = contextFor(c.env, config);
    try {
      const outcome = await runVoiceConfirm(token, action, ctx);
      logTurn(outcome, 0, 'confirm', ctx);
      return respond(outcome);
    } catch (error) {
      return failure(error, ctx);
    }
  });

  // The manifest and its two icons, the one place this page breaks its own no-assets rule.
  //
  // It has no choice: Chrome's "install as an app" dialog reads the icon from a web app
  // manifest, a manifest is fetched by URL and its icons are fetched by URL too, so none of
  // the three can be a data: URI inside the HTML. Without them the dialog draws the first
  // letter of the title in a grey box.
  //
  // They are still not files: the PNGs live as base64 in the bundle, which keeps the deploy
  // a single Worker and the icon impossible to get out of step with the logo.
  app.get('/voice/manifest.webmanifest', (c) => {
    if (!enabledConfig(c.env)) return c.notFound();
    const manifest = {
      name: 'Jarvis',
      short_name: 'Jarvis',
      // The page itself, so an installed window opens where the microphone is.
      start_url: '/voice/test',
      scope: '/voice/',
      display: 'standalone',
      background_color: '#08090b',
      theme_color: '#08090b',
      icons: [
        { src: '/voice/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        // `maskable` as well, and it is safe to claim rather than a box ticked: a masked icon
        // is cropped to the inner 80% and the sphere takes up 76% of the square, so the mask
        // only ever eats dark corners.
        { src: '/voice/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    };
    // Its own media type and not `application/json`: browsers are lenient about it today,
    // and this is a file whose whole job is to be recognised by somebody else's installer.
    return new Response(JSON.stringify(manifest), {
      headers: {
        'content-type': 'application/manifest+json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  });

  app.get('/voice/icon-192.png', (c) => (enabledConfig(c.env) ? icon(APP_ICON_192) : c.notFound()));
  app.get('/voice/icon-512.png', (c) => (enabledConfig(c.env) ? icon(APP_ICON_512) : c.notFound()));
}

/** One of the app icons, decoded out of the bundle. Immutable: it changes with a deploy. */
function icon(base64: string): Response {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

/** The config, or nothing when the channel is off or the environment is broken. */
function enabledConfig(env: Env): Config | null {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('voz: configuración inválida:', error.message);
      return null;
    }
    throw error;
  }
  return config.voiceEnabled ? config : null;
}

/**
 * Who the voice channel talks as.
 *
 * The first id of the whitelist, used as both the user id and the chat id — in a private
 * Telegram chat they are the same number. That is the whole trick behind the conversation
 * being continuous across channels: it resolves to the very same row in `conversations`
 * the bot writes to, with no new column, no migration and no second history.
 *
 * It carries no name, and the one consequence is bounded: on a cold KV cache
 * `resolveIdentity` would upsert `users.first_name` to null. Those two columns are written
 * and never read anywhere in the project, and the cache key is shared with Telegram —which
 * rewrites it on every message— so in practice it is not even reachable.
 */
function contextFor(env: Env, config: Config): VoiceContext {
  const id = [...config.allowedTelegramIds][0]!;
  const principal: Principal = { id };
  return { env, config, deadline: Deadline.in(VOICE_BUDGET_MS), chatId: id, principal };
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.VOICE_API_TOKEN;
  // No token configured means the door stays shut, even with the channel enabled. An
  // endpoint that spends money must not end up open because a secret was forgotten.
  if (!expected) return false;

  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return timingSafeEqual(header.slice('Bearer '.length), expected);
}

/**
 * The rule for what comes back, and it is not the usual one.
 *
 * Anything the user is meant to *hear* leaves as a 200 with audio, failures included: in
 * front of a microphone a 503 is silence, and silence is the worst possible outcome. Only
 * what a person cannot act on —a bad token, a format the browser should not have sent— is
 * an HTTP error, because those are for whoever is writing the client.
 */
function respond(outcome: VoiceOutcome): Response {
  const headers = new Headers({
    'Server-Timing': serverTiming(outcome),
    'X-Jarvis-Kind': outcome.kind,
    'X-Jarvis-Reply': encodeURIComponent(outcome.text),
    'Cache-Control': 'no-store',
  });
  if (outcome.transcript) {
    headers.set('X-Jarvis-Transcript', encodeURIComponent(outcome.transcript));
  }
  if (outcome.confirmToken) headers.set('X-Jarvis-Confirm-Token', outcome.confirmToken);
  if (outcome.notice) headers.set('X-Jarvis-Notice', encodeURIComponent(outcome.notice));

  if (outcome.speech) {
    headers.set('Content-Type', outcome.speech.mimeType);
    return new Response(outcome.speech.audio, { status: 200, headers });
  }

  // No audio: the reply survives as JSON and the page puts it on screen.
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({
      ok: true,
      kind: outcome.kind,
      transcript: outcome.transcript ?? null,
      text: outcome.text,
      notice: outcome.notice ?? null,
      timings: outcome.timings,
    }),
    { status: 200, headers },
  );
}

/**
 * A failure the user should hear about, wearing the same 200 as a normal turn.
 *
 * `transcript` travels when the caller knows it. It is not bookkeeping: the client shows
 * the conversation as text, and a failed turn that drops what was said is the one turn you
 * most want to read back.
 */
function failure(error: unknown, ctx: VoiceContext, transcript?: string): Response {
  let text: string;
  if (error instanceof DeadlineExceededError) {
    text = error.userMessage;
  } else if (error instanceof SttError) {
    console.error(`voice_stt_error kind=${error.kind}`, error.message);
    text = error.userMessage;
  } else {
    // describeError re-throws what it does not understand, and that is the point: a bug
    // has to reach the logs as an unhandled error instead of as a polite sentence.
    try {
      text = describeError(error);
    } catch (unhandled) {
      console.error('voz: fallo no controlado', unhandled);
      text = 'Algo ha fallado por dentro. Los detalles están en los logs.';
    }
  }

  return respond({
    kind: 'text',
    text,
    ...(transcript ? { transcript } : {}),
    notice: 'Sin audio: el turno se cortó antes de llegar a la voz.',
    timings: { total: VOICE_BUDGET_MS - ctx.deadline.remainingMs() },
  });
}

/** An error for whoever is writing the client, not for whoever is talking. */
function problem(status: 400 | 401 | 413 | 415, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function unauthorized(): Response {
  return problem(401, 'Token ausente o inválido.');
}

/** `audio/webm;codecs=opus` is a webm. The parameter is the browser's business. */
function baseContentType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

function serverTiming(outcome: VoiceOutcome): string {
  const parts: string[] = [];
  if (outcome.timings.stt !== undefined) parts.push(`stt;dur=${outcome.timings.stt}`);
  if (outcome.timings.agent !== undefined) parts.push(`agent;dur=${outcome.timings.agent}`);
  if (outcome.timings.tts !== undefined) parts.push(`tts;dur=${outcome.timings.tts}`);
  parts.push(`total;dur=${outcome.timings.total}`);
  return parts.join(', ');
}

/**
 * One line per turn, with the same shape as the `transcription` and `llm_call` events.
 *
 * This is the deliverable of the phase and not decoration: the question it answers is
 * which tramo the seconds go to, and a header the browser prints is only half of it — the
 * other half has to survive in `wrangler tail` after the tab is closed.
 */
function logTurn(outcome: VoiceOutcome, bytes: number, type: string, ctx: VoiceContext): void {
  console.info(
    JSON.stringify({
      event: 'voice_turn',
      kind: outcome.kind,
      content_type: type,
      bytes,
      stt_provider: ctx.config.sttProvider,
      tts_provider: ctx.config.ttsProvider,
      tts_model: ctx.config.ttsModel,
      chars_in: outcome.transcript?.length ?? 0,
      chars_out: outcome.text.length,
      spoken: Boolean(outcome.speech),
      stt_ms: outcome.timings.stt ?? null,
      agent_ms: outcome.timings.agent ?? null,
      tts_ms: outcome.timings.tts ?? null,
      total_ms: outcome.timings.total,
      budget_left_ms: ctx.deadline.remainingMs(),
    }),
  );
}
