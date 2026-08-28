import { Hono } from 'hono';

import { ConfigError, loadConfig } from './config';
import { runScheduled } from './cron';
import { Deadline, DeadlineExceededError } from './lib/deadline';
import { TelegramClient } from './telegram/client';
import { claimUpdate, extractActor, isAuthorized, verifyWebhookSecret } from './telegram/guard';
import { handleUpdate } from './telegram/handler';
import type { Env, TelegramUpdate } from './types';
import { registerVoiceRoutes } from './voice/routes';

/**
 * Total budget per message.
 *
 * Cloudflare grants waitUntil() 30 s after the response is returned, shared across every
 * task, and then cancels them without ceremony. 27 s leaves room to send the error
 * message when a step overruns, instead of dying silently.
 *
 * If this turns out to be routinely short, the way out is not raising it: it is
 * Cloudflare Queues ($5/month), which decouples the work from the request and brings
 * retries. It would only affect this file.
 */
const TOTAL_BUDGET_MS = 27_000;

/**
 * The cron's budget.
 *
 * Looser than the webhook's because nobody is waiting for a response here: the work is
 * awaited directly, without waitUntil, so there is no external margin to run out. There
 * is still a cap so that one hung call does not eat the whole run and leave the briefing
 * half done.
 */
const CRON_BUDGET_MS = 25_000;

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('jarvis ok'));

// The voice channel (phase 25). It shares the agent, the database and the conversation
// row with Telegram, and nothing else: no message of its own goes out over the bot, and
// `src/tts/` is not reachable from `telegram/`. Every route here answers 404 unless
// VOICE_ENABLED is "true", so a deploy is enough to make the whole thing disappear.
registerVoiceRoutes(app);

app.post('/webhook', async (c) => {
  const env = c.env;

  // 1. Secret header. Cheapest first: it discards internet noise before touching KV
  //    or parsing the body.
  if (!verifyWebhookSecret(c.req.raw, env)) {
    console.warn('webhook rechazado: secret token inválido o ausente');
    return c.text('forbidden', 403);
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('configuración inválida:', error.message);
      // 200 on purpose: the failure is ours, not Telegram's. A 5xx would only trigger
      // retries that would fail the same way.
      return c.json({ ok: true });
    }
    throw error;
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    console.warn('webhook rechazado: cuerpo no es JSON válido');
    return c.text('bad request', 400);
  }

  // 2. Authorisation. Deliberate silence towards strangers: we neither confirm the bot
  //    exists nor hint at why it does not answer.
  const actor = extractActor(update);
  if (!actor) {
    return c.json({ ok: true });
  }
  if (!isAuthorized(actor, config)) {
    console.warn(`update ignorado de usuario no autorizado: ${actor.telegramUserId}`);
    return c.json({ ok: true });
  }

  // 3. Dedupe. If Telegram retries this update, it does not run again.
  const claimed = await claimUpdate(env, update.update_id);
  if (!claimed) {
    console.info(`update ${update.update_id} ya procesado, se ignora`);
    return c.json({ ok: true });
  }

  // 4. Answer 200 immediately and process in the background.
  //
  //    This point cost two iterations and it is worth writing down why it looks like
  //    this.
  //
  //    We sit between two opposing limits:
  //      - If we wait to finish before answering, Telegram cuts us off. Measured in
  //        production: it retries after ~4 s, and once the client disconnects
  //        Cloudflare cancels the execution. Total silence.
  //      - If we process inside waitUntil() with no limit, Cloudflare kills the task
  //        once a margin after the response has passed. Silence again.
  //
  //    The way out is answering now and fitting inside that margin. Viable now that the
  //    model takes 2-5 s instead of the 45 NVIDIA took. Deadline enforces the budget
  //    and, when it does not make it, an honest message is sent.
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const started = Date.now();
  const deadline = Deadline.in(TOTAL_BUDGET_MS);

  c.executionCtx.waitUntil(
    handleUpdate(update, { env, config, telegram, actor, deadline, channel: 'telegram' })
      .catch(async (error: unknown) => {
        console.error('fallo procesando update', update.update_id, error);
        const text =
          error instanceof DeadlineExceededError
            ? error.userMessage
            : 'Algo ha fallado por dentro. Los detalles están en los logs.';
        await telegram.sendMessage(actor.chatId, text).catch((sendError: unknown) => {
          console.error('además falló avisar al usuario:', sendError);
        });
      })
      .finally(() => {
        console.info(
          JSON.stringify({
            event: 'update_processed',
            update_id: update.update_id,
            duration_ms: Date.now() - started,
            budget_left_ms: deadline.remainingMs(),
          }),
        );
      }),
  );

  return c.json({ ok: true });
});

/**
 * Cron: briefing and reminders (Phase 5).
 *
 * It is awaited instead of being handed to waitUntil: there is no response to return
 * here, so the short margin that forces the webhook's gymnastics does not exist.
 *
 * Failures are logged and swallowed. A throw would have Cloudflare mark the run as
 * failed, and it neither retries nor warns: it only dirties the metrics.
 */
async function scheduled(env: Env): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    console.error('cron abortado, configuración inválida:', error);
    return;
  }

  try {
    await runScheduled(env, config, Deadline.in(CRON_BUDGET_MS));
  } catch (error) {
    console.error('cron falló:', error);
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_controller, env: Env) => scheduled(env),
} satisfies ExportedHandler<Env>;
