-- 0006_change_feed: o diário de mudanças que alimenta o tempo real (SSE) do servidor.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Desenho:
--   * Triggers nas tabelas que o app acompanha gravam uma linha minúscula em `change_log`: só o
--     tipo da mudança e ids (nunca texto de mensagem, de memória ou payload de evento).
--   * A trigger é de CONSTRAINT, adiada (DEFERRABLE INITIALLY DEFERRED): roda no COMMIT, depois de
--     todas as outras escritas da transação, e aí pega uma trava consultiva global antes de
--     numerar. Como a trava só é solta quando o commit termina, e a numeração acontece com ela
--     pega, os ids de `change_log` crescem na ordem em que as transações ficam visíveis: quem lê
--     "id > N" nunca perde uma linha que apareça depois (o problema clássico das sequências que
--     confirmam fora de ordem). Pegar a trava só no fim também evita deadlock: quem a segura não
--     espera por mais nada.
--   * A mesma trigger dá um NOTIFY com o id. O servidor ouve (LISTEN), lê as linhas novas e então
--     lê as linhas das tabelas. O NOTIFY é só a campainha; se for perdido, a leitura periódica
--     do servidor recupera, porque a fonte da verdade é a tabela.
--   * O canal e a trava levam o nome do schema, para que bancos de teste em schemas diferentes
--     no mesmo banco não se misturem.

create table change_log (
  id bigint generated always as identity primary key,
  -- run_event | run | message | memory | conversation | bot
  kind text not null,
  -- id principal da linha afetada (uuid em texto)
  ref text not null,
  -- run_event: o seq do evento
  ref2 bigint,
  -- created | updated | archived | restored (memória); created | updated (o resto)
  op text not null default 'updated',
  -- Hora da gravação (no commit): cresce junto com o id, o que a poda por idade pressupõe.
  created_at timestamptz not null default clock_timestamp()
);
create index change_log_created_idx on change_log (created_at);

-- Até que id o diário já foi podado: quem pede para continuar de um id menor precisa recarregar.
create table change_log_state (
  singleton boolean primary key default true check (singleton),
  pruned_through bigint not null default 0
);
insert into change_log_state default values;

create or replace function change_log_append(p_kind text, p_ref text, p_ref2 bigint, p_op text)
returns void language plpgsql as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('suup:change_log:' || current_schema(), 0));
  insert into change_log (kind, ref, ref2, op) values (p_kind, p_ref, p_ref2, p_op)
    returning id into v_id;
  perform pg_notify('suup_changes_' || current_schema(), v_id::text);
end;
$$;

create or replace function change_log_run_events() returns trigger language plpgsql as $$
begin
  perform change_log_append('run_event', new.run_id::text, new.seq, 'created');
  return null;
end;
$$;

create or replace function change_log_runs() returns trigger language plpgsql as $$
begin
  perform change_log_append('run', new.id::text, null,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create or replace function change_log_messages() returns trigger language plpgsql as $$
begin
  perform change_log_append('message', new.id::text, new.seq,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create or replace function change_log_memories() returns trigger language plpgsql as $$
declare
  v_op text;
begin
  if tg_op = 'INSERT' then v_op := 'created';
  elsif old.archived_at is null and new.archived_at is not null then v_op := 'archived';
  elsif old.archived_at is not null and new.archived_at is null then v_op := 'restored';
  else v_op := 'updated';
  end if;
  perform change_log_append('memory', new.id::text, null, v_op);
  return null;
end;
$$;

create or replace function change_log_conversations() returns trigger language plpgsql as $$
begin
  perform change_log_append('conversation', new.id::text, null,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create or replace function change_log_bots() returns trigger language plpgsql as $$
begin
  perform change_log_append('bot', new.id::text, null,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create constraint trigger run_events_change_log
  after insert on run_events
  deferrable initially deferred
  for each row execute function change_log_run_events();

-- Só o que muda a tela: situação, pausa, uso, plano e resultado. Renovar a posse (locked_at) a
-- cada batimento não gera linha.
create constraint trigger runs_change_log_insert
  after insert on runs
  deferrable initially deferred
  for each row execute function change_log_runs();
create constraint trigger runs_change_log_update
  after update on runs
  deferrable initially deferred
  for each row
  when (
    old.status is distinct from new.status
    or old.paused_at is distinct from new.paused_at
    or old.turns is distinct from new.turns
    or old.cost_usd is distinct from new.cost_usd
    or old.plan is distinct from new.plan
    or old.failure_detail is distinct from new.failure_detail
  )
  execute function change_log_runs();

create constraint trigger messages_change_log_insert
  after insert on messages
  deferrable initially deferred
  for each row execute function change_log_messages();
create constraint trigger messages_change_log_update
  after update on messages
  deferrable initially deferred
  for each row
  when (old.status is distinct from new.status or old.run_id is distinct from new.run_id)
  execute function change_log_messages();

create constraint trigger memories_change_log_insert
  after insert on memories
  deferrable initially deferred
  for each row execute function change_log_memories();
create constraint trigger memories_change_log_update
  after update on memories
  deferrable initially deferred
  for each row
  when (old.text is distinct from new.text or old.archived_at is distinct from new.archived_at)
  execute function change_log_memories();

create constraint trigger conversations_change_log_insert
  after insert on conversations
  deferrable initially deferred
  for each row execute function change_log_conversations();
create constraint trigger conversations_change_log_update
  after update on conversations
  deferrable initially deferred
  for each row
  when (
    old.last_message_at is distinct from new.last_message_at
    or old.archived_at is distinct from new.archived_at
    or old.last_read_seq is distinct from new.last_read_seq
    or old.title is distinct from new.title
  )
  execute function change_log_conversations();

create constraint trigger bots_change_log_insert
  after insert on bots
  deferrable initially deferred
  for each row execute function change_log_bots();
create constraint trigger bots_change_log_update
  after update on bots
  deferrable initially deferred
  for each row
  when (
    old.name is distinct from new.name
    or old.description is distinct from new.description
    or old.personality is distinct from new.personality
    or old.model_id is distinct from new.model_id
    or old.model_provider is distinct from new.model_provider
    or old.allowed_tools is distinct from new.allowed_tools
    or old.limits is distinct from new.limits
    or old.avatar is distinct from new.avatar
    or old.is_default is distinct from new.is_default
    or old.archived_at is distinct from new.archived_at
  )
  execute function change_log_bots();
