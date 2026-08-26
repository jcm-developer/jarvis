-- Jarvis — database schema
-- Run it in Supabase: SQL Editor → New query → paste → Run.
-- Idempotent: it can be re-run without breaking anything.

create extension if not exists "pgcrypto";

-- Authorised users -----------------------------------------------------------
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  telegram_id      bigint unique not null,
  username         text,
  first_name       text,
  timezone         text not null default 'Europe/Madrid',
  created_at       timestamptz not null default now()
);

-- One conversation per Telegram chat ----------------------------------------
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  telegram_chat_id   bigint unique not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- History --------------------------------------------------------------------
-- `role` follows the OpenAI standard so the LLM's context can be rebuilt by reading
-- the table verbatim, with no transformations.
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user','assistant','tool','system')),
  content          text,
  tool_calls       jsonb,        -- role='assistant' when it asks for tools
  tool_call_id     text,         -- role='tool', links to the call that produced it
  source           text not null default 'text' check (source in ('text','voice','photo')),
  transcript_raw   text,         -- raw audio transcript, for debugging
  attachment_ref   text,         -- telegram file_id of an attached photo, never the image
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on messages (conversation_id, created_at desc);

-- Phase 10 added photos: the column for the reference, and 'photo' in the source list.
-- `create table if not exists` does not touch a table that already exists, so both have
-- to be stated separately for a database created before this.
alter table messages add column if not exists attachment_ref text;

-- The check is replaced rather than added: there is no `add constraint if not exists`,
-- and on a fresh table the inline check above is already named like this, so dropping it
-- and putting back an identical one keeps the script re-runnable.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'messages_source_check') then
    alter table messages drop constraint messages_source_check;
  end if;
  alter table messages
    add constraint messages_source_check check (source in ('text','voice','photo'));
end $$;

-- Long-term memory -----------------------------------------------------------
-- Written by the agent itself through the remember() tool.
create table if not exists memories (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  key          text not null,
  value        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, key)
);

-- Domain: tasks --------------------------------------------------------------
-- One table for two lifecycles. `kind` does not change how a row is stored, it changes
-- when it dies: a 'reminder' is spent once the cron announces it, a 'task' waits to be
-- completed. Two tables would have meant duplicating the cron, the date guardrails and
-- the tool catalogue for one column's worth of difference.
create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  title          text not null,
  notes          text,
  kind           text not null default 'task' check (kind in ('task','reminder')),
  due_at         timestamptz,
  remind_at      timestamptz,   -- when to alert, when it is not at the deadline
  priority       smallint not null default 2 check (priority between 1 and 3), -- 1 = high
  status         text not null default 'pending'
                   check (status in ('pending','done','cancelled')),
  completed_at   timestamptz,
  reminded_at    timestamptz,   -- prevents duplicate reminders from the cron
  -- Frequency for something that repeats, from a closed list the model picks from. The
  -- row is not copied per occurrence: it rolls forward. See §12 of ARCHITECTURE.md.
  recurrence     text check (recurrence in
                   ('diario','laborables','semanal','mensual','anual')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists tasks_user_status_due_idx
  on tasks (user_id, status, due_at);
create index if not exists tasks_user_status_remind_idx
  on tasks (user_id, status, remind_at);

-- For databases created before these columns existed: `create table if not exists` does
-- not add columns to a table that is already there, so this is needed.
alter table tasks add column if not exists remind_at timestamptz;
alter table tasks add column if not exists kind text not null default 'task';
alter table tasks add column if not exists recurrence text;

-- The check has to go in separately, and guarded: there is no `add constraint if not
-- exists`, and on a fresh table the inline check above is already named like this, so a
-- re-run finds it and skips.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_kind_check') then
    alter table tasks add constraint tasks_kind_check check (kind in ('task','reminder'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_recurrence_check') then
    alter table tasks add constraint tasks_recurrence_check check (recurrence in
      ('diario','laborables','semanal','mensual','anual'));
  end if;
end $$;

-- Deferred jobs (phase 17) --------------------------------------------------
-- Work that does not fit inside a message's 27 s and never will: fetching a page,
-- extracting its text, summarising it. The turn writes the row and answers "I'll tell
-- you later"; the cron is what actually does it.
--
-- No `conversation_id`: the cron already resolves the conversation from the user
-- (`listCronTargets`), and a second column saying where the answer goes is a second
-- thing that can disagree with the first. This is a single-user assistant, so they
-- would always match anyway.
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  kind         text not null check (kind in ('read_url')),
  payload      jsonb not null,
  -- 'running' is not decoration: it is how a row gets claimed without a transaction.
  -- PostgREST cannot open one, but a single UPDATE ... RETURNING is atomic per row, so
  -- flipping pending -> running and reading the row back is what stops two overlapping
  -- ticks from fetching the same URL twice.
  --
  -- 'dead' is separate from 'failed' on purpose: it means "stop retrying". A boolean
  -- here would leave no way to tell a job that is waiting for its next attempt from one
  -- that has given up, and nobody is watching this table (§16).
  state        text not null default 'pending'
                 check (state in ('pending','running','done','dead')),
  attempts     smallint not null default 0,
  -- When it becomes eligible. Also the backoff: a failure pushes it into the future
  -- instead of retrying on the very next tick, five minutes later.
  run_after    timestamptz not null default now(),
  -- Kept for the dead ones. Without it a job that gave up says nothing about why.
  last_error   text,
  -- When the row was claimed. It is what lets a tick that Cloudflare cancelled
  -- mid-fetch be recovered: a 'running' row nobody ever finished is invisible without
  -- this, which is exactly the silent failure this table is supposed to avoid.
  started_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- Phase 24 adds a kind. The check is replaced rather than added: there is no
-- `add constraint if not exists`, and on a fresh table the inline check above is already
-- named like this, so dropping it and putting back a wider one keeps the script re-runnable.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'jobs_kind_check') then
    alter table jobs drop constraint jobs_kind_check;
  end if;
  alter table jobs
    add constraint jobs_kind_check check (kind in ('read_url','impute_hours'));
end $$;

-- The cron's only query: what is eligible, oldest first.
create index if not exists jobs_claimable_idx
  on jobs (state, run_after);

-- Imputación: what was submitted (phase 24) ---------------------------------
-- What used to be impute_log.json. Append-only: it is a record of what was sent to
-- somebody else's system, and a record that can be edited is not a record.
create table if not exists imputations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  project        text not null,
  task           text,
  hours          numeric(4,2) not null check (hours > 0 and hours <= 24),
  -- Mandatory here too, and not only in the tool: the site refuses an empty one, so a
  -- row without it could not have been submitted and must not be able to exist.
  comment        text not null check (length(btrim(comment)) > 0),
  -- The day the hours landed on, as the site reported it AFTER submitting, which is not
  -- always the day we asked for: a full day rolls over to the next one.
  work_date      date not null,
  day_advanced   boolean not null default false,
  source         text not null default 'text' check (source in ('voice','text')),
  logged_at      timestamptz not null default now()
);
create index if not exists imputations_user_logged_idx
  on imputations (user_id, logged_at desc);
create index if not exists imputations_user_work_date_idx
  on imputations (user_id, work_date);

-- The day's project table, cached whole (phase 24) ---------------------------
-- So that no turn ever waits on a scrape: the tick refreshes this and the tool reads it.
-- One row per day and a jsonb blob, because the row indexes inside it are the site's and
-- only mean anything together with the day they were scraped on.
create table if not exists project_cache (
  user_id        uuid not null references users(id) on delete cascade,
  day            date not null,
  projects       jsonb not null,
  scraped_at     timestamptz not null default now(),
  primary key (user_id, day)
);

-- Domain: books (phase 24) ---------------------------------------------------
-- What the user has read, with a mark and what it was about. It is not a library
-- catalogue: it exists so the model can recommend from a real taste instead of from a
-- guess, so what is stored is the judgement (`rating`, `notes`) and the subject
-- (`topics`), not the metadata anybody can look up (ISBN, pages, publisher).
--
-- `topics` is a comma-separated string and not text[]: it is written by the model and
-- read back with ilike, the same as `memories`, and an array would buy a containment
-- operator nothing here queries by.
--
-- No `finished_on`. The model does not calculate dates (§7) and "hace un par de años"
-- would land wrong on a column that reads as fact; `created_at` says when it was logged,
-- which is the honest version of the same thing.
create table if not exists books (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  title        text not null,
  author       text,
  status       text not null default 'read'
                 check (status in ('read','reading','pending','abandoned')),
  rating       smallint check (rating between 1 and 5),
  topics       text,          -- 'ciencia ficción, distopía'
  notes        text,          -- what the user said about it, in their words
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists books_user_status_idx
  on books (user_id, status, rating desc nulls last);

-- Domain: projects (phase 25) ------------------------------------------------
-- What the user is building, so the model knows what "el de la web" means without
-- being told again every week. It is context, not a task list: a project is the thing
-- tasks belong to, and it outlives all of them.
--
-- `links` is jsonb and not a table of its own: a link is a label and a url written by
-- the model, always read back whole with its project, and never queried by. It is
-- upserted by label —"repo", "docs", "staging"— which is what makes correcting a wrong
-- url a normal sentence instead of a delete.
--
-- No unique constraint on the name: matching is done in the handler with the name
-- normalised, and a raw-text unique would neither catch "Jarvis" against "jarvis" nor
-- give the model anything it could fix when it fired.
create table if not exists projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  description  text,
  status       text not null default 'active'
                 check (status in ('active','paused','done','idea')),
  links        jsonb not null default '[]'::jsonb,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- The index the injected context reads: the active ones, most recently touched first.
create index if not exists projects_user_status_idx
  on projects (user_id, status, updated_at desc);

-- Observability --------------------------------------------------------------
-- Without this, understanding why the agent did something odd is impossible.
create table if not exists tool_call_logs (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid references conversations(id) on delete set null,
  tool_name         text not null,
  arguments         jsonb,
  result            jsonb,
  success           boolean not null,
  error             text,
  duration_ms       integer,
  created_at        timestamptz not null default now()
);
create index if not exists tool_call_logs_created_idx
  on tool_call_logs (created_at desc);

-- Automatic updated_at ------------------------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists conversations_touch on conversations;
create trigger conversations_touch before update on conversations
  for each row execute function touch_updated_at();

drop trigger if exists memories_touch on memories;
create trigger memories_touch before update on memories
  for each row execute function touch_updated_at();

drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

drop trigger if exists books_touch on books;
create trigger books_touch before update on books
  for each row execute function touch_updated_at();

drop trigger if exists jobs_touch on jobs;
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();

-- Row Level Security ---------------------------------------------------------
-- No policies: nobody gets in except `service_role`, which bypasses them by design.
-- The Worker is the only client. This hardens the DB even if the anon key leaks.
alter table users          enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table memories       enable row level security;
alter table tasks          enable row level security;
alter table books          enable row level security;
alter table jobs           enable row level security;
alter table tool_call_logs enable row level security;
