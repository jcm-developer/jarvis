# Jarvis

Asistente personal por Telegram sobre Cloudflare Workers, con Supabase como base de datos.

Diseño completo y decisiones técnicas: [ARCHITECTURE.md](ARCHITECTURE.md)

**Estado: Fase 0 completa** — webhook seguro y bot respondiendo. Sin LLM todavía.

---

## Puesta en marcha

### 1. Dependencias

```bash
npm install
```

### 2. Crear el bot en Telegram

Habla con [@BotFather](https://t.me/BotFather) → `/newbot` → guarda el token.

Consigue tu propio user id con [@userinfobot](https://t.me/userinfobot). Es el número
que va en la whitelist: sin él, el bot no te responde ni a ti.

### 3. Configurar

En `wrangler.toml`, rellena tu id:

```toml
ALLOWED_TELEGRAM_IDS = "123456789"
```

Crea el namespace de KV y copia el id que imprime:

```bash
npx wrangler kv namespace create STATE
```

```toml
[[kv_namespaces]]
binding = "STATE"
id = "el-id-que-te-ha-dado"
```

### 4. Secrets

Genera un secreto para el webhook (cualquier cadena larga y aleatoria):

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Para desarrollo local, copia `.dev.vars.example` a `.dev.vars` y rellénalo.
Ese fichero está en `.gitignore` y no se sube nunca.

### 5. Desplegar

```bash
npm run deploy
```

Anota la URL del Worker: `https://jarvis.<tu-subdominio>.workers.dev`

### 6. Registrar el webhook

El `secret_token` debe ser **exactamente** el mismo valor que pusiste en
`TELEGRAM_WEBHOOK_SECRET`. Si no coinciden, el Worker devuelve 403 a todo y el bot
parece muerto sin dar ninguna pista.

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://jarvis.<tu-subdominio>.workers.dev/webhook",
    "secret_token": "<TU_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "edited_message", "callback_query"]
  }'
```

Comprobar que quedó bien registrado:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

`pending_update_count` alto o `last_error_message` con contenido significan que algo falla.

### 7. Base de datos (opcional en Fase 0)

Se usa a partir de la Fase 2, pero puedes dejarla lista ya: en Supabase,
SQL Editor → pega [supabase/schema.sql](supabase/schema.sql) → Run.

### 8. Probar

Escribe a tu bot: `/start`, `/ping`, o cualquier texto.

---

## Desarrollo

```bash
npm run dev         # servidor local
npm run typecheck   # tsc --noEmit
npm run tail        # logs de producción en vivo
```

Para probar en local hace falta exponer el puerto (Cloudflare Tunnel, ngrok) y
apuntar ahí el webhook. Es más rápido desplegar y usar `npm run tail`.

---

## Qué hace la Fase 0

Cada update pasa por cuatro filtros antes de procesarse:

1. **Cabecera secreta** — `X-Telegram-Bot-Api-Secret-Token`, comparada en tiempo constante.
2. **Whitelist** — solo los ids de `ALLOWED_TELEGRAM_IDS`. Los demás se ignoran en silencio.
3. **Dedupe** — el `update_id` se reclama en KV con TTL de 24 h, así un reintento de
   Telegram no reejecuta las acciones.
4. **Respuesta inmediata** — se devuelve `200 OK` al momento y el trabajo real ocurre
   en `ctx.waitUntil()`, porque el agente tardará más que el timeout de Telegram.

Comandos: `/start`, `/help`, `/ping`. Cualquier otro texto se responde con eco.
Los audios se reconocen y se acusa recibo, pero no se transcriben hasta la Fase 3.

## Siguiente

**Fase 1** — capa `LLMProvider`, adaptador de NVIDIA NIM y conversación real.
