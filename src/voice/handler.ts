import { runAgent, executeConfirmed } from '../agent';
import type { Config } from '../config';
import type { Principal } from '../core/principal';
import type { Deadline } from '../lib/deadline';
import { DeadlineExceededError } from '../lib/deadline';
import { createTranscriber } from '../stt';
import { SttError } from '../stt/provider';
import { takePending } from '../tools/pending';
import { createSynthesizer } from '../tts';
import { speakable, TtsError } from '../tts/provider';
import type { Env } from '../types';

/**
 * A turn of the voice channel: audio in, audio out.
 *
 * Two things separate this from `telegram/handler.ts` and both come from the same fact —
 * the client stays connected and waits for the answer:
 *
 * 1. **There is no `waitUntil` gymnastics.** Cloudflare puts no wall-clock limit on a
 *    request while its client is connected, so the whole turn is awaited and the reply is
 *    the response. The 27 s budget of the webhook exists because Telegram retries after
 *    ~4 s, and there is no Telegram here.
 * 2. **There is no dedupe write.** No `update_id` to claim means no KV write per turn, so
 *    this channel costs nothing against the 1,000/day the free plan allows — the resource
 *    ARCHITECTURE.md §11 flags as the tight one.
 */

/** Per-stage caps, further bounded by the global budget. */
const MAX_STT_MS = 12_000;
const MAX_TTS_MS = 12_000;

/**
 * What has to be left after transcribing for the agent to be worth starting. Same
 * minimum the agent enforces on itself before a model call.
 */
const MIN_AGENT_MS = 4_000;

export interface VoiceContext {
  env: Env;
  config: Config;
  deadline: Deadline;
  /** The Telegram chat this shares a conversation row with. See `voiceIdentity`. */
  chatId: number;
  principal: Principal;
}

export interface StageTimings {
  stt?: number;
  agent?: number;
  tts?: number;
  total: number;
}

export interface VoiceOutcome {
  kind: 'text' | 'confirm';
  /** What the user said, when this turn started with audio. */
  transcript?: string;
  /** The full reply, always. The audio may carry less of it — see `speakable`. */
  text: string;
  /** Present only on `kind: 'confirm'`. Consumed by POST /voice/confirm. */
  confirmToken?: string;
  /** Absent when synthesis failed. The text survives; the audio is the expendable half. */
  speech?: { audio: ArrayBuffer; mimeType: string };
  /** Something the user should read but not hear, e.g. why there is no audio. */
  notice?: string;
  timings: StageTimings;
}

/** A spoken turn, from bytes to bytes. */
export async function runVoiceTurn(
  audio: ArrayBuffer,
  mimeType: string,
  ctx: VoiceContext,
): Promise<VoiceOutcome> {
  const startedAt = Date.now();
  const timings: StageTimings = { total: 0 };

  const sttStart = Date.now();
  const transcriber = createTranscriber(ctx.env, ctx.config);
  const transcript = await transcriber.transcribe(audio, mimeType, {
    timeoutMs: ctx.deadline.budgetFor(MAX_STT_MS),
  });
  timings.stt = Date.now() - sttStart;

  if (!transcript) {
    // Never hand an empty string to the model: it would answer something, confidently.
    return finish(ctx, { kind: 'text', text: new SttError('empty', 'sin texto').userMessage }, timings, startedAt);
  }
  if (!ctx.deadline.hasRoomFor(MIN_AGENT_MS)) {
    throw new DeadlineExceededError();
  }

  const agentStart = Date.now();
  const result = await runAgent(
    {
      chatId: ctx.chatId,
      from: ctx.principal,
      text: transcript,
      // 'voice' and not a channel of its own: `messages.source` is constrained to
      // ('text','voice','photo') and this IS voice. A fourth value would need a migration,
      // and `saveTurns` swallows its errors — so the symptom of getting it wrong would be
      // a conversation that quietly stops being remembered.
      source: 'voice',
      transcriptRaw: transcript,
    },
    ctx,
  );
  timings.agent = Date.now() - agentStart;

  return finish(
    ctx,
    result.kind === 'confirm'
      ? { kind: 'confirm', text: result.text, confirmToken: result.token, transcript }
      : { kind: 'text', text: result.text, transcript },
    timings,
    startedAt,
  );
}

/**
 * The other half of a confirmation, with the button living in the browser instead of in
 * Telegram.
 *
 * Telegram is told nothing about any of this, deliberately: the voice channel borrows its
 * conversation row and nothing else. What it does share is the rule — nothing destructive
 * runs off a spoken sentence alone, there is always a press in between.
 */
export async function runVoiceConfirm(
  token: string,
  action: 'ok' | 'cancel',
  ctx: VoiceContext,
): Promise<VoiceOutcome> {
  const startedAt = Date.now();
  const timings: StageTimings = { total: 0 };

  const pending = await takePending(ctx.env, ctx.chatId, token);
  if (!pending) {
    return finish(
      ctx,
      {
        kind: 'text',
        text: 'Esa confirmación ha caducado o ya se usó. Pídemelo otra vez si sigue haciendo falta.',
      },
      timings,
      startedAt,
    );
  }

  if (action === 'cancel') {
    return finish(ctx, { kind: 'text', text: 'Cancelado, no he tocado nada.' }, timings, startedAt);
  }

  const agentStart = Date.now();
  const outcome = await executeConfirmed(
    pending,
    { chatId: ctx.chatId, from: ctx.principal },
    ctx,
  );
  timings.agent = Date.now() - agentStart;

  return finish(ctx, { kind: 'text', text: outcome }, timings, startedAt);
}

/**
 * Puts a voice on a reply, and gives up on the voice rather than on the reply.
 *
 * The order matters: a TTS failure must never cost the answer. Losing the audio is a
 * degraded turn the user can still read; losing the text because synthesis failed is the
 * same silence the whole project is built to avoid.
 */
async function finish(
  ctx: VoiceContext,
  outcome: Omit<VoiceOutcome, 'timings'>,
  timings: StageTimings,
  startedAt: number,
): Promise<VoiceOutcome> {
  const spoken = speakable(outcome.text);
  const budget = ctx.deadline.budgetFor(MAX_TTS_MS);

  if (budget < 1_000) {
    return {
      ...outcome,
      notice: 'Me he quedado sin tiempo para leerlo en voz alta.',
      timings: { ...timings, total: Date.now() - startedAt },
    };
  }

  const ttsStart = Date.now();
  try {
    const synthesizer = createSynthesizer(ctx.env, ctx.config);
    const speech = await synthesizer.synthesize(spoken, { timeoutMs: budget });
    timings.tts = Date.now() - ttsStart;
    return { ...outcome, speech, timings: { ...timings, total: Date.now() - startedAt } };
  } catch (error) {
    timings.tts = Date.now() - ttsStart;
    const notice = error instanceof TtsError ? error.userMessage : 'No he podido generar el audio.';
    console.error(
      JSON.stringify({
        event: 'voice_tts_failed',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        chars: spoken.length,
        elapsed_ms: timings.tts,
        budget_left_ms: ctx.deadline.remainingMs(),
      }),
    );
    return { ...outcome, notice, timings: { ...timings, total: Date.now() - startedAt } };
  }
}
