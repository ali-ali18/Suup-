-- 0023_supervisor: o Principal como supervisor da equipe (docs/SUPERVISOR.md). Pesquisa e decisões do
-- dono: docs/pesquisas/fase-4-supervisor-e-delegacao.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * supervisor_settings: uma linha só. Revisão noturna ligada ou não, a hora dela e a da mensagem
--     da manhã (minutos desde a meia-noite, no fuso do usuário; a mensagem pode ser desligada com
--     null) e o teto de custo por noite (null: sem teto, o padrão).
--   * team_reviews: uma linha por tentativa de revisão. `night` é a data local (AAAA-MM-DD) da noite;
--     o índice único deixa UMA revisão viva (em andamento, feita ou dispensada) por noite, o que
--     vale com vários workers e depois de uma queda. Guarda o que foi lido, o que ficou para a
--     próxima noite, o que foi anotado, o custo e a mensagem da manhã (e se já foi postada).
--   * team_review_cursors: até quando cada bot já foi lido pela revisão (só avança quando a revisão
--     termina e leu aquele bot por inteiro).
--   * delegations: a ligação entre a execução do Principal que delegou e a execução delegada na
--     conversa do outro bot; o resultado volta para a conversa do Principal uma vez.
--   * runs: a execução delegada (origem `delegation`, que já existia) passa a ser a execução em
--     primeiro plano da conversa do bot delegado, como a do usuário e a da recepção: se ela
--     perguntar algo, a resposta do usuário vai para ela.
--
-- Nada aqui usa expressão regular.

create table supervisor_settings (
  singleton boolean primary key default true check (singleton),
  review_enabled boolean not null default true,
  review_minute smallint not null default 180 check (review_minute between 0 and 1439),
  morning_minute smallint default 480 check (morning_minute is null or morning_minute between 0 and 1439),
  cost_cap_usd numeric(10, 4) check (cost_cap_usd is null or cost_cap_usd > 0),
  updated_at timestamptz not null default now()
);
insert into supervisor_settings (singleton) values (true);
create trigger supervisor_settings_set_updated_at
  before update on supervisor_settings
  for each row execute function set_updated_at();

create table team_reviews (
  id uuid primary key default gen_random_uuid(),
  night text not null check (length(night) = 10),
  bot_id uuid not null references bots (id) on delete cascade,
  status text not null check (status in ('running', 'done', 'skipped', 'failed')),
  claimed_by text,
  lease_expires_at timestamptz,
  window_to timestamptz not null,
  bots_read jsonb not null default '[]'::jsonb,
  left_over jsonb not null default '[]'::jsonb,
  cap_reached boolean not null default false,
  cost_cap_usd numeric(10, 4),
  noted jsonb not null default '[]'::jsonb,
  morning_text text,
  morning_posted_at timestamptz,
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6),
  latency_ms integer,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index team_reviews_one_per_night_idx on team_reviews (night)
  where status in ('running', 'done', 'skipped');
create index team_reviews_recent_idx on team_reviews (created_at desc, id);

create table team_review_cursors (
  bot_id uuid primary key references bots (id) on delete cascade,
  read_until timestamptz not null
);

create table delegations (
  id uuid primary key default gen_random_uuid(),
  from_bot_id uuid not null references bots (id) on delete cascade,
  from_run_id uuid not null references runs (id) on delete cascade,
  from_conversation_id uuid references conversations (id) on delete set null,
  to_bot_id uuid not null references bots (id) on delete cascade,
  to_run_id uuid not null unique references runs (id) on delete cascade,
  to_conversation_id uuid not null references conversations (id) on delete cascade,
  objective text not null,
  -- a mesma delegação (mesmo bot, mesmo objetivo) na mesma execução é uma só
  objective_key text not null,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (from_run_id, to_bot_id, objective_key)
);
create index delegations_open_idx on delegations (created_at) where returned_at is null;

drop index runs_one_active_user_run_per_conversation_idx;
create unique index runs_one_active_user_run_per_conversation_idx on runs (conversation_id)
  where conversation_id is not null
    and origin in ('user', 'reception', 'delegation')
    and status in ('queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_timer');
