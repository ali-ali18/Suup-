-- 0012_connectors: conectores MCP (plano 4.11) e as concessões por bot.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Um conector é um servidor MCP externo cujas ferramentas um bot pode usar: um processo filho
-- (`stdio`: comando + argumentos, sem shell) ou um endereço HTTP. As credenciais NUNCA ficam aqui:
-- `env` e `headers` guardam, por nome, ou um texto comum ou uma REFERÊNCIA a um segredo do cofre
-- (`{"secret": "NOME"}`), resolvida na hora de conectar. Quem pode usar o conector é a tabela de
-- concessões, por bot (como no cofre). `scope` limita o conector inteiro; `tool_overrides` é o que o
-- usuário afirma de cada ferramenta (por exemplo, que é uma leitura): o que o servidor diz de si
-- mesmo só pode apertar, nunca afrouxar.
--
-- `origin`: quem criou. Hoje só `user` (API e CLI). `proposal` é o gancho para "o bot propõe instalar
-- um conector": uma proposta nasce DESLIGADA (`enabled = false`) e só um cartão de aprovação a liga
-- (veja docs/CONECTORES.md, o que ainda não existe).
--
-- `connector_discovery` guarda o que se viu do servidor na última vez (as ferramentas e o último
-- erro) em tabela à parte: gravar isso não mexe em `connectors.updated_at`, que identifica a
-- versão da configuração (uma conexão aberta com a versão antiga é descartada).

create table connectors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
    check (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and length(name) <= 24),
  description text not null default '' check (length(description) <= 500),
  transport text not null check (transport in ('stdio', 'http')),
  -- stdio
  command text check (command is null or length(command) between 1 and 1024),
  args jsonb not null default '[]' check (jsonb_typeof(args) = 'array'),
  cwd text check (cwd is null or length(cwd) between 1 and 1024),
  env jsonb not null default '{}' check (jsonb_typeof(env) = 'object'),
  -- http
  url text check (url is null or length(url) between 1 and 2048),
  headers jsonb not null default '{}' check (jsonb_typeof(headers) = 'object'),
  scope text not null default 'read_write' check (scope in ('read_only', 'read_write')),
  tool_overrides jsonb not null default '{}' check (jsonb_typeof(tool_overrides) = 'object'),
  trust_annotations boolean not null default false,
  timeout_ms integer check (timeout_ms is null or timeout_ms between 1000 and 600000),
  enabled boolean not null default true,
  origin text not null default 'user' check (origin in ('user', 'proposal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connectors_transport_columns check (
    (transport = 'stdio' and command is not null and url is null)
    or (transport = 'http' and url is not null and command is null)
  )
);

create trigger connectors_set_updated_at
  before update on connectors
  for each row execute function set_updated_at();

create table connector_grants (
  connector_id uuid not null references connectors (id) on delete cascade,
  bot_id uuid not null references bots (id),
  granted_at timestamptz not null default now(),
  primary key (connector_id, bot_id)
);

create index connector_grants_bot_idx on connector_grants (bot_id);

create table connector_discovery (
  connector_id uuid primary key references connectors (id) on delete cascade,
  -- As ferramentas como o servidor as descreveu (texto do servidor, não confiável), limitadas em tamanho.
  tools jsonb check (tools is null or jsonb_typeof(tools) = 'array'),
  discovered_at timestamptz,
  -- A última falha ao falar com o servidor (já sem valores de segredo), e quando.
  last_error text check (last_error is null or length(last_error) <= 2000),
  last_error_at timestamptz
);
