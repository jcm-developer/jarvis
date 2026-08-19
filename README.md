# Jarvis

Asistente personal por Telegram sobre Cloudflare Workers, con Supabase como base de datos.

Diseño completo y decisiones técnicas: [ARCHITECTURE.md](ARCHITECTURE.md)

**Estado: Fase 5** — el roadmap inicial está completo: tareas, memoria, notas de voz, historial en Supabase y avisos proactivos por cron.

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
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) → *Create new secret key*. Sirve para el modelo y para transcribir |
| `SUPABASE_URL` | Supabase → Project Settings → API → *Project URL* |
| `SUPABASE_SERVICE_ROLE_KEY` | ídem → *service_role*. Se salta RLS: trátala como la llave maestra |
| `GOOGLE_SA_EMAIL` | desde la Fase 6. El `client_email` del JSON de la service account |
| `GOOGLE_SA_PRIVATE_KEY` | ídem, el `private_key`: pégalo tal cual, con sus `\n` |
| `GOOGLE_CALENDAR_ID` | ídem, el id del calendario compartido. Nunca `primary` |

**Al terminar, pulsa Deploy.** Los secrets no se aplican hasta entonces.

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

Es idempotente y se puede reejecutar: es como llegan los cambios de esquema de las fases
siguientes (la última, `remind_at` en `tasks`, para los avisos a una hora concreta).

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

### Probar el cron sin esperar a la hora en punto

`wrangler dev` expone un endpoint para dispararlo a mano:

```bash
npx wrangler dev --test-scheduled
# en otra terminal
curl.exe "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Cada ejecución deja una línea `cron_run` en los logs con cuántos usuarios miró, y
cuántos recordatorios y briefings salieron. Si el briefing ya salió hoy no se repite:
para volver a probarlo hay que borrar su clave de KV (`briefing:<userId>:<fecha>`).

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

### Límite conocido: todo tiene que caber en 27 s

El plan free de Cloudflare concede **30 s** a `ctx.waitUntil()` tras responder y
luego cancela la tarea. Todo el procesamiento de un mensaje tiene que caber ahí,
y el reparto lo controla [src/lib/deadline.ts](src/lib/deadline.ts) con un
presupuesto de 27 s:

| Paso | Tope |
|---|---|
| Descarga del audio (`getFile` + fichero) | 6 s por intento, con un reintento |
| Transcripción | 10 s |
| Cada llamada al modelo | 15 s, o lo que quede |

La descarga tuvo 15 s dando por hecho que las notas largas tardaban más. No es
así: Telegram las manda en OGG/Opus a ~16 kbps, un minuto de audio son ~120 KB y
bajan en menos de un segundo. Los fallos de descarga son **picos puntuales del
servidor de ficheros de Telegram**, no cuestión de tamaño; por eso aparecían con
el mismo audio unas veces sí y otras no. Ahora se corta antes y se reintenta una
vez, siempre que quede presupuesto para transcribir y responder después.

La solución real es **Cloudflare Queues** ($5/mes): desacopla el trabajo de la
petición y elimina el techo. El cambio afecta casi solo a
[src/index.ts](src/index.ts) — está diseñado para eso desde el principio.

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

## Qué hace la Fase 1

Conversación real contra un LLM, con memoria de los últimos turnos.

**Capa de proveedor** ([src/llm/](src/llm/)). Nada fuera de ese directorio sabe qué
proveedor está activo. OpenAI, Groq y NVIDIA hablan el mismo formato, así que
comparten un único adaptador ([openai-compatible.ts](src/llm/providers/openai-compatible.ts))
y cambiar entre ellos son dos líneas de `wrangler.toml` más su API key:

```toml
LLM_PROVIDER = "openai"
LLM_MODEL = "gpt-4.1-mini"
```

Eso es lo que corre en producción. Se empezó con NVIDIA NIM por su free tier y hubo
que abandonarlo: encolaba las peticiones gratuitas y un simple saludo se iba de 45 s,
más de lo que aguanta cualquier montaje sobre el plan free (ver
[ARCHITECTURE.md §11](ARCHITECTURE.md)). Con OpenAI la misma respuesta tarda 2-5 s.
`groq` (`llama-3.3-70b-versatile`) y `nvidia` siguen soportados como alternativa.

Dentro de OpenAI se empezó con `gpt-4o-mini` y se cambió a `gpt-4.1-mini` porque el
primero se saltaba las instrucciones: duplicaba tareas y fechaba los avisos al día
siguiente con las reglas delante. Es más caro de lista, pero casi todo lo que
gastamos es prefijo cacheado, donde la diferencia baja al 33%.

Se usa `fetch` directo en lugar del SDK de OpenAI para no engordar el bundle.
Incluye timeout de 20 s por llamada —recortado por el presupuesto del mensaje—, un
reintento ante 429 y 5xx, y limpieza de los bloques
`<think>` que emiten los modelos de razonamiento.

**Memoria de corto plazo.** Ventana deslizante de `HISTORY_WINDOW` mensajes. Nació
en KV con TTL de 7 días como solución interina; en la Fase 4 se mudó a Supabase.

**Errores legibles.** Cuota agotada, clave inválida o timeout llegan a Telegram como
una frase clara, no como silencio ni como un volcado de stack.

Comandos: `/ping`, `/reset`, `/help`. Todo lo demás va al modelo.
Los audios se acusan recibo pero no se transcriben hasta la Fase 3.

## Qué hace la Fase 2

El agente deja de conversar y empieza a actuar.

**Registry de herramientas** ([src/tools/](src/tools/)). Cada tool es una definición
tipada con su JSON Schema, y se envían en el campo `tools` de la petición — no
descritas en prosa dentro del prompt, que duplicaría la fuente de verdad.

| Tool | Qué hace | Confirmación |
|---|---|---|
| `create_task` | Crea tarea con fecha límite, hora de aviso, prioridad y notas | No |
| `list_tasks` | Filtra por estado y vencimiento | No |
| `update_task` | Cambia fecha límite, hora de aviso, título, notas, prioridad o estado | No |
| `complete_task` | Marca como hecha | No |
| `delete_task` | Borra permanentemente | **Sí** |
| `remember` | Guarda un dato duradero del usuario | No |
| `recall` | Busca entre lo recordado | No |

**Bucle agéntico** ([src/agent.ts](src/agent.ts)). Hasta `MAX_AGENT_ITERATIONS`
vueltas: el modelo pide herramientas, se ejecutan, el resultado vuelve como mensaje
`tool` y decide otra vez. Los errores se devuelven al modelo como
`{ok:false, error}` para que se corrija solo, en vez de romper la conversación.

**Confirmación humana.** `delete_task` no se ejecuta: la acción queda en KV con TTL
de 15 minutos y el usuario recibe botones. Confirmar la consume — pulsar dos veces no
la ejecuta dos veces. El texto del botón incluye el título real de la tarea, porque
nadie revisa un uuid.

**Cliente de base de datos propio** ([src/db/client.ts](src/db/client.ts)). PostgREST
por `fetch`, sin `@supabase/supabase-js`, por el mismo motivo que en la capa de LLM.
Entra con `service_role`, que se salta RLS.

**Auditoría.** Cada llamada a herramienta se registra en `tool_call_logs` con
argumentos, resultado, duración y error. Es lo que permite entender después por qué
el agente hizo lo que hizo.

## Qué hace la Fase 3

Notas de voz. Le mandas un audio y hace lo que le pidas.

Telegram envía OGG/Opus → se descarga con `getFile` → se transcribe → el texto
entra por el mismo camino que un mensaje escrito.

**Dos transcriptores** ([src/stt/](src/stt/)), intercambiables como los de LLM:

| `STT_PROVIDER` | Modelo | Notas |
|---|---|---|
| `openai` (por defecto) | `whisper-1` | Acepta OGG sin convertir. Mejor en español. Céntimos por hora |
| `workers-ai` | `@cf/openai/whisper-large-v3-turbo` | Gratis, dentro de Cloudflare |

`STT_LANGUAGE = "es"` fija el idioma en vez de autodetectarlo, lo que mejora
bastante la precisión en audio de móvil.

Una transcripción vacía **nunca** llega al modelo: se responde pidiendo repetir. Si
no, el agente improvisaría sobre una cadena vacía.

## Qué hace la Fase 4

El historial deja KV y pasa a la tabla `messages`
([src/db/messages.ts](src/db/messages.ts)). No es un cambio cosmético: el plan free
da 1.000 escrituras de KV al día y el historial gastaba una por mensaje, compitiendo
con el dedupe de `update_id`. Ahora KV solo guarda lo efímero — dedupe,
confirmaciones pendientes y la caché de identidades.

Se persiste el turno **completo**: el mensaje del usuario, el `assistant` con sus
`tool_calls` y cada resultado `tool`. Y de una sola vez al final del turno, en un
INSERT con varias filas: guardar a medias dejaría un `assistant` con `tool_calls` sin
sus resultados, que es contexto que la API rechaza con un 400.

Cada fila lleva `source` (`text` o `voice`) y, en los audios, la transcripción cruda.
Cuando el agente entiende algo raro, lo primero que se mira es si venía de un audio.

`/reset` borra las filas de la conversación de verdad. La auditoría de lo que el
agente *hizo* sigue en `tool_call_logs`, y lo que recuerda del usuario a largo plazo
(`memories`) no se toca.

## Qué hace la Fase 5

Jarvis deja de esperar a que le escribas: ahora escribe él.

**Briefing diario** ([src/cron/briefing.ts](src/cron/briefing.ts)). A las 8 de la
mañana *en tu hora local* llega un mensaje con lo que tienes: vencidas, lo de hoy con
su hora, y lo urgente sin fecha. Se manda una vez al día, dentro de una ventana de 3
horas: si el disparo de las 8 se pierde, lo recupera el de las 9 o el de las 10.

```toml
BRIEFING_HOUR = "8"   # hora local, 0-23
```

El texto se compone en código, sin pasar por el modelo: es una lista de tareas con
fechas, y así no cuesta tokens ni puede inventarse una tarea que no existe.

**Recordatorios** ([src/cron/reminders.ts](src/cron/reminders.ts)). El cron corre cada
cinco minutos y distingue dos clases de aviso:

| Pides | Campo | Te llega |
|---|---|---|
| "recuérdamelo a las 12:10" | `remind_at` | A las 12:10 (dentro de esos 5 minutos) |
| una tarea con fecha límite | `due_at` | Una hora antes de vencer |

Se avisa una sola vez por tarea (`reminded_at`), y lo que ya estaba vencido también
entra, con un tope de 10 por ejecución para que no llegue una avalancha el primer día.

El mensaje está escrito para que suene a persona, no a alarma:

> Acuérdate de llamar a David a las 18:00.
>
> Se te ha pasado pagar la luz, era ayer a las 09:00.

Lo compone el Worker, sin pasar por el modelo: cero tokens y no puede inventarse una
tarea. La hora solo se dice si aporta algo, los días van con nombre (ayer, mañana)
y la frase de entrada varía entre tareas.

Que el aviso sea un campo de la tarea y no otra tarea importa: sin `remind_at`, un
"llamo a David a las 17:30, recuérdamelo a las 12:10" acababa en dos filas, la tarea y
un "recordar llamar a David". Una sola cosa que hacer, una sola fila.

**La hora local, calculada de verdad** ([src/lib/localtime.ts](src/lib/localtime.ts)).
El cron de Cloudflare dispara en UTC y España cambia de horario dos veces al año: un
cron a las 06:00 UTC serían las 7 en invierno y las 8 en verano. Así que la hora
local, el inicio y el fin del día salen de `Intl`, incluidos los dos días del año que
duran 23 y 25 horas.

Los avisos se guardan en el historial como mensajes del asistente. Sin eso, contestar
"hecho" a un recordatorio no tendría referente y el modelo preguntaría de qué le hablas.

No hacen falta secrets nuevos. El trigger de [wrangler.toml](wrangler.toml) ya va
activado, y la columna `remind_at` se añade reejecutando
[supabase/schema.sql](supabase/schema.sql), que es idempotente.

## Qué hacen las Fases 6 y 7: el calendario

Apuntar citas en Google Calendar desde el chat. *"Apúntame el dentista el jueves a las
diez"* crea el evento; *"comprar pan"* sigue siendo una tarea. La frontera es si ocupa
un hueco del día a una hora concreta o es algo que hay que hacer cuando se pueda, y si
el modelo duda, pregunta.

La Fase 6 solo sabía crear. La **Fase 7** añadió consultarlas, moverlas y borrarlas:

```
¿qué tengo el jueves?
muévela al viernes
la del dentista bórrala, que al final no puedo ir
apunta que me voy a Lisboa del 23 al 26
```

Las citas de varios días se guardan como un solo evento, no como uno por día. Y según de
qué sean —viaje, trabajo, estudios, personal, salud, social— salen de un color distinto en la app
del calendario: el modelo deduce el tipo y el color lo pone el código, para que los viajes
sean siempre del mismo color y no de uno cada semana.

Para cambiar o borrar necesita el id, así que primero consulta el calendario y luego
actúa. Borrar pide confirmación con botones, como borrar una tarea, y la pregunta lleva
el título de la cita para que sepas qué estás confirmando.

Los avisos de una cita los da tu propia app de calendario, no el cron de Jarvis.

### Preparar Google (una vez)

1. [console.cloud.google.com](https://console.cloud.google.com) con la cuenta del
   calendario → proyecto nuevo → **APIs y servicios → Biblioteca** → habilitar
   **Google Calendar API**. No pide tarjeta: la cuota gratuita es de un millón de
   peticiones al día y nosotros hacemos una por cita.
2. **IAM y administración → Cuentas de servicio → Crear**. Sin ningún rol de IAM: los
   permisos vienen del calendario compartido, no de aquí.
3. La cuenta → **Claves → Agregar clave → JSON**. Guarda el fichero fuera del repo,
   que es público, y bórralo en cuanto copies los dos campos que hacen falta.
4. [calendar.google.com](https://calendar.google.com) → el calendario → **⋮ →
   Configuración y uso compartido → Compartir con determinadas personas** → añade el
   `client_email` con permiso **"Hacer cambios en los eventos"**. En la misma pantalla,
   **Integrar calendario → ID del calendario**: ese es `GOOGLE_CALENDAR_ID`.
5. Los tres secrets del paso 4 de la puesta en marcha, y **Deploy**.

> **La política que bloquea el paso 3.** En las organizaciones nuevas Google aplica de
> oficio `iam.disableServiceAccountKeyCreation` y el diálogo de error no dice que se
> pueda quitar. Se desactiva solo en este proyecto, desde Cloud Shell:
>
> ```bash
> gcloud resource-manager org-policies disable-enforce \
>   iam.disableServiceAccountKeyCreation --project=<PROJECT_ID>
> ```
>
> La consola cachea el estado: recarga la pestaña antes de reintentar, o crea la clave
> con `gcloud iam service-accounts keys create`, que no pasa por ahí.

### Tres cosas que no puede hacer y no son bugs

- **Invitar a otras personas a un evento.** Una service account sin *domain-wide
  delegation* —que necesita Google Workspace, no una cuenta Gmail— no puede añadir
  invitados, y la API lo rechaza.
- **Mover una serie entera.** Si cambias una cita que se repite, cambia solo ese día. Te
  lo dice al hacerlo.
- **Ver el título de tus citas privadas.** El permiso que le das las muestra como hueco
  ocupado y sin nombre. Las puede mover y borrar, pero no reconocerlas por el título.
  Se arregla subiendo el permiso a *Make changes and see all event details*, a cambio de
  darle acceso de lectura a todo.

### Si algo falla la primera vez

Con `npx wrangler tail` delante, los dos errores probables se distinguen solos:

| En el log | Qué pasa |
|---|---|
| `google_token_failed` con `invalid_grant` | el `private_key` está mal pegado |
| `calendar_request_failed` con `404` en un `POST` o `GET` de lista | el `GOOGLE_CALENDAR_ID` está mal, o el calendario no está compartido con la service account (la API responde 404, no 403: para ella ese calendario no existe) |
| `calendar_request_failed` con `404` en un `PATCH` o `DELETE` | el evento ya no existe; el calendario está bien |
| `tool_calls: []` y el bot dice que no está configurado | el modelo contesta desde el historial; ver abajo |

**`GOOGLE_CALENDAR_ID` no sale de Google Cloud ni del JSON de la service account.** Es
el `Calendar ID` de *Settings and sharing → Integrate calendar*, que en el calendario
principal es tu dirección de Gmail. Poner ahí el email `...iam.gserviceaccount.com` da
exactamente el mismo 404: es quien escribe, no dónde se escribe.

**Después de arreglar un secret, `/reset` antes de volver a probar.** El error de la
herramienta se queda guardado en el historial y el modelo contesta desde ahí sin
reintentar, así que la prueba mide la conversación vieja y no el arreglo. Se reconoce en
el log: `llm_call` con `tool_calls: []`.

## Varias cosas en un mensaje

Ya funcionaba desde la Fase 2 — el bucle ejecuta todas las `tool_calls` de una misma
respuesta — y ahora el prompt lo pide explícitamente. Un audio como *"recuérdame
llamar al banco, comprar pan y revisar el podcast"* crea las tres tareas de una vez.

## Siguiente

Con el calendario completo, el siguiente candidato es que **el briefing cuente las
reuniones del día**, que es la lectura masiva que sigue fuera. Detrás, sin orden: notas y
gastos como dominios nuevos, búsqueda web, respuesta en audio, entender imágenes y un
panel web. La lista completa, al final de [ARCHITECTURE.md](ARCHITECTURE.md).
