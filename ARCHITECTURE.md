# Jarvis — a personal assistant over Telegram

Architecture document. The source of truth for technical decisions.
Last revised: 2026-08-20.

---

## 1. What this is

An AI agent you write to, or send voice notes to, over Telegram. The agent reasons,
decides which tools to run (create tasks, put appointments on the calendar, look
things up, remember facts) and answers. It all runs on Cloudflare Workers, with no
server of our own, and Supabase as the database.

**Single user** (or a short whitelist). This is not a multi-tenant product.

---

## 2. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Cloudflare plan | **Free** | Personal use. Immediate 200 OK plus bounded work in `waitUntil()` (see §11). Migratable to Queues without a redesign. |
| LLM provider | **OpenAI** (`gpt-4.1-mini`) behind an abstraction layer | It started on NVIDIA NIM for the free tier and that did not survive production: it queued requests and a greeting took 45 s. The layer stays: the reason it exists still holds. |
| STT | **OpenAI Whisper** (`whisper-1`) | It accepts Telegram's OGG/Opus without conversion and is more accurate in Spanish. Workers AI remains as the free alternative behind an env var. |
| DB | **Supabase** | Managed Postgres, free tier, REST. |
| Language | **TypeScript** | Typing in the tool contracts, which is where mistakes hurt most. |

---

## 3. Flow diagram

```
Telegram
   │  POST /webhook  (update)
   ▼
┌─────────────────────────── Cloudflare Worker ───────────────────────────┐
│                                                                          │
│  [1] Guard                                                               │
│      ├─ verifies X-Telegram-Bot-Api-Secret-Token                         │
│      ├─ whitelist of telegram_user_id                                    │
│      └─ update_id dedupe in KV (TTL 24h)                                 │
│                                                                          │
│  [2] Immediate 200 OK + processing inside ctx.waitUntil()                │
│      bounded by a global budget of 27 s; see §11                         │
│                                                                          │
│  [3] Input normalisation                                                 │
│      ├─ text       → as is                                               │
│      ├─ voice      → getFile → download OGG → Whisper (OpenAI) → text    │
│      ├─ photo      → pick size → download JPEG → travels as an image     │
│      │              (caption = the message's text)                       │
│      └─ anything   → "not supported yet" reply                           │
│                                                                          │
│  [4] sendChatAction("typing")                                            │
│                                                                          │
│  [5] Building the context                                                │
│      system prompt + memories + last N messages + current message        │
│                                                                          │
│  [6] Agentic loop (max 3 iterations)                                     │
│      ┌──────────────────────────────────────────┐                        │
│      │ LLM.chat(messages, tools)                │                        │
│      │   ├─ finish_reason=stop      → exit      │                        │
│      │   └─ finish_reason=tool_calls            │                        │
│      │        ├─ requiresConfirmation? → pause  │──▶ inline keyboard      │
│      │        ├─ run handler → Supabase         │                        │
│      │        ├─ log to tool_call_logs          │                        │
│      │        └─ push result to messages ───────┘                        │
│      └──────────────────────────────────────────┘                        │
│                                                                          │
│  [7] Persistence + sendMessage                                           │
└──────────────────────────────────────────────────────────────────────────┘

Cron Trigger (every 5 min, UTC) ──▶  briefing due in local time?  ──▶ sendMessage
                                └─▶  any reminder due?            ──▶ sendMessage
```

---

## 4. File layout

```
jarvis/
├─ src/
│  ├─ index.ts                 # entrypoint: fetch (webhook) + scheduled (cron)
│  ├─ agent.ts                 # agentic loop and confirmations
│  ├─ config.ts                # env reading and validation
│  ├─ types.ts                 # Env + Telegram API types
│  │
│  ├─ lib/
│  │  ├─ deadline.ts           # time budget shared across a message
│  │  ├─ localtime.ts          # the user's local time (Intl, clock changes)
│  │  ├─ relative-time.ts      # "en 5 minutos" read from the user's message
│  │  ├─ recurrence.ts         # frequencies: the next occurrence of what repeats
│  │  ├─ events.ts             # shared shapes for calendar events
│  │  └─ slots.ts              # interval arithmetic: busy time and free gaps
│  │
│  ├─ telegram/
│  │  ├─ guard.ts              # secret token, whitelist, dedupe
│  │  ├─ client.ts             # sendMessage, sendChatAction, getFile, answerCallbackQuery
│  │  ├─ photos.ts             # which of Telegram's photo sizes gets downloaded
│  │  └─ handler.ts            # update router + commands
│  │
│  ├─ llm/
│  │  ├─ provider.ts           # LLMProvider interface  ◄── the abstraction layer
│  │  ├─ index.ts              # provider selection by env
│  │  └─ providers/
│  │     └─ openai-compatible.ts   # openai, groq and nvidia speak the same protocol
│  │
│  ├─ tools/
│  │  ├─ registry.ts           # Map<name, ToolDefinition>
│  │  ├─ types.ts              # ToolDefinition, ToolContext, argument validators
│  │  ├─ guardrails.ts         # corrections applied to the model's output (dates, titles)
│  │  ├─ tasks.ts              # create/list/update/complete/delete_task
│  │  ├─ calendar.ts           # create/list/update/delete_event + overlap check
│  │  ├─ agenda.ts             # find_free_slots, what_now
│  │  ├─ memory.ts             # remember, recall
│  │  ├─ search.ts             # search_web (in the turn), read_url (queued)
│  │  ├─ snooze.ts             # postponing straight from the alert's buttons
│  │  └─ pending.ts            # actions awaiting confirmation (KV)
│  │
│  ├─ stt/
│  │  ├─ provider.ts           # Transcriber interface
│  │  ├─ index.ts              # selection by env
│  │  ├─ openai.ts             # OpenAI's Whisper
│  │  └─ workers-ai.ts         # Whisper inside the Worker itself
│  │
│  ├─ search/
│  │  ├─ provider.ts           # SearchProvider interface
│  │  ├─ index.ts              # selection + "is it configured at all?"
│  │  └─ tavily.ts             # Tavily: the only recurring free tier left
│  │
│  ├─ reader/
│  │  ├─ provider.ts           # PageReader interface + the byte-safe cutter
│  │  ├─ index.ts              # selection
│  │  └─ jina.ts               # Jina Reader: url in, markdown out
│  │
│  ├─ calendar/
│  │  ├─ provider.ts           # CalendarClient interface
│  │  ├─ index.ts              # provider selection
│  │  ├─ google.ts             # Google Calendar over REST
│  │  └─ google-auth.ts        # RS256 JWT with WebCrypto + token cached in KV
│  │
│  ├─ db/
│  │  ├─ client.ts             # hand-written PostgREST (service_role)
│  │  ├─ identity.ts           # users + conversations, cached in KV
│  │  ├─ messages.ts           # conversation history
│  │  ├─ logs.ts               # tool_call_logs
│  │  ├─ jobs.ts               # the deferred-job queue: claim, retry, give up
│  │  └─ types.ts              # table rows
│  │
│  ├─ prompts/
│  │  └─ system.ts             # personality + rules + memories + date/time/TZ
│  │
│  └─ cron/
│     ├─ index.ts              # what happens on every tick
│     ├─ briefing.ts           # daily briefing at the local hour
│     ├─ event-alerts.ts       # the heads-up before an appointment
│     ├─ jobs.ts               # deferred jobs, last in the tick
│     └─ reminders.ts          # alerts for tasks falling due
│
├─ supabase/
│  └─ schema.sql
├─ wrangler.toml
├─ package.json
├─ tsconfig.json
└─ ARCHITECTURE.md
```

---

## 5. Database schema

```sql
-- Authorised users
create table users (
  id              uuid primary key default gen_random_uuid(),
  telegram_id     bigint unique not null,
  username        text,
  first_name      text,
  timezone        text not null default 'Europe/Madrid',
  created_at      timestamptz not null default now()
);

-- One conversation per Telegram chat
create table conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  telegram_chat_id bigint unique not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- History. `role` follows the OpenAI standard so it can be replayed verbatim.
create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','tool','system')),
  content         text,
  tool_calls      jsonb,          -- when role='assistant' and it asks for tools
  tool_call_id    text,           -- when role='tool'
  source          text not null default 'text' check (source in ('text','voice','photo')),
  transcript_raw  text,           -- the original transcribed audio, before cleanup
  attachment_ref  text,           -- a photo's file_id. The reference, never the image
  created_at      timestamptz not null default now()
);
create index on messages (conversation_id, created_at desc);

-- Long-term memory. Written by the agent itself through the remember() tool.
create table memories (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  key             text not null,           -- 'trabajo', 'preferencia_horario'
  value           text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, key)
);

-- Domain: tasks
create table tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  title           text not null,
  notes           text,
  kind            text not null default 'task'
                    check (kind in ('task','reminder')),  -- lifecycle, not storage
  due_at          timestamptz,
  remind_at       timestamptz,             -- when to alert, when it is not at the deadline
  priority        smallint not null default 2 check (priority between 1 and 3), -- 1 high
  status          text not null default 'pending'
                    check (status in ('pending','done','cancelled')),
  completed_at    timestamptz,
  reminded_at     timestamptz,             -- prevents duplicate reminders
  recurrence      text                     -- frequency when it repeats: one row, rolled
                    check (recurrence in   -- forward. Never a row per occurrence
                      ('diario','laborables','semanal','mensual','anual')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on tasks (user_id, status, due_at);
create index on tasks (user_id, status, remind_at);

-- Observability
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

-- Things the assistant owes the user (phase 17). Written inside a turn, settled by a
-- later tick. `state` carries 'running' so a row can be claimed without a transaction,
-- and 'dead' so "gave up" is distinguishable from "waiting for its next go" — see §16.
create table jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  kind            text not null check (kind in ('read_url')),
  payload         jsonb not null,
  state           text not null default 'pending'
                    check (state in ('pending','running','done','dead')),
  attempts        smallint not null default 0,
  run_after       timestamptz not null default now(),   -- also the backoff
  last_error      text,
  started_at      timestamptz,                          -- to spot an abandoned row
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on jobs (state, run_after);

-- RLS is on for all of them. The Worker connects as service_role, which bypasses it.
-- This hardens the database should the anon key ever be exposed.
alter table users            enable row level security;
alter table conversations    enable row level security;
alter table messages         enable row level security;
alter table memories         enable row level security;
alter table tasks            enable row level security;
alter table jobs             enable row level security;
alter table tool_call_logs   enable row level security;
```

### History: how it is read and written

It lived in KV through phases 1-3 and has been in `messages` since phase 4. The
reason was not aesthetic: the free plan gives **1,000 KV writes a day** and the
history spent one per message, competing with the `update_id` dedupe, which is not
negotiable. It was also the only thing outside the database, so re-reading a past
conversation could only be done through the Worker's logs.

Three decisions that the schema does not show:

- **The whole turn is stored**, not just the visible text: the `assistant` message
  with its `tool_calls` and every `tool` result go in too. Storing only the text made
  the model lose track of what it had already done and repeat actions — it created
  the same task twice when the user mentioned it again on the next message.
- **It is written in one shot at the end of the turn**, in a single multi-row INSERT.
  Writing as things happen would leave half turns behind if something failed on the
  way, and an `assistant` with `tool_calls` and no results is context the API rejects
  with a 400.
- **`created_at` is set by the Worker**, one millisecond apart per row, instead of
  leaving the column's `now()`. `now()` is the same instant for every row of an
  INSERT, so reading them back ordered by date would return them in arbitrary order,
  and a `tool` message ahead of the call that produced it is another 400.

Reading asks for the `HISTORY_WINDOW` most recent rows (descending order, which is
exactly the index's) and reverses them. If the cut lands inside a turn, the leading
rows are dropped until one that can open the context: a `user`, or an `assistant`
without `tool_calls`. Accepting the second matters because a turn with many tools can
fill the whole window, and then there is no `user` left to find.

`/reset` deletes the conversation's rows. A real delete and not a cut-off marker: if
the user asks to forget, it is forgotten. The audit trail of what the agent *did* is
not lost with it — that lives in `tool_call_logs`, which is the table you look at
when something went wrong. Long-term memories are untouched too: another table,
another contract.

The table grows without bound and that is accepted for now: 500 MB is years of one
person's conversation. If it ever gets tight, it is a `delete` by age in the cron,
not a redesign.

---

## 6. The LLM abstraction layer

The thing that made it possible to switch providers without touching `agent.ts` when
NVIDIA did not hold up. It has already been used in anger once, so it stays.

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

Selection happens at runtime through `LLM_PROVIDER`. Switching provider is two vars
plus its API key; the agent never notices.

### Images in the interface (phase 10)

`LLMMessage` gained `images?: LLMImage[]` —raw bytes plus a mime type— and `LLMProvider`
gained `supportsImages`. The plan said the change would be in `content`, going from
`string | null` to a list of parts; it is not, and the reason is worth the paragraph.
Content in parts is **the wire format**, not the contract: the moment that shape reaches
the interface, everything that reads `.content` —the history, the agent's reply, the
cron— has to narrow a union to get at a string it always had. So the parts are built in
the adapter, on the way out, and the layer above hands over bytes. What §10's plan
actually asked for —that `agent.ts` must not learn how a photo is sent— holds either
way, and this way nothing else moves.

The base64 lives for exactly one request. In `messages` what gets stored is the
`file_id`, because a photo as base64 is hundreds of thousands of characters: one would
fill the history window and travel again in the prompt of every message after it.

`supportsImages` comes from an allowlist by model name in
[llm/index.ts](src/llm/index.ts), and it is read **before** downloading anything. The
two ways of being wrong do not cost the same: assuming a text-only model can see means
spending the budget on a download and getting a 400 back mid-turn, which reaches the
user as "algo ha fallado por dentro"; assuming the reverse costs one sentence saying it
cannot see photos. The doubt resolves towards the recoverable one.

| `LLM_PROVIDER` | Base URL | Model in use / suggested | Secret |
|---|---|---|---|
| `openai` (**in production**) | `https://api.openai.com/v1` | `gpt-4.1-mini` | `OPENAI_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` | `NVIDIA_API_KEY` |

All three speak OpenAI's format, so they share a single adapter
([openai-compatible.ts](src/llm/providers/openai-compatible.ts)) written with plain
`fetch`: the `openai` SDK does not enter the Worker bundle, on weight and Node
dependency grounds. The adapter retries once on 429 and 5xx, never on a timeout (that
would double the worst case when we are already late) and strips the `<think>` blocks
reasoning models emit.

Gemini is left out on purpose: its native API is not compatible and would need an
adapter of its own.

> **Two checks when changing model.** That it supports function calling, or the whole
> of phase 2 stops working. And on OpenAI, avoid the "o" reasoning series: it rejects
> `max_tokens` and `temperature`, which the adapter always sends.

### Why NVIDIA NIM was abandoned

It was the initial choice for its free tier. In production, its queue for free
requests meant a simple greeting took over 45 s. No architecture on Workers' free plan
fits inside that: it is what forced the design in §11. With OpenAI the same reply
takes 2-5 s and the problem disappeared.

---

## 7. The tool contract

There is no "instruction manual" in the prompt. The functions are declared as JSON
Schema and passed in the request's `tools` field. The prompt only carries personality
and business rules.

```ts
export interface ToolDefinition {
  name: string;
  description: string;              // the model decides from this: be explicit
  parameters: JSONSchema;
  mutates: boolean;                 // does it write? on a photo, everything that does waits
  requiresConfirmation: boolean;    // destructive actions → human confirmation
  available?: (env) => boolean;     // can this deployment run it? absent means always
  confirmationPrompt?: (args, ctx) => Promise<string>;   // the sentence the user reads
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  conversationId: string;
  timezone: string;
  db: Db;                           // our own PostgREST client, not the SDK
  env: Env;                         // secrets and bindings
  config: Config;                   // env already parsed: the day's window, among others
  deadline: Deadline;               // the message's time budget
  userMessage: string;              // what the user wrote on this turn
}

export type ToolResult =
  | { ok: true;  data: unknown }
  | { ok: false; error: string };   // the error goes back to the model so it can react
```

### The catalogue

| Tool | Description | Confirmation |
|---|---|---|
| `create_task` | Creates a task or an alert (`kind`), with an optional deadline and alert time, in ISO or in minutes from now, and an optional frequency (`repeat`) when it happens for ever. Rejects duplicate tasks. | No |
| `list_tasks` | Lists with filters: status, date range, kind. Tasks unless `kind='reminder'` is asked for. | No |
| `update_task` | Changes the deadline, alert time, title, notes, priority, frequency or status of an existing task. Reopens the alert when a date changes. | No |
| `complete_task` | Marks it as done, or moves it to its next occurrence when it repeats. | No |
| `delete_task` | Deletes permanently. | **Yes** |
| `create_event` | Creates a calendar appointment, timed or all-day. Warns when it overlaps something. | No |
| `list_events` | Appointments over a range of days, with text search. Returns the ids. | No |
| `update_event` | Changes the time, day, title or location of an appointment. Preserves what is not touched. | No |
| `delete_event` | Deletes an appointment permanently. | **Yes** |
| `find_free_slots` | The free gaps in the calendar over one or more days, within the user's day window. | No |
| `what_now` | Time left until the next appointment plus the pending tasks that fit, already crossed. | No |
| `remember` | Stores a long-term fact about the user. | No |
| `recall` | Searches the memories. | No |
| `search_web` | Searches the internet and returns a handful of results with a snippet each. Not offered when there is no key. | No |
| `read_url` | Queues the reading of a page. Returns nothing to read: the summary arrives later, in its own message. | No |

The tool descriptions and the `error` strings stay in Spanish: they are read by the
model and end up shaping what reaches the chat, so they are product rather than code.

`available` arrived with `search_web`, the first tool whose provider is optional, and it
filters the catalogue rather than the handler: with no key the schema is not sent at all.
The alternative was leaving the model reading a contradiction —a list of limits saying it
cannot search, next to a tool for searching— and that is exactly the kind of thing it
resolves by promising a search it cannot run. `getTool` still resolves the name, so a
model that asks anyway gets the configuration error instead of "that tool does not
exist", which is the truth.

### The date rule

The model does not compute dates. That sounds like a theoretical precaution and it is
not: `gpt-4o-mini` dated an "in 5 minutes" task **to the following day** —right time,
wrong day, copied from the year-month-day of another task in the history— and the
alert sat waiting for 24 hours. Four measures, in reverse order of when they were
tried:

1. **What the user said wins, and the handler applies it.** Two cases, and both had to
   be covered because the model fails equally at each:
   - **Delays.** `lib/relative-time.ts` reads "en 5 minutos", "dentro de media hora"
     or "en un par de horas" out of the message and sets the date from the Worker's
     real clock.
   - **Explicit times.** "Remind me at 13:14" carries no day, so the day is today. The
     hour the model set is kept —it does get that right— and the day is swapped,
     rolling to tomorrow when that hour has already passed. If the message **does**
     mention another day ("on Thursday", "on 19 September", "next week"), nothing is
     touched.

   Correction only happens past a ten-minute deviation, and never without a message
   from the user: on the confirmation-button path there is no text to interpret, and
   correcting blindly would mean inventing intent.
2. **Relative delays as a parameter.** `create_task` and `update_task` accept
   `due_in_minutes` and `remind_in_minutes`. When the model uses them there is no
   calendar arithmetic left to go wrong. The problem is that it often does not.
3. **Anchors in the prompt.** Along with the Spanish date, the instant is injected in
   ISO 8601 with offset (`2026-08-18T12:27:00+02:00`) plus today's and tomorrow's
   dates on their own. It helps, but it is not enough by itself.
4. **Make it state the date it stored.** The prompt asks it to repeat, in its reply,
   the date exactly as the tool returned it, so the user catches the mistake on the
   spot.

Ambiguities like "on Tuesday" are still resolved against the user's TZ. There is no
`get_current_time` tool: that would be another loop iteration for a value that
already travels in the prompt.

### Guardrails in the handlers

The lesson from the testing phase, and probably the most important one in the project:
**a rule the model has to follow voluntarily is not a guarantee.** With `gpt-4o-mini`
three explicit rules were documented —do not duplicate tasks, do not title things
"Remember X", use the minute fields— and all three were broken in the same turn, with
the new prompt already in production. What the system cannot afford is enforced in
code, and the prompt stays as help rather than control.

| Guardrail | What it prevents |
|---|---|
| The message's delay overrides the model's date | Alerts dated tomorrow |
| With no day in the message, the model's time is moved to today | The same, when the user names an explicit hour |
| `create_task` cleans up "Recordar X" / "Avisar de X" titles | Tasks named after their own alert |
| `create_task` rejects a task repeating another pending one's words, and returns the existing id | Duplicate rows for the same thing |
| On an all-day event, the day correction is not applied | An "all day" on the 25th ending up today: with no time, the corrector's premise does not exist |
| `update_event` sends only the fields that change | Wiping the location or the notes the user set from their phone |
| Moving an appointment without a stated duration reads the one it had | Turning "move it to Friday" into an appointment of a different length |
| `create_event` checks the overlap **after** writing, and only with budget to spare | An appointment left unwritten because a courtesy lookup ate the message's time |
| Free gaps and overlaps are computed in `lib/slots.ts`, never by the model | Invented gaps, which raise no error and sound exactly as confident |
| From a photo, everything that writes waits for one confirmation | Five rows dated off a poster with nobody having read them |

Rejecting a duplicate is not a `throw`: it is an `{ok: false, error}` telling the model
which id to use with `update_task`, so it corrects itself on the next loop iteration.
There is an escape hatch: `force: true` for when they really are two different things.
It costs a SELECT before the INSERT, which at this scale nobody notices.

The guardrails stay, but the practical conclusion was **changing model**.
`gpt-4o-mini` was as much the problem as the design, so production runs
`gpt-4.1-mini`.

| Model | Input | Cached input | Output |
|---|---|---|---|
| `gpt-4o-mini` | $0.15/M | $0.075/M | $0.60/M |
| `gpt-4.1-mini` | $0.40/M | $0.10/M | $1.60/M |

List price is 2.7 times higher; in practice, far less. Our load is ~97% input tokens
and most of it is the stable prefix —prompt and tool schemas—, which is billed at the
cached rate: there the difference is 33%. Output is 30-60 tokens per reply and does
not move the needle. At personal-use volume the jump is a few euros a month, and
changing it is two lines of `wrangler.toml`.

### The system prompt

Personality and business rules, never the tool descriptions: those go as JSON Schema
in the `tools` field, and duplicating them in prose guarantees the two versions drift
apart.

It has three parts and the order is not cosmetic:

1. **What it can and cannot do**, enumerated. Without that list the model offered to
   search the internet and promised to "keep an eye on" alerts it had never scheduled.
   Declaring the limits is cheaper than fixing a broken promise.
2. **Tool and style rules**: plain text (Telegram does not render our markdown), tell
   only what the tool returned, no flattery, and **ask rather than assume**. That last
   one is an explicit preference of the user's: faced with two matching tasks, an
   ambiguous day, or the choice between creating and updating, a short question beats
   getting it right by luck. When it does decide alone, it has to say what it assumed
   in the same sentence.
3. **The volatile part, last**: memories and temporal context. OpenAI caches the
   common prefix between requests and charges half for that part; the prefix is cut at
   the first character that differs, so the time —which changes every minute— placed
   at the top would invalidate the whole prompt on every message. With ~97% input
   tokens, that shows up on the bill.

The prompt's text is in Spanish, and stays that way: it is what the bot sounds like.

### The confirmation flow

1. The model asks for `delete_task({id})`.
2. The agent sees `requiresConfirmation` and **does not execute**.
3. The pending tool call is stored in KV (TTL 15 min). Confirming consumes it:
   pressing twice does not execute twice.
4. An inline keyboard is sent: `✅ Confirmar` / `❌ Cancelar`.
5. The `callback_query` retrieves the pending call and runs or discards it.

Why: "delete tomorrow's task" with three tasks tomorrow is a silent, irreversible
failure. The model gets things wrong; the confirmation contains it.

---

## 8. The agentic loop

```
messages = [system, ...memories, ...history, userMessage]

for i in 1..MAX_AGENT_ITERATIONS (3):
    if no time budget left: stop with an honest message
    res = llm.chat(messages, toolSchemas, {timeoutMs: whatever is left, max 15 s})
    if res.finishReason != 'tool_calls': return res.content
    messages.push(assistant with tool_calls)
    for each tc in res.toolCalls:
        if requiresConfirmation: store pending, leave the loop, ask for confirmation
        result = run(tc)  # try/catch → errors come back as tool content
        log(tc, result)
        messages.push({role:'tool', tool_call_id: tc.id, content: JSON(result)})

if the iterations run out: ask the model for a final answer with no tools
```

**Why the limit:** without a cap, a confused model calls tools in a loop and burns the
quota in a single conversation. Lowered from 5 to 3 because every round is a model
call and all three have to fit the message's time budget.

**Tool errors:** never propagated to the user as an exception. They go back to the
model as `{ok:false, error}` so it can correct itself or explain.

**And they stay in the history, with a side effect that cost a whole test run.** While
setting up the calendar, the first call returned "the calendar is not configured", and
that sentence was persisted in `messages` as a tool result. On the following turns the
model read it and answered from memory **without calling the tool again**:
`finish_reason=stop` with an empty `tool_calls` list, even though the missing secret
was already in place. Insisting did not help; it took a `/reset`.

This is consistent with how an LLM works —the context says that cannot be done— but it
has a practical consequence: **after fixing a configuration, the conversation has to be
wiped before testing again**, or the test measures the history instead of the fix. It
is not corrected in code: filtering errors out of the history would take away the
model's memory of what it already tried, which is precisely what stops it repeating
actions.

---

## 9. Security

| Vector | Mitigation |
|---|---|
| Public bot — anyone can message it | `ALLOWED_TELEGRAM_IDS` whitelist. Unauthorised users are ignored silently. |
| Forged webhook | `secret_token` on `setWebhook`, validated against `X-Telegram-Bot-Api-Secret-Token` on every request. |
| Credential leak | Everything under `wrangler secret put`. `wrangler.toml` holds no secrets and goes to git. |
| Direct database access | RLS enabled on every table. Only `service_role`, only from the Worker. |
| Double execution on retry | `update_id` dedupe in KV, TTL 24h. |
| Prompt injection through content | The handlers validate the model's arguments by hand (`tools/types.ts`); SQL is never built from model text. No Zod: it is a handful of tools and does not justify the dependency. |
| Quota exhaustion | The whitelist is the real defence, and `MAX_AGENT_ITERATIONS` bounds the spend per message. There is no daily counter: with a single authorised user there is nobody to rate-limit. |

### Environment variables

```
# Secrets — set once, they survive every deploy
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
ALLOWED_TELEGRAM_IDS      # a secret, not a var: the repo is public
OPENAI_API_KEY            # LLM and transcription, the same key
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_SA_EMAIL           # calendar: the service account's client_email
GOOGLE_SA_PRIVATE_KEY     # calendar: private_key from the same JSON, PEM included
GOOGLE_CALENDAR_ID        # calendar: the shared calendar's id, never "primary"
GROQ_API_KEY              # optional, only with LLM_PROVIDER = "groq"
NVIDIA_API_KEY            # optional, only with LLM_PROVIDER = "nvidia"

# Vars (wrangler.toml) — OVERWRITTEN on every deploy
LLM_PROVIDER = "openai"
LLM_MODEL    = "gpt-4.1-mini"
STT_PROVIDER = "openai"       # or "workers-ai" (free, inside Cloudflare)
STT_MODEL    = "whisper-1"
STT_LANGUAGE = "es"           # pinning it is more accurate than autodetecting
DEFAULT_TIMEZONE     = "Europe/Madrid"
BRIEFING_HOUR        = "8"    # LOCAL hour of the daily briefing, 0-23
DAY_START_HOUR       = "9"    # the day window free slots are searched in
DAY_END_HOUR         = "21"   # 24 means midnight
MAX_AGENT_ITERATIONS = "3"
HISTORY_WINDOW       = "30"   # rows of `messages`, not exchanges: a turn with
                              # tools spends four or five
LOG_LEVEL            = "info"
```

> Editing a var in the dashboard does nothing: the next push reverts it to the value
> in `wrangler.toml`. Secrets work the other way round and deploys do not touch them.

### Deployment

**Cloudflare Workers Builds** connected to `jcm-developer/jarvis`. Every push to
`main` runs `npm run typecheck` and, only if it passes, `npx wrangler deploy`. The
typecheck acts as the gate: a push that does not compile never reaches production.

### Bindings

```toml
[ai]
binding = "AI"                    # Workers AI (Whisper)

[[kv_namespaces]]
binding = "STATE"                 # dedupe, pending confirmations, quotas

[triggers]
crons = ["*/5 * * * *"]           # briefing and reminders
```

---

## 10. Audio

1. `message.voice.file_id` → `getFile` → `https://api.telegram.org/file/bot<token>/<path>`
2. Download (`ArrayBuffer`). Hard limit: **reject anything over 20 MB** (the Telegram
   API's cap).
3. Transcription, with whichever provider `STT_PROVIDER` names:
   - `openai` (in production): `POST /audio/transcriptions` with `whisper-1`. It
     accepts Telegram's OGG/Opus without conversion and is more accurate in Spanish.
   - `workers-ai`: `env.AI.run('@cf/openai/whisper-large-v3-turbo', ...)`. Free and
     with no network hop, but worse with Spanish phone audio.
4. Transcript → the same path as a text message, with `source='voice'`.
5. `transcript_raw` is stored, to debug the cases where the agent understands
   something odd.

If the transcript comes back empty or fails, the reply asks the user to repeat — an
empty string is never sent to the LLM.

**Budget split** (caps each step asks the `Deadline` for, not fixed values): download
6 s per attempt with one retry, transcription 10 s, each model call 15 s. `getFile`
and the download share that cap instead of each having its own: when `getFile` spent
its own 8 s outside it, a download that was "within cap" could take 23 s of the 27 and
leave the model with no time to answer.

The download had 15 s based on the diagnosis that long notes took longer. That does
not hold: Telegram sends them as OGG/Opus at ~16 kbps, so a minute of audio is ~120
KB. Download failures are momentary spikes on the file server, not a size issue, which
is why the same audio failed some times and not others. It now cuts sooner and retries
once, only when there is budget left to transcribe and answer afterwards. If it still
fails, the bot says so without inventing a cause, and the `voice_download_failed` log
carries duration, size, time spent and remaining budget so it can be looked at.

---

## 11. Free plan constraints

| Resource | Limit | Does it bite? |
|---|---|---|
| Workers requests | 100,000/day | No |
| Workers CPU | 10 ms/request | **No** — network waiting (LLM, Supabase) does not count as CPU |
| Workers AI | ~10,000 Neurons/day | Not applicable: transcription goes through OpenAI. Only counts with `STT_PROVIDER = "workers-ai"` |
| KV writes | 1,000/day | Tight. One per message (dedupe), one a day (the briefing marker) and one per confirmation asked — routine since phase 10, where every photo asks. Still far from the limit for one person; do not add more |
| Cron triggers | Included, down to 1 min granularity | No. Every 5 min is 288 invocations a day |
| Supabase | 500 MB | No |
| OpenAI | Paid credits, no queue | Not biting: a few euros a month at this volume (see §6) |
| `waitUntil` after responding | ~30 s, then cancelled | **Yes** — it is the ceiling that shapes everything |

### Time: two opposing limits (phases 1 and 3)

This point took two iterations and is the constraint that shaped the code most. We sit
between two walls:

- **If we wait to finish before answering, Telegram cuts us off.** Measured in
  production: it retries after ~4 s and, once the client disconnects, Cloudflare
  cancels the execution. Total silence.
- **If we process inside `waitUntil()` with no control, Cloudflare cuts us off.** Past
  a margin after the response, the tasks die like this:

```
(warn) waitUntil() tasks did not complete within the allowed time
after invocation end and have been cancelled.
```

With NVIDIA taking 45 s there was no gap between the two walls: awaiting the
processing was tried and Telegram cut in first. Moving to OpenAI brought the reply
down to 2-5 s and it does fit, so the current design is **immediate 200 OK + work
inside `ctx.waitUntil()`** with a global budget of **27 s**
([src/lib/deadline.ts](src/lib/deadline.ts)), leaving room to send an honest error
message when a step overruns. Every step asks the `Deadline` what is left on the clock
instead of setting its own cap: three 20 s steps honour their individual timeouts and
still blow the combined budget.

The `update_id` dedupe has been there since day one, and that is what makes this
viable: if Telegram retries an update we are already processing, it does not run twice.

**Migration path if it gets tight:** moving to Workers Paid ($5/month) enables Queues
with retries and a dead-letter queue. The change touches only `index.ts`; the rest of
the code stays. It is designed that way on purpose.

---

## 12. Being proactive: the cron

One Cron Trigger every five minutes (`*/5 * * * *`) and three independent jobs per
user, each with its own `try`: one alert failing must not leave the user without the
others. In order: the task reminders, the heads-up before an appointment (phase 14) and
the briefing.

**It started running hourly and that did not work.** A "remind me at 12:10" asked for
in a 12:07 message could not go out before 13:00, almost an hour late: an alert's
precision cannot be worse than the cron's period. Every five minutes is 288
invocations a day against the free plan's 100,000, and it adds no KV writes at all,
because the only thing written there is the briefing marker, once a day.

The `scheduled` handler **awaits** its work instead of handing it to `waitUntil()`.
There is no response to return here, so the short margin that forces the webhook's
gymnastics does not exist. It still carries a budget (25 s): one hung call must not
leave the briefing half done.

Who gets written to comes from joining `users` and `conversations`, filtered by
`ALLOWED_TELEGRAM_IDS`. **The whitelist is checked again here on purpose:** this is
the only path in the code with no Telegram update to validate, so if nobody looks at
the list, a removed user would keep receiving messages.

### Daily briefing

It goes out at the user's **local** hour (`BRIEFING_HOUR`, 8 by default). The cron
fires in UTC, so the local hour is computed on every run with `Intl`
([src/lib/localtime.ts](src/lib/localtime.ts)) and not with a fixed offset: Spain
changes its clocks twice a year, and a cron at 06:00 UTC would be 7 in winter and 8 in
summer.

- **Once a day**, with a KV marker `briefing:<userId>:<local date>` and a 48 h TTL.
  The key's date is the local one, not UTC: that is what defines "today" for whoever
  reads it. One KV write a day does not dent the 1,000 budget.
- **The sending window is 3 hours**: with `BRIEFING_HOUR = 8`, it goes out on the 8,
  9 or 10 tick. If the first is missed, the next one recovers it. Without a window
  there would be no briefing that day; without a limit a "good morning" would land at
  midnight.
- **The text is composed in code, without going through the model.** It is a list of
  appointments and tasks with dates: the LLM adds nothing and does add cost, latency and
  the chance of inventing a task. The briefing has to be boring and exact.
- Contents: the day's appointments, what is overdue, what is due today with its time,
  and high-priority items with no date. Pending things with neither a date nor a
  priority stay out: this is the day, not the inventory.

#### The appointments (phase 12)

The briefing was the last place still telling half the day: the tasks were there and
the calendar was not, so the fixed part of the morning —the part that cannot be moved—
had to be looked up somewhere else.

- **The whole local day, not from `now`.** The window runs up to three hours late, and
  cutting at the current instant would hide the 09:00 meeting from a briefing that went
  out at 10. The day's plan is not the same thing as what is left of it — that question
  is `what_now`'s, in §14.
- **Timed and all-day go in separate lists**, the same distinction the free gaps make:
  one holds a slot and the other does not, and mixing them would drop "Ana's birthday"
  between two meetings as though it were one of them.
- **A private appointment is named as what it is**, "algo (cita privada)", because the
  shared permission returns the slot with no title (§13). There is no model here to
  invent one, and there must not be a line inventing it either.
- **Google is read last, and its failure costs only its own section.** `todaysEvents`
  returns null on any error —including a missing `GOOGLE_CALENDAR_ID`— and the briefing
  goes out with the tasks plus a line saying the appointments are missing. Nobody asked
  for this message: if it arrives incomplete and quiet, nobody comes back to ask why.
- **The cap is 6 s**, below the 10 s the tools give themselves. This runs unattended and
  shares the cron's budget with every other user's reminders, and the read is an extra:
  if it does not fit, the tasks still go out.
- One extra Google call a day, not one per tick: the read hangs off the branch that has
  already checked the KV marker.

### Reminders

There are **two classes of alert** and they are not held to the same standard:

| Class | Field | When it goes out | Why |
|---|---|---|---|
| At the requested time | `remind_at` | Within 5 min of that time | "Remind me at 12:10" has to arrive at 12:10 |
| Before it is due | `due_at` with no `remind_at` | 1 h before the deadline | Warning right at the deadline leaves no room for anything |

They are two parallel queries rather than one with `or`: the sets are disjoint —one
requires `remind_at`, the other requires it to be null— so there is nothing to
deduplicate, and each filter uses PostgREST syntax already proven elsewhere in the
code. The merge still deduplicates by id, which is cheap and prevents a future change
in one filter from turning into repeated alerts.

`remind_at` exists so an alert does not become a task of its own. Without that field,
"I'm calling David at 17:30, remind me at 12:10" could only be represented by creating
a second "remember to call David" task, which is what the model did: two rows for one
thing to do.

- `reminded_at` is what stops the alert repeating on every tick until the task is
  completed.
- **It is marked after sending, never before.** If the send fails, the task stays
  unmarked and the alert is retried on the next tick. The other way round, a 500 from
  Telegram would turn into a reminder that never arrives.
- Cap of 10 per run. The first time this ran, everything overdue from before came into
  the batch, and we do not want it arriving as an avalanche.
- **`update_task` sets `reminded_at` to null when either date changes.** Without that,
  postponing a task that was already announced would leave it without a reminder
  forever: the cron only looks at the ones with a null `reminded_at`.

### A task waits; an alert is spent

`kind` does not decide where a row is stored. It decides **when it dies**:

| | Announced | Afterwards | Shows up in |
|---|---|---|---|
| `task` | at `remind_at`, or an hour before `due_at` | stays open until it is completed | the pending list, the briefing, `what_now` |
| `reminder` | at `remind_at`, which is mandatory | closed on the spot | nothing, and that is the point |

The bug that forced it: "remind me at 21:00 to take the bins out" was a task with a
`remind_at` and nothing else. The alert went out, `reminded_at` got stamped, and the row
stayed `pending` for ever, because nobody marks an alert as done. The pending list turned
into a graveyard of alerts already delivered, and they were competing for the briefing's
25 slots with what was genuinely left to do.

**One table, not two.** A `reminders` table of its own would have meant duplicating the
cron's queries, the date guardrails and the tool catalogue — and handing the model two
near-identical sets of tools to confuse in both directions, which is the most expensive
failure mode this architecture has. What separates the two things is one column's worth,
and it is a lifecycle, not a schema.

**And the calendar cannot take the tasks over either**, which is the other half of the
same question. An errand on the calendar is an errand occupying a slot it does not
occupy: `busyIntervals` would count "buy filters" as busy time and §14's three
computations —free gaps, the overlap warning, the minutes left until the next
appointment— would start answering with a day that is not the real one. Google Tasks is
not a way out: it is user data, so it runs into the same wall as §13's service account.

What follows from the split:

- **The cron announces both and closes only the alerts** (`markAnnounced`). Two writes
  instead of one, and only for the group that is not empty.
- **`list_tasks` returns tasks unless it is asked otherwise.** Without the `kind`
  parameter a pending alert would be unreachable: no id means it can be neither moved nor
  cancelled.
- **An alert with no time is rejected, and a time the model put in `due_at` is moved to
  `remind_at`.** From `due_at` it would go out an hour early —the right courtesy for a
  deadline, plain wrong for "at 12:10"— and with no time at all it would be a row nobody
  ever hears of again, because it is not on any list either.
- **No duplicate control between alerts.** Two with the same title are two different
  alerts —the pill at 09:00 and the pill at 21:00— so blocking the second one loses it.
  Between tasks the check stays exactly as it was.
- **An alert that has gone out is spent**: the prompt has the model create a new one
  rather than reopen it. Reopening would mean writing a date onto a closed row, and the
  cron only looks at pending ones, so the alert would never arrive — a silent failure.
  The postpone button does reopen it, and that is not a contradiction: see below.
- **The briefing and `what_now` read `kind='task'`.** An alert arrives by itself; naming
  it in the morning tells the user something he is about to be told again.

`kind` defaults to `'task'`, and the tool description says so as well. Getting it wrong
in that direction leaves a row too many in a list the user reads; getting it wrong the
other way makes something disappear on its own. Of the two, only the first is visible.

### Something that repeats (phase 16)

The bins on Tuesdays, the rent on the 1st, the pill at nine. Until this phase every one of
them had to be written down again after each time, which is the one chore an assistant
exists to remove — and the calendar could not take them over either, for the reason
already given above: an errand on the calendar occupies a slot it does not occupy.

**One column, and one row rolled forward.** `recurrence` holds a frequency from a closed
list —`diario`, `laborables`, `semanal`, `mensual`, `anual`— and the row moves to its next
date instead of being copied per occurrence. Two reasons, and the second is the one that
decided it:

- A row per occurrence is an insert **plus** a close, two writes that can half-happen. The
  insert landing while the close fails is a duplicate alert; the other way round is a
  repetition that disappears without a word. Rolling forward is a single patch — the same
  argument the postpone button is built on.
- And it does not grow. A daily alert would be 365 rows a year, competing in every query
  with what is actually pending.

What is given up is the record of "I took it in August", and it is not lost: every
`complete_task` sits in `tool_call_logs` with its arguments. Phase 13 was already going to
read postponements from there.

**The two paths that move a repetition, and they must not be confused:**

| | Who moves it | What it writes |
|---|---|---|
| A recurring **task** (`kind='task'`) | `complete_task`, when the user says it is done | the next `due_at` and `remind_at`, `reminded_at` back to null |
| A recurring **alert** (`kind='reminder'`) | the cron, the moment it announces it | the next `remind_at`, `reminded_at` null, still `pending` |

An alert is not waiting to be done, so nobody would ever complete it: if the cron closed
it like any other spent alert, tomorrow's pill would need creating again. And in both
cases the new date and the null `reminded_at` travel in the **same** patch, because the
cron only reads rows whose `reminded_at` is null: split in two, the alert either never
comes back or comes back on every tick.

**The arithmetic is the code's, and it is not milliseconds.**
[src/lib/recurrence.ts](src/lib/recurrence.ts) advances the LOCAL date and puts the local
hour back afterwards. A daily 09:00 alert plus 24 h is an 08:00 alert the day the clocks
change, and it stays wrong from then on. The rest is the same family of trap: the 31st of a
month with 30 days is clamped, not overflowed —"el día 31" landing on 1 March is a bill
paid in the wrong month, and it would drift another day every time— 29 February yearly
becomes the 28th, and `laborables` jumps the weekend instead of firing on Saturday.

- **It advances from the stored date, not from `now`, and repeats until it is past
  `now`.** An alert left behind three days comes back on its own hour, not three days late
  and not at whatever time the user got round to reading it.
- **A frequency that cannot be advanced closes the row** and logs why. The alternative is
  the same alert on every tick, for ever, which is the one failure mode worse than losing
  it.
- **Deleting a repetition deletes all of them**, because there is one row. The
  confirmation says so —"se repite todos los días, ¿la borro del todo?"— which is the
  difference between a confirmation and a trap. Skipping a single time is `update_task`
  with a new date.
- **One vocabulary for both domains.** These are the same five words the appointments
  already used, and the phrases moved to `lib/recurrence.ts` so the two lists cannot drift
  apart. The model must not have to remember that "mensual" is the word for an appointment
  and something else for a task; what stays in `tools/calendar.ts` is the RRULE, which is
  Google's alone.

### What the alerts sound like

The text is written in code, not by the model, but that is no excuse for sounding like
a machine. The first version said `Recordatorio: "Llamar a David a las seis" venció a
las 13:25` and in the chat it read like a system alarm: quotes around the title, the
verb "expired", and the time repeated even when it was the current one.

It now comes out the way a person would say it:

```
Acuérdate de llamar a David a las 18:00.
Oye, acuérdate de llamar a mamá.
Se te ha pasado pagar la luz, era ayer a las 09:00.

Tienes tres cosas encima:

- pagar la luz ayer a las 09:00 (se te ha pasado)
- llamar a David a las 18:00
- sacar la basura
```

Four details that make the difference, and none of them needs an LLM:

- **The time is only stated when it adds something.** Nothing when the alert is for
  right now, nothing when the title already carries it ("Llamar a David a las seis"
  with an "a las 13:25" after it confuses more than it helps).
- **Named days**: "yesterday", "tomorrow", "on 20 August at 09:00". Not `20 ago, 09:00`.
- **An alert at the requested time is not a breach.** "Overdue" is reserved for what
  genuinely slipped a while ago.
- **The opening phrase varies** between tasks, picked by id rather than at random: the
  same alert repeated reads the same, and two different alerts do not sound identical.

Proactive messages are stored in `messages` as assistant turns. Without that, a "done"
or a "push it back" in reply to an alert would have no referent in the context and the
model would ask what it is being told about.

A task falling due within the briefing's own hour appears in both messages. That is
accepted: they are different things —planning the day and flagging what is imminent—
and suppressing the reminder would silence precisely the most urgent thing of the day.

### Postponing from the alert itself (phase 15)

The most repeated answer to a proactive message was "pospónlo diez minutos", and it was
the most expensive one: a model call and a couple of seconds to move a date by ten
minutes, with the chance of the day going wrong that §7 is all about. Now the alert
arrives with three buttons —`+10 min`, `+1 h`, `Mañana`— and none of that happens.

- **No KV write, unlike the confirmation flow.** There the payload is a whole tool call
  and it has to be stored (§7); here it is one id and one option, and both fit in
  `callback_data`: `zz:<uuid>:<code>` is 42 of the 64 bytes Telegram allows. Alerts go
  out several times a day and the plan gives 1,000 writes: a flow that spent one per
  alert would have been a flow with a budget.
- **It reopens the row instead of adding another one**, which is the opposite of what the
  prompt tells the model to do with a spent alert. Both are right for their own path: the
  model is told not to reopen because reopening means setting a date on a closed row and
  the cron only reads pending ones —a model that writes `remind_at` and forgets
  `status` produces an alert that never arrives— and the button can guarantee exactly
  that, because the three fields travel in one patch.
- **And that is what makes a double tap harmless.** Pressing twice writes the same fields
  on the same row. Had it inserted a row per press, a double tap would be two alerts, and
  §12 already says there is no duplicate control between alerts on purpose.
- **"Mañana" keeps the alert's own hour**, not the hour of the press: the bins are a 21:00
  thing, and pressing the button at 23:40 because the phone was in another room must not
  turn them into a 23:40 thing for ever. It is not "+1,440 minutes" either — a day is not
  1,440 minutes on the two clock-change days a year, and `zonedInstant` already knows it.
- **Buttons only when the message announces one task.** With three in the same message
  there is no telling which one `+10 min` refers to, and a row of buttons per task is a
  menu. On a multiple alert the answer stays where it was: said out loud, with
  `update_task`.
- **A task already closed is not resurrected** by a button pressed on an old message; a
  spent alert is, because that is the whole point. The two cases are told apart by `kind`,
  not by `status`: both are `done` in the database.

### Before an appointment (phase 14)

Google Calendar already sends its own notification, and that is exactly why this exists:
it arrives wherever the calendar app is installed, while everything else the assistant
knows —the tasks, what was agreed in the chat, the reply to "move it an hour"— lives in
Telegram. An appointment that only warns you somewhere else is the one thing left that
makes you keep two apps open.

- **The read is the notice, not the day.** `EVENT_ALERT_MINUTES` (15 by default) sets
  both the notice and the width of the window read from Google: `now` to
  `now + lead`. Reading four hours of calendar every five minutes to announce what
  happens in the next fifteen would be 288 pointless reads a day.
- **The marker is in KV and carries the start instant**, not just the id:
  `event_alert:<userId>:<eventId>:<startAt>`. Moving an appointment keeps its id —that
  is what `update_event` is for— so a key without the hour would announce the 09:00 slot
  and then say nothing about the 17:00 it was moved to. With the instant in it, a moved
  appointment is something else to warn about, which is what it is.
- **One KV write per appointment announced, none per tick.** That is what keeps this
  inside the 1,000 daily writes: the marker is only written when a message actually goes
  out, and there are a handful of appointments a day, not 288 ticks' worth.
- **It goes between the reminders and the briefing.** It is the only one of the three
  that is time-critical to the minute —an appointment announced late is not announced— so
  it does not queue behind the briefing's own calendar read.
- **What has already started is not announced.** Google returns whatever overlaps the
  window, so a meeting under way comes back too and is dropped: at that point the user is
  either in it or has decided not to be, and a warning is a reproach.
- **The window's edge belongs to the next tick.** `timeMax` is exclusive, so something
  starting at exactly `now + 15` arrives on the following tick, ten minutes ahead. With
  a 15-minute notice the alert lands between 15 and 10 minutes before, and that is the
  real precision — the same trade the cron's period already imposes on the reminders.
- **Zero disables it**, and that is not a cosmetic setting: it is what makes the
  difference between the two versions of the prompt rule below.

**The prompt had to change with it, and that is the part worth remembering.** Until this
phase the honest line was "the appointments' reminders come from your own calendar app,
not from me", and it was in the prompt precisely so the model would not promise an alert
nobody was going to send. Shipping the job without touching that line would have left the
assistant turning down, in writing, a message it was about to send fifteen minutes later.
So the rule now has two versions —`eventAlertMinutes > 0` or not— and both state what
the system does. Neither leaves room to promise a per-appointment notice: the notice is
the same for all of them, so "warn me an hour before this one" is a `reminder` of its
own, not a setting on the appointment.

---

## 13. Calendar

Four tools: `create_event`, `list_events`, `update_event` and `delete_event`.

**Phase 6 was write-only and lasted one message.** The moment it was tried, in came a
"delete it, I can't make it after all", and then a "actually move it to Friday": the
bot answered well —it said it could not rather than pretending— but a badly placed
appointment could only be fixed from the phone, which is exactly the work this project
exists to save. Phase 7 added reading, modifying and deleting.

What remains out is **bulk** reading for the briefing: that one does drag in
incremental sync tokens, recurrence expansion and the time zones of recurrences.
Searching for "Thursday's dentist" over a date range drags in none of that, and the
`calendar.events` scope we were already using allowed it without touching anything on
Google's side.

`create_event` is a separate tool from `create_task` rather than a field of it. The
boundary is whether the thing takes up a slot of the day at a specific time —the
doctor on Thursday at ten— or is something to do whenever possible —buy bread. Now
that the model can look in both places, the prompt asks it to search both before
saying something does not exist: the first attempt at moving an appointment failed
because it only searched the tasks.

### Authentication: a service account, not user OAuth

The user OAuth flow was ruled out and the reason is specific: a Google Cloud app in
*Testing* state issues refresh tokens that **expire after seven days**, so the bot
would have gone dead every week; and publishing it with the Calendar scope requires
passing Google's verification. With a service account and the personal calendar shared
with its email, nothing expires.

The price is signing an RS256 JWT by hand with WebCrypto and exchanging it for an
access token ([src/calendar/google-auth.ts](src/calendar/google-auth.ts)). Three
details that matter:

- **Scope `calendar.events`**, not `calendar`: it can create and edit events, not
  administer or delete calendars. The service account also has **no** IAM role at all,
  so the key grants access to nothing else in the project.
- **The token is cached in KV for 55 minutes**, not 60: one just pulled from the cache
  has to outlive the request it is about to make. That is ~26 writes a day, far from
  the 1,000 limit the dedupe already spends against.
- **The `private_key` arrives from a secret on a single line, with literal `\n`**,
  which is how it sits in Google's JSON. The parser accepts that form, the one with
  real newlines, and the one with quotes stuck on from copying: it is a
  1,700-character string pasted by hand once, and a slip there shows up as a
  `401 invalid_grant` that explains nothing.

Alternatives ruled out: **Google Tasks** fits the product's name better but does not
support service accounts, which puts us back on the expiring refresh token.
**iCloud's CalDAV** remains the plan B —simpler authentication, an app-specific
password and Basic auth— but it forces discovering the calendar's URL with `PROPFIND`
and writing iCalendar by hand: CRLF, folding at 75 octets, `DTSTART` with `TZID`,
escaping the `SUMMARY`. It fails silently, with the event at the wrong time.

### The organisation trap

Google applies the `iam.disableServiceAccountKeyCreation` policy ("secure by
default") to new organisations, which **prevents creating the key** behind a dialog
that does not mention it can be turned off. It is disabled for this project only, not
for the whole organisation:

```bash
gcloud resource-manager org-policies disable-enforce \
  iam.disableServiceAccountKeyCreation --project=<PROJECT_ID>
```

The console caches the state, so the tab has to be reloaded before retrying — or the
key created from Cloud Shell, which does not go through it.

### Modifying without breaking what was not asked for

Three `update_event` decisions, all born of the fact that the model sends whatever it
feels like and what is in the calendar was not put there by it:

- **Only the fields that change travel.** A `PATCH` with the whole object would blank
  out the description, the location or the guests the user has set from their phone,
  with nobody asking and no trace left. `undefined` means "do not touch it"; `null`
  means "clear it".
- **Moving an appointment reads its duration first.** "Move it to Friday" means the
  same appointment on another day, not an appointment of a different length, and only
  Google knows how long it was. That is two calls —`GET` and then `PATCH`— and each
  asks the `Deadline` for its cap separately.
- **`singleEvents=true` when listing**, which expands series into concrete
  occurrences. The id it returns belongs to *that* instance, so moving "Monday's
  standup" does not touch the rest of the series. That is what we want, but the user
  will not guess it: when the event came from a series, the result carries a note so
  the model says so.

`delete_event` goes through button confirmation, like `delete_task`, and the question
is built by reading the event's title: nobody reviews "delete appointment 7f3a-...?".
If it cannot be read, the question is asked generically — what must never happen is
deleting without asking.

### Several days, and the extra day the user is never told about

An "I'm away from the 23rd to the 26th" is a four-day all-day event, and in Google the
last day is **exclusive**: it is stored as 23 → 27. An off-by-one here raises no error
at all, just a trip that ends on the 25th in the calendar.

So the model sends `end_date` with the last day **included**, which is what the user
says, and the `+1` is added by the handler. It is subtracted again in the reply: the
user is told "from 23 August to 26 August", never the 27th. Same division of labour as
with relative delays — the model contributes what it heard, the code does the
arithmetic.

Moving an event like that preserves the days it spanned. Without it, "push it to
September" would collapse the trip into a single day, because the patch rebuilds both
dates and only one of them comes from the user.

Bare dates are added in UTC, not through `Intl`: a 'YYYY-MM-DD' is not an instant, and
dragging the time zone into it is exactly what makes a trip start a day early.

### Categories: the model picks the kind, the code picks the colour

A trip shows up in a different colour in the calendar app. The tool accepts a
`category` from a closed list —viaje, trabajo, estudios, personal, salud, social— and
the handler translates it into one of Google's eleven `colorId` values.

**The split is deliberate and it is the same one as everywhere in this project:**
letting the model send the `colorId` would give us trips in a different colour every
week. There is no way it stays consistent with a number between 1 and 11 across months
of conversations, and a colour is only useful when it is always the same. It picks the
kind, which is what it can infer from the message; the table is maintained by the code.

An unknown category does not break the appointment: it is created without a colour,
which is what happened before this existed. And when listing, a `colorId` is only
translated back if it is in our table — colours the user set by hand from the app mean
nothing here, and naming them would be inventing data.

### Recurrence: and scope, which is the dangerous part

A birthday is an all-day event with `RRULE:FREQ=YEARLY`. The model picks the frequency
from a closed list —anual, mensual, semanal, diario, laborables— and the string is
written by the code, for the same reason as with the colours but with more force: an
RRULE has a grammar of its own, and a badly written rule **is accepted by the API**
and repeats the birthday on the wrong day for the next twenty years.

Adding recurrence forced fixing something that predated it. With `singleEvents=true`,
the ids `list_events` returns belong to **concrete occurrences**, so a `delete_event`
with one of those ids deletes that day only: "delete my sister's birthday" would have
left the other twenty years in place, and the user would not find out until the
following year. That is why `update_event` and `delete_event` carry `scope`:

| `scope` | What it acts on |
|---|---|
| `esta` (default) | That occurrence only |
| `serie` | All of them, using the `recurringEventId` that comes inside the event |

The default is the least destructive one, and **the scope goes in the confirmation's
text**, not in a note afterwards: between skipping a birthday and deleting it forever
there is no way back, and that is exactly what the button is confirming.

**Changing the time of a whole series is not done.** Re-anchoring the series from here
is where it breaks silently: a rule with fixed days —weekdays— moved onto a Saturday
stops matching its own pattern and a whole week of appointments disappears with no
error. A single occurrence can be moved, or a series can have its title, location or
category changed; for rescheduling, the calendar app. The tool says so in the error
and the prompt declares it in the list of limits, which is cheaper than spending an
iteration discovering it.

### All-day events do not go through the date corrector

`correctDay` assumes the model gets the **time** right and the day wrong. On an all-day
event there is no time, so the premise does not exist: applying it dragged the
appointment to today whenever the message did not name a day the detector recognised.
"All day" entries now use the model's date as is, which is the part it does well.

That failure exposed an older one that also affected tasks: `mentionsAnotherDay`
recognised "el 25 de agosto" but demanded the "el", so "pásalo **al** 25 de agosto",
"quedamos **para el** 3 de septiembre" and "la cita **del** 12 de enero" all slipped
through, and with them the corrector moved the date to today. A day number followed by
"de \<month\>" is now enough, with the month list spelled out so "el capítulo 12 de la
serie" is not mistaken for a date.

### Two limits that code does not fix

- **Guests cannot be invited.** A service account without *domain-wide delegation*
  —which requires Google Workspace, not a Gmail account— cannot add attendees and the
  API rejects it. "Put the appointment in" yes; "invite David" no.
- **An event's own reminders come from Google Calendar**, using that calendar's
  settings, and they cannot be set per appointment from here. What our cron does send is
  a heads-up a fixed number of minutes before every appointment (§12, phase 14); the
  prompt states that notice and forbids promising a different one for one particular
  appointment, which remains something only the calendar app can do.
- **Private events arrive with no title.** The shared permission we use is the one that
  shows them as an occupied slot and nothing more. One can be moved and deleted —the
  id does travel— but not identified by name, so `list_events` returns it flagged as
  private instead of letting the model invent what it is about. Raising the permission
  to *Make changes and see all event details* fixes that, at the price of giving the
  credential read access to everything.

### What it shares with tasks

The date guardrails moved out of `tasks.ts` into
[src/tools/guardrails.ts](src/tools/guardrails.ts) unchanged: the model gets the day
wrong just as often booking an appointment as creating a task, and on an appointment it
hurts more, because it takes up a slot the user believes is free. `honourUserInstant`
is the single-field variant —an appointment starts at a time and has no
deadline/reminder pair—; the split between two fields that `honourUserDeadlines` makes
does not apply, both corrections do.

`ToolContext` gained `env` and `deadline` here: this is the first tool to talk to an
outside service on its own, and until then `db` was all the handlers needed.
Authentication and the write **share a single budget** instead of each having its own
cap, which is the same lesson the audio path left in §10. Below 3 s it is not
attempted: telling the user to repeat themselves beats firing a write that Cloudflare
will cancel halfway, leaving us unable to tell whether the event was created.

---

## 14. The agenda: gaps, overlaps and what to do now

Phases 8 and 9. Two tools —`find_free_slots` and `what_now`— plus the overlap warning
on `create_event`. They share one premise, which is the project's oldest:
**the model asks, the code computes.**

That premise is not a style preference here. A free gap and the minutes left until the
next appointment are hour arithmetic, and that is what an LLM gets wrong **without
raising any error**: it invents a plausible gap and reports it with exactly the same
confidence as when it is right. A wrong date at least gets caught by the user reading
the reply; an invented gap gets caught when they show up to a meeting that was already
taken. So the interval arithmetic lives in [src/lib/slots.ts](src/lib/slots.ts), with
no dependencies, and the prompt has one extra line forbidding the model from working
gaps out for itself.

### `lib/slots.ts`: three functions and one distinction that matters

`overlaps`, `mergeIntervals` and `freeGaps`, all on epoch milliseconds. Time zones are
resolved before reaching them, in `lib/localtime.ts`: mixing both concerns in one
function is what makes a gap come out an hour off on the two clock-change days.

**Touching is not overlapping.** A 10:00-11:00 appointment and an 11:00-12:00 one are
back to back, not a conflict, so the comparisons in `overlaps` are strict. That is not
pedantry: Google returns events that end exactly when the search window starts as
being "inside the range", so without the strict comparison every appointment would
warn about the one before it.

The reverse holds when subtracting busy time: `mergeIntervals` **does** merge blocks
that touch, because two back-to-back meetings from 10 to 12 are one busy block, and
treating them separately would leave a zero-minute free gap between them.

It is the one part of these phases that can be wrong in silence, so it is also the one
with tests: compiled on its own and exercised from a `.mjs` with 26 cases, including
appointments arriving from yesterday, ones running into tomorrow, one contained inside
another, and gaps exactly at the minimum. Two of them failed on the first run and both
were wrong expectations in the test, not in the code.

### The day window, which has to be declared somewhere

`DAY_START_HOUR` and `DAY_END_HOUR` (9 to 21 by default). Without a declared window,
"you are free from 03:00 to 07:00" is a technically correct and completely useless
answer: the calendar is empty at night because people sleep, not because there is room
for anything.

It lives in the config and not in a memory because it is the user's decision and it
must not depend on `recall` getting it right. `DAY_END_HOUR` accepts 24 so that "until
midnight" is expressible; the window ending "at 24" is asked for as the next day's
midnight rather than 23:59, which would drop a minute from every day. The tool also
takes `from_hour` and `to_hour` so "what afternoons am I free?" narrows the window — the
model naming a range the user asked for is fine, it is doing the arithmetic that is not.

`ToolContext` gained `config` for this. Re-parsing the env inside each handler would
mean two different readings of the same var.

### What counts as busy

- **All-day events do not take up time.** A birthday or an "I'm travelling" fills the
  day in the calendar without preventing a meeting at eleven. If they blocked, any week
  with a name day in it would come back with no free slot at all and the tool would be
  useless.
- **Private appointments do.** They arrive with no title, but the shared permission we
  use returns them as an occupied slot, which is exactly the piece of data needed here.
  The gap is busy; what it is about stays unknown.
- **Gaps that already went by are not gaps.** For today, only what is left of the
  window counts, rounded up to the next five minutes: "from 12:35 to 14:00" reads like
  a person talking, "from 12:33" reads like machine output.

One read covers the whole range, no matter how many days were asked for, capped at 100
appointments and at 14 days. If the cap is reached, the result says so and tells the
model to say so too: a range with more appointments than fit in one page would
otherwise be reported as "I checked everything" having checked half.

### The overlap warning: it warns, and it goes after the write

`create_event` now says when the appointment it just created runs into another one. Two
decisions carry the weight.

**It warns, it does not block.** Two things at the same hour is something people do on
purpose. The warning travels inside an `{ok:true}` for the model to relay, not as an
`{ok:false}` — that would send it hunting for another hour nobody asked for.

**The check runs after writing, not before.** The appointment is what the user asked
for and it cannot end up unwritten because a courtesy lookup ate the message's budget.
Going after the write means the primary action always gets the full budget, and the
worst case is losing the warning. Two consequences fall out of that order:

- The check only runs when there is room for **the lookup plus the reply**
  (`CONFLICT_MAX_MS` + 5 s). The first version only required the lookup to fit, and the
  test caught it: with 8 s left, the lookup fitted and the reply that had to report it
  did not. The warning would have been paid for with silence, which is the failure this
  project has been avoiding since phase 1.
- The just-created appointment shows up in its own search, so it has to be filtered
  out. By its id — and **also by the series id**, because a recurring event comes back
  with the occurrence's id, which is not the one the POST returned. Without that, a
  weekly class would warn about clashing with itself.

A failure in the check never becomes a `create_event` error: the appointment is already
written, and telling the model something failed would have it report that to the user
as if nothing had been created.

`update_event` does **not** warn. It already spends a `GET` and a `PATCH`, and a third
call is not affordable inside a 27 s budget. It is a real gap: "move it to Friday at
14:00" can land on something taken and nothing will be said. Left as is on purpose,
noted here rather than pretended away.

### `what_now`: crossing three things, promising nothing

The answer to "what should I do?" crosses the clock, the calendar and the task list:
minutes until the next appointment, whatever is currently in progress, all-day entries
as context, and the pending things worth suggesting.

Which pending things is the briefing's criterion, for the same reason: what is overdue,
what is due today, and what matters with no date. A task with neither a date nor a
priority stays out — that is the inventory, not the day. Capped at three, and when more
qualify the count travels in a note so the model does not enumerate them.

**A task carries no estimated duration, so "it fits" cannot be asserted.** The phase's
own example was *"two of your pending things fit"*, and that is a hunch, not a
calculation. The result carries a note telling the model to give the free time and the
options without claiming it measured anything. Adding a duration field to `tasks` was
the alternative and it is not worth it yet: an estimate the user has to type in is a
field that goes stale.

**If the calendar cannot be read, the tasks still arrive.** The Google call is wrapped
in its own `try` and a failure degrades the answer to the task half plus a note saying
the calendar could not be read. It is the same split as the cron, where every job
carries its own `try`: on a "what should I do?", losing the tasks over a 500 from Google
would trade a useful answer for an error.

Both tools were exercised the same way as `lib/slots.ts` — a fake calendar and a `Db`
double, 26 more cases — covering the failing calendar, the exhausted budget, the
inverted window, the day already past, and a range crossing October's clock change.

---

## 15. Images: the universal capture

Phase 10. A photo of the school letter, the concert poster, the receipt or a meeting's
whiteboard, and out come the tasks and the appointments. It is the phase that saves the
most manual work, and the only one so far that opened up the LLM layer (§6).

The path is the audio one from §10 with the transcription step removed: `message.photo` →
pick a size → `getFile` → download → and from there the same flow as a text message, with
the caption as the message's text.

### Which photo, because there are four

Telegram does the compressing: one `sendPhoto` arrives as several versions —90, 320, 800
and 1280 px are the usual ones— each with its own `file_id`. Taking the last of the array
is the obvious move and the wrong one: it is the slowest to come down, the most expensive
to send, and past a point it adds nothing, because what is being read is the text on a
letter, not the grain of the paper.

[telegram/photos.ts](src/telegram/photos.ts) takes the **biggest one under both caps**:
1280 px on the long edge and 700 KB. Below 800 px a letter is no longer legible, which is
why the smallest is not simply always taken. When nothing fits —a message carrying only
the original— the smallest goes anyway: a photo the model can barely read still beats
telling the user their photo is unusable.

The array is re-sorted rather than trusted. It does arrive ordered, nothing in the API
promises it, and the whole point of the function is to not depend on that.

The mime type is hardcoded to `image/jpeg`. Telegram compresses to JPEG and, unlike
`voice`, does not send a `mime_type` for photos.

### The budget

Download 8 s with one retry, the same shape as the audio path and for the same reason: the
typical failure is a momentary spike on Telegram's file server and the second attempt
answers instantly. Two differences from audio: a little more time to come down (the 1280
version is 150-300 KB against the ~120 KB of a minute of audio) and clearly more reserved
for what comes after —10 s— because a call carrying an image is slower than a text one and
a photo with several things in it spends a second iteration.

The retry only happens when what is left covers the download **and** the answer. Nothing
new: it is the lesson of §10 applied to a different file.

### One confirmation before writing anything

The important decision of the phase, and it is not about images: it is about dates.

The date guardrails of §7 work by reading the user's message. **A photo with no caption
has no message**, so the corrector has nothing to hold on to —exactly the same hole as
the confirmation-button path— and the day the model reads off a poster goes in
uncorrected. On top of that, one photo fires several writes in a single turn.

So on a photo turn, **everything that writes waits for one confirmation**, destructive or
not. That is what `mutates` in `ToolDefinition` is for: `requiresConfirmation` answers
"is this irreversible?", `mutates` answers "does this write?", and they are different
questions. Read-only tools keep running as usual, because the model needs them to word
itself.

Which forced two things the previous phases had not:

- **Every tool that writes now has a `confirmationPrompt`.** Until now only the two
  `delete_` tools had one, and the fallback for the rest was `Ejecutar "create_task"`,
  which is not something anybody can review. They state what the ARGUMENTS say —"¿Apunto
  'Llevar el impreso' para el 3 de septiembre a las 10:00?"— and they say it the way the
  reminders do (§12), because this sentence is the whole guardrail: it is where a day
  read off a letter wrong gets caught.
- **The caption travels with the pending action.** A photo's caption is user text and does
  feed the corrector, so it is stored in KV with the call and read back when the button is
  pressed. Without it the guardrails would see an empty message and a "pásalo al jueves"
  written under the photo would be lost between the question and the answer.

`executeConfirmed` used to answer "Hecho, borrado", which was the only thing it ever had
to say. It now reports what it stored, with the date, read off the tools' own results.
That is rule 4 of §7 —make it state the date it stored— on a path where there is no model
reply to carry it.

The confirmation states the arguments, and the handler applies the guardrails afterwards,
so the two can differ: with a caption naming a relative delay and a model date deviating
more than ten minutes, what gets written is not exactly what was read. The message after
confirming names the real stored date, which is where that closes.

### What the history keeps

`source='photo'` and the `file_id` in `attachment_ref`. The stored text carries a `[foto]`
marker: without it, the caption would be read back on the following turns as though it had
arrived on its own, and the model would have no idea where the three tasks it created came
from.

### The prompt stops lying in one direction and starts in the other

The list of limits used to say "no puedo ver imágenes, fotos ni documentos", and with
vision on that sentence became false. It is now conditional on `supportsImages`, so with
a text-only model configured the prompt keeps saying it cannot see. Documents stay out
either way: a photo sent "as a file" arrives in `message.document` and is not handled.

The photo rules are all about what NOT to do, because the failure mode is not refusing to
read the photo, it is filling in what the photo does not say: no hour if the poster does
not give one, no day rather than a made-up day, and no describing the image, which is not
what it was sent for.

### Two limits left standing

- **An album is several messages.** Telegram sends each photo of a media group as its own
  update, so three photos are three turns and three confirmations. Grouping them would
  mean holding state between updates for a case that has not come up yet.
- **A photo sent as a file is not read.** "Send as file" skips the compression and lands in
  `document`, with the full original behind it. Supporting it means deciding a size cap
  for something Telegram has not compressed for us.

---

## 16. Deferred jobs: the things I owe you

Some work does not fit inside a message and no amount of tuning changes that. Downloading
a page is seconds of somebody else's latency, and the turn has 27 s to cover three model
rounds as well. Phase 17 is the answer, and it is barely a feature: a table of things the
assistant owes the user, written while answering "I'll tell you in a minute" and settled
by a later tick.

```sql
jobs(id, user_id, kind, payload, state, attempts, run_after, last_error, started_at, ...)
```

What lives on it today is one kind, `read_url`. The point was never the kind: it is that
once the table exists, anything blocked on latency stops being blocked. The slow half of
the search is the first tenant; the Sunday review of phase 13 and the audio reply that did
not fit in its turn are the obvious next ones.

### Claiming a row without a transaction

PostgREST cannot open one, and two overlapping ticks fetching the same URL twice is not
hypothetical — it is what happens the first time a tick runs long. What it *can* do is a
single `UPDATE ... RETURNING`, which is atomic per row. So the claim is a select for the
candidates followed by one conditional update each:

```
PATCH /jobs?id=eq.<id>&state=eq.pending   { state: 'running', ... }
```

The `state=eq.pending` in the **filter** is the whole mechanism. The winner gets its row
back; the loser gets an empty array and moves on. That is as close to a real claim as this
client gets, and it is close enough.

### The attempt is counted when the job is taken, not when it fails

This is the part that looks wrong and is not. Incrementing `attempts` on failure only
counts the failures the code got to *observe*, and the failure that matters here is the
one where `waitUntil()` gets cancelled mid-fetch: no exception, no log, nothing written.
A URL that reliably hangs would then be retried for ever, every five minutes, and the
counter would sit at zero the whole time.

### And a row left mid-flight has to be swept

The same cancellation leaves the row in `running` for ever, invisible to the claim query.
So before claiming anything, rows that have been `running` past a generous cutoff go back
to `pending` —or straight to `dead` if they had already used their attempts, since one of
those attempts is what took the tick down. Without this sweep, "I'll tell you later"
becomes a lie with no trace anywhere.

The cutoff is generous on purpose: reclaiming a job that is *still running* fetches the
same page twice, which is worse than waiting another tick.

### Retry, dead, and who gets told

`dead` is a state and not a boolean because "waiting for its next go" and "gave up" are
different things, and with nobody watching the table there is no other way to tell them
apart. The backoff grows with the attempt: the usual reason a page read fails is a site
that is down or rate-limiting us, and hammering it on the next tick is how a temporary
block becomes a permanent one. What cannot be fixed by waiting —a 404— skips the retries
entirely and dies on the spot.

**The user only hears about a failure when the job is dead.** A retry still has ticks
left, and announcing each attempt turns one link into three messages that say nothing.
But when it gives up, they have to be told: they were promised a summary, and silence
here is the exact failure this table exists to prevent.

### Where it sits in the tick, and the rule it breaks

Jobs go **last**, after the reminders, the alerts and the briefing. They are the only
thing in the project nobody is waiting on, and an appointment announced late is not an
appointment announced (§12). They ask the `Deadline` for their cap like everything else
and leave what does not fit for five minutes later.

They also break something that had been true since phase 5: **this is the first cron job
that calls the model.** Until now every proactive message was composed in code —zero
tokens, nothing to invent, no dependency on the provider being up when the alarm goes
off— and that does not survive contact with "tell me what this page says", which is a
summary and nothing else. The trade is contained the same way as everywhere else: if the
call does not fit the budget, the job stays pending rather than the message going out
half-written.

No new KV writes. State goes to Supabase; KV stays at its one write per message for the
`update_id` dedupe, which is the budget that actually binds.

## 17. Web search, in two halves

Search sat at the bottom of the roadmap for a long time as "useful, not spectacular", and
that was true while it was one thing. Split, each half lands on a surface that can pay for
it:

- **`search_web` returns snippets, not pages.** One request, with the token count decided
  in advance. That fits in a turn.
- **`read_url` returns nothing at all.** It queues a job (§16) and the summary arrives in
  its own message minutes later.

The split is what keeps the first third party we do not control down to one bounded call
inside a message's budget.

### The provider was chosen on the shape of the free tier, not on results

This is the decision worth recording, because the obvious criterion is the wrong one.
Every candidate returns adequate results for "what time do they open"; what separates them
is whether they still work in six months with nobody touching anything.

| | Free tier | Verdict |
|---|---|---|
| **Tavily** | 1.000 credits/month, **renewed**, no card | ✅ chosen |
| Serper | 2.500 queries, **once** | ❌ runs out and the bot goes mute on a random Tuesday |
| Google CSE | 100/day, but closed to new customers and shutting down | ❌ cannot even sign up |
| Brave | metered credits, card required, no spending cap | ❌ a loop becomes an invoice |

A welcome credit is not a free tier. Serper's 2.500 look better than Tavily's 1.000 until
you notice they do not come back: at the volume one person generates they last a few months
and then the assistant silently loses a capability. Brave's is worse than absent — the
whole project runs on the free plan precisely so that a bug costs nothing, and "no spending
cap" undoes that.

`search_depth: 'basic'` costs 1 credit against advanced's 2, which puts the ceiling at
about 33 searches a day. The real ceiling is lower and has nothing to do with Tavily:
`MAX_AGENT_ITERATIONS` is 3, so a search eats a third of the turn's rounds and there is
room for one, maybe two, per message.

Tavily can also return a written answer. We do not ask for it: relaying another model's
summary as fact through ours leaves no way to tell which of the two got it wrong. Our
model gets the snippets and cites them.

### The token cost is decided in the tool, once

Results × snippet cap, both constants in `tools/search.ts`, rather than whatever the
provider feels like returning. Five results at 400 characters is roughly 500 tokens, which
a turn can afford. What gets *persisted* is smaller still: the 600-character cap on tool
results (§5) means later turns see only the head of a search, and that degradation is the
right one — the model answers with everything in the turn where it searched.

Every result carries its url and, when the provider knows it, its date; the result set
carries the moment it was read. That is rule 4 of §7 in the domain where it bites hardest:
a search result is a snapshot, and Friday's number presented as "now" on a Sunday is the
same lie as an invented day.

### Reading a page: cut it, and say that you cut it

`read_url` hands the job a URL and the job hands the model extracted text, never HTML,
truncated to a byte cap. Bytes and not characters because what is being protected is the
token count, and a naive slice splits an accented letter in half — which in Spanish is
most sentences.

The flag saying it was truncated is the part that matters. **A model that does not know it
is reading half a page will happily invent the other half**, so the summariser is told, in
words, that the text is partial. That is the whole reason the reader returns an object
instead of a string.

The provider here is Jina Reader, and it is deliberately not the search provider: a URL
prefix that returns markdown, extraction included, no key required. Its honest limit is
that it does not fight anti-bot systems — a page behind a challenge or a paywall comes
back as an error, and the job reports that instead of pretending it read something.

### The prompt rule that had to be rewritten

Phase 14's lesson, again: shipping this meant deleting a line that had been true since
phase 1. The list of limits said flatly that it could not *search the internet, open
links or read pages*, and that line was earning its place — without it the model offered
to search and to "keep an eye on" things.

It could not simply go, because the two halves are not symmetrical. Searching is now
something the model does. Reading a page is something the **system** does later, and the
model never sees the text at all. So the line splits into a capability and a limit that
has to be stated even with the tool available, or the model answers as though it had
already read the page.

Both readings come from one place: with no key, `search_web` is not offered *and* the
prompt goes back to denying it. Two switches would drift apart.

### What is deliberately not here

**No cache.** It was in the plan, justified by saving credits, and that justification
collapsed once the credits turned out not to be scarce. What is left is latency, which
only pays if the same query really does repeat — and `tool_call_logs` already stores every
call with its arguments, so that is measurable instead of assumed. Same move as §13 makes
with postponements: read the logs before adding structure. A table, a TTL and a purge are
cheap to add later and impossible to un-add.

## 18. Fichaje: the first thing that acts on its own outside

Everything the cron did until here was a message. Phase 22 is different in kind: four times
a day the tick logs into somebody else's portal and writes to an attendance record. Nothing
about the mechanics is hard —three HTTP requests— and everything about the failure modes is,
because the two ways of being wrong are not symmetrical. A punch that does not happen is a
line missing from a timesheet. A punch that happens twice, or at the wrong time, or that we
report as done when it never landed, is a record that lies.

### There is no browser, and that turned out not to matter

Playwright, which is how this normally gets done, cannot run on Workers, and Browser
Rendering is on the paid plan. So [src/timeclock/http.ts](src/timeclock/http.ts) talks to
`registro.asp` the way a browser would: `GET` the page, fill the form, `POST` it back.

The page is three things, and every decision below follows from them:

- **One submit button, and its wording is the phase.** "Registrar entrada" while you are
  out, "Registrar salida" while you are in. Never both.
- **A radio group above it** ("Motivo registro") with the reasons for that phase, the
  ordinary one already selected. Starting and ending the day is pressing the button and
  nothing else; the two break punches have to pick their reason first.
- **"Último movimiento" below it**, stating what the portal recorded last and at what time,
  to the second.

What makes talking to it survivable is copying the form's own state back verbatim —every
hidden input travels through without this code knowing it exists— and matching buttons and
reasons by their **full** wording only. "entrada" as a loose fallback would also match
*Entrada del descanso* and register the wrong reason. Anything unrecognised becomes an error
carrying the route walked, what each page held and what it said, which is how a broken run
names the hop that broke instead of just failing.

Buttons are `<button type="submit">` with an icon inside and often no `name`, not
`<input type="submit">`, so the label lives in the element's text and not in a `value`. A
`type="button"` is skipped on purpose: it does whatever its script does, and on the login
page that one is *Cambiar Contraseña*.

And the login does not end at the login: it lands on a **bridge page**, a form with hidden
fields, no button and a script that posts it. There is no JavaScript in this runtime to run
that script with, and there does not need to be — a form with nothing to press is a form
meant to be posted as it stands, so it is posted as it stands. Without that hop there is no
session, and the symptom is indistinguishable from a wrong password.

**Four attempts, four wrong assumptions, and they are the lesson.** The first invented a
button per action and looked for a control labelled *Salida al descanso* — which is a
radio's label. The second recognised only `<input type="submit">`, so it could not have
found the real buttons either. The third guessed the login's URL, asked for `/CCB/`, got a
page that was not the login and filled nothing in; the site's own redirect from
`registro.asp` was there all along and needed no guessing. The fourth stopped at the bridge
page and reported it as unrecognisable, when what the page held was a form waiting to be
posted — the trail had not been counting input fields, so the one fact that would have said
so was the one fact missing.

Every one of the four showed up as "I do not understand this page", which is why the
diagnosis grew a breadcrumb trail with what each hop held and what it said: the failure was
never where the message pointed. The trail also caught a bug of its own on the way —
`textOf` stripped tags but not `<script>` bodies, so the page's "text" was quoting
JavaScript, and radio labels and the "Último movimiento" line were being matched against
code.

### The portal is the source of truth, not our table

The page shows one phase at a time, and that single property does three jobs at once. It is
why there is no "have I punched today?" flag anywhere in the schema:

- **Idempotence.** The user can clock in from the web at 09:20 and the automation, arriving
  at 09:00, finds no "Registrar entrada" and does nothing. Silently: there is nothing to
  report, and a message per skipped stage is how a bot gets muted.
- **`punch_status`.** What the user reads is the portal's state and its own "Último
  movimiento", not our log. Our log answers the other half —what the automation did— which
  the portal cannot.
- **Verification.** After submitting, "Último movimiento" must be the reason we just sent.
  Anything else and either it did not land or we cannot tell, and those are not the same.

### The four endings of one punch, and why they cannot share code

This is the whole design, and it is a table rather than a `catch`:

| What happened | What it means | What is done |
|---|---|---|
| The phase button is not there | Already punched, or not this stage's turn | Nothing, quietly. Day closed |
| Portal down, timeout | Nothing was written | Day **released**, next tick retries |
| Wrong credentials, page not understood | A human has to look | Day closed, user told |
| Answered, "Último movimiento" unchanged | **Unknown** whether it registered | Day closed, user told, **never retried** |

The last row is the one worth the section. A retry there is a coin flip on a duplicate
punch, so the code refuses to take it: an unverified punch is reported and left alone. That
asymmetry —silence is cheap, duplication is not— decides every branch above.

### The day is claimed before it is punched

`fired_on` is stamped with a conditional `UPDATE ... RETURNING`, the same trick the job
queue claims rows with (§16). Two overlapping ticks cannot both win, which matters here more
than it does for a page summary: the loser would clock in a second time. The price is that a
failure has already spent the day, which is why the "nothing was written" case explicitly
gives it back.

### The random offset is drawn once a day and written down

The requested behaviour is a window of five minutes either side of each time. The obvious
implementation —jitter on each tick— does not produce that: the tick runs every five
minutes and the rule is `now >= at_time + offset`, so re-rolling fires on the first tick
whose draw happens to pass, pinning every day to the earliest edge. `offset_minutes` and
`offset_for` exist so the number survives to the next tick.

### And it runs first in the tick, not last

The opposite of the jobs of §16, and for the opposite reason. A job is the one thing nobody
is waiting on; a punch has to land at the time it was told, so it does not queue behind a
calendar read that might eat the budget. It also never becomes a job for the same reason —
that was a real change of mind mid-implementation, recorded in `db/types.ts` where the
`JobKind` union no longer has a punch in it.

What it cannot know is holidays: nobody told us the calendar of somebody else's company. On
a holiday the portal simply does not offer the button, which lands on the first row of the
table above and is the safe direction.

## 19. Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0** | Scaffold, webhook, security guard, echo | ✅ Done |
| **1** | NVIDIA provider + text conversation | ✅ Done |
| **2** | Tool registry + tasks in Supabase + confirmations | ✅ Done |
| **3** | Audio with Whisper | ✅ Done |
| **4** | History in Supabase + long-term memory | ✅ Done |
| **5** | Cron: morning briefing and due-date reminders | ✅ Done |
| **6** | Google Calendar events (write) | ✅ Done |
| **7** | Reading, moving and deleting calendar appointments | ✅ Done |
| **8** | Overlap warning on create and free-slot search | ✅ Done |
| **9** | "What should I do now?": tasks + agenda + clock in one answer | ✅ Done |
| **10** | Images with vision: the universal capture | ✅ Done |
| **11** | Audio replies (TTS) | ⬜ Pending |
| **12** | The briefing covering the day's meetings | ✅ Done |
| **13** | The Sunday review | ⬜ Pending |
| **14** | A heads-up before each appointment | ✅ Done |
| **15** | Postponing an alert from the alert itself | ✅ Done |
| **16** | Tasks and alerts that repeat | ✅ Done |
| **17** | Deferred jobs: the link inbox | ✅ Done |
| **18** | Weather and travel time inside the alerts | ⬜ Pending |
| **19** | Markets: a watchlist, not a ticker | ⬜ Pending |
| **20** | Web search, split in two | ✅ Done |
| **21** | Expenses in a spreadsheet | ⬜ Pending |
| **22** | Fichaje: scheduled punches and the state of the day | ✅ Done |
| **23** | Imputación de horas into the day's projects | ⬜ Pending |

Every phase is deployed and used on its own. Phase 2 is where it stops being a chatbot
and becomes an assistant; phase 5 is where it becomes proactive.

Phases 6 and 7 shipped back to back on the same day: 6 left the calendar write-only and
the first real conversation made clear that would not hold. It is told in §13, because
the lesson is not about the calendar but about where trimmed-down scopes break.

Phases 8 and 9 shipped together for the opposite reason: 9 is almost free once 8 exists
—the interval arithmetic is the same— and splitting them would have meant two deploys
for one idea. Both are told in §14.

**From 11 to 13 the order is about risk, not importance.** Phase 10 came first of the
four because it was the only one that opened up the LLM layer, and it went in after the
agenda was complete so that a contract change was not mixed in with new functionality.
It is told in §15.

Phase 12 jumped ahead of 11 for the opposite reason: it changes nothing about the
contract with anybody —no new tool, no new provider, one call to a calendar that was
already being read— and it is the one that is read every single morning. It is told in
§12, alongside the rest of the cron, because what it is really about is the briefing and
not the calendar.

Phase 14 was not on this list and went in right after 12, because 12 is what made it
obvious: once the briefing names the day's appointments at eight in the morning, the
question of who warns you at ten to ten stops being theoretical. It is a third cron job
and no new tool, and it is told in §12 too. Its interesting part is not the job: it is
that shipping it meant rewriting a prompt rule that had been true until that day.

Phases 15 and 16 close the same gap from two sides: what happens **after** an alert
arrives. 15 is the answer that was already being written by hand every time —postpone
it— and 16 is the one that was being written down again every week. Neither adds a
provider or a tool; 16 is the only one of the three that touches the schema, with one
column. Both are in §12.

**Phases 17 to 21 were ordered by which surface they land on, not by what they are
about.** There are two, and only one of them is busy. The reactive surface —a message,
its 27 s and its three model rounds— is where every new external call competes with the
LLM for the same budget. The proactive one —the cron, 288 ticks a day out of the free
plan's 100,000— has nobody waiting on it and reads nothing outside the calendar today.

That is what unblocked the two ideas that had been sitting at the bottom of this list. A
forwarded link does not fit inside a turn and never will; the same link, stored as a row
and resolved by the next tick, has no deadline left to blow. So 17 is not really a
feature, it is where the others live: once there is a table for "things I owe you", the
link summary, the slow search, the review of §13 and even the audio reply that did not
fit in its turn all stop being blocked on latency.

Phases 17 and 20 shipped together, and that pairing was not a matter of convenience: 20
is the phase that proves 17. Half of it —snippets— runs in the turn, and the other half
—reading the page— is the first tenant of the queue, so shipping one without the other
would have meant either a search that cannot open a link or a table with nothing in it.
17 is told in §16, 20 in §17 and 22 in §18. Between them they cost the cron its oldest rule, that no
proactive message goes through the model, and the tool contract one new optional field.

### Phase 11 — Audio replies (TTS)

Answering a voice note with a voice note. It is the detail that stops it feeling like a
bot, and one of the cheap ones: `ChatAction` already covers `upload_voice` and
`record_voice`, so what is missing is `sendVoice` on the client and a provider behind an
interface in `src/tts/`, like the STT.

- **Opus, not MP3.** That is what Telegram accepts as a voice note without conversion,
  the same stroke of luck we already have with the incoming OGG. An MP3 arrives as a
  file attachment, which is not the same thing in a chat.
- **Voice only when the message came in as voice, and the text always too.** An alert
  that only arrives as audio is an alert that cannot be read in a meeting.
- It goes at the end of the turn with whatever budget is left. If it does not fit, the
  text is sent and nothing is said: an audio is no reason to lose the reply.

### Phase 13 — The Sunday review

One message a week: what got closed, what is still open, and what has been postponed
for three weeks. That last one is what impresses, and what no app says out loud.

Counting postponements needs the data, and today it is not there: `updated_at` does not
tell moving a date apart from fixing a title. Start by reading it from
`tool_call_logs`, which already stores every `update_task` with its arguments, before
adding a counter to `tasks`.

In code like the briefing, and with a KV marker like its own: one write a week.

### Phase 18 — Weather and travel time inside the alerts

This one adds no domain and no tool: it improves the message that already arrives every
day. `EVENT_ALERT_MINUTES` is a fixed 15 today, and Calendar events carry `location`,
so the heads-up can go from "you have an appointment in 15 minutes" to **"leave at
9:35, it is 22 minutes with traffic"**.

- **Weather belongs in the briefing and in `what_now`, not in a tool.** Nobody asks a
  bot for the forecast twice; what is worth saying out loud is that it rains at six and
  the appointment is across town. Open-Meteo needs no key and returns a small JSON.
- **Both have to degrade to today's message.** No location, no coordinates, provider
  down or slow: the alert goes out as it does now. An alert that arrives late because a
  traffic API was thinking is strictly worse than a fixed 15 minutes.
- One decision has to be made before writing it: where "from" is when there is no
  previous event on the calendar. Home as a memory is the cheap answer.

### Phase 19 — Markets: a watchlist, not a ticker

A `get_quote` tool is cheap —one request, well inside the budget— and it is also worse
than opening the broker's app. What an app does not do is speak first, so the product is
the watchlist: symbols and thresholds in Supabase, evaluated by the tick, batched into a
single request and gated to market hours with `lib/localtime.ts`. "Tell me if Nvidia
drops below 140" is asked in one sentence and arrives on its own.

- **The number is not the interesting part, the reason is.** When a threshold fires,
  hang the symbol's headlines off it: Yahoo Finance and Google News both publish keyless
  RSS, four fields out of the XML, no dependency added.
- **A market line in the briefing only above a movement threshold.** A line that says
  "+0.3%" every morning stops being read inside a week, and then so does the rest of the
  briefing.
- **Every price carries the moment it was read.** This is rule 4 of §7 —say the date you
  stored— in a domain where it bites harder: markets close, and Friday's number
  presented as "now" on a Sunday is the same lie as an invented day.
- **The provider goes behind an interface in `src/markets/`, like the LLM and the STT,
  and here that is not ceremony.** Yahoo has no supported free API: the quote endpoint
  has wanted a cookie and a crumb for a long time and breaks without notice. Stooq's
  plain CSV, or a keyed free tier such as Twelve Data or Finnhub, are the fallbacks; FX
  from the ECB via Frankfurter, crypto from CoinGecko. Which one is primary has to be
  checked the day this gets written, not decided here.

### Phase 21 — Expenses in a spreadsheet

"Forty on dinner" said into a voice note becomes a row in a Google Sheet. `calendar/
google-auth.ts` already signs service-account JWTs, so the whole cost is one endpoint
(`values.append`) against a sheet shared with the service account, and a monthly summary
from the cron.

Why a spreadsheet and not an `expenses` table: a table means also writing the
categories, the queries and the reports, which is the `tasks` pattern again for no new
lesson. The sheet **is** the report, and it is one the user can pivot without teaching
Jarvis anything about pivots.

### Phase 23 — Imputación de horas

The other half of the same portal, and the reason the schema already carries `imputations`
and `project_cache` with nothing reading them yet: they were written with phase 22 because
the tables are the cheap part and a second migration is not.

The shape is decided and it is not the shape of phase 22. Punching is one button; imputing
is a project picked out of the day's table, a number of hours and a **mandatory** comment,
which means the model has to choose a row and the user has to confirm before anything is
written. So: the tick scrapes the day's table into `project_cache` —a login plus a scrape
does not fit in a turn next to three model rounds— the turn reads the cache, the
confirmation goes through `tools/pending.ts` like every other irreversible write, and the
submit itself becomes a job (§16), because unlike a punch nobody is waiting for it to land
on a particular minute.

Two things it has to get right, both learned from phase 22: the date the row lands on is the
one the **site** reports after submitting, not the one we asked for —a full day rolls over to
the next— and hours go in as digits with a comma, never "3h".

### Ideas with no phase assigned

- **Gmail triage.** Worth knowing before starting: the service account cannot read a
  personal inbox —that needs domain-wide delegation, which is a Workspace thing— so it
  means OAuth with consent and a refresh token kept as a secret. And the shape that
  holds is not "summarise my inbox" but a label: only what gets tagged comes in, and
  what comes out of it is **commitments** ("they need the form by Thursday") turned into
  tasks. Bounded in volume, in tokens and in privacy, all three by the same decision.
- **Reminders triggered by context instead of by date.** A `triggers` table matched on
  keywords in the handler *before* the model call: zero tokens, zero third parties, and
  nothing any task app does. "When the mortgage comes up, remind me to ask about the
  rate." It is the cheapest idea on this page; it has no phase because the matching rule
  is the whole problem, and one that fires on every other message is worse than nothing.
- **The bank via PSD2** (GoCardless, ex-Nordigen). It would make 21 automatic instead of
  dictated, which is the difference between an expense log that survives a month and one
  that does not. But the consent has to be renewed every 90 days: that is a project, not
  a phase.
- More tool domains: notes, shopping lists. There is nothing to learn there, it is
  repeating the `tasks` pattern. Google Tasks is the same thing with a worse ending:
  duplicating our own table under somebody else's schema.
- A web panel on Cloudflare Pages reading from Supabase. It takes the product out of
  Telegram, which is where it works.
- Embeddings on `memories` (`pgvector`) once key-based recall genuinely falls short.
  Today it does not, and it would be invisible work.
