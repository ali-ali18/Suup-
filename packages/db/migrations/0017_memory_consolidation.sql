-- 0017_memory_consolidation: a memória ganha estado (ativa, pendente, recusada), um fato curto,
-- data de último uso, histórico de mudanças, configurações do servidor e a fila da consolidação em
-- segundo plano. Pesquisa que embasa o desenho: docs/pesquisas/memoria-dos-agentes.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- O que muda:
--   1. memories.status: `active` (vale), `pending` (uma regra ou um fato proposto por um bot ou pela
--      consolidação, que espera a confirmação do usuário: nunca entra num prompt) e `rejected` (o
--      usuário recusou; fica guardada para a consolidação não propor a mesma coisa outra vez).
--   2. memories.summary: o fato curto (até 200 caracteres) de uma nota ou de uma entrada do diário.
--      Entra no vetor de busca junto do texto, com peso maior (a técnica "expandir a chave com
--      fatos" da pesquisa). A coluna `search` é recriada.
--   3. memories.last_used_at: renovada quando a memória é achada pelo `recall`; o que não é usado
--      por `memory_settings.expiry_days` é arquivado pelo worker (só notas e diário).
--   3b. memories.supersedes_id: a memória pendente que propõe trocar outra (veja abaixo).
--   4. memories.text_key: o texto sem diferença de caixa nem de espaços (função `suup_text_key`),
--      para comparar fatos por IGUALDADE (nada de comparação aproximada). Sem expressão regular.
--   5. memory_revisions: cada mudança de uma memória (quem, de onde, o que mudou), para desfazer.
--   6. memory_settings: uma linha só, como approval_settings.
--   7. memory_consolidations: a fila e o registro da consolidação por conversa (uma por vez por
--      conversa, garantido pelo banco) e memory_reviews: o registro da revisão de uma escrita do bot.
--   8. O diário de mudanças (change_log) deixa de acordar o app só porque uma memória foi usada.
--
-- Nada aqui usa expressão regular.

-- 4. A chave de comparação. Espaço, tabulação e quebras de linha contam como espaço; as sequências
--    viram um espaço só; maiúsculas viram minúsculas. Só isso.
create function suup_text_key(t text) returns text language plpgsql immutable parallel safe as $$
declare
  v text := lower(translate(btrim(t, E' \t\n\r'), E'\t\n\r', '   '));
begin
  while position('  ' in v) > 0 loop
    v := replace(v, '  ', ' ');
  end loop;
  return v;
end;
$$;

alter table memories
  add column status text not null default 'active' check (status in ('active', 'pending', 'rejected')),
  add column summary text check (summary is null or (length(summary) between 1 and 200 and summary = btrim(summary))),
  add column last_used_at timestamptz,
  add column text_key text,
  -- Uma regra ou um fato pendente que PROPÕE trocar outra memória (uma atualização): confirmar a
  -- pendente arquiva a que ela troca. Recusar não toca em nada.
  add column supersedes_id uuid references memories (id) on delete set null;

update memories set text_key = suup_text_key(text);
alter table memories alter column text_key set not null;

create function memories_set_text_key() returns trigger language plpgsql as $$
begin
  new.text_key := suup_text_key(new.text);
  return new;
end;
$$;

create trigger memories_text_key
  before insert or update of text on memories
  for each row execute function memories_set_text_key();

create index memories_text_key_idx on memories (text_key) where archived_at is null;
-- A fila de confirmação e o contexto de cada execução (só o que está ativo).
create index memories_pending_idx on memories (created_at, id) where status = 'pending' and archived_at is null;
-- A expiração olha só notas e diário ativos.
create index memories_expiry_idx on memories (coalesce(last_used_at, created_at))
  where archived_at is null and status = 'active' and layer in ('note', 'journal');

-- 2. O vetor de busca: o fato curto (peso A) e o texto, com e sem acento, como na 0007.
drop index memories_search_idx;
alter table memories drop column search;
alter table memories add column search tsvector generated always as (
  setweight(to_tsvector('portuguese', coalesce(summary, '')), 'A')
  || to_tsvector('portuguese', text)
  || strip(to_tsvector('portuguese', suup_unaccent(coalesce(summary, '') || ' ' || text)))
) stored;
create index memories_search_idx on memories using gin (search);

-- Renovar o uso não é uma edição: `updated_at` só muda quando algo que o usuário vê muda.
drop trigger memories_set_updated_at on memories;
create trigger memories_set_updated_at
  before update of layer, scope, bot_id, text, summary, status, archived_at, embedding_ready on memories
  for each row execute function set_updated_at();

-- 8. O app só é avisado quando o texto, o resumo, o estado, a camada ou o arquivamento mudam.
create or replace function change_log_memories() returns trigger language plpgsql as $$
declare
  v_op text;
begin
  if tg_op = 'INSERT' then
    v_op := case when new.status = 'pending' then 'pending' else 'created' end;
  elsif old.archived_at is null and new.archived_at is not null then v_op := 'archived';
  elsif old.archived_at is not null and new.archived_at is null then v_op := 'restored';
  else v_op := 'updated';
  end if;
  perform change_log_append('memory', new.id::text, null, v_op);
  return null;
end;
$$;

drop trigger memories_change_log_update on memories;
create constraint trigger memories_change_log_update
  after update on memories
  deferrable initially deferred
  for each row
  when (
    old.text is distinct from new.text
    or old.archived_at is distinct from new.archived_at
    or old.status is distinct from new.status
    or old.layer is distinct from new.layer
    or old.summary is distinct from new.summary
  )
  execute function change_log_memories();

-- 5. O histórico de mudanças. Sem chave estrangeira para a origem: ela pode ser apagada e o
--    histórico continua dizendo de onde veio.
create table memory_revisions (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references memories (id) on delete cascade,
  -- created | edited | confirmed | rejected | archived | restored | promoted | undone
  kind text not null check (kind in ('created', 'edited', 'confirmed', 'rejected', 'archived', 'restored', 'promoted', 'undone')),
  -- Quem mudou: você, o bot (a ferramenta remember), a consolidação em segundo plano ou a expiração.
  actor text not null check (actor in ('user', 'bot', 'consolidation', 'expiry')),
  -- O estado de antes (nulo na criação) e o de depois.
  prev_text text,
  prev_summary text,
  prev_status text,
  prev_layer text,
  prev_scope text,
  prev_bot_id uuid,
  prev_archived boolean,
  new_text text not null,
  new_summary text,
  new_status text not null,
  new_layer text not null,
  new_scope text not null,
  new_bot_id uuid,
  new_archived boolean not null,
  origin_run_id uuid,
  origin_conversation_id uuid,
  origin_message_id uuid,
  origin_consolidation_id uuid,
  created_at timestamptz not null default clock_timestamp()
);
create index memory_revisions_memory_idx on memory_revisions (memory_id, created_at desc);

-- 6. As configurações (uma linha só). Os padrões são os do dono.
create table memory_settings (
  singleton boolean primary key default true check (singleton),
  consolidation_enabled boolean not null default true,
  idle_minutes integer not null default 5 check (idle_minutes between 1 and 120),
  max_turns integer not null default 15 check (max_turns between 3 and 100),
  prompt_limit_chars integer not null default 6000 check (prompt_limit_chars between 1000 and 50000),
  -- Nulo: nunca expira.
  expiry_days integer default 90 check (expiry_days is null or expiry_days between 7 and 3650),
  compaction_threshold double precision not null default 0.8 check (compaction_threshold between 0.5 and 0.95),
  updated_at timestamptz not null default now()
);
insert into memory_settings (singleton) values (true);
create trigger memory_settings_set_updated_at
  before update on memory_settings
  for each row execute function set_updated_at();

-- 7. A consolidação em segundo plano. Uma linha por tentativa. A janela é (from_seq, to_seq]: as
--    mensagens da conversa depois da última consolidação concluída até o momento da posse.
--    `queued` espera um worker (pedida antes de uma compactação); `running` tem posse com prazo.
create table memory_consolidations (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id),
  bot_id uuid not null references bots (id),
  reason text not null check (reason in ('idle', 'max_turns', 'pre_compaction')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'skipped', 'failed')),
  claimed_by text,
  lease_expires_at timestamptz,
  from_seq bigint,
  to_seq bigint,
  user_turns integer,
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  cost_usd double precision,
  latency_ms integer,
  -- O que o modelo propôs, o que foi guardado e o que foi descartado (e por quê).
  proposed jsonb,
  kept jsonb,
  dropped jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- No máximo uma consolidação viva por conversa: é o que torna a posse idempotente entre workers.
create unique index memory_consolidations_one_live_idx
  on memory_consolidations (conversation_id) where status in ('queued', 'running');
create index memory_consolidations_conversation_idx on memory_consolidations (conversation_id, created_at desc);
create index memory_consolidations_done_idx on memory_consolidations (conversation_id, to_seq desc) where status = 'done';

-- A revisão de uma escrita do bot (ferramenta remember) depois de a execução ler conteúdo de fora.
create table memory_reviews (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  bot_id uuid not null,
  memory_id uuid references memories (id) on delete set null,
  layer text not null,
  -- run | ask | block | error
  decision text not null check (decision in ('run', 'ask', 'block', 'error')),
  reason text not null,
  outcome text not null check (outcome in ('active', 'pending')),
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  cost_usd double precision,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index memory_reviews_run_idx on memory_reviews (run_id);
