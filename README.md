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
curl.exe -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -H "Content-Type: application/json" -d '{\"url\":\"https://jarvis.<subdominio>.workers.dev/webhook\",\"secret_token\":\"<SECRET>\",\"allowed_updates\":[\"message\",\"edited_message\",\"callback_query\"]}'
```

En PowerShell usa `curl.exe`, no `curl`: este último es un alias de `Invoke-WebRequest`
y no acepta estos flags. No olvides el `/webhook` final en la URL.

Comprobar:

```powershell
curl.exe "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
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
