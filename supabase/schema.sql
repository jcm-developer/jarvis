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
  source           text not null default 'text' check (source in ('text','voice')),
  transcript_raw   text,         -- raw audio transcript, for debugging
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on messages (conversation_id, created_at desc);

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
create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  title          text not null,
  notes          text,
  due_at         timestamptz,
  remind_at      timestamptz,   -- when to alert, when it is not at the deadline
  priority       smallint not null default 2 check (priority between 1 and 3), -- 1 = high
  status         text not null default 'pending'
                   check (status in ('pending','done','cancelled')),
  completed_at   timestamptz,
  reminded_at    timestamptz,   -- prevents duplicate reminders from the cron
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists tasks_user_status_due_idx
  on tasks (user_id, status, due_at);
create index if not exists tasks_user_status_remind_idx
  on tasks (user_id, status, remind_at);

-- For databases created before remind_at existed: `create table if not exists` does
-- not add columns to a table that is already there, so this is needed.
alter table tasks add column if not exists remind_at timestamptz;

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

-- Row Level Security ---------------------------------------------------------
-- No policies: nobody gets in except `service_role`, which bypasses them by design.
-- The Worker is the only client. This hardens the DB even if the anon key leaks.
alter table users          enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table memories       enable row level security;
alter table tasks          enable row level security;
alter table tool_call_logs enable row level security;
