# Jarvis — Asistente personal por Telegram

Documento de arquitectura. Fuente de verdad de las decisiones técnicas.
Última revisión: 2026-08-18.

---

## 1. Qué es

Un agente de IA al que se le escribe o se le manda audios por Telegram. El agente
razona, decide qué herramientas ejecutar (crear tareas, consultar, recordar cosas)
y responde. Todo corre en Cloudflare Workers, sin servidor propio, con Supabase
como base de datos.

**Usuario único** (o lista blanca corta). No es un producto multi-tenant.

---

## 2. Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Plan Cloudflare | **Free** | Uso personal. 200 OK inmediato y trabajo en `waitUntil()` acotado (ver §11). Migrable a Queues sin rediseñar. |
| Proveedor LLM | **OpenAI** (`gpt-4o-mini`) tras capa de abstracción | Se empezó con NVIDIA NIM por su free tier y no aguantó producción: encolaba las peticiones y un saludo se iba de 45 s. La capa se queda: el motivo por el que existe sigue vigente. |
| STT | **OpenAI Whisper** (`whisper-1`) | Acepta el OGG/Opus de Telegram sin convertir y acierta más en español. Workers AI queda como alternativa gratis por env var. |
| DB | **Supabase** | Postgres gestionado + free tier + REST. |
| Lenguaje | **TypeScript** | Tipado en los contratos de tools, que es donde más duele el error. |

---

## 3. Diagrama de flujo

```
Telegram
   │  POST /webhook  (update)
   ▼
┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
│                                                                          │
│  [1] Guard                                                               │
│      ├─ verifica X-Telegram-Bot-Api-Secret-Token                         │
│      ├─ whitelist de telegram_user_id                                    │
│      └─ dedupe update_id en KV (TTL 24h)                                 │
│                                                                          │
│  [2] 200 OK inmediato + procesamiento en ctx.waitUntil()                 │
│      acotado por un presupuesto global de 27 s; ver §11                  │
│                                                                          │
│  [3] Normalización de entrada                                            │
│      ├─ texto      → tal cual                                            │
│      ├─ voz/audio  → getFile → descarga OGG → Whisper (OpenAI)  → texto  │
│      └─ otro       → respuesta "no soportado aún"                        │
│                                                                          │
│  [4] sendChatAction("typing")                                            │
│                                                                          │
│  [5] Construcción del contexto                                           │
│      system prompt + memorias + últimos N mensajes + mensaje actual       │
│                                                                          │
│  [6] Loop agéntico (máx 3 iteraciones)                                   │
│      ┌──────────────────────────────────────────┐                        │
│      │ LLM.chat(messages, tools)                │                        │
│      │   ├─ finish_reason=stop      → salir     │                        │
│      │   └─ finish_reason=tool_calls            │                        │
│      │        ├─ requiresConfirmation? → pausa  │──▶ inline keyboard      │
│      │        ├─ ejecuta handler → Supabase     │                        │
│      │        ├─ log en tool_call_logs          │                        │
│      │        └─ push resultado a messages ─────┘                        │
│      └──────────────────────────────────────────┘                        │
│                                                                          │
│  [7] Persistencia + sendMessage                                          │
└──────────────────────────────────────────────────────────────────────────┘

Cron Trigger (cada hora, UTC)  ──▶  ¿toca briefing en hora local?  ──▶ sendMessage
                               └─▶  tareas que vencen en 1 h        ──▶ sendMessage
```

---

## 4. Estructura de ficheros

```
jarvis/
├─ src/
│  ├─ index.ts                 # entrypoint: fetch (webhook) + scheduled (cron)
│  ├─ agent.ts                 # loop agéntico y confirmaciones
│  ├─ config.ts                # lectura y validación de env
│  ├─ types.ts                 # Env + tipos de la Telegram API
│  │
│  ├─ lib/
│  │  ├─ deadline.ts           # presupuesto de tiempo compartido del mensaje
│  │  └─ localtime.ts          # hora local del usuario (Intl, cambios de hora)
│  │
│  ├─ telegram/
│  │  ├─ guard.ts              # secret token, whitelist, dedupe
│  │  ├─ client.ts             # sendMessage, sendChatAction, getFile, answerCallbackQuery
│  │  └─ handler.ts            # router de updates + comandos
│  │
│  ├─ llm/
│  │  ├─ provider.ts           # interfaz LLMProvider  ◄── la capa de abstracción
│  │  ├─ index.ts              # selección de proveedor por env
│  │  └─ providers/
│  │     └─ openai-compatible.ts   # openai, groq y nvidia hablan el mismo protocolo
│  │
│  ├─ tools/
│  │  ├─ registry.ts           # Map<name, ToolDefinition>
│  │  ├─ types.ts              # ToolDefinition, ToolContext, validadores de args
│  │  ├─ tasks.ts              # create/list/update/complete/delete_task
│  │  ├─ memory.ts             # remember, recall
│  │  └─ pending.ts            # acciones a la espera de confirmación (KV)
│  │
│  ├─ stt/
│  │  ├─ provider.ts           # interfaz Transcriber
│  │  ├─ index.ts              # selección por env
│  │  ├─ openai.ts             # Whisper de OpenAI
│  │  └─ workers-ai.ts         # Whisper en el propio Worker
│  │
│  ├─ db/
│  │  ├─ client.ts             # PostgREST a mano (service_role)
│  │  ├─ identity.ts           # users + conversations, cacheados en KV
│  │  ├─ messages.ts           # historial de conversación
│  │  ├─ logs.ts               # tool_call_logs
│  │  └─ types.ts              # filas de las tablas
│  │
│  ├─ prompts/
│  │  └─ system.ts             # personalidad + reglas + memorias + fecha/hora/TZ
│  │
│  └─ cron/
│     ├─ index.ts              # qué se hace en cada disparo
│     ├─ briefing.ts           # briefing diario a la hora local
│     └─ reminders.ts          # avisos de tareas que vencen
│
├─ supabase/
│  └─ schema.sql
├─ wrangler.toml
├─ package.json
├─ tsconfig.json
└─ ARCHITECTURE.md
```

---

## 5. Esquema de base de datos

```sql
-- Usuarios autorizados
create table users (
  id              uuid primary key default gen_random_uuid(),
  telegram_id     bigint unique not null,
  username        text,
  first_name      text,
  timezone        text not null default 'Europe/Madrid',
  created_at      timestamptz not null default now()
);

-- Una conversación por chat de Telegram
create table conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  telegram_chat_id bigint unique not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Historial. role sigue el estándar OpenAI para poder replayearlo tal cual.
create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','tool','system')),
  content         text,
  tool_calls      jsonb,          -- cuando role='assistant' y pide tools
  tool_call_id    text,           -- cuando role='tool'
  source          text not null default 'text' check (source in ('text','voice')),
  transcript_raw  text,           -- audio original transcrito, antes de limpiar
  created_at      timestamptz not null default now()
);
create index on messages (conversation_id, created_at desc);

-- Memoria de largo plazo. La escribe el propio agente con la tool remember().
create table memories (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  key             text not null,           -- 'trabajo', 'preferencia_horario'
  value           text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, key)
);

-- Dominio: tareas
create table tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  title           text not null,
  notes           text,
  due_at          timestamptz,
  priority        smallint not null default 2 check (priority between 1 and 3), -- 1 alta
  status          text not null default 'pending'
                    check (status in ('pending','done','cancelled')),
  completed_at    timestamptz,
  reminded_at     timestamptz,             -- evita recordatorios duplicados
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on tasks (user_id, status, due_at);

-- Observabilidad
create table tool_call_logs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete set null,
  tool_name       text not null,
  arguments       jsonb,
  result          jsonb,
  success         boolean not null,
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);
create index on tool_call_logs (created_at desc);

-- RLS activo en todas. El Worker entra con service_role, que la bypasea.
-- Esto blinda la DB si algún día se expone la anon key.
alter table users            enable row level security;
alter table conversations    enable row level security;
alter table messages         enable row level security;
alter table memories         enable row level security;
alter table tasks            enable row level security;
alter table tool_call_logs   enable row level security;
```

### Historial: cómo se lee y se escribe

Vivió en KV durante las fases 1-3 y desde la fase 4 está en `messages`. El motivo
no fue estético: el plan free da **1.000 escrituras de KV al día** y el historial
gastaba una por mensaje, compitiendo con el dedupe de `update_id`, que no es
negociable. Además era lo único fuera de la base de datos, así que releer una
conversación pasada solo se podía hacer por los logs del Worker.

Tres decisiones que no se ven en el esquema:

- **Se guarda el turno completo**, no solo el texto visible: también el mensaje
  `assistant` con sus `tool_calls` y cada resultado `tool`. Guardando solo el texto
  el modelo perdía constancia de lo que ya había hecho y repetía acciones — creaba
  dos veces la misma tarea al volver a mencionarla en el mensaje siguiente.
- **Se escribe de golpe al final del turno**, en un único INSERT con varias filas.
  Escribir a medida que ocurren dejaría turnos a medias si algo falla por el
  camino, y un `assistant` con `tool_calls` sin sus resultados es contexto que la
  API rechaza con un 400.
- **`created_at` lo pone el Worker**, un milisegundo por fila, en vez de dejar el
  `now()` de la columna. `now()` es el mismo instante para todas las filas de un
  INSERT, así que al releerlas ordenadas por fecha volverían en orden arbitrario, y
  un mensaje `tool` delante de la llamada que lo originó es otro 400.

La lectura pide las `HISTORY_WINDOW` filas más recientes (orden descendente, que es
justo el del índice) y las invierte. Si el corte cae dentro de un turno, se
descartan las filas iniciales hasta una que pueda abrir el contexto: un `user`, o un
`assistant` sin `tool_calls`. Aceptar el segundo importa porque un turno con muchas
herramientas puede llenar la ventana entero y entonces no hay ningún `user` que
encontrar.

`/reset` borra las filas de la conversación. Borrado real y no marca de corte: si el
usuario pide olvidar, se olvida. La auditoría de lo que el agente *hizo* no se pierde
por eso — vive en `tool_call_logs`, que es la tabla que se mira cuando algo salió mal.
Las memorias de largo plazo tampoco se tocan: son otra tabla y otro contrato.

La tabla crece sin límite y de momento se acepta: 500 MB dan para años de
conversación de una persona. Si algún día aprieta, es un `delete` por antigüedad en
el cron, no un rediseño.

---

## 6. Capa de abstracción del LLM

El punto que permitió cambiar de proveedor sin tocar `agent.ts` cuando NVIDIA no
aguantó. Ya se ha usado en serio una vez, así que se queda.

```ts
// src/llm/provider.ts
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: LLMMessage[], tools?: ToolSchema[], options?: ChatOptions): Promise<LLMResponse>;
}
```

Selección en runtime por `LLM_PROVIDER`. Cambiar de proveedor son dos vars más su
API key; el agente no se entera.

| `LLM_PROVIDER` | Base URL | Modelo en uso / sugerido | Secret |
|---|---|---|---|
| `openai` (**en producción**) | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` | `NVIDIA_API_KEY` |

Los tres hablan el formato de OpenAI, así que comparten un único adaptador
([openai-compatible.ts](src/llm/providers/openai-compatible.ts)) escrito con
`fetch` directo: el SDK `openai` no entra en el bundle del Worker por peso y
dependencias de Node. El adaptador reintenta una vez ante 429 y 5xx, nunca ante
timeout (duplicaría el peor caso cuando ya vamos tarde) y limpia los bloques
`<think>` que emiten los modelos de razonamiento.

Gemini queda fuera a propósito: su API nativa no es compatible y necesitaría su
propio adaptador.

> **Al cambiar de modelo, dos comprobaciones.** Que soporte function calling, o la
> Fase 2 entera deja de funcionar. Y en OpenAI, evitar la serie "o" de
> razonamiento: rechaza `max_tokens` y `temperature`, que el adaptador siempre manda.

### Por qué se abandonó NVIDIA NIM

Era la elección inicial por su free tier. En producción, su cola de peticiones
gratuitas hacía que un simple saludo tardara más de 45 s. Con ese tiempo no cabe
ninguna arquitectura sobre el plan free de Workers: es lo que forzó el diseño de
§11. Con OpenAI la misma respuesta tarda 2-5 s y el problema desapareció.

---

## 7. Contrato de las tools

No hay "manual de instrucciones" en el prompt. Las funciones se declaran como
JSON Schema y se pasan en el campo `tools` de la petición. El prompt solo lleva
personalidad y reglas de negocio.

```ts
export interface ToolDefinition {
  name: string;
  description: string;              // el modelo decide por esto: ser explícito
  parameters: JSONSchema;
  requiresConfirmation: boolean;    // acciones destructivas → confirmación humana
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  conversationId: string;
  timezone: string;
  db: Db;                           // cliente PostgREST propio, no el SDK
}

export type ToolResult =
  | { ok: true;  data: unknown }
  | { ok: false; error: string };   // el error vuelve al modelo para que reaccione
```

### Catálogo inicial

| Tool | Descripción | Confirmación |
|---|---|---|
| `create_task` | Crea una tarea. Fechas relativas resueltas contra la TZ del usuario. | No |
| `list_tasks` | Lista con filtros: status, rango de fechas, prioridad. | No |
| `update_task` | Cambia fecha, título, notas, prioridad o estado de una tarea existente. | No |
| `complete_task` | Marca como hecha. | No |
| `delete_task` | Elimina permanentemente. | **Sí** |
| `remember` | Guarda un hecho de largo plazo sobre el usuario. | No |
| `recall` | Busca en memorias. | No |

**Regla de fechas:** el modelo nunca calcula fechas absolutas por su cuenta. El
system prompt inyecta la fecha/hora actual y la TZ, y `create_task` acepta ISO 8601.
Ambigüedades ("el martes") se resuelven en el handler, no en el modelo. No hay tool
`get_current_time`: sería una vuelta más del bucle para un dato que ya viaja en el
prompt.

### Flujo de confirmación

1. El modelo pide `delete_task({id})`.
2. El agente detecta `requiresConfirmation` y **no ejecuta**.
3. Se guarda la tool call pendiente en KV (TTL 15 min). Confirmar la consume:
   pulsar dos veces no ejecuta dos veces.
4. Se envía inline keyboard: `✅ Confirmar` / `❌ Cancelar`.
5. El `callback_query` recupera la llamada pendiente y ejecuta o descarta.

Motivo: "borra la tarea de mañana" con tres tareas mañana es un fallo silencioso
e irreversible. El modelo se equivoca; la confirmación lo contiene.

---

## 8. Loop agéntico

```
messages = [system, ...memorias, ...historial, userMessage]

para i en 1..MAX_AGENT_ITERATIONS (3):
    si no queda presupuesto de tiempo: cortar con un mensaje honesto
    res = llm.chat(messages, toolSchemas, {timeoutMs: lo que quede, máx 15 s})
    si res.finishReason != 'tool_calls': devolver res.content
    messages.push(assistant con tool_calls)
    para cada tc en res.toolCalls:
        si requiresConfirmation: guardar pendiente, salir del loop, pedir confirmación
        result = ejecutar(tc)  # try/catch → los errores vuelven como contenido de tool
        log(tc, result)
        messages.push({role:'tool', tool_call_id: tc.id, content: JSON(result)})

si se agotan las iteraciones: pedir al modelo una respuesta final sin tools
```

**Por qué el límite:** sin tope, un modelo confundido llama tools en bucle y
quema la cuota en una sola conversación. Bajado de 5 a 3 porque cada vuelta es una
llamada al modelo y las tres deben caber en el presupuesto de tiempo del mensaje.

**Errores de tool:** nunca se propagan como excepción al usuario. Se devuelven al
modelo como `{ok:false, error}` para que se autocorrija o lo explique.

---

## 9. Seguridad

| Vector | Mitigación |
|---|---|
| Bot público — cualquiera puede escribirle | Whitelist `ALLOWED_TELEGRAM_IDS`. Los no autorizados se ignoran en silencio. |
| Webhook falso | `secret_token` en `setWebhook`, validado contra `X-Telegram-Bot-Api-Secret-Token` en cada petición. |
| Fuga de credenciales | Todo en `wrangler secret put`. `wrangler.toml` no contiene secretos y va a git. |
| Acceso directo a la DB | RLS activa en todas las tablas. Solo `service_role`, solo desde el Worker. |
| Doble ejecución por reintento | Dedupe de `update_id` en KV, TTL 24h. |
| Prompt injection vía contenido | Los handlers validan a mano los argumentos del modelo (`tools/types.ts`); nunca se construye SQL desde texto del modelo. Sin Zod: son siete herramientas y no justifica la dependencia. |
| Agotamiento de cuota | La whitelist es la defensa real, y `MAX_AGENT_ITERATIONS` acota el gasto por mensaje. No hay contador diario: con un solo usuario autorizado no hay a quién limitar. |

### Variables de entorno

```
# Secrets — se ponen una vez y sobreviven a todos los deploys
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
ALLOWED_TELEGRAM_IDS      # secret, no var: el repo es público
OPENAI_API_KEY            # LLM y transcripción, la misma clave
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GROQ_API_KEY              # opcional, solo si LLM_PROVIDER = "groq"
NVIDIA_API_KEY            # opcional, solo si LLM_PROVIDER = "nvidia"

# Vars (wrangler.toml) — se SOBRESCRIBEN en cada deploy
LLM_PROVIDER = "openai"
LLM_MODEL    = "gpt-4o-mini"
STT_PROVIDER = "openai"       # o "workers-ai" (gratis, dentro de Cloudflare)
STT_MODEL    = "whisper-1"
STT_LANGUAGE = "es"           # fijarlo acierta más que autodetectar
DEFAULT_TIMEZONE     = "Europe/Madrid"
BRIEFING_HOUR        = "8"    # hora LOCAL del briefing diario, 0-23
MAX_AGENT_ITERATIONS = "3"
HISTORY_WINDOW       = "30"   # filas de `messages`, no intercambios: un turno con
                              # herramientas gasta cuatro o cinco
LOG_LEVEL            = "info"
```

> Editar una var en el dashboard no sirve: el siguiente push la revierte al valor
> de `wrangler.toml`. Los secrets funcionan al revés y los deploys no los tocan.

### Despliegue

**Cloudflare Workers Builds** conectado a `jcm-developer/jarvis`. Cada push a `main`
ejecuta `npm run typecheck` y, solo si pasa, `npx wrangler deploy`. El typecheck actúa
de barrera: un push que no compila no llega a producción.

### Bindings

```toml
[ai]
binding = "AI"                    # Workers AI (Whisper)

[[kv_namespaces]]
binding = "STATE"                 # dedupe, confirmaciones pendientes, cuotas

[triggers]
crons = ["0 * * * *"]             # briefing y recordatorios
```

---

## 10. Audio

1. `message.voice.file_id` → `getFile` → `https://api.telegram.org/file/bot<token>/<path>`
2. Descarga (`ArrayBuffer`). Límite duro: **rechazar > 20 MB** (tope de la API de Telegram).
3. Transcripción, con el proveedor que diga `STT_PROVIDER`:
   - `openai` (en producción): `POST /audio/transcriptions` con `whisper-1`. Acepta el
     OGG/Opus de Telegram sin convertir y acierta más en español.
   - `workers-ai`: `env.AI.run('@cf/openai/whisper-large-v3-turbo', ...)`. Gratis y sin
     salto de red, pero peor con audio de móvil en español.
4. Transcripción → misma ruta que un mensaje de texto, con `source='voice'`.
5. Se guarda `transcript_raw` para depurar cuando el agente entienda algo raro.

Si la transcripción viene vacía o falla, se responde pidiendo repetir — nunca se
manda una cadena vacía al LLM.

**Reparto del presupuesto** (topes que cada paso pide al `Deadline`, no fijos):
descarga 15 s, transcripción 10 s, cada llamada al modelo 15 s. El paso peor
escalado es la descarga: el servidor de ficheros de Telegram tarda varios segundos
con notas de voz largas, y por encima de ~20 s de audio el mensaje puede no caber
en el presupuesto. Cuando pasa, el bot lo dice y pide trocear.

---

## 11. Restricciones del free plan

| Recurso | Límite | ¿Aprieta? |
|---|---|---|
| Workers requests | 100.000/día | No |
| Workers CPU | 10 ms/petición | **No** — la espera de red (LLM, Supabase) no cuenta como CPU |
| Workers AI | ~10.000 Neurons/día | No aplica: la transcripción va por OpenAI. Solo cuenta con `STT_PROVIDER = "workers-ai"` |
| KV escrituras | 1.000/día | Justo. Una por mensaje (dedupe) más una al día (marca del briefing); no añadir más |
| Cron triggers | Incluidos | No |
| Supabase | 500 MB | No |
| OpenAI | Créditos de pago, sin cola | No aprieta. `gpt-4o-mini` sale a céntimos al mes con este volumen |
| `waitUntil` tras responder | ~30 s, y luego cancela | **Sí** — es el techo que marca todo el diseño |

### El tiempo: dos límites opuestos (Fases 1 y 3)

Este punto costó dos iteraciones y es la restricción que más ha moldeado el código.
Estamos entre dos paredes:

- **Si esperamos a terminar antes de responder, corta Telegram.** Medido en
  producción: reintenta a los ~4 s y, al desconectarse el cliente, Cloudflare cancela
  la ejecución. Silencio total.
- **Si procesamos en `waitUntil()` sin control, corta Cloudflare.** Pasado un margen
  tras la respuesta las tareas mueren así:

```
(warn) waitUntil() tasks did not complete within the allowed time
after invocation end and have been cancelled.
```

Con NVIDIA tardando 45 s no había hueco entre ambas paredes: se probó a *awaitar* el
procesamiento y respondía Telegram cortando antes. Al pasar a OpenAI la respuesta bajó
a 2-5 s y sí cabe, así que el diseño actual es **200 OK inmediato + trabajo en
`ctx.waitUntil()`** con un presupuesto global de **27 s**
([src/lib/deadline.ts](src/lib/deadline.ts)) que deja margen para enviar un mensaje de
error honesto si algún paso se pasa. Cada paso pide al `Deadline` lo que queda del
reloj en vez de fijar su propio tope: tres pasos de 20 s cumplen sus timeouts
individuales y aun así se salen del presupuesto conjunto.

El dedupe de `update_id` estaba desde el día 1 y por eso esto es viable: si Telegram
reintenta un update que ya estamos procesando, no se ejecuta dos veces.

**Ruta de migración si aprieta:** el paso a Workers Paid ($5/mes) habilita Queues
con reintentos y dead-letter queue. El cambio afecta solo a `index.ts`; el resto del
código no se toca. Está diseñado así a propósito.

---

## 12. Proactividad: el cron

Un Cron Trigger cada hora (`0 * * * *`) y dos trabajos independientes por usuario,
cada uno con su `try`: que falle un aviso no debe dejar al usuario sin el otro.

El `scheduled` **awaita** su trabajo en vez de mandarlo a `waitUntil()`. Aquí no hay
respuesta que devolver, así que no existe el margen corto que obliga a la gimnasia
del webhook. Aun así lleva presupuesto (25 s): una llamada colgada no debe dejar el
briefing a medias.

A quién se escribe sale del cruce de `users` y `conversations`, filtrado por
`ALLOWED_TELEGRAM_IDS`. **La whitelist se vuelve a comprobar aquí a propósito:** es
el único camino del código en el que no hay un update de Telegram que validar, así
que si nadie mira la lista, un usuario retirado seguiría recibiendo mensajes.

### Briefing diario

Sale a la hora **local** del usuario (`BRIEFING_HOUR`, por defecto las 8). El cron
dispara en UTC, así que la hora local se calcula en cada ejecución con `Intl`
([src/lib/localtime.ts](src/lib/localtime.ts)) y no con un offset fijo: España
cambia de horario dos veces al año, y un cron a las 06:00 UTC sería las 7 en
invierno y las 8 en verano.

- **Una vez al día**, con marca en KV `briefing:<userId>:<fecha local>` y TTL de 48 h.
  La fecha de la clave es la local, no la UTC: es la que define "hoy" para quien lee.
  Una escritura de KV al día no se nota en el presupuesto de 1.000.
- **La ventana de envío son 3 horas**: con `BRIEFING_HOUR = 8`, se manda en el disparo
  de las 8, las 9 o las 10. Si el primero se pierde, el siguiente lo recupera. Sin
  ventana no habría briefing ese día; sin límite llegaría un "buenos días" a medianoche.
- **El texto se compone en código, sin pasar por el modelo.** Es una lista de tareas
  con fechas: el LLM no añade nada y sí añade coste, latencia y la posibilidad de
  inventarse una tarea. El briefing tiene que ser aburrido y exacto.
- Contenido: vencidas, lo que vence hoy con su hora, y las de prioridad alta sin
  fecha. Las pendientes sin fecha ni prioridad no entran: es el día, no el inventario.

### Recordatorios de vencimiento

Cada ejecución busca tareas `pending` que vencen en la próxima hora y que no tienen
`reminded_at`. La ventana es de una hora porque el cron corre cada hora: más corta
dejaría caer entre dos disparos lo que vence a y media.

- `reminded_at` (columna que estaba en el esquema desde la Fase 2) es lo que evita
  repetir el aviso cada hora hasta que la tarea se complete.
- **Se marca después de enviar, nunca antes.** Si el envío falla, la tarea sigue sin
  marcar y el aviso se reintenta a la hora siguiente. Al revés, un 500 de Telegram
  se convertiría en un recordatorio que nunca llega.
- Tope de 10 por ejecución. La primera vez que esto corre, todo lo vencido de antes
  entra en el lote, y no queremos que llegue como una avalancha.
- **`update_task` pone `reminded_at` a null cuando cambia la fecha.** Sin eso, aplazar
  una tarea de la que ya se avisó la dejaría sin recordatorio para siempre: el cron
  solo mira las que lo tienen a null.

Los mensajes proactivos se guardan en `messages` como turnos del asistente. Sin eso,
un "hecho" o un "posponlo" como respuesta al aviso no tendría referente en el
contexto y el modelo preguntaría de qué se le habla.

Una tarea que vence dentro de la misma hora del briefing sale en los dos mensajes.
Se acepta: son cosas distintas —planificar el día y avisar de lo inminente— y
suprimir el recordatorio dejaría sin aviso justo lo más urgente del día.

---

## 13. Roadmap

| Fase | Alcance | Estado |
|---|---|---|
| **0** | Scaffold, webhook, guard de seguridad, echo | ✅ Hecha |
| **1** | Provider NVIDIA + conversación de texto | ✅ Hecha |
| **2** | Registry de tools + tareas en Supabase + confirmaciones | ✅ Hecha |
| **3** | Audio con Whisper | ✅ Hecha |
| **4** | Historial en Supabase + memoria de largo plazo | ✅ Hecha |
| **5** | Cron: briefing matutino y recordatorios de vencimiento | ✅ Hecha |

Cada fase se despliega y se usa por separado. Fase 2 es donde deja de ser un
chatbot y pasa a ser un asistente; fase 5 es donde se vuelve proactivo.

Con la Fase 5 cerrada, el roadmap inicial está completo. Lo que venga sale de la
lista de abajo, y ya no por orden.

### Ideas para después

- Más dominios de tools: notas, gastos, calendario (CalDAV/Google), listas de compra.
- Búsqueda web como tool.
- Respuesta en audio (TTS) para contestar a los audios en el mismo formato.
- Imágenes → modelo con visión (facturas, pizarras).
- Panel web en Cloudflare Pages leyendo de Supabase.
- Embeddings en `memories` (`pgvector`) cuando el recall por clave se quede corto.
