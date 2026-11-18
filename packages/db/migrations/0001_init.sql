-- 0001_init: bots, runs, run_events.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.

-- Mantém updated_at em dia em qualquer UPDATE, venha de onde vier.
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create table bots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  personality text not null default '',
  model_provider text not null,
  model_id text not null,
  allowed_tools text[] not null default '{}',
  limits jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create trigger bots_set_updated_at
  before update on bots
  for each row execute function set_updated_at();

create table runs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id),
  parent_run_id uuid references runs (id),
  origin text not null
    check (origin in ('user', 'routine', 'delegation', 'proactive')),
  objective text not null,
  acceptance_criteria jsonb not null default '[]',
  plan jsonb not null default '[]',
  status text not null default 'queued'
    check (status in (
      'queued', 'running', 'waiting_approval', 'waiting_user', 'done', 'failed', 'cancelled'
    )),
  failure_origin text
    check (failure_origin in ('provider', 'tool', 'harness', 'limit', 'approval', 'user')),
  failure_detail text,
  result jsonb,
  turns integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  trace_id text,
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint runs_failure_origin_iff_failed
    check ((status = 'failed') = (failure_origin is not null))
);

-- Fila: SELECT ... FOR UPDATE SKIP LOCKED sobre as execuções 'queued', da mais antiga para a mais nova.
create index runs_queue_idx on runs (created_at) where status = 'queued';
create index runs_bot_created_idx on runs (bot_id, created_at desc);

create trigger runs_set_updated_at
  before update on runs
  for each row execute function set_updated_at();

create table run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references runs (id),
  seq integer not null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

-- Log só de acréscimo: o banco recusa qualquer UPDATE, DELETE ou TRUNCATE.
create function run_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'run_events is append-only: % is not allowed', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger run_events_no_update_delete
  before update or delete on run_events
  for each row execute function run_events_append_only();

create trigger run_events_no_truncate
  before truncate on run_events
  for each statement execute function run_events_append_only();
