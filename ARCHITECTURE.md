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
| Plan Cloudflare | **Free** | Uso personal. Procesamiento dentro de la petición (ver §4). Migrable a Queues sin rediseñar. |
| Proveedor LLM | **NVIDIA NIM** tras capa de abstracción | Free tier para empezar; el free tier se agota y hay que poder cambiar por env var. |
| STT | **Workers AI Whisper** | Corre en el mismo Worker. Sin API key extra, sin salto de red. |
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
│  [2] Procesamiento DENTRO de la petición (await, no waitUntil)           │
│      el 200 OK se devuelve al terminar; ver §4                           │
│                                                                          │
│  [3] Normalización de entrada                                            │
│      ├─ texto      → tal cual                                            │
│      ├─ voz/audio  → getFile → descarga OGG → Workers AI Whisper → texto │
│      └─ otro       → respuesta "no soportado aún"                        │
│                                                                          │
│  [4] sendChatAction("typing")                                            │
│                                                                          │
│  [5] Construcción del contexto                                           │
│      system prompt + memorias + últimos N mensajes + mensaje actual       │
│                                                                          │
│  [6] Loop agéntico (máx 5 iteraciones)                                   │
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

Cron Trigger (cada hora)  ──▶  briefing / recordatorios  ──▶  sendMessage
```

---

## 4. Estructura de ficheros

```
jarvis/
├─ src/
│  ├─ index.ts                 # entrypoint: fetch (+ scheduled en la fase 5)
│  ├─ agent.ts                 # loop agéntico y confirmaciones
│  ├─ config.ts                # lectura y validación de env
│  ├─ types.ts                 # Env + tipos de la Telegram API
│  │
│  ├─ lib/
│  │  └─ deadline.ts           # presupuesto de tiempo compartido del mensaje
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
│  │  ├─ tasks.ts              # create/list/complete/delete_task
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
│  └─ cron/                    # fase 5
│     └─ briefing.ts
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

El punto que evita quedarnos atrapados en NVIDIA cuando se agote su free tier.

```ts
// src/llm/provider.ts
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  readonly name: string;
  chat(messages: LLMMessage[], tools: ToolSchema[]): Promise<LLMResponse>;
}
```

Selección en runtime por `LLM_PROVIDER` (`nvidia` | `groq` | `gemini`).
Cambiar de proveedor = cambiar una variable, no tocar `agent.ts`.

### NVIDIA NIM

- Base URL: `https://integrate.api.nvidia.com/v1`
- Es OpenAI-compatible → se usa el SDK `openai` con `baseURL` sobrescrito.
- **Modelo por defecto:** `meta/llama-3.3-70b-instruct`
- **Alternativa:** `nvidia/llama-3.3-nemotron-super-49b-v1`

> **Restricción importante.** No todos los modelos del catálogo NIM soportan
> `tools`. Si se cambia el modelo hay que verificar antes que soporte function
> calling, o el agente deja de funcionar entero. Rate limit del free tier
> ~40 req/min y créditos finitos.

### Planes B / C

`groq` (rápido, free tier generoso) y `gemini` (free tier muy generoso, 15 RPM).
Ambos implementan la misma interfaz. Groq es además OpenAI-compatible, así que
su adaptador es casi idéntico al de NVIDIA.

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
  db: SupabaseClient;
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
| `complete_task` | Marca como hecha. | No |
| `delete_task` | Elimina permanentemente. | **Sí** |
| `remember` | Guarda un hecho de largo plazo sobre el usuario. | No |
| `recall` | Busca en memorias. | No |
| `get_current_time` | Fecha/hora actual en la TZ del usuario. | No |

**Regla de fechas:** el modelo nunca calcula fechas absolutas por su cuenta. El
system prompt inyecta la fecha/hora actual y la TZ, y `create_task` acepta ISO 8601.
Ambigüedades ("el martes") se resuelven en el handler, no en el modelo.

### Flujo de confirmación

1. El modelo pide `delete_task({id})`.
2. El agente detecta `requiresConfirmation` y **no ejecuta**.
3. Se guarda la tool call pendiente en KV (`pending:<chat_id>`, TTL 5 min).
4. Se envía inline keyboard: `✅ Confirmar` / `❌ Cancelar`.
5. El `callback_query` recupera la llamada pendiente y ejecuta o descarta.

Motivo: "borra la tarea de mañana" con tres tareas mañana es un fallo silencioso
e irreversible. El modelo se equivoca; la confirmación lo contiene.

---

## 8. Loop agéntico

```
messages = [system, ...memorias, ...historial, userMessage]

para i en 1..MAX_ITERATIONS (5):
    res = llm.chat(messages, toolSchemas)
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
quema el free tier en una sola conversación.

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
| Prompt injection vía contenido | Los handlers validan sus argumentos con Zod; nunca se construye SQL desde texto del modelo. |
| Agotamiento de cuota | Contador diario de llamadas LLM por usuario en KV. |

### Variables de entorno

```
# Secrets — se ponen una vez y sobreviven a todos los deploys
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
ALLOWED_TELEGRAM_IDS      # secret, no var: el repo es público
NVIDIA_API_KEY
GROQ_API_KEY              # opcional
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

# Vars (wrangler.toml) — se SOBRESCRIBEN en cada deploy
LLM_PROVIDER = "nvidia"
LLM_MODEL    = "meta/llama-3.3-70b-instruct"
DEFAULT_TIMEZONE     = "Europe/Madrid"
MAX_AGENT_ITERATIONS = "5"
HISTORY_WINDOW       = "20"   # filas de `messages`, no intercambios: un turno con
                              # herramientas gasta cuatro o cinco

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
3. `env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: [...bytes] })`
4. Transcripción → misma ruta que un mensaje de texto, con `source='voice'`.
5. Se guarda `transcript_raw` para depurar cuando el agente entienda algo raro.

Si la transcripción viene vacía o falla, se responde pidiendo repetir — nunca se
manda una cadena vacía al LLM.

---

## 11. Restricciones del free plan

| Recurso | Límite | ¿Aprieta? |
|---|---|---|
| Workers requests | 100.000/día | No |
| Workers CPU | 10 ms/petición | **No** — la espera de red (LLM, Supabase) no cuenta como CPU |
| Workers AI | ~10.000 Neurons/día | No para uso personal |
| KV escrituras | 1.000/día | Justo. Queda una por mensaje (dedupe) desde que el historial se fue a Supabase; no añadir más |
| Cron triggers | Incluidos | No |
| Supabase | 500 MB | No |
| NVIDIA NIM | Créditos finitos, ~40 req/min | **Sí, es el cuello de botella real** |
| `waitUntil` tras responder | Margen corto, y luego cancela | **Sí** — nos costó un fallo intermitente |

### El fallo de `waitUntil` (Fase 1)

El diseño original respondía `200 OK` al instante y procesaba en `ctx.waitUntil()`,
para no agotar el timeout de Telegram. En producción apareció esto:

```
(warn) waitUntil() tasks did not complete within the allowed time
after invocation end and have been cancelled.
```

Cloudflare cancela esas tareas pasado un margen corto tras devolver la respuesta.
Con el modelo tardando 10-30 s, la tarea moría a media llamada: **sin respuesta, sin
excepción y sin log**. Un fallo intermitente y silencioso, el peor tipo — desde
Telegram solo se veía que "a veces no contesta".

**Solución:** el handler *awaita* el procesamiento y responde 200 al terminar. Dispone
de toda la vida de la petición, y la espera de red no consume CPU, que es lo que
limita el plan free. A cambio Telegram puede reintentar si tardamos mucho, y eso ya
lo cubre el dedupe de `update_id`.

Ese es exactamente el motivo por el que el dedupe estaba desde el día 1: sin él, este
cambio no habría sido viable.

**Ruta de migración si aprieta:** el paso a Workers Paid ($5/mes) habilita Queues
con reintentos y dead-letter queue. El cambio afecta solo a `index.ts`; el resto del
código no se toca. Está diseñado así a propósito.

---

## 12. Roadmap

| Fase | Alcance | Estado |
|---|---|---|
| **0** | Scaffold, webhook, guard de seguridad, echo | ✅ Hecha |
| **1** | Provider NVIDIA + conversación de texto | ✅ Hecha |
| **2** | Registry de tools + tareas en Supabase + confirmaciones | ✅ Hecha |
| **3** | Audio con Whisper | ✅ Hecha |
| **4** | Historial en Supabase + memoria de largo plazo | ✅ Hecha |
| **5** | Cron: briefing matutino y recordatorios de vencimiento | Pendiente |

Cada fase se despliega y se usa por separado. Fase 2 es donde deja de ser un
chatbot y pasa a ser un asistente; fase 5 es donde se vuelve proactivo.

### Ideas para después

- Más dominios de tools: notas, gastos, calendario (CalDAV/Google), listas de compra.
- Búsqueda web como tool.
- Respuesta en audio (TTS) para contestar a los audios en el mismo formato.
- Imágenes → modelo con visión (facturas, pizarras).
- Panel web en Cloudflare Pages leyendo de Supabase.
- Embeddings en `memories` (`pgvector`) cuando el recall por clave se quede corto.
