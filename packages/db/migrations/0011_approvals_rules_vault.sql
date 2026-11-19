-- 0011_approvals_rules_vault: aprovações, regras do usuário e o cofre de segredos.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Aprovações (`approvals`): o cartão que espera o usuário. A linha é uma PROJEÇÃO do evento
-- `approval_requested` do log da execução (criada na mesma transação em que o evento é gravado, com
-- o id calculado pelo loop a partir da execução e da chamada, então regravar é inofensivo). A
-- decisão é gravada aqui por quem decide (servidor ou CLI); o loop a lê, a registra no log como
-- `approval_decided` e só então marca `delivered_at`. Enquanto isso o log é a verdade: esta tabela
-- só diz o que o usuário vê e o que ainda falta entregar.
--   * no máximo um cartão pendente por execução (as chamadas de um turno são tratadas em ordem);
--   * `args` guarda o conteúdo exato a executar (com os marcadores de segredo, nunca valores).
--
-- Regras (`approval_rules`): permissões e proibições permanentes do usuário, por bot ou globais,
-- por ferramenta (ou `*`) e, opcionalmente, por condições sobre os argumentos.
--
-- Cofre (`secrets`, `secret_grants`): o valor é cifrado FORA do banco (AES-256-GCM, a chave vem de
-- uma variável de ambiente); aqui ficam só o texto cifrado, o nonce e o id da chave. Quem pode usar
-- cada segredo é a tabela de concessões, por bot.

create table approvals (
  id uuid primary key,
  run_id uuid not null references runs (id),
  bot_id uuid not null references bots (id),
  call_id text not null,
  tool text not null,
  args jsonb not null,
  level text not null check (level in ('read', 'write_reversible', 'external_irreversible')),
  summary text not null,
  secrets text[] not null default '{}',
  source text not null check (source in ('rule', 'reviewer', 'default')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  reason text,
  rule_id uuid,
  expires_at timestamptz,
  decided_at timestamptz,
  -- A decisão já está no log da execução (o loop a registrou).
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, call_id),
  constraint approvals_decided_iff_not_pending
    check ((status = 'pending') = (decided_at is null))
);

create unique index approvals_one_pending_per_run_idx on approvals (run_id) where status = 'pending';
create index approvals_pending_idx on approvals (created_at) where status = 'pending';
create index approvals_undelivered_idx on approvals (run_id) where status <> 'pending' and delivered_at is null;
create index approvals_bot_idx on approvals (bot_id, created_at desc);

create trigger approvals_set_updated_at
  before update on approvals
  for each row execute function set_updated_at();

create table approval_rules (
  id uuid primary key default gen_random_uuid(),
  -- Nulo: vale para todos os bots.
  bot_id uuid references bots (id),
  -- Nome da ferramenta, ou '*' para qualquer uma.
  tool text not null check (length(tool) between 1 and 64),
  effect text not null check (effect in ('allow', 'deny')),
  -- Lista de { field, op, value }; todas precisam valer (E).
  matchers jsonb not null default '[]' check (jsonb_typeof(matchers) = 'array'),
  note text check (note is null or length(note) <= 500),
  -- Quem criou: o usuário direto, ou o "aprovar e sempre permitir" de um cartão.
  created_by text not null default 'user' check (created_by in ('user', 'approval')),
  source_approval_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index approval_rules_bot_idx on approval_rules (bot_id);

create trigger approval_rules_set_updated_at
  before update on approval_rules
  for each row execute function set_updated_at();

create table secrets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  description text not null default '' check (length(description) <= 500),
  -- AES-256-GCM: nonce de 12 bytes; o texto cifrado leva a etiqueta de autenticação no fim.
  nonce bytea not null check (length(nonce) = 12),
  ciphertext bytea not null,
  -- Impressão digital da chave que cifrou (não é a chave): permite trocar a chave com segurança.
  key_id text not null check (length(key_id) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);

create trigger secrets_set_updated_at
  before update on secrets
  for each row execute function set_updated_at();

create table secret_grants (
  secret_id uuid not null references secrets (id) on delete cascade,
  bot_id uuid not null references bots (id),
  granted_at timestamptz not null default now(),
  primary key (secret_id, bot_id)
);

create index secret_grants_bot_idx on secret_grants (bot_id);

-- Tempo real: a mudança de um cartão entra no diário de mudanças como as demais linhas.
create or replace function change_log_approvals() returns trigger language plpgsql as $$
begin
  perform change_log_append('approval', new.id::text, null,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create constraint trigger approvals_change_log_insert
  after insert on approvals
  deferrable initially deferred
  for each row execute function change_log_approvals();
create constraint trigger approvals_change_log_update
  after update on approvals
  deferrable initially deferred
  for each row
  when (old.status is distinct from new.status)
  execute function change_log_approvals();
