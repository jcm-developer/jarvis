import { Hono } from 'hono';

import { ConfigError, loadConfig } from './config';
import { TelegramClient } from './telegram/client';
import { claimUpdate, extractActor, isAuthorized, verifyWebhookSecret } from './telegram/guard';
import { handleUpdate } from './telegram/handler';
import type { Env, TelegramUpdate } from './types';

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

  // 4. Responder ya y procesar después.
  //    El loop agéntico tardará bastante más que el timeout de Telegram; si
  //    esperásemos a terminar, Telegram reintentaría y duplicaría el trabajo.
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);

  c.executionCtx.waitUntil(
    handleUpdate(update, { env, config, telegram, actor }).catch(async (error: unknown) => {
      console.error('fallo procesando update', update.update_id, error);
      // El usuario merece saber que algo se rompió, en vez de quedarse esperando.
      await telegram
        .sendMessage(actor.chatId, 'Algo ha fallado por dentro. Los detalles están en los logs.')
        .catch((sendError: unknown) => {
          console.error('además falló avisar al usuario:', sendError);
        });
    }),
  );

  return c.json({ ok: true });
});

export default app;
