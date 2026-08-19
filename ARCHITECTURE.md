# Jarvis — Asistente personal por Telegram

Documento de arquitectura. Fuente de verdad de las decisiones técnicas.
Última revisión: 2026-08-19.

---

## 1. Qué es

Un agente de IA al que se le escribe o se le manda audios por Telegram. El agente
razona, decide qué herramientas ejecutar (crear tareas, apuntar citas en el
calendario, consultar, recordar cosas) y responde. Todo corre en Cloudflare Workers, sin servidor propio, con Supabase
como base de datos.

**Usuario único** (o lista blanca corta). No es un producto multi-tenant.

---

## 2. Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Plan Cloudflare | **Free** | Uso personal. 200 OK inmediato y trabajo en `waitUntil()` acotado (ver §11). Migrable a Queues sin rediseñar. |
| Proveedor LLM | **OpenAI** (`gpt-4.1-mini`) tras capa de abstracción | Se empezó con NVIDIA NIM por su free tier y no aguantó producción: encolaba las peticiones y un saludo se iba de 45 s. La capa se queda: el motivo por el que existe sigue vigente. |
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

Cron Trigger (cada 5 min, UTC) ──▶  ¿toca briefing en hora local?  ──▶ sendMessage
                               └─▶  ¿toca algún aviso ya?           ──▶ sendMessage
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
│  │  ├─ localtime.ts          # hora local del usuario (Intl, cambios de hora)
│  │  └─ relative-time.ts      # "en 5 minutos" leído del mensaje del usuario
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
│  │  ├─ guardrails.ts         # correcciones a lo que manda el modelo (fechas, títulos)
│  │  ├─ tasks.ts              # create/list/update/complete/delete_task
│  │  ├─ calendar.ts           # create_event
│  │  ├─ memory.ts             # remember, recall
│  │  └─ pending.ts            # acciones a la espera de confirmación (KV)
│  │
│  ├─ stt/
│  │  ├─ provider.ts           # interfaz Transcriber
│  │  ├─ index.ts              # selección por env
│  │  ├─ openai.ts             # Whisper de OpenAI
│  │  └─ workers-ai.ts         # Whisper en el propio Worker
│  │
│  ├─ calendar/
│  │  ├─ provider.ts           # interfaz CalendarClient (solo escritura)
│  │  ├─ index.ts              # selección de proveedor
│  │  ├─ google.ts             # Google Calendar por REST
│  │  └─ google-auth.ts        # JWT RS256 con WebCrypto + token cacheado en KV
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
  remind_at       timestamptz,             -- cuándo avisar, si no es al vencer
  priority        smallint not null default 2 check (priority between 1 and 3), -- 1 alta
  status          text not null default 'pending'
                    check (status in ('pending','done','cancelled')),
  completed_at    timestamptz,
  reminded_at     timestamptz,             -- evita recordatorios duplicados
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on tasks (user_id, status, due_at);
create index on tasks (user_id, status, remind_at);

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
| `openai` (**en producción**) | `https://api.openai.com/v1` | `gpt-4.1-mini` | `OPENAI_API_KEY` |
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
| `create_task` | Crea una tarea, con fecha límite y hora de aviso opcionales, en ISO o en minutos desde ahora. Rechaza duplicados. | No |
| `list_tasks` | Lista con filtros: status, rango de fechas, prioridad. | No |
| `update_task` | Cambia fecha límite, hora de aviso, título, notas, prioridad o estado de una tarea existente. Reabre el aviso si cambia una fecha. | No |
| `complete_task` | Marca como hecha. | No |
| `delete_task` | Elimina permanentemente. | **Sí** |
| `create_event` | Crea una cita en el calendario, con hora o de día completo. | No |
| `list_events` | Citas de un rango de días, con búsqueda por texto. Da los ids. | No |
| `update_event` | Cambia hora, día, título o sitio de una cita. Conserva lo que no se toca. | No |
| `delete_event` | Borra una cita permanentemente. | **Sí** |
| `remember` | Guarda un hecho de largo plazo sobre el usuario. | No |
| `recall` | Busca en memorias. | No |

### Regla de fechas

El modelo no calcula fechas. Suena a precaución teórica y no lo es: `gpt-4o-mini`
fechó una tarea de "en 5 minutos" **al día siguiente** —hora correcta, día equivocado,
copiado del año-mes-día de otra tarea del historial—, y el aviso se quedó esperando 24
horas. Cuatro medidas, en orden inverso al que se probaron:

1. **Lo que dijo el usuario manda, y lo aplica el handler.** Dos casos, y hubo que
   cubrir los dos porque el modelo falla igual en ambos:
   - **Plazos.** `lib/relative-time.ts` lee "en 5 minutos", "dentro de media hora" o
     "en un par de horas" del mensaje y fija la fecha con la hora real del Worker.
   - **Horas concretas.** "Avísame a las 13:14" no lleva día, así que el día es hoy.
     Se conserva la hora que puso el modelo —eso lo hace bien— y se le cambia el día,
     rodando a mañana si esa hora ya pasó. Si el mensaje **sí** menciona otro día
     ("el jueves", "el 19 de septiembre", "la semana que viene"), no se toca nada.

   Solo se corrige cuando la desviación pasa de diez minutos, y nunca sin mensaje del
   usuario: en el camino de los botones de confirmación no hay texto que interpretar y
   corregir a ciegas sería inventarse la intención.
2. **Plazos relativos como parámetro.** `create_task` y `update_task` aceptan
   `due_in_minutes` y `remind_in_minutes`. Cuando el modelo los usa, no hay aritmética
   de calendario que pueda salir mal. El problema es que muchas veces no los usa.
3. **Anclas en el prompt.** Además de la fecha en castellano se inyecta el instante en
   ISO 8601 con desplazamiento (`2026-08-18T12:27:00+02:00`) y las fechas de hoy y
   mañana sueltas. Ayuda, pero no es suficiente por sí solo.
4. **Que diga la fecha que guardó.** El prompt le pide repetir en la respuesta la fecha
   tal como la devolvió la herramienta, para que el usuario detecte el error en el acto.

Las ambigüedades del tipo "el martes" siguen resolviéndose contra la TZ del usuario. No
hay tool `get_current_time`: sería una vuelta más del bucle para un dato que ya viaja
en el prompt.

### Guardarraíles en los handlers

La lección de la fase de pruebas, y probablemente la más importante del proyecto:
**una regla que el modelo tiene que cumplir voluntariamente no es una garantía.** Con
`gpt-4o-mini` se documentaron tres reglas explícitas —no dupliques tareas, no titules
"Recordar X", usa los campos en minutos— y las tres se incumplieron en el mismo turno,
con el prompt nuevo ya en producción. Lo que el sistema no puede permitirse se hace
cumplir en código, y el prompt se queda como ayuda, no como control.

| Guardarraíl | Qué impide |
|---|---|
| El plazo del mensaje corrige la fecha del modelo | Avisos fechados mañana |
| Sin día en el mensaje, la hora del modelo se lleva al día de hoy | Lo mismo, cuando el usuario dice una hora concreta |
| `create_task` limpia los títulos "Recordar X" / "Avisar de X" | Tareas que se llaman como su propio aviso |
| `create_task` rechaza una tarea que repite las palabras de otra pendiente, y devuelve el id de la existente | Filas duplicadas para la misma cosa |
| En un evento de día completo, la corrección de día no se aplica | Que un "todo el día" del 25 acabe hoy: sin hora, la premisa del corrector no existe |
| `update_event` manda solo los campos que cambian | Borrar el sitio o las notas que el usuario puso desde el móvil |
| Mover una cita sin decir duración lee la que tenía | Convertir "muévela al viernes" en una cita de otra longitud |

El rechazo del duplicado no es un `throw`: es un `{ok: false, error}` que le dice al
modelo qué id tiene que usar con `update_task`, así que se corrige en la vuelta
siguiente del bucle. Tiene escape: `force: true` para cuando de verdad son dos cosas
distintas. Cuesta un SELECT antes del INSERT, que a esta escala no se nota.

Los guardarraíles se quedan, pero la conclusión práctica fue **cambiar de modelo**.
`gpt-4o-mini` era el problema tanto como el diseño, así que en producción va
`gpt-4.1-mini`.

| Modelo | Entrada | Entrada cacheada | Salida |
|---|---|---|---|
| `gpt-4o-mini` | 0,15 $/M | 0,075 $/M | 0,60 $/M |
| `gpt-4.1-mini` | 0,40 $/M | 0,10 $/M | 1,60 $/M |

De lista es 2,7 veces más caro; en la práctica, mucho menos. Nuestra carga es ~97%
tokens de entrada y la mayor parte es el prefijo estable —prompt y esquemas de
herramientas—, que va al precio cacheado: ahí la diferencia es del 33%. La salida son
30-60 tokens por respuesta y no mueve la aguja. A un volumen de uso personal el salto
es de unos pocos euros al mes, y cambiarlo son dos líneas de `wrangler.toml`.

### El system prompt

Personalidad y reglas de negocio, nunca la descripción de las herramientas: eso va
como JSON Schema en el campo `tools`, y duplicarlo en prosa garantiza que las dos
versiones se desincronicen.

Tiene tres partes y el orden no es estético:

1. **Qué puede y qué NO puede hacer**, enumerado. Sin esa lista el modelo ofrecía
   buscar en internet y prometía "estar pendiente" de avisos que no había programado.
   Declarar los límites sale más barato que arreglar una promesa incumplida.
2. **Reglas de herramientas y de estilo**: texto plano (Telegram no renderiza nuestro
   markdown), contar solo lo que la herramienta devolvió, sin halagos, y **preguntar
   antes que suponer**. Esto último es una preferencia explícita del usuario: ante dos
   tareas que encajan, un día ambiguo o la duda entre crear y actualizar, una pregunta
   corta gana a acertar por casualidad. Cuando sí decide solo, tiene que decir qué ha
   dado por supuesto en la misma frase.
3. **Lo volátil, al final**: memorias y contexto temporal. OpenAI cachea el prefijo
   común entre peticiones y cobra la mitad por esa parte; el prefijo se corta en el
   primer carácter que difiere, así que la hora —que cambia cada minuto— puesta arriba
   invalidaría el prompt entero en cada mensaje. Con ~97% de tokens de entrada, eso se
   nota en la factura.

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

**Y se quedan en el historial, con un efecto secundario que costó una prueba entera.**
Al configurar el calendario, la primera llamada devolvió "el calendario no está
configurado", y esa frase se persistió en `messages` como resultado de herramienta. En
los turnos siguientes el modelo la leía y contestaba de memoria **sin volver a llamar a
la herramienta**: `finish_reason=stop` con la lista de `tool_calls` vacía, aunque el
secret que faltaba ya estuviera puesto. Insistir no servía; hizo falta un `/reset`.

Es coherente con cómo funciona un LLM —el contexto dice que eso no se puede hacer— pero
tiene una consecuencia práctica: **al arreglar una configuración, hay que borrar la
conversación antes de volver a probar**, o la prueba mide el historial y no el arreglo.
No se corrige en código: filtrar los errores del historial le quitaría al modelo la
memoria de lo que ya intentó, que es justo lo que evita que repita acciones.

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
GOOGLE_SA_EMAIL           # calendario: client_email de la service account
GOOGLE_SA_PRIVATE_KEY     # calendario: private_key del mismo JSON, PEM incluido
GOOGLE_CALENDAR_ID        # calendario: el id del calendario compartido, nunca "primary"
GROQ_API_KEY              # opcional, solo si LLM_PROVIDER = "groq"
NVIDIA_API_KEY            # opcional, solo si LLM_PROVIDER = "nvidia"

# Vars (wrangler.toml) — se SOBRESCRIBEN en cada deploy
LLM_PROVIDER = "openai"
LLM_MODEL    = "gpt-4.1-mini"
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
descarga 6 s por intento con un reintento, transcripción 10 s, cada llamada al
modelo 15 s. `getFile` y la descarga comparten ese tope en vez de tener cada uno
el suyo: cuando `getFile` gastaba 8 s propios por fuera, una descarga "dentro de
tope" podía llevarse 23 s de los 27 y dejar al modelo sin tiempo para responder.

La descarga tuvo 15 s por el diagnóstico de que las notas largas tardaban más.
No se sostiene: Telegram las manda en OGG/Opus a ~16 kbps, así que un minuto de
audio son ~120 KB. Los fallos de descarga son picos puntuales del servidor de
ficheros, no cuestión de tamaño, y por eso pasaban con el mismo audio unas veces
sí y otras no. Se corta antes y se reintenta una vez, solo si queda presupuesto
para transcribir y contestar después. Si aun así falla, el bot lo dice sin
inventarse la causa, y el log `voice_download_failed` lleva duración, tamaño,
tiempo gastado y presupuesto restante para poder mirarlo.

---

## 11. Restricciones del free plan

| Recurso | Límite | ¿Aprieta? |
|---|---|---|
| Workers requests | 100.000/día | No |
| Workers CPU | 10 ms/petición | **No** — la espera de red (LLM, Supabase) no cuenta como CPU |
| Workers AI | ~10.000 Neurons/día | No aplica: la transcripción va por OpenAI. Solo cuenta con `STT_PROVIDER = "workers-ai"` |
| KV escrituras | 1.000/día | Justo. Una por mensaje (dedupe) más una al día (marca del briefing); no añadir más |
| Cron triggers | Incluidos, hasta 1 min de granularidad | No. Cada 5 min son 288 invocaciones al día |
| Supabase | 500 MB | No |
| OpenAI | Créditos de pago, sin cola | No aprieta: unos pocos euros al mes a este volumen (ver §6) |
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

Un Cron Trigger cada cinco minutos (`*/5 * * * *`) y dos trabajos independientes por
usuario, cada uno con su `try`: que falle un aviso no debe dejar al usuario sin el otro.

**Empezó siendo cada hora en punto y no servía.** Un "recuérdamelo a las 12:10" pedido
en un mensaje de las 12:07 no podía salir antes de las 13:00, casi una hora tarde: la
precisión de un aviso no puede ser peor que el periodo del cron. Cada cinco minutos son
288 invocaciones al día frente a las 100.000 del plan free, y no añaden ni una escritura
de KV, porque lo único que se escribe ahí es la marca del briefing, una vez al día.

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

### Recordatorios

Hay **dos clases de aviso** y no se miden con la misma vara:

| Clase | Campo | Cuándo sale | Por qué |
|---|---|---|---|
| A la hora pedida | `remind_at` | En los 5 min siguientes a esa hora | "Recuérdamelo a las 12:10" tiene que llegar a las 12:10 |
| Antes de vencer | `due_at` sin `remind_at` | 1 h antes del vencimiento | Avisar justo al vencer no da margen para nada |

Son dos consultas en paralelo, no una con `or`: los conjuntos son disjuntos —una exige
`remind_at`, la otra que sea nulo—, así que no hay nada que deduplicar y cada filtro usa
sintaxis PostgREST ya probada en el resto del código. Aun así el merge deduplica por id,
que es barato y evita que un cambio futuro en un filtro se traduzca en avisos repetidos.

`remind_at` existe para no convertir un aviso en una tarea aparte. Sin ese campo, "llamo
a David a las 17:30, recuérdamelo a las 12:10" solo se podía representar creando una
segunda tarea "recordar llamar a David", que es lo que hacía el modelo: dos filas para
una sola cosa que hacer.

- `reminded_at` es lo que evita repetir el aviso en cada disparo hasta que la tarea se
  complete.
- **Se marca después de enviar, nunca antes.** Si el envío falla, la tarea sigue sin
  marcar y el aviso se reintenta al disparo siguiente. Al revés, un 500 de Telegram se
  convertiría en un recordatorio que nunca llega.
- Tope de 10 por ejecución. La primera vez que esto corre, todo lo vencido de antes
  entra en el lote, y no queremos que llegue como una avalancha.
- **`update_task` pone `reminded_at` a null cuando cambia cualquiera de las dos fechas.**
  Sin eso, aplazar una tarea de la que ya se avisó la dejaría sin recordatorio para
  siempre: el cron solo mira las que lo tienen a null.

### Cómo suenan los avisos

El texto se escribe en código, no con el modelo, pero eso no es excusa para que suene
a máquina. La primera versión decía `Recordatorio: "Llamar a David a las seis" venció
a las 13:25` y en el chat se leía como una alarma de sistema: comillas alrededor del
título, el verbo "vencer" y la hora repetida aunque fuera la de ese mismo instante.

Ahora sale como lo diría una persona:

```
Acuérdate de llamar a David a las 18:00.
Oye, acuérdate de llamar a mamá.
Se te ha pasado pagar la luz, era ayer a las 09:00.

Tienes tres cosas encima:

- pagar la luz ayer a las 09:00 (se te ha pasado)
- llamar a David a las 18:00
- sacar la basura
```

Cuatro detalles que hacen la diferencia, y ninguno necesita un LLM:

- **La hora solo se dice si aporta.** Nada si el aviso es para ahora mismo, nada si el
  título ya la lleva ("Llamar a David a las seis" con un "a las 13:25" detrás confunde
  más que ayuda).
- **Días con nombre**: "ayer", "mañana", "el 20 de agosto a las 09:00". No `20 ago, 09:00`.
- **Un aviso a la hora pedida no es un incumplimiento.** "Vencido" se reserva para lo
  que de verdad se pasó hace rato.
- **La frase de entrada varía** entre tareas, elegida por el id, no al azar: el mismo
  aviso repetido se lee igual, y dos avisos distintos no suenan calcados.

Los mensajes proactivos se guardan en `messages` como turnos del asistente. Sin eso,
un "hecho" o un "posponlo" como respuesta al aviso no tendría referente en el
contexto y el modelo preguntaría de qué se le habla.

Una tarea que vence dentro de la misma hora del briefing sale en los dos mensajes.
Se acepta: son cosas distintas —planificar el día y avisar de lo inminente— y
suprimir el recordatorio dejaría sin aviso justo lo más urgente del día.

---

## 13. Calendario

Cuatro herramientas: `create_event`, `list_events`, `update_event` y `delete_event`.

**La Fase 6 fue solo escritura y duró un mensaje.** Nada más probarla llegó un "bórrala
que al final no puedo ir", y luego un "pues muévela al viernes": el bot contestó bien
—dijo que no podía en vez de fingir— pero una cita mal puesta solo se arreglaba desde el
móvil, que es exactamente el trabajo que este proyecto existe para ahorrar. La Fase 7
añadió leer, modificar y borrar.

Lo que sigue fuera es la lectura **masiva** para el briefing: eso sí arrastra tokens de
sincronización incremental, expansión de recurrentes y zonas horarias de las
recurrencias. Buscar "el dentista del jueves" en un rango de fechas no arrastra nada de
eso, y el scope `calendar.events` que ya usábamos lo permitía sin tocar nada en Google.

`create_event` es una tool aparte de `create_task` y no un campo suyo. La frontera es
si la cosa ocupa un hueco del día a una hora concreta —el médico el jueves a las diez—
o es algo que hay que hacer cuando se pueda —comprar pan—. Ahora que el modelo puede
mirar los dos sitios, el prompt le pide buscar en ambos antes de decir que algo no
existe: el primer intento de mover la cita falló porque buscó solo en tareas.

### Autenticación: service account, no OAuth de usuario

El flujo OAuth de usuario se descartó y el motivo es dedicado: una app de Google Cloud
en estado *Testing* emite refresh tokens que **caducan a los siete días**, así que el
bot se habría quedado muerto cada semana; y publicarla con el scope de Calendar exige
pasar la verificación de Google. Con una service account y el calendario personal
compartido con su email no caduca nada.

El precio es firmar un JWT RS256 a mano con WebCrypto y canjearlo por un access token
([src/calendar/google-auth.ts](src/calendar/google-auth.ts)). Tres detalles que
importan:

- **Scope `calendar.events`**, no `calendar`: puede crear y editar eventos, no
  administrar ni borrar calendarios. La service account además no tiene **ningún** rol
  de IAM, así que la clave no da acceso a nada más del proyecto.
- **El token se cachea en KV 55 minutos**, no 60: uno recién sacado de la caché tiene
  que sobrevivir a la petición que va a hacer con él. Son ~26 escrituras al día, lejos
  del límite de 1.000 que ya gasta el dedupe.
- **El `private_key` llega desde un secret en una sola línea, con `\n` literales**, que
  es como está en el JSON de Google. El parser acepta esa forma, la de saltos reales y
  la de comillas pegadas al copiar: es una cadena de 1.700 caracteres que se pega a
  mano una vez, y un fallo ahí se manifiesta como un `401 invalid_grant` que no explica
  nada.

Alternativas descartadas: **Google Tasks** encaja mejor con el nombre del producto pero
no admite service accounts, así que devuelve al refresh token que caduca. **CalDAV de
iCloud** sigue siendo el plan B —autenticación más simple, app-specific password y
Basic auth— pero obliga a descubrir la URL del calendario con `PROPFIND` y a escribir
iCalendar a mano: CRLF, plegado a 75 octetos, `DTSTART` con `TZID`, escapado del
`SUMMARY`. Falla en silencio, con el evento a la hora equivocada.

### La trampa de la organización

Google aplica de oficio en las organizaciones nuevas la política
`iam.disableServiceAccountKeyCreation` ("secure by default"), que **impide crear la
clave** con un diálogo que no dice que se pueda quitar. Se desactiva solo en este
proyecto, no en toda la organización:

```bash
gcloud resource-manager org-policies disable-enforce \
  iam.disableServiceAccountKeyCreation --project=<PROJECT_ID>
```

La consola cachea el estado, así que hay que recargar la pestaña antes de reintentar —o
crear la clave desde Cloud Shell, que no pasa por ahí.

### Modificar sin romper lo que no se pidió

Tres decisiones de `update_event`, todas nacidas de que el modelo manda lo que le apetece
y lo que hay en el calendario no lo puso él:

- **Solo viajan los campos que cambian.** Un `PATCH` con el objeto entero pondría a vacío
  la descripción, el sitio o los invitados que el usuario tenga puestos desde el móvil,
  sin que nadie lo haya pedido y sin dejar rastro. `undefined` es "no lo toques"; `null`
  es "bórralo".
- **Mover una cita lee antes su duración.** "Muévela al viernes" quiere decir la misma
  cita otro día, no una cita de otra longitud, y cuánto duraba solo lo sabe Google. Son
  dos llamadas —`GET` y luego `PATCH`— y cada una pide su tope al `Deadline` por
  separado.
- **`singleEvents=true` al listar**, que expande las series en repeticiones concretas. El
  id que devuelve es el de *esa* instancia, así que mover "el standup del lunes" no toca
  el resto de la serie. Es lo que queremos, pero el usuario no lo adivina: cuando el
  evento venía de una serie, el resultado lleva una nota para que el modelo lo diga.

`delete_event` va con confirmación por botones, como `delete_task`, y la pregunta se
construye leyendo el título del evento: "¿borro la cita 7f3a-...?" no lo revisa nadie. Si
no se puede leer, se pregunta en genérico — lo que no puede pasar es borrar sin preguntar.

### Varios días, y el día de más que no se le dice al usuario

Un "me voy del 23 al 26" es un evento de día completo de cuatro días, y en Google el
último día es **exclusivo**: se guarda como 23 → 27. Un off-by-one aquí no da ningún
error, solo un viaje que en el calendario acaba el 25.

Así que el modelo manda `end_date` con el último día **incluido**, que es lo que dice el
usuario, y el `+1` lo pone el handler. En la respuesta se vuelve a restar: al usuario se
le dice "del 23 de agosto al 26 de agosto", nunca el 27. Es el mismo reparto de trabajo
que con los plazos relativos — el modelo aporta lo que oyó, la aritmética la hace el
código.

Mover un evento así conserva los días que ocupaba. Sin eso, "pásalo a septiembre" dejaría
el viaje en un solo día, porque el patch reconstruye las dos fechas y solo una viene del
usuario.

Las fechas sueltas se suman en UTC, no con `Intl`: un 'YYYY-MM-DD' no es un instante, y
meter la zona horaria en medio es exactamente lo que hace que un viaje amanezca un día
antes.

### Categorías: el modelo elige el tipo, el código elige el color

Un viaje se ve de un color distinto en la app del calendario. La tool acepta una
`category` de una lista cerrada —viaje, trabajo, estudios, personal, salud, social— y el
handler la traduce a uno de los once `colorId` de Google.

**El reparto es deliberado y es el mismo de siempre en este proyecto:** dejarle al modelo
mandar el `colorId` daría los viajes de un color distinto cada semana. No hay forma de que
sea consistente con un número entre 1 y 11 a lo largo de meses de conversaciones, y un
color solo sirve si siempre es el mismo. Elige el tipo, que es lo que sabe deducir del
mensaje; la tabla la mantiene el código.

Una categoría desconocida no rompe la cita: se crea sin color, que es lo que pasaba antes
de que esto existiera. Y al listar, un `colorId` solo se traduce de vuelta si está en
nuestra tabla — los colores que el usuario haya puesto a mano desde la app no significan
nada aquí, y darles un nombre sería inventarse un dato.

### Repeticiones: y el alcance, que es lo peligroso

Un cumpleaños es un evento de día completo con `RRULE:FREQ=YEARLY`. El modelo elige la
frecuencia de una lista cerrada —anual, mensual, semanal, diario, laborables— y la cadena
la escribe el código, por el mismo motivo que con los colores pero con más razón: una
RRULE tiene su propia gramática, y una regla mal escrita **la API la acepta** y repite el
cumpleaños el día equivocado durante los próximos veinte años.

Añadir repeticiones obligó a arreglar algo antes de que existieran. Con
`singleEvents=true`, los ids que devuelve `list_events` son de **repeticiones concretas**,
así que un `delete_event` con ese id borra solo ese día: "borra el cumpleaños de mi
hermana" habría dejado los otros veinte años puestos, y el usuario no se enteraría hasta
el año siguiente. Por eso `update_event` y `delete_event` llevan `scope`:

| `scope` | Sobre qué actúa |
|---|---|
| `esta` (por defecto) | Solo esa repetición |
| `serie` | Todas, usando el `recurringEventId` que viene dentro del evento |

El defecto es el menos destructivo, y **el alcance va en el texto de la confirmación**, no
en una nota posterior: entre saltarse un cumpleaños y borrarlo para siempre no hay vuelta
atrás, y es exactamente lo que el botón está confirmando.

**Cambiar la hora de una serie entera no se hace.** Reanclar la serie desde aquí es donde
se rompe en silencio: una regla con días fijos —los laborables— movida a un sábado deja de
cuadrar con su propio patrón y desaparece una semana entera de citas sin ningún error. Se
puede mover una repetición suelta, o cambiarle a la serie el título, el sitio o la
categoría; para reprogramarla, la app del calendario. La herramienta lo dice en el error y
el prompt lo declara en la lista de límites, que sale más barato que gastar una iteración
en descubrirlo.

### El día completo no pasa por el corrector de fechas

`correctDay` parte de que el modelo acierta la **hora** y falla el día. En un evento de
día completo no hay hora, así que la premisa no existe: aplicárselo traía la cita a hoy
cuando el mensaje no nombraba un día que el detector reconociera. Ahora los "todo el día"
usan la fecha del modelo tal cual, que es lo que sí hace bien.

Ese fallo destapó otro más viejo, que afectaba también a las tareas:
`mentionsAnotherDay` reconocía "el 25 de agosto" pero exigía el "el", así que "pásalo
**al** 25 de agosto", "quedamos **para el** 3 de septiembre" y "la cita **del** 12 de
enero" se le escapaban, y con ellas el corrector cambiaba la fecha a hoy. Ahora basta un
número de día seguido de "de \<mes\>", con la lista de meses explícita para no confundir
"el capítulo 12 de la serie" con una fecha.

### Dos límites que no se arreglan con código

- **No se pueden invitar asistentes.** Una service account sin *domain-wide delegation*
  —que requiere Google Workspace, no una cuenta Gmail— no puede añadir invitados y la
  API lo rechaza. "Apúntame la cita" sí; "invita a David" no.
- **Los avisos de la cita los da Google Calendar**, con la configuración del propio
  calendario. Nuestro cron solo sabe de la tabla `tasks`, así que el prompt le prohíbe
  al modelo prometer un aviso de un evento como si lo fuera a mandar él.
- **Los eventos privados llegan sin título.** El permiso compartido que usamos es el que
  los muestra como hueco ocupado y nada más. Se puede mover y borrar uno —el id sí
  viaja—, pero no identificarlo por su nombre, así que `list_events` lo devuelve marcado
  como privado en vez de dejar que el modelo se invente de qué es. Subir el permiso a
  *Make changes and see all event details* lo resuelve, a cambio de darle a la
  credencial acceso de lectura a todo.

### Lo que comparte con las tareas

Los guardarraíles de fecha salieron de `tasks.ts` a
[src/tools/guardrails.ts](src/tools/guardrails.ts) sin cambiarlos: el modelo se
equivoca de día igual apuntando una cita que una tarea, y en una cita duele más porque
ocupa un hueco de la agenda que el usuario cree libre. `honourUserInstant` es la
variante de un solo campo —una cita empieza a una hora y no tiene el par
fecha-límite/aviso—; el reparto entre los dos campos que hace `honourUserDeadlines` no
aplica, las dos correcciones sí.

`ToolContext` ganó `env` y `deadline` aquí: es la primera herramienta que habla con un
servicio de fuera por su cuenta, y hasta ahora a los handlers les bastaba `db`. La
autenticación y la escritura **comparten un solo presupuesto** en vez de tener cada una
su tope, que es la misma lección que dejó el audio en §10. Por debajo de 3 s no se
intenta: decirle al usuario que lo repita es mejor que lanzar una escritura que
Cloudflare va a cancelar a mitad, dejándonos sin saber si el evento se creó.

---

## 14. Roadmap

| Fase | Alcance | Estado |
|---|---|---|
| **0** | Scaffold, webhook, guard de seguridad, echo | ✅ Hecha |
| **1** | Provider NVIDIA + conversación de texto | ✅ Hecha |
| **2** | Registry de tools + tareas en Supabase + confirmaciones | ✅ Hecha |
| **3** | Audio con Whisper | ✅ Hecha |
| **4** | Historial en Supabase + memoria de largo plazo | ✅ Hecha |
| **5** | Cron: briefing matutino y recordatorios de vencimiento | ✅ Hecha |
| **6** | Eventos en Google Calendar (escritura) | ✅ Hecha |
| **7** | Consultar, mover y borrar citas del calendario | ✅ Hecha |

Cada fase se despliega y se usa por separado. Fase 2 es donde deja de ser un
chatbot y pasa a ser un asistente; fase 5 es donde se vuelve proactivo.

Con la Fase 5 cerrada, el roadmap inicial está completo. La Fase 6 es el primer
añadido de después; el resto sale de la lista del final, y ya no por orden.

Las fases 6 y 7 salieron seguidas y en el mismo día: la 6 dejó el calendario en solo
escritura y la primera conversación real dejó claro que eso no se sostenía. Está contado
en §13, porque la lección no es sobre el calendario sino sobre por dónde se rompen los
alcances recortados.

### Ideas para después

- **El briefing contando las reuniones del día**, ahora que sabemos leer el calendario.
  Es la lectura masiva que sigue fuera: haría falta decidir qué hacer con las series y
  con las citas sin hora, y el briefing tiene que seguir siendo aburrido y exacto.
- Más dominios de tools: notas, gastos, listas de compra.
- Búsqueda web como tool.
- Respuesta en audio (TTS) para contestar a los audios en el mismo formato.
- Imágenes → modelo con visión (facturas, pizarras).
- Panel web en Cloudflare Pages leyendo de Supabase.
- Embeddings en `memories` (`pgvector`) cuando el recall por clave se quede corto.
