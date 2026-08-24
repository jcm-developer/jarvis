# Jarvis

A personal assistant over Telegram, running on Cloudflare Workers with Supabase as the database.

Full design and technical decisions: [ARCHITECTURE.md](ARCHITECTURE.md)

**Status: phase 20** — tasks, memory, voice notes, photos with vision, history in
Supabase, proactive cron alerts, a full read/write Google Calendar, free-slot search, a
"what should I do now?" that crosses the agenda with the task list, things that repeat,
and web search: it looks things up in the conversation and reads the links you send it in
a message of its own.

The bot talks Spanish: everything it says in the chat, the system prompt and the tool
descriptions are written in Spanish on purpose. The code and the docs are in English.

Continuous deployment with **Cloudflare Workers Builds**: every push to `main` deploys.

---

## Getting it running

### 1. Telegram bot

- [@BotFather](https://t.me/BotFather) → `/newbot` → keep the **token**
- [@userinfobot](https://t.me/userinfobot) → your **user id** (a number)

That id is the whitelist. Without it the bot will not answer even you.

### 2. KV namespace

In the dashboard: **Storage & Databases → KV → Create Instance**, named `jarvis-STATE`.
Copy the **Namespace ID** into [wrangler.toml](wrangler.toml).

The CLI is equivalent:

```bash
npx wrangler kv namespace create STATE
```

The id **has to be committed before the first build**: Workers Builds deploys by
reading `wrangler.toml` from the repo, and with the placeholder in place the deploy
fails.

### 3. Connecting Workers Builds

**Workers & Pages → Create → Import a repository → `jcm-developer/jarvis`**

| Field | Value |
|---|---|
| Project name | `jarvis` (must match `name` in `wrangler.toml`) |
| Build command | `npm run typecheck` |
| Deploy command | `npx wrangler deploy` |
| Builds for non-production branches | unchecked |
| Path | `/` |
| API token | the one Cloudflare creates by default |

`npm run typecheck` as the build command acts as a gate: if the TypeScript does not
compile, the build fails and **nothing is deployed**. Without it, one broken push takes
the bot down in production.

### 4. Secrets

After the first deploy: **Worker → Settings → Variables and Secrets → Add**, of type
**Secret** (not *Text*), one for each of:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the one from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | a long random string (see below) |
| `ALLOWED_TELEGRAM_IDS` | your user id, several separated by commas |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) → *Create new secret key*. Used for the model and for transcription |
| `SUPABASE_URL` | Supabase → Project Settings → API → *Project URL* |
| `SUPABASE_SERVICE_ROLE_KEY` | same page → *service_role*. It bypasses RLS: treat it as the master key |
| `GOOGLE_SA_EMAIL` | from phase 6 on. The `client_email` from the service account JSON |
| `GOOGLE_SA_PRIVATE_KEY` | same JSON, the `private_key`: paste it as is, `\n` included |
| `GOOGLE_CALENDAR_ID` | same, the shared calendar's id. Never `primary` |
| `TAVILY_API_KEY` | from phase 20 on, and optional. [tavily.com](https://tavily.com) → API key. Free, no card. Without it the bot simply cannot search |

**Press Deploy when you are done.** The secrets do not take effect until then.

Generating the webhook secret in PowerShell:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

Keep it: you need it again in step 5.

> **Secrets vs vars.** Secrets are set once and survive every deploy. The `[vars]` in
> `wrangler.toml` are overwritten on every deploy, so editing them in the dashboard is
> pointless: the next push reverts them. `wrangler.toml` is the only source of truth
> for vars.

`ALLOWED_TELEGRAM_IDS` is a secret and not a var because this repo is public.

### 5. Registering the webhook

Once only. The `secret_token` has to be **identical** to `TELEGRAM_WEBHOOK_SECRET`; if
it does not match, the Worker answers 403 to everything and the bot looks dead without
giving any clue.

```powershell
$token  = "<TOKEN>"
$secret = "<YOUR_WEBHOOK_SECRET>"
$url    = "https://jarvis.<subdomain>.workers.dev/webhook"

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -ContentType "application/json" -Body (@{
    url             = $url
    secret_token    = $secret
    allowed_updates = @("message", "edited_message", "callback_query")
  } | ConvertTo-Json)
```

`Invoke-RestMethod` is used rather than `curl` on purpose: in PowerShell `curl` is an
alias for `Invoke-WebRequest` and does not accept curl's flags, while `curl.exe` forces
escaping the JSON by hand, which is where almost everybody trips. Do not forget the
trailing `/webhook` in the URL.

To check:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" | Select-Object -ExpandProperty result
```

A non-empty `last_error_message` or a high `pending_update_count` means something is
wrong.

### 6. Database (from phase 2 on)

Supabase → SQL Editor → paste [supabase/schema.sql](supabase/schema.sql) → Run.

It is idempotent and can be re-run: that is how later phases' schema changes arrive
(the last one, `kind` on `tasks`, which tells a task apart from an alert).

### 7. Trying it

`/start`, `/ping`, or any text at all.

---

## Development

```bash
npm install
npm run dev         # local server
npm run typecheck   # the same thing CI runs
npm run tail        # live production logs
```

For local work, copy `.dev.vars.example` to `.dev.vars` and fill it in. It is in
`.gitignore`.

Deploying by hand, skipping CI:

```bash
npm run deploy
```

### Testing the cron without waiting for the hour

`wrangler dev` exposes an endpoint to fire it by hand:

```bash
npx wrangler dev --test-scheduled
# in another terminal
curl.exe "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Every run leaves a `cron_run` line in the logs with how many users it looked at, and
how many reminders, appointment heads-ups and briefings went out. Neither the briefing
nor an appointment already announced repeats: to test them again, delete the KV key
(`briefing:<userId>:<date>` or `event_alert:<userId>:<eventId>:<startAt>`).

### Testing delicate logic without a test framework

There is no test framework. For anything where a mistake is silent, the pattern that
works is compiling the module on its own and exercising it from a `.mjs` (or `.cjs`)
with doubles:

```bash
# pure interval arithmetic: no dependencies, compiles alone
npx tsc src/lib/slots.ts --outDir <scratchpad> --module es2022 --target es2022

# whole tools, with a fake calendar and a Db double
npx tsc -p tsconfig.json --outDir <scratchpad>/cjs --module commonjs \
  --moduleResolution node --verbatimModuleSyntax false --noEmit false
```

With the CommonJS build you can replace `createCalendarClient` on the calendar
module's exports object and drive `find_free_slots`, `what_now` or `create_event`
against events you made up. It has already caught real bugs — the latest being an
overlap check that fitted in the budget while the reply that had to report it did not.

The same trick works for the LLM adapter: compile `openai-compatible.ts`, replace
`globalThis.fetch` with one that captures the body, and you can assert exactly what
travels on the wire — that a photo goes as a data URL, that a message with no attachment
still sends its content as a plain string, and that a 300 KB image survives the base64
round-trip. Phase 10 was checked that way, along with the sentences each tool shows
before writing anything.

---

## Troubleshooting

### The bot does not answer

The Worker returns `200` in almost every failure mode (so Telegram does not retry in a
loop), so from Telegram you see nothing. Diagnose in layers:

```powershell
# 1. Is the Worker alive?  → it should answer "jarvis ok"
curl.exe https://jarvis.<subdomain>.workers.dev/

# 2. Does the secret match?  → 200 = yes, 403 = no
curl.exe -s -o NUL -w "%{http_code}" -X POST https://jarvis.<subdomain>.workers.dev/webhook `
  -H "Content-Type: application/json" `
  -H "X-Telegram-Bot-Api-Secret-Token: <YOUR_SECRET>" -d '{\"update_id\":1}'

# 3. Is Telegram delivering?  → look at last_error_message
Invoke-RestMethod "https://api.telegram.org/bot$token/getWebhookInfo" | Select -ExpandProperty result
```

If step 2 returns 200 and the bot is still mute, the problem is the whitelist: check the
logs (**Compute → Workers → jarvis → Logs**), where `update ignorado de usuario no
autorizado: N` gives you your real id.

### Known limit: everything has to fit in 27 s

Cloudflare's free plan grants **30 s** to `ctx.waitUntil()` after answering and then
cancels the task. All of a message's processing has to fit in there, and the split is
controlled by [src/lib/deadline.ts](src/lib/deadline.ts) with a 27 s budget:

| Step | Cap |
|---|---|
| Audio download (`getFile` + file) | 6 s per attempt, with one retry |
| Transcription | 10 s |
| Each model call | 15 s, or whatever is left |
| Each calendar call | 10 s, or whatever is left |

The download had 15 s on the assumption that long notes took longer. They do not:
Telegram sends them as OGG/Opus at ~16 kbps, a minute of audio is ~120 KB and comes
down in under a second. Download failures are **momentary spikes on Telegram's file
server**, not a size issue; that is why the same audio failed some times and not
others. It now cuts sooner and retries once, as long as there is budget left to
transcribe and answer afterwards.

The real fix is **Cloudflare Queues** ($5/month): it decouples the work from the request
and removes the ceiling. The change touches almost only
[src/index.ts](src/index.ts) — it has been designed for that from the start.

### Two traps that cost time

**Dashboard secrets do not take effect until you press Deploy.** Adding them under
*Variables and Secrets* and leaving the screen does nothing: the Worker keeps running
the previous version, without them, and rejects everything with 403.

**`setWebhook` ignores the `secret_token` when the URL was already registered.**
Telegram compares only the URL, answers
`{"ok":true,"description":"Webhook is already set"}` and discards the rest of the
parameters. If you see `already set` instead of `Webhook was set`, your secret has
**not** been stored. It has to be deleted first:

```
https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>/webhook&secret_token=<SECRET>
```

## What phase 0 does

Every update goes through four filters before being processed:

1. **Secret header** — `X-Telegram-Bot-Api-Secret-Token`, compared in constant time.
2. **Whitelist** — only the ids in `ALLOWED_TELEGRAM_IDS`. Everyone else is ignored
   silently.
3. **Dedupe** — the `update_id` is claimed in KV with a 24 h TTL, so a Telegram retry
   does not re-run the actions.
4. **Immediate response** — `200 OK` right away and the real work inside
   `ctx.waitUntil()`, because the agent will take longer than Telegram's timeout.

## What phase 1 does

A real conversation against an LLM, with memory of the last few turns.

**Provider layer** ([src/llm/](src/llm/)). Nothing outside that directory knows which
provider is active. OpenAI, Groq and NVIDIA speak the same format, so they share a
single adapter ([openai-compatible.ts](src/llm/providers/openai-compatible.ts)) and
switching between them is two lines of `wrangler.toml` plus its API key:

```toml
LLM_PROVIDER = "openai"
LLM_MODEL = "gpt-4.1-mini"
```

That is what runs in production. It started on NVIDIA NIM for the free tier and had to
be abandoned: it queued free requests and a simple greeting took over 45 s, more than
any setup on the free plan can absorb (see
[ARCHITECTURE.md §11](ARCHITECTURE.md)). With OpenAI the same reply takes 2-5 s.
`groq` (`llama-3.3-70b-versatile`) and `nvidia` are still supported as alternatives.

Within OpenAI it started on `gpt-4o-mini` and moved to `gpt-4.1-mini` because the first
one ignored instructions: it duplicated tasks and dated alerts to the following day with
the rules right in front of it. It is more expensive on paper, but almost everything we
spend is cached prefix, where the difference drops to 33%.

Plain `fetch` is used instead of OpenAI's SDK to keep the bundle small. It includes a
20 s timeout per call —trimmed further by the message's budget—, one retry on 429 and
5xx, and cleanup of the `<think>` blocks reasoning models emit.

**Short-term memory.** A sliding window of `HISTORY_WINDOW` messages. It was born in KV
with a 7-day TTL as a stopgap; phase 4 moved it to Supabase.

**Readable errors.** Exhausted quota, an invalid key or a timeout reach Telegram as a
clear sentence, not as silence and not as a stack dump.

Commands: `/ping`, `/test`, `/reset`, `/help`. Everything else goes to the model. `/ping`
also reports the briefing's hour and the notice given before appointments.
Audio is acknowledged but not transcribed until phase 3.

## What phase 2 does

The agent stops conversing and starts acting.

**Tool registry** ([src/tools/](src/tools/)). Every tool is a typed definition with its
JSON Schema, and they are sent in the request's `tools` field — not described in prose
inside the prompt, which would duplicate the source of truth.

| Tool | What it does | Confirmation |
|---|---|---|
| `create_task` | Creates a task, or an alert that goes out and closes itself | No |
| `list_tasks` | Filters by status, due date and kind | No |
| `update_task` | Changes the deadline, alert time, title, notes, priority or status | No |
| `complete_task` | Marks it as done | No |
| `delete_task` | Deletes permanently | **Yes** |
| `remember` | Stores a lasting fact about the user | No |
| `recall` | Searches what has been remembered | No |

**Agentic loop** ([src/agent.ts](src/agent.ts)). Up to `MAX_AGENT_ITERATIONS` rounds:
the model asks for tools, they run, the result comes back as a `tool` message and it
decides again. Errors are returned to the model as `{ok:false, error}` so it corrects
itself instead of breaking the conversation.

**Human confirmation.** `delete_task` does not run: the action is parked in KV with a
15-minute TTL and the user gets buttons. Confirming consumes it — pressing twice does
not run it twice. The button text includes the task's real title, because nobody
reviews a uuid.

**Our own database client** ([src/db/client.ts](src/db/client.ts)). PostgREST over
`fetch`, without `@supabase/supabase-js`, for the same reason as in the LLM layer. It
connects as `service_role`, which bypasses RLS.

**Audit trail.** Every tool call is recorded in `tool_call_logs` with arguments, result,
duration and error. That is what makes it possible to understand later why the agent did
what it did.

## What phase 3 does

Voice notes. You send audio and it does whatever you asked.

Telegram sends OGG/Opus → it is downloaded with `getFile` → transcribed → the text
enters through the same path as a written message.

**Two transcribers** ([src/stt/](src/stt/)), interchangeable like the LLM ones:

| `STT_PROVIDER` | Model | Notes |
|---|---|---|
| `openai` (default) | `whisper-1` | Accepts OGG without conversion. Better in Spanish. Cents per hour |
| `workers-ai` | `@cf/openai/whisper-large-v3-turbo` | Free, inside Cloudflare |

`STT_LANGUAGE = "es"` pins the language instead of autodetecting it, which improves
accuracy on phone audio quite a bit.

An empty transcript **never** reaches the model: the reply asks the user to repeat.
Otherwise the agent would improvise on top of an empty string.

## What phase 4 does

The history leaves KV and moves to the `messages` table
([src/db/messages.ts](src/db/messages.ts)). It is not a cosmetic change: the free plan
gives 1,000 KV writes a day and the history spent one per message, competing with the
`update_id` dedupe. KV now only holds the ephemeral — dedupe, pending confirmations and
the identity cache.

The **whole** turn is persisted: the user's message, the `assistant` with its
`tool_calls` and every `tool` result. And in one shot at the end of the turn, in a
multi-row INSERT: saving halfway would leave an `assistant` with `tool_calls` and no
results, which is context the API rejects with a 400.

Every row carries `source` (`text` or `voice`) and, for audio, the raw transcript. When
the agent understands something odd, the first thing to check is whether it came from
audio.

`/reset` really deletes the conversation's rows. The audit trail of what the agent *did*
stays in `tool_call_logs`, and what it remembers about the user long term (`memories`)
is untouched.

## What phase 5 does

Jarvis stops waiting for you to write: now it writes to you.

**Daily briefing** ([src/cron/briefing.ts](src/cron/briefing.ts)). At 8 in the morning
*in your local time* a message arrives with what you have: overdue items, today's with
their time, and the urgent ones with no date. Since phase 12 it opens with the day's
appointments — see further down. It is sent once a day, inside a 3-hour window: if the 8
o'clock tick is missed, the 9 or the 10 one recovers it.

```toml
BRIEFING_HOUR = "8"   # local hour, 0-23
```

The text is composed in code, without going through the model: it is a list of tasks
with dates, so this way it costs no tokens and cannot invent a task that does not exist.

**Reminders** ([src/cron/reminders.ts](src/cron/reminders.ts)). The cron runs every five
minutes and tells two classes of alert apart:

| You ask for | Field | It arrives |
|---|---|---|
| "recuérdamelo a las 12:10" | `remind_at` | At 12:10 (within those 5 minutes) |
| a task with a deadline | `due_at` | One hour before it is due |

Each row is announced once (`reminded_at`), and anything already overdue comes in too,
capped at 10 per run so day one is not an avalanche.

**An alert does not survive going out.** *"Recuérdame a las nueve que saque la basura"* is
a `kind='reminder'` row: the message lands at nine and the row closes itself. It never
reaches your pending list, because once you have been told there is nothing left of it. A
task —*"pagar el IBI antes del viernes"*— stays open until you say it is done: what
matters there is not the alert, it is the payment. Before this, alerts already delivered
piled up as pending for ever and took the briefing's slots away from the real plan.

One table with one extra column, not a `reminders` table: two would have meant two
near-identical sets of tools for the model to mix up. And the calendar cannot take the
tasks over either — an errand sitting there would count as an occupied slot and would
break the free-gap search.

The message is written to sound like a person, not like an alarm:

> Acuérdate de llamar a David a las 18:00.
>
> Se te ha pasado pagar la luz, era ayer a las 09:00.

The Worker composes it, without the model: zero tokens and it cannot invent a task. The
time is only stated when it adds something, days are named (ayer, mañana) and the
opening phrase varies between tasks.

That the alert is a field of the task and not another task matters: without `remind_at`,
an "I'm calling David at 17:30, remind me at 12:10" ended up as two rows, the task and a
"remember to call David". One thing to do, one row.

**Local time, properly computed** ([src/lib/localtime.ts](src/lib/localtime.ts)).
Cloudflare's cron fires in UTC and Spain changes its clocks twice a year: a cron at
06:00 UTC would be 7 in winter and 8 in summer. So the local hour, the start and the end
of the day all come from `Intl`, including the two days a year that last 23 and 25 hours.

Alerts are stored in the history as assistant messages. Without that, answering "done"
to a reminder would have no referent and the model would ask what you are talking about.

No new secrets are needed. The trigger in [wrangler.toml](wrangler.toml) is already on,
and the `remind_at` column arrives by re-running
[supabase/schema.sql](supabase/schema.sql), which is idempotent.

## What phases 6 and 7 do: the calendar

Putting appointments on Google Calendar from the chat. *"Apúntame el dentista el jueves
a las diez"* creates the event; *"comprar pan"* is still a task. The boundary is whether
it takes up a slot of the day at a specific time or is something to do whenever
possible, and if the model is unsure, it asks.

Phase 6 could only create. **Phase 7** added looking them up, moving them and deleting
them:

```
¿qué tengo el jueves?
muévela al viernes
la del dentista bórrala, que al final no puedo ir
apunta que me voy a Lisboa del 23 al 26
el cumple de Marta es el 3 de septiembre, todos los años
```

Multi-day appointments are stored as a single event, not one per day. And depending on
what they are —viaje, trabajo, estudios, personal, salud, social— they come out in a
different colour in the calendar app: the model infers the kind and the code picks the
colour, so trips are always the same colour rather than a new one every week.

Recurring appointments (yearly, monthly, weekly, daily, weekdays) can be touched two
ways, and **before changing or deleting one it asks which**: that day only, or every
occurrence. The confirmation button's text says so, because between skipping a birthday
and deleting it forever there is no way back.

To change or delete anything it needs the id, so it looks the calendar up first and acts
afterwards. Deleting asks for button confirmation, like deleting a task, and the question
carries the appointment's title so you know what you are confirming.

An appointment's reminders come from your own calendar app, not from Jarvis's cron.

### Preparing Google (once)

1. [console.cloud.google.com](https://console.cloud.google.com) with the calendar's
   account → new project → **APIs & Services → Library** → enable the
   **Google Calendar API**. No card required: the free quota is a million requests a day
   and we make one per appointment.
2. **IAM & Admin → Service Accounts → Create**. With no IAM role at all: the permissions
   come from the shared calendar, not from here.
3. The account → **Keys → Add key → JSON**. Store the file outside the repo, which is
   public, and delete it as soon as you have copied the two fields you need.
4. [calendar.google.com](https://calendar.google.com) → the calendar → **⋮ → Settings
   and sharing → Share with specific people** → add the `client_email` with **"Make
   changes to events"** permission. On the same screen, **Integrate calendar → Calendar
   ID**: that is `GOOGLE_CALENDAR_ID`.
5. The three secrets from step 4 of the setup, and **Deploy**.

> **The policy that blocks step 3.** On new organisations Google applies
> `iam.disableServiceAccountKeyCreation` by default and the error dialog does not
> mention it can be turned off. Disable it for this project only, from Cloud Shell:
>
> ```bash
> gcloud resource-manager org-policies disable-enforce \
>   iam.disableServiceAccountKeyCreation --project=<PROJECT_ID>
> ```
>
> The console caches the state: reload the tab before retrying, or create the key with
> `gcloud iam service-accounts keys create`, which does not go through it.

### Three things it cannot do, and they are not bugs

- **Invite other people to an event.** A service account without *domain-wide
  delegation* —which needs Google Workspace, not a Gmail account— cannot add guests, and
  the API rejects it.
- **Change the time of a whole series.** It can move a single occurrence, and it can
  change a series' title, location or category, but not reschedule the whole thing:
  re-anchoring a series from outside is where it breaks silently, and a fixed-days rule
  moved onto a Saturday makes a week of appointments disappear without any error.
- **See the title of your private appointments.** The permission you grant shows them as
  an occupied slot with no name. It can move and delete them, but not recognise them by
  title. Raising the permission to *Make changes and see all event details* fixes it, at
  the cost of giving it read access to everything.

### If something fails the first time

With `npx wrangler tail` open, the two likely errors tell themselves apart:

| In the log | What is happening |
|---|---|
| `google_token_failed` with `invalid_grant` | the `private_key` was pasted wrong |
| `calendar_request_failed` with `404` on a `POST` or a list `GET` | `GOOGLE_CALENDAR_ID` is wrong, or the calendar is not shared with the service account (the API answers 404, not 403: as far as it is concerned that calendar does not exist) |
| `calendar_request_failed` with `404` on a `PATCH` or `DELETE` | the event is gone; the calendar is fine |
| `tool_calls: []` and the bot says it is not configured | the model is answering from the history; see below |

**`GOOGLE_CALENDAR_ID` does not come from Google Cloud nor from the service account
JSON.** It is the `Calendar ID` under *Settings and sharing → Integrate calendar*, which
on the main calendar is your Gmail address. Putting the `...iam.gserviceaccount.com`
email there gives exactly the same 404: that is who writes, not where.

**After fixing a secret, `/reset` before testing again.** The tool's error stays in the
history and the model answers from there without retrying, so the test measures the old
conversation rather than the fix. You can spot it in the log: `llm_call` with
`tool_calls: []`.

## What phases 8 and 9 do: the agenda that can add up

Phase 8 gave it hour arithmetic, and phase 9 spent it.

**It warns when an appointment overlaps.** The appointment is still created — two things
at the same hour is something people do on purpose — but the reply says what it runs
into:

> Hecho, comida con Marta el jueves 21 de agosto a las 14:00.
> Ojo, que a esa hora ya tienes la revisión trimestral (14:00 a 15:30).

**And it finds free gaps**, which is the question that used to force opening the
calendar yourself:

```
¿cuándo tengo dos horas seguidas esta semana?
¿qué tardes tengo libres?
¿me cabe el fisio el martes?
```

The gaps are looked for inside your normal day, because "you are free from 03:00 to
07:00" is a correct and useless answer:

```toml
DAY_START_HOUR = "9"    # local hours
DAY_END_HOUR   = "21"   # 24 means midnight
```

If you narrow it yourself —"in the afternoon", "after ten"— that wins for that question.
All-day entries do not block the day: a birthday does not stop you meeting at eleven.
Private appointments do take up their slot, even though their title cannot be read.

**And with that, "what should I do now?"**:

> Tienes 40 minutos hasta la reunión con David a las 18:00.
> De lo pendiente, esto es lo que encaja ahora:
> - llamar al seguro (vence hoy)
> - contestar el correo de Ana

One question, and the answer crosses the clock, the calendar and the task list. What
gets suggested is the briefing's criterion —overdue, due today, high priority with no
date— capped at three: dumping the whole list is what makes you stop asking. And it will
not claim things "fit" as though it had measured them, because a task carries no
duration.

If the calendar cannot be read, the task half still arrives and the reply says the
calendar could not be read. Losing the tasks over a 500 from Google would trade a useful
answer for an error.

**All the arithmetic lives in code** ([src/lib/slots.ts](src/lib/slots.ts)), and the
prompt forbids the model from working gaps out for itself. It is the same rule as with
dates, and here it matters more: a wrong date gets caught by reading the reply, while an
invented gap gets caught when you show up to a meeting that was already taken.

One thing it does **not** do: `update_event` does not warn about overlaps. It already
spends a read and a write, and a third call does not fit the 27 s budget, so "move it to
Friday at 14:00" can land on something taken without a word. It is written down in
[ARCHITECTURE.md §14](ARCHITECTURE.md) rather than pretended away.

No new secrets and no schema changes. The two new vars have defaults, so an existing
deploy keeps working without touching anything.

## What phase 10 does: photos

Send it a photo —the school letter, a concert poster, a receipt, the whiteboard after a
meeting— and it pulls out what needs writing down. Tasks go to tasks, appointments go to
the calendar, and the caption counts as part of the message: "esto es para el jueves"
under the photo is read as yours, not as the photo's.

**It asks once before writing anything.** Not politeness: the date corrector works by
reading your message (see [ARCHITECTURE.md §7](ARCHITECTURE.md)), and a photo with no
caption gives it nothing to read, so a wrong day would go in unchecked — five at a time,
because one photo can produce five things. What arrives is a list of what it understood,
with the dates spelled out, and two buttons:

```
De la foto saco esto:

• ¿Apunto "Llevar el impreso firmado" para el 3 de septiembre a las 10:00?
• ¿Pongo en el calendario "Reunión de padres" el 12 de septiembre a las 17:00?

[✅ Confirmar]  [❌ Cancelar]
```

After confirming it repeats what it stored with the date, which is your second chance to
catch a wrong day.

Which version of the photo travels is decided in code, not by whatever Telegram sends
last: the biggest one under 1280 px and 700 KB. The original is slower to download, more
expensive to send and no more legible. Only the reference is stored in `messages`, never
the image: one photo as base64 would fill the history window on its own.

Two things it does not do. **An album is several messages** — Telegram sends each photo of
a media group as its own update, so three photos are three confirmations. And **a photo
sent "as a file"** lands in `document` and is not read; send it the normal way.

It needs a model that reads images. Production runs `gpt-4.1-mini`, which does; `/ping`
says so on its `fotos:` line, and with a text-only model configured the bot says it cannot
see photos instead of failing halfway.

**One manual step on an existing deploy:** re-run [supabase/schema.sql](supabase/schema.sql)
in the SQL editor. It adds `attachment_ref` to `messages` and lets `source` be `'photo'`;
the script is idempotent, so re-running the whole thing is safe. No new secrets and no new
vars.

## What phase 12 does: the briefing tells the whole day

The morning message used to know your tasks and not your calendar, so the part of the day
that cannot be moved had to be looked up somewhere else. Now it opens with it:

```
Buenos días. Hoy es jueves, 20 de agosto.

Agenda:
- 09:30-10:15 Dentista
- 13:00-14:00 algo (cita privada)

Todo el día:
- Cumpleaños de Ana

Vencidas:
- Pagar el seguro (18 ago, 10:30)

Hoy:
- 17:00 Llamar a la gestoría (alta)

Sin fecha, prioridad alta:
- Renovar el pasaporte
```

Appointments that hold a slot and all-day ones go in separate lists: a birthday is not a
meeting, and the free-slot search already makes that same distinction. A private
appointment is named as "algo (cita privada)" — the shared permission returns the
occupied slot with no title, and no title is invented for it here either.

**It is still written in code, with no model involved**, which is what keeps it boring and
exact, and it still costs no tokens.

**If Google fails, the briefing still goes out.** The calendar is read last and its
failure costs only its own section: the tasks arrive with one line saying the
appointments are missing. This is the one message you did not ask for, so one that shows
up quietly incomplete is one nobody would come back to question.

No new secrets, no new vars and nothing to run in Supabase. It uses the calendar that
phases 6 and 7 already set up; without `GOOGLE_CALENDAR_ID` the briefing behaves exactly
as it did before, tasks only.

## What phase 14 does: it warns you before the appointment

Fifteen minutes before each appointment, a message:

```
Dentro de 13 minutos: Dentista, a las 09:30.
```

And when two fall together:

```
Dentro de un rato tienes esto:

- 13:00 Comida con David
- 13:03 una cita privada
```

Google Calendar already notifies you, and this does not replace it: its notification
arrives wherever the calendar app is, and this one arrives where the tasks, the chat and
the answer are. *"Muévela una hora"* right after the alert works, because the alert is in
the conversation.

```toml
EVENT_ALERT_MINUTES = "15"   # 0 turns it off
```

The notice is the same for every appointment and cannot be changed for one of them — that
is a calendar-app setting. What you can do is ask for a separate alert: *"avísame a las
ocho de la reunión"* is a reminder of its own, and that one does go out when you said.

It announces each appointment **once**: the cron runs every five minutes, so the marker
that remembers the alert went out is the whole feature. Moving the appointment announces
it again at its new hour, because a moved appointment is a different thing to be warned
about. Something already under way is not announced at all.

## What phase 15 does: postponing without writing

The alert arrives with three buttons:

```
Acuérdate de sacar la basura.

[+10 min]  [+1 h]  [Mañana]
```

*"Pospónlo diez minutos"* was the most repeated reply to an alert and the most expensive
one: a model call and a couple of seconds to move a date. The button does it with one
patch and no model.

**Mañana** means tomorrow at the hour the alert was set for, not the hour you pressed the
button: the bins are a 21:00 thing even if you get to the phone at 23:40.

You can press twice with no harm — the second press moves the same alert again, it does
not create a second one. Buttons only show up when the message announces **one** thing:
with three in the same alert there is no telling which one `+10 min` is about, so there
the answer stays *"mueve la basura a mañana"*, said out loud.

Nothing to configure, no new secrets and nothing to run in Supabase.

## What phase 16 does: things that repeat

*"Saca la basura los martes"*, *"el alquiler el día 1"*, *"la pastilla todos los días a
las nueve"*. Before this, each of those had to be written down again after every time.

Five frequencies, the same words the calendar appointments already used: `diario`,
`laborables`, `semanal`, `mensual`, `anual`.

**A repetition does not disappear when you do it.** Say it is done and it moves to the
next time, and the reply tells you when:

```
Hecho. La siguiente, el 1 de septiembre a las 19:00.
```

An alert that repeats moves on its own, the moment it goes out: *"la pastilla todos los
días a las nueve"* arrives tomorrow at nine without you touching anything.

**Deleting it deletes every time**, not just this one — there is a single row behind all
of them — so the confirmation says so out loud:

```
"Sacar la basura" se repite todos los días. ¿La borro del todo y dejo de avisarte?

[✅ Confirmar]  [❌ Cancelar]
```

To skip one single time, move its date instead: *"esta semana la basura pásala al
miércoles"*.

The dates are computed in code, never by the model, and in local time rather than by
adding hours: a 09:00 alert stays at 09:00 the day the clocks change, the 31st of a month
with 30 days becomes the 30th instead of slipping into the following month, and
`laborables` jumps over the weekend.

**One manual step on an existing deploy:** re-run
[supabase/schema.sql](supabase/schema.sql) in the SQL editor. It adds `recurrence` to
`tasks`; the script is idempotent, so re-running the whole thing is safe. No new secrets
and no new vars.

## What phases 17 and 20 do: it can look things up now

Two phases, one idea, and they shipped together because each is half of the other. Until
now the bot's answer to *"how much does the Cercanías cost"* was that it could not look
it up.

**Ask it something it cannot know and it searches.**

```
— ¿A qué hora abre mañana la biblioteca de Sants?

De 8:30 a 20:30 de lunes a viernes, y mañana es jueves. Lo pone la web del
Ayuntamiento, consultado hoy a las 18:04.
biblioteques.barcelona.cat/...
```

It cites where it comes from, and it says **when** it read it. That is on purpose: a
search result is a snapshot, and a price from last week presented as today's is the same
kind of lie as an invented date.

**Send it a link and it reads it — but not straight away.**

```
— https://ejemplo.com/articulo-largo  ¿qué dice de los precios?

Apuntado, te lo cuento en un rato.
```

And a few minutes later, on its own:

```
Ya he leído Los precios de la vivienda en 2026.

Sube un 8% de media, con Madrid y Baleares por encima del 12%. El artículo
lo atribuye a la falta de obra nueva más que a la demanda...

https://ejemplo.com/articulo-largo
```

That delay is the design, not a limitation we failed to fix. A message has 27 seconds
total to cover everything including the model, and downloading a page is somebody else's
latency inside that. So the link goes into a queue and the cron settles it — which also
means a slow page cannot make the reply that promised it arrive late.

If it cannot read the page it says so instead of going quiet:

```
No he podido leer https://ejemplo.com/x: la página no me deja entrar.
```

It tries three times, spacing them out, before giving up. Paywalls and anti-bot
challenges are the usual reason, and there is no fix for those on our side.

### What it deliberately will not do

- **It does not read a page inside the conversation.** Search gives it snippets; the full
  text only ever reaches the summary that arrives separately. If it ever talks as though
  it had opened the link itself, that is a bug.
- **It does not search what it already knows.** The date, your tasks, your appointments
  and what you just said are all in front of it. Searching costs a third of the rounds a
  message gets.
- **It does not invent when the results come up empty.** It says the search found
  nothing.

### Setting it up

One secret, and the bot works without it:

| Secret | Value |
|---|---|
| `TAVILY_API_KEY` | [tavily.com](https://tavily.com) → sign up → API key. Free tier, **no card** |

Without it, `search_web` is not even offered to the model and the assistant behaves
exactly as it did in phase 16 — it says it cannot search. Nothing else breaks.

Reading links needs **no** secret: it runs on Jina Reader, which works keyless. Set
`JINA_API_KEY` only if you hit its rate limit.

**One manual step on an existing deploy:** re-run
[supabase/schema.sql](supabase/schema.sql) in the SQL editor. It adds the `jobs` table;
the script is idempotent, so re-running the whole thing is safe. No new vars.

### What it costs

Nothing, with a ceiling: Tavily's free tier is 1.000 searches a month, renewed monthly,
and one search costs one. That is about 33 a day for a single user. The real limit is
tighter and is ours, not theirs — a message allows three model rounds and a search eats
one, so there is room for one or two searches per message, not five.

## What phase 22 does: it clocks you in

Four times a day, on its own, it logs into ficharweb and presses the button: entry at
**09:00**, out to lunch at **14:00**, back at **15:00**, out at **18:00**. Monday to Friday,
each one at its time **plus a random offset of up to five minutes either side** so the
record does not read like a cron job.

You can ask about it, and ask for it by hand:

> — ¿he fichado?
> — Sí, la entrada está fichada. El portal ofrece ahora la salida a comer, y la salida de
>   las 18:00 sigue pendiente.

> — fíchame la salida
> — Fichada la salida del trabajo. El portal lo ha registrado a las 18:03.

### If you punched yourself, it does not touch anything

This is the part worth understanding, because it is where the whole design comes from. The
portal only ever shows the action that comes **next**: if the entry is registered, the entry
button is not on the page. So there is no need to keep track of what you have done — if you
clocked in from the web at 09:20, the automation finds no button and simply waits for the
next stage. Quietly: there is nothing to tell you.

The same property answers *"have I clocked in?"* honestly. What you get back is the
**portal's** state, not our log, so a punch you did yourself from the web counts.

### What it will never do

- **Punch twice.** The day is claimed in the database before the request goes out, so two
  overlapping ticks cannot both fire.
- **Retry when it does not know what happened.** If the portal answers but keeps the button
  on screen, the punch may or may not have registered. It tells you and stops. A retry
  there is a coin flip on a duplicate line in an attendance record.
- **Punch on the model's initiative.** The assistant only clocks in when you ask for it in
  that message; the four scheduled ones are the system's, not the model's.

It does retry the one case where nothing was written: if the portal is down, the day is
released and the next tick tries again, up to **30 minutes** past the target. After that it
gives up and says so, once.

Holidays are the honest gap: nobody told it your company's calendar. On a holiday the
portal does not offer the button, so nothing gets punched — which is the safe direction, but
it is a coincidence and not a feature.

### Setting it up

| Secret | Value |
|---|---|
| `TIMECLOCK_USER` | your ficharweb user |
| `TIMECLOCK_PASS` | your ficharweb password |
| `TIMECLOCK_BASE_URL` | optional, the portal's address if it is not the default |

```powershell
npx wrangler secret put TIMECLOCK_USER
npx wrangler secret put TIMECLOCK_PASS
```

Without them the two tools are not offered to the model and the scheduler does nothing:
everything else works exactly as before.

**One manual step on an existing deploy:** re-run
[supabase/schema.sql](supabase/schema.sql) in the SQL editor. It adds `punch_schedules` and
`punches`; the script is idempotent. The four times seed themselves on the first tick, and
from then on they live in `punch_schedules` — changing an hour, or turning one off with
`enabled`, is a row in Supabase and not a deploy.

### `/test`: what is slow, when something is slow

The one command whose answer is written entirely in code, which is the point: it works when
the model is exactly the thing that is broken. It reports four numbers —Supabase,
ficharweb, a bare model ping and the request as the assistant really sends it— and then
says what they mean:

```
Diagnóstico

Supabase          0.3 s  ok
ficharweb         2.1 s  ofrece break_start

Modelo openai/gpt-4.1-mini
  ping             0.9 s  12 tok de entrada
  carga real      13.4 s  7938 tok de entrada

La lentitud aparece con el tamaño de la petición, no con el proveedor.
```

The two model lines are the reason it exists. "The model is slow" has two different causes
with two different fixes: the provider having a bad minute, or our request having grown too
big — the prompt plus seventeen tool schemas is around 7.900 tokens of input on **every**
message. The bare ping measures one, the loaded call measures the other, and the gap between
them is the answer.

The ficharweb line is a bonus that pays for itself: it says which punch actions it
recognised on the page, so a reworded portal shows up when you ask instead of at nine in the
morning. It reads the page and never presses anything.

It costs two model calls, so it is not free — but it is on demand, and cheaper than reading
`wrangler tail` with a token counter in the other hand.

## Several things in one message

This already worked from phase 2 — the loop runs every `tool_call` of one response — and
now the prompt asks for it explicitly. An audio like *"recuérdame llamar al banco,
comprar pan y revisar el podcast"* creates all three tasks at once.

## Next

**Imputación de horas**: the other half of the same portal — hours and a mandatory comment
against the day's projects, which needs a confirmation step because it is a choice and not
a button. Then **audio replies**: answering a voice note with a voice note. Behind it, a weekly review
that says what you have been postponing — and now that there is a queue for work nobody
is waiting on, that review has somewhere to live. Then the weather and the travel time
inside the appointment alerts. The full list is at the end of
[ARCHITECTURE.md](ARCHITECTURE.md).
