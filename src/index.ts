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

  // 4. Procesar dentro de la petición, no en waitUntil().
  //
  //    waitUntil() parecía lo natural (responder 200 al instante y trabajar
  //    después), pero Cloudflare cancela esas tareas pasado un margen corto tras
  //    devolver la respuesta. Con el modelo tardando 10-30 s, la tarea moría a
  //    media llamada: ni respuesta, ni excepción, ni log. Silencio.
  //
  //    Awaitando aquí disponemos de toda la vida de la petición, y la espera de
  //    red no consume tiempo de CPU. El coste es que Telegram puede reintentar si
  //    tardamos demasiado, y eso ya está cubierto por el dedupe del paso 3.
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const started = Date.now();

  try {
    await handleUpdate(update, { env, config, telegram, actor });
  } catch (error) {
    console.error('fallo procesando update', update.update_id, error);
    // El usuario merece saber que algo se rompió, en vez de quedarse esperando.
    await telegram
      .sendMessage(actor.chatId, 'Algo ha fallado por dentro. Los detalles están en los logs.')
      .catch((sendError: unknown) => {
        console.error('además falló avisar al usuario:', sendError);
      });
  }

  console.info(
    JSON.stringify({
      event: 'update_processed',
      update_id: update.update_id,
      duration_ms: Date.now() - started,
    }),
  );

  // Siempre 200: un 5xx solo haría que Telegram reintentase algo ya procesado.
  return c.json({ ok: true });
});

export default app;
