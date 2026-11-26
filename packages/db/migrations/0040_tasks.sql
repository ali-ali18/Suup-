-- 0040_tasks: tarefas em segundo plano do próprio bot (KOD-68, docs/TAREFAS.md).
-- Pesquisa: docs/pesquisas/kod-68-tarefas.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * conversations.kind ganha `task`: a conversa própria de uma tarefa (as mensagens do trabalho
--     dela). Não aparece na lista de conversas e não recebe mensagem pelo chat (só pela API da
--     tarefa). Tem o bot como membro, como a conversa direta, sem entrar nos índices da direta.
--   * runs.origin ganha `task` (a execução da tarefa, FORA do índice de uma execução ativa por
--     conversa: o chat segue livre) e `task_result` (o turno curto do bot no chat que recebe o
--     relatório da tarefa quando ela termina; esse SIM é a execução em primeiro plano do chat, então
--     entra no índice).
--   * tasks: a tarefa. O estado (trabalhando, esperando, concluída...) é o da execução (`run_id`),
--     nunca copiado para cá. `source_message_ids` são as mensagens do usuário que embasam o pedido
--     (o texto é copiado do banco quando a tarefa começa a rodar, nunca reescrito pelo modelo).
--     `closed_at` marca que o fim da tarefa já foi tratado (o resultado entregue ao chat, ou nada a
--     entregar porque o usuário a parou) e `closing_run_id` é o turno do chat que a entregou. Os dois
--     são gravados numa transação com a linha da tarefa travada, o que torna a entrega uma só.
--
-- Nada aqui usa expressão regular.

alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('direct', 'group', 'task'));

alter table runs drop constraint runs_origin_check;
alter table runs add constraint runs_origin_check
  check (origin in ('user', 'routine', 'delegation', 'proactive', 'reception', 'task', 'task_result'));

drop index runs_one_active_user_run_per_conversation_idx;
create unique index runs_one_active_user_run_per_conversation_idx on runs (conversation_id)
  where conversation_id is not null
    and origin in ('user', 'reception', 'delegation', 'task_result')
    and status in ('queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_timer');

create table tasks (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references bots (id) on delete cascade,
  -- o chat em que a tarefa foi pedida: o resultado e os cartões de aprovação voltam para ele
  conversation_id uuid not null references conversations (id) on delete cascade,
  -- a execução do chat que abriu a tarefa
  from_run_id uuid references runs (id) on delete set null,
  -- a execução da tarefa e a conversa dela
  run_id uuid not null unique references runs (id) on delete cascade,
  task_conversation_id uuid not null unique references conversations (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  brief text not null check (length(btrim(brief)) > 0),
  source_message_ids uuid[] not null default '{}',
  -- a mesma tarefa (mesmo título e pedido) na mesma execução do chat é uma só
  start_key text not null,
  closing_run_id uuid references runs (id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_run_id, start_key)
);
create index tasks_conversation_idx on tasks (conversation_id, created_at, id);
create index tasks_bot_idx on tasks (bot_id, created_at, id);
create index tasks_closing_run_idx on tasks (closing_run_id) where closing_run_id is not null;

create trigger tasks_set_updated_at
  before update on tasks
  for each row execute function set_updated_at();

-- Tempo real: a tarefa nova e a entrega do resultado entram no diário de mudanças.
create or replace function change_log_tasks() returns trigger language plpgsql as $$
begin
  perform change_log_append('task', new.id::text, null,
    case tg_op when 'INSERT' then 'created' else 'updated' end);
  return null;
end;
$$;

create constraint trigger tasks_change_log_insert
  after insert on tasks
  deferrable initially deferred
  for each row execute function change_log_tasks();
create constraint trigger tasks_change_log_update
  after update on tasks
  deferrable initially deferred
  for each row
  when (old.closed_at is distinct from new.closed_at)
  execute function change_log_tasks();

-- O estado de uma tarefa é o da execução dela: quando a situação da execução muda, a tarefa também
-- entra no diário de mudanças (uma linha por mudança: o stream não repete um id de evento).
create or replace function change_log_task_runs() returns trigger language plpgsql as $$
declare
  v_task uuid;
begin
  select id into v_task from tasks where run_id = new.id;
  if v_task is not null then
    perform change_log_append('task', v_task::text, null, 'updated');
  end if;
  return null;
end;
$$;

create constraint trigger runs_task_change_log_update
  after update on runs
  deferrable initially deferred
  for each row
  when (new.origin = 'task' and old.status is distinct from new.status)
  execute function change_log_task_runs();
