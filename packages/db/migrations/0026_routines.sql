-- 0026_routines: rotinas por horário (docs/ROTINAS.md) e o fuso do usuário guardado no banco.
-- Pesquisa: docs/pesquisas/fase-4-rotinas-webhooks-notificacoes.md. A 0025 está reservada para
-- outro ramo: o migrador aplica por ordem de nome e aceita o buraco.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * user_settings: uma linha só. O fuso IANA do usuário (`time_zone`) e de onde ele veio:
--     `device` (o app mandou o fuso do computador do usuário na conexão) ou `user` (escolhido em
--     Configurações > Geral). Nunca o fuso do processo do servidor, que pode estar numa VPS em UTC.
--   * routines: a rotina de um bot. O gatilho é estruturado (`trigger_kind`, hoje só `schedule`;
--     monitor e webhook entram depois) e o horário é um JSON de campos (`schedule`: once, daily,
--     weekly, monthly, interval), nunca texto de cron. Cada rotina guarda o fuso em que foi criada
--     (`time_zone`) e a âncora do intervalo (`anchor_at`). `next_run_at` só existe com a rotina
--     ativa. `state` é a nota pequena que a própria rotina atualiza entre um disparo e outro.
--   * routine_fires: o histórico. Um disparo por (rotina, horário marcado): o índice único deixa
--     cada horário disparar UMA vez, com qualquer número de workers e depois de uma queda. Um
--     disparo pulado (a execução anterior ainda rodava) fica gravado como `skipped`; os horários
--     perdidos com a máquina desligada viram um só disparo (`catch_up`) com `missed_count`.
--   * messages.routine_id: a mensagem do bot que é o resultado de uma rotina (o app mostra de qual).
--
-- Nada aqui usa expressão regular.

create table user_settings (
  singleton boolean primary key default true check (singleton),
  time_zone text,
  time_zone_source text check (time_zone_source in ('device', 'user')),
  updated_at timestamptz not null default now(),
  check ((time_zone is null) = (time_zone_source is null))
);
insert into user_settings (singleton) values (true);
create trigger user_settings_set_updated_at
  before update on user_settings
  for each row execute function set_updated_at();

create table routines (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  instruction text not null check (length(instruction) between 1 and 2000),
  trigger_kind text not null default 'schedule' check (trigger_kind in ('schedule')),
  schedule jsonb not null check (jsonb_typeof(schedule) = 'object'),
  time_zone text not null check (length(time_zone) between 1 and 100),
  anchor_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  next_run_at timestamptz,
  state text not null default '' check (length(state) <= 2000),
  state_updated_at timestamptz,
  cost_cap_usd numeric(10, 4) check (cost_cap_usd is null or cost_cap_usd > 0),
  created_by text not null check (created_by in ('bot', 'user')),
  created_run_id uuid references runs (id) on delete set null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (next_run_at is null or status = 'active'),
  check ((status = 'ended') = (ended_at is not null))
);
create trigger routines_set_updated_at
  before update on routines
  for each row execute function set_updated_at();
create index routines_bot_idx on routines (bot_id, created_at);
-- O job do worker procura só as ativas e vencidas.
create index routines_due_idx on routines (next_run_at) where status = 'active';

create table routine_fires (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references routines (id) on delete cascade,
  scheduled_for timestamptz not null,
  kind text not null check (kind in ('scheduled', 'catch_up', 'manual')),
  status text not null check (status in ('running', 'done', 'failed', 'cancelled', 'skipped')),
  skip_reason text check (skip_reason in ('overlap')),
  missed_count integer not null default 0 check (missed_count >= 0),
  run_id uuid unique references runs (id) on delete set null,
  result_text text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (routine_id, scheduled_for),
  check ((status = 'skipped') = (skip_reason is not null))
);
create index routine_fires_recent_idx on routine_fires (routine_id, created_at desc, id);

alter table routine_fires add column message_id uuid references messages (id) on delete set null;

alter table messages add column routine_id uuid references routines (id) on delete set null
  check (routine_id is null or author_kind = 'bot' or author_kind = 'system');
