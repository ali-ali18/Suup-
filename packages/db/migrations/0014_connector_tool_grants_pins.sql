-- 0014_connector_tool_grants_pins: concessões de conector por ferramenta e fixação (pinning) da
-- definição das ferramentas.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- 1. Concessões por ferramenta. Uma concessão passa a dizer QUAIS ferramentas do conector o bot pode
--    usar: `all_tools = true` (todas as que o conector oferecer e estiverem aprovadas) ou a lista
--    `tools` (nomes NO SERVIDOR). Uma ferramenta que não está na concessão não existe para o bot.
--    As concessões que já existiam eram do conector inteiro: viram `all_tools = true`, para que nada
--    deixe de funcionar em silêncio.
-- 2. Fixação da definição. Para cada ferramenta de cada conector guarda-se a impressão digital
--    (hash SHA-256 da serialização canônica de nome, descrição, esquema e dicas) da definição que o
--    usuário aprovou, e a que o servidor mostra agora. Uma ferramenta cuja definição mudou
--    (`changed`), ou que apareceu depois da primeira listagem (`new`), fica desligada para todos os
--    bots até o usuário revisar e aprovar de novo. É comparação exata de hash, não padrão de texto.
-- 3. `connector_tool_events`: o que aconteceu (linha de base, mudança, aprovação), só se acrescenta.

alter table connector_grants
  add column all_tools boolean not null default false,
  add column tools text[] not null default '{}';

update connector_grants set all_tools = true;

create table connector_tool_pins (
  connector_id uuid not null references connectors (id) on delete cascade,
  -- O nome da ferramenta NO SERVIDOR.
  tool text not null check (length(tool) between 1 and 128),
  status text not null check (status in ('approved', 'changed', 'new')),
  approved_fingerprint text,
  approved_definition jsonb,
  approved_at timestamptz,
  seen_fingerprint text not null,
  seen_definition jsonb not null,
  seen_at timestamptz not null default now(),
  primary key (connector_id, tool),
  constraint connector_tool_pins_approved_iff check (
    (status = 'new') = (approved_fingerprint is null)
  )
);

-- Existe uma linha quando a primeira listagem do conector já serviu de linha de base.
create table connector_pin_baselines (
  connector_id uuid primary key references connectors (id) on delete cascade,
  baselined_at timestamptz not null default now()
);

create table connector_tool_events (
  id bigint generated always as identity primary key,
  connector_id uuid references connectors (id) on delete set null,
  connector_name text not null,
  tool text,
  kind text not null check (kind in ('baseline', 'pinned_on_grant', 'changed', 'new', 'restored', 'approved')),
  from_fingerprint text,
  to_fingerprint text,
  detail text check (detail is null or length(detail) <= 1000),
  created_at timestamptz not null default now()
);

create index connector_tool_events_connector_idx on connector_tool_events (connector_name, id desc);
