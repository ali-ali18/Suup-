-- 0016_written_rules_approval_mode: revisão automática por modelo, com regras que o usuário ESCREVE.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- 1. `written_rules`: regras em linguagem natural ("Permitir sem perguntar: e-mails para minha equipe
--    em acme.com"). O texto é prosa livre, aparado e com no máximo 500 caracteres; nenhum código o
--    interpreta, quem o lê é o modelo revisor. `kind` é o que a regra pede: `never` (nunca fazer),
--    `ask` (sempre perguntar) ou `allow` (pode fazer sem perguntar). `bot_id` nulo vale para todos os
--    bots. Só um ato explícito do usuário (API, CLI, app) cria uma; o modelo nunca cria.
--    As regras exatas (`approval_rules`) continuam como estavam: são a camada determinística.
-- 2. `approval_settings`: uma linha só, com o modo de aprovação (`auto_review`, o padrão, ou
--    `ask_all`). Fica no servidor, não no navegador.
-- 3. `approvals.review_reason` e `approvals.written_rule_id`: por que o cartão foi para o usuário,
--    quando foi o revisor (uma frase) e qual regra escrita ele citou. Sem chave estrangeira: a regra
--    pode ser apagada depois e o cartão continua dizendo o motivo.
--
-- Nada aqui usa expressão regular.

create table written_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('never', 'ask', 'allow')),
  text text not null check (length(text) between 1 and 500 and text = btrim(text)),
  bot_id uuid references bots (id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index written_rules_bot_idx on written_rules (bot_id);

create trigger written_rules_set_updated_at
  before update on written_rules
  for each row execute function set_updated_at();

create table approval_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'auto_review' check (mode in ('auto_review', 'ask_all')),
  updated_at timestamptz not null default now()
);

insert into approval_settings (singleton) values (true);

create trigger approval_settings_set_updated_at
  before update on approval_settings
  for each row execute function set_updated_at();

alter table approvals
  add column review_reason text check (review_reason is null or length(review_reason) <= 1000),
  add column written_rule_id uuid;
