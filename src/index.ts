import { Hono } from 'hono';

import { ConfigError, loadConfig } from './config';
import { Deadline, DeadlineExceededError } from './lib/deadline';
import { TelegramClient } from './telegram/client';
import { claimUpdate, extractActor, isAuthorized, verifyWebhookSecret } from './telegram/guard';
import { handleUpdate } from './telegram/handler';
import type { Env, TelegramUpdate } from './types';

/**
 * Presupuesto total por mensaje. Debe caber holgadamente en el margen que
 * Cloudflare concede a waitUntil() tras devolver la respuesta.
 */
const TOTAL_BUDGET_MS = 25_000;

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('jarvis ok'));

app.post('/webhook', async (c) => {
  const env = c.env;

  // 1. Cabecera secreta. Lo más barato primero: descarta el ruido de internet
  //    antes de tocar KV o parsear el cuerpo.
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
      // 200 a propósito: el fallo es nuestro, no de Telegram. Un 5xx solo
      // provocaría reintentos que volverían a fallar igual.
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

  // 2. Autorización. Silencio deliberado ante desconocidos: no confirmamos que
  //    el bot existe ni damos pistas de por qué no responde.
  const actor = extractActor(update);
  if (!actor) {
    return c.json({ ok: true });
  }
  if (!isAuthorized(actor, config)) {
    console.warn(`update ignorado de usuario no autorizado: ${actor.telegramUserId}`);
    return c.json({ ok: true });
  }

  // 3. Dedupe. Si Telegram reintenta este update, no se vuelve a ejecutar.
  const claimed = await claimUpdate(env, update.update_id);
  if (!claimed) {
    console.info(`update ${update.update_id} ya procesado, se ignora`);
    return c.json({ ok: true });
  }

  // 4. Responder 200 al instante y procesar en background.
  //
  //    Este punto costó dos iteraciones y conviene dejar escrito por qué está así.
  //
  //    Estamos entre dos límites opuestos:
  //      · Si esperamos a terminar antes de responder, Telegram corta. Se midió
  //        en producción: reintenta a los ~4 s, y al desconectarse el cliente
  //        Cloudflare cancela la ejecución. Silencio total.
  //      · Si procesamos en waitUntil() sin límite, Cloudflare cancela la tarea
  //        pasado un margen tras la respuesta. También silencio.
  //
  //    La salida es responder ya y caber en ese margen. Viable ahora que el
  //    modelo tarda 2-5 s en vez de los 45 que tardaba NVIDIA. Deadline impone
  //    el presupuesto y, si no llega, se responde con un mensaje honesto.
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const started = Date.now();
  const deadline = Deadline.in(TOTAL_BUDGET_MS);

  c.executionCtx.waitUntil(
    handleUpdate(update, { env, config, telegram, actor, deadline })
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

export default app;
