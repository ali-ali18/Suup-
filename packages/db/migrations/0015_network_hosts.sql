-- 0015_network_hosts: rede de saída das máquinas dos bots (e dos conectores stdio isolados).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- A máquina de um bot não tem rede própria: sai só por um proxy do harness, com uma lista de
-- NOMES de host exatos (igualdade, sem curinga nem sufixo; docs/REDE.md). Esta migração guarda:
--
-- 1. `network_hosts`: os hosts liberados para um bot. `run_id` nulo é uma liberação do bot (um ato
--    explícito do usuário: `suup network allow`, API); `run_id` preenchido é uma liberação só para
--    aquela execução (o que um cartão aprovado cria), que deixa de valer quando a execução termina.
-- 2. `network_events`: toda recusa do proxy (e só ela), para o usuário ver o que o bot tentou.
-- 3. `connectors.egress_hosts`: os hosts exatos que um conector stdio isolado pode alcançar.
--
-- Os nomes são validados por quem grava (o runtime, com a mesma função do proxy); aqui só se
-- limita o tamanho. Nada aqui usa expressão regular.

create table network_hosts (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id) on delete cascade,
  host text not null check (length(host) between 3 and 253),
  run_id uuid references runs (id) on delete cascade,
  created_by text not null default 'user' check (created_by in ('user', 'approval')),
  created_at timestamptz not null default now()
);

create unique index network_hosts_bot_host_idx on network_hosts (bot_id, host) where run_id is null;
create unique index network_hosts_run_host_idx on network_hosts (run_id, host) where run_id is not null;
create index network_hosts_bot_idx on network_hosts (bot_id);

create table network_events (
  id bigserial primary key,
  subject_kind text not null check (subject_kind in ('bot', 'connector', 'harness')),
  subject_id text not null check (length(subject_id) between 1 and 100),
  host text not null check (length(host) <= 300),
  port integer not null,
  reason text not null check (length(reason) <= 50),
  message text not null check (length(message) <= 1000),
  created_at timestamptz not null default now()
);

create index network_events_subject_idx on network_events (subject_kind, subject_id, id desc);

alter table connectors
  add column egress_hosts jsonb not null default '[]' check (jsonb_typeof(egress_hosts) = 'array');
