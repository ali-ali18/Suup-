-- 0002_inbox_and_model_origin: origem de falha `model` e a caixa de entrada das execuções.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.

-- `model`: o modelo se recusou, desistiu sem concluir ou entrou em laço (ver FAILURE_ORIGINS no core).
-- O 0001 declarou a restrição sem nome; o Postgres a chamou de runs_failure_origin_check.
alter table runs drop constraint runs_failure_origin_check;
alter table runs add constraint runs_failure_origin_check
  check (failure_origin in ('provider', 'model', 'tool', 'harness', 'limit', 'approval', 'user'));

-- Mensagens e pedidos de parada enviados a uma execução enquanto ela trabalha.
-- Entrega em duas fases: o loop lê (consumed_at is null) e só marca consumed_at depois de gravar
-- os eventos que entregam o item. Assim uma queda no meio nunca perde a mensagem.
create table run_inbox (
  id bigint generated always as identity primary key,
  run_id uuid not null references runs (id),
  kind text not null check (kind in ('user_message', 'stop')),
  text text,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  constraint run_inbox_text_iff_message check ((kind = 'user_message') = (text is not null))
);

-- Itens ainda não consumidos de cada execução, na ordem de chegada.
create index run_inbox_pending_idx on run_inbox (run_id, id) where consumed_at is null;

-- Execuções com posse vencida: a varredura de requeueStaleRuns olha só as que estão rodando.
create index runs_running_lock_idx on runs (locked_at) where status = 'running';
