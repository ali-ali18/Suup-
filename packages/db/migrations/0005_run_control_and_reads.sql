-- 0005_run_control_and_reads: pausar e interromper execuções de fora do worker, e não lidas.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Pausar e interromper (quem pede é o servidor, quem obedece é o worker, em outro processo):
--   paused_at               a execução foi pausada pelo usuário. Enquanto estiver preenchido, nenhum
--                           worker a pega da fila (ela fica `queued` ou, até o worker devolvê-la,
--                           `running`). Retomar limpa o campo.
--   interrupt_requested_at  pedido de interrupção imediata: o worker que detém a posse o vê no
--                           próximo batimento (renovação da posse) e aborta a chamada em curso.
--                           Quem o limpa é quem devolve ou pega a execução.
--   Pausar só faz sentido numa execução que ainda não terminou nem espera o usuário: o banco
--   recusa `paused_at` fora de `queued`/`running`, e setRunStatus o limpa ao sair desses estados.
alter table runs add column paused_at timestamptz;
alter table runs add column interrupt_requested_at timestamptz;
alter table runs add constraint runs_pause_only_when_active
  check (paused_at is null or status in ('queued', 'running'));
alter table runs add constraint runs_interrupt_only_when_running
  check (interrupt_requested_at is null or status in ('queued', 'running'));

-- A fila não enxerga as pausadas.
drop index runs_queue_idx;
create index runs_queue_idx on runs (created_at) where status = 'queued' and paused_at is null;

-- Não lidas: até que `seq` o usuário já leu a conversa. Não lida = mensagem de bot ou do sistema
-- com seq maior que isto.
alter table conversations add column last_read_seq bigint not null default 0 check (last_read_seq >= 0);
