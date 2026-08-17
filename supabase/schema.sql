-- Jarvis — esquema inicial
-- Ejecutar en Supabase: SQL Editor → New query → pegar → Run.
-- Idempotente: se puede reejecutar sin romper nada.

create extension if not exists "pgcrypto";

-- Usuarios autorizados -------------------------------------------------------
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  telegram_id      bigint unique not null,
  username         text,
  first_name       text,
  timezone         text not null default 'Europe/Madrid',
  created_at       timestamptz not null default now()
);

-- Una conversación por chat de Telegram --------------------------------------
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  telegram_chat_id   bigint unique not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Historial ------------------------------------------------------------------
-- `role` sigue el estándar de OpenAI para poder reconstruir el contexto del LLM
-- leyendo la tabla tal cual, sin transformaciones.
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user','assistant','tool','system')),
  content          text,
  tool_calls       jsonb,        -- role='assistant' cuando pide herramientas
  tool_call_id     text,         -- role='tool', enlaza con la llamada que lo originó
  source           text not null default 'text' check (source in ('text','voice')),
  transcript_raw   text,         -- transcripción cruda del audio, para depurar
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on messages (conversation_id, created_at desc);

-- Memoria de largo plazo -----------------------------------------------------
-- La escribe el propio agente mediante la tool remember().
create table if not exists memories (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  key          text not null,
  value        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, key)
);

-- Dominio: tareas ------------------------------------------------------------
create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  title          text not null,
  notes          text,
  due_at         timestamptz,
  priority       smallint not null default 2 check (priority between 1 and 3), -- 1 = alta
  status         text not null default 'pending'
                   check (status in ('pending','done','cancelled')),
  completed_at   timestamptz,
  reminded_at    timestamptz,   -- evita recordatorios duplicados en el cron
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists tasks_user_status_due_idx
  on tasks (user_id, status, due_at);

-- Observabilidad -------------------------------------------------------------
-- Sin esto, entender por qué el agente hizo algo raro es imposible.
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

-- updated_at automático ------------------------------------------------------
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
-- Sin políticas: nadie accede salvo `service_role`, que las bypasea por diseño.
-- El Worker es el único cliente. Esto blinda la DB aunque se filtre la anon key.
alter table users          enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table memories       enable row level security;
alter table tasks          enable row level security;
alter table tool_call_logs enable row level security;
