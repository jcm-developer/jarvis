# Jarvis

Asistente personal por Telegram sobre Cloudflare Workers, con Supabase como base de datos.

Diseño completo y decisiones técnicas: [ARCHITECTURE.md](ARCHITECTURE.md)

**Estado: Fase 0** — webhook seguro y bot respondiendo. Sin LLM todavía.

Despliegue continuo con **Cloudflare Workers Builds**: cada push a `main` despliega.

---

## Puesta en marcha

### 1. Bot de Telegram

- [@BotFather](https://t.me/BotFather) → `/newbot` → guarda el **token**
- [@userinfobot](https://t.me/userinfobot) → tu **user id** (un número)

Ese id es la whitelist. Sin él, el bot no responde ni a ti.

### 2. KV namespace

En el dashboard: **Storage & Databases → KV → Create Instance**, nombre `jarvis-STATE`.
Copia el **Namespace ID** a [wrangler.toml](wrangler.toml).

Por CLI es equivalente:

```bash
npx wrangler kv namespace create STATE
```

El id **debe estar commiteado antes del primer build**: Workers Builds despliega
leyendo `wrangler.toml` del repo, y con el placeholder el deploy falla.

### 3. Conectar Workers Builds

**Workers & Pages → Create → Import a repository → `jcm-developer/jarvis`**

| Campo | Valor |
|---|---|
| Project name | `jarvis` (debe coincidir con `name` en `wrangler.toml`) |
| Build command | `npm run typecheck` |
| Deploy command | `npx wrangler deploy` |
| Builds for non-production branches | desmarcado |
| Path | `/` |
| API token | el que crea Cloudflare por defecto |

`npm run typecheck` como build command actúa de barrera: si el TypeScript no compila,
el build falla y **no se despliega**. Sin eso, un push roto tumba el bot en producción.

### 4. Secrets

Tras el primer deploy: **Worker → Settings → Variables and Secrets → Add**, tipo
**Secret** (no *Text*), uno por cada:

| Secret | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | el de BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | cadena aleatoria larga (ver abajo) |
| `ALLOWED_TELEGRAM_IDS` | tu user id, varios separados por coma |

Generar el secreto del webhook en PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

Guárdalo: lo necesitas otra vez en el paso 5.

> **Secrets vs vars.** Los secrets se ponen una vez y sobreviven a todos los deploys.
> Las `[vars]` de `wrangler.toml` se sobrescriben en cada deploy, así que editarlas
> en el dashboard no sirve de nada: el siguiente push las revierte. `wrangler.toml`
> es la única fuente de verdad para las vars.

`ALLOWED_TELEGRAM_IDS` es un secret y no una var porque este repo es público.

### 5. Registrar el webhook

Una sola vez. El `secret_token` debe ser **idéntico** a `TELEGRAM_WEBHOOK_SECRET`;
si no coincide, el Worker devuelve 403 a todo y el bot parece muerto sin dar pistas.

```powershell
$token  = "<TOKEN>"
$secret = "<TU_WEBHOOK_SECRET>"
$url    = "https://jarvis.<subdominio>.workers.dev/webhook"

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -ContentType "application/json" -Body (@{
    url             = $url
    secret_token    = $secret
    allowed_updates = @("message", "edited_message", "callback_query")
  } | ConvertTo-Json)
```

Se usa `Invoke-RestMethod` y no `curl` a propósito: en PowerShell `curl` es un alias de
`Invoke-WebRequest` y no acepta los flags de curl, y `curl.exe` obliga a escapar el JSON
a mano, que es donde falla casi todo el mundo. No olvides el `/webhook` final en la URL.

Comprobar:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" | Select-Object -ExpandProperty result
```

`last_error_message` con contenido o `pending_update_count` alto = algo falla.

### 6. Base de datos (desde la Fase 2)

Supabase → SQL Editor → pegar [supabase/schema.sql](supabase/schema.sql) → Run.

### 7. Probar

`/start`, `/ping`, o cualquier texto.

---

## Desarrollo

```bash
npm install
npm run dev         # servidor local
npm run typecheck   # lo mismo que corre el CI
npm run tail        # logs de producción en vivo
```

Para local, copia `.dev.vars.example` a `.dev.vars` y rellénalo. Está en `.gitignore`.

Desplegar a mano, saltándose el CI:

```bash
npm run deploy
```

---

## Troubleshooting

### El bot no responde

El Worker devuelve `200` en casi todos los modos de fallo (para que Telegram no
reintente en bucle), así que desde Telegram no se ve nada. Diagnostica por capas:

```powershell
# 1. ¿Está vivo el Worker?  → debe responder "jarvis ok"
curl.exe https://jarvis.<subdominio>.workers.dev/

# 2. ¿Coincide el secret?  → 200 = sí, 403 = no
curl.exe -s -o NUL -w "%{http_code}" -X POST https://jarvis.<subdominio>.workers.dev/webhook `
  -H "Content-Type: application/json" `
  -H "X-Telegram-Bot-Api-Secret-Token: <TU_SECRET>" -d '{\"update_id\":1}'

# 3. ¿Entrega Telegram?  → mira last_error_message
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" | Select -ExpandProperty result
```

Si el paso 2 da 200 y el bot sigue mudo, el problema es la whitelist: mira los logs
(**Compute → Workers → jarvis → Logs**), donde `update ignorado de usuario no
autorizado: N` te da tu id real.

### Dos trampas que cuestan tiempo

**Los secrets del dashboard no se aplican hasta pulsar Deploy.** Añadirlos en
*Variables and Secrets* y salir de la pantalla no hace nada: el Worker sigue
corriendo la versión anterior, sin ellos, y rechaza todo con 403.

**`setWebhook` ignora el `secret_token` si la URL ya estaba registrada.** Telegram
compara solo la URL, responde `{"ok":true,"description":"Webhook is already set"}`
y descarta el resto de parámetros. Si ves `already set` en vez de `Webhook was set`,
tu secret **no** se ha guardado. Hay que borrar primero:

```
https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>/webhook&secret_token=<SECRET>
```

## Qué hace la Fase 0

Cada update pasa por cuatro filtros antes de procesarse:

1. **Cabecera secreta** — `X-Telegram-Bot-Api-Secret-Token`, comparada en tiempo constante.
2. **Whitelist** — solo los ids de `ALLOWED_TELEGRAM_IDS`. Los demás se ignoran en silencio.
3. **Dedupe** — el `update_id` se reclama en KV con TTL de 24 h, así un reintento de
   Telegram no reejecuta las acciones.
4. **Respuesta inmediata** — `200 OK` al momento y el trabajo real en `ctx.waitUntil()`,
   porque el agente tardará más que el timeout de Telegram.

Comandos: `/start`, `/help`, `/ping`. Cualquier otro texto se responde con eco.
Los audios se acusan recibo pero no se transcriben hasta la Fase 3.

## Siguiente

**Fase 1** — capa `LLMProvider`, adaptador de NVIDIA NIM y conversación real.
