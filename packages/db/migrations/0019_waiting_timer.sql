-- 0019_waiting_timer: o bot volta sozinho (ferramenta `schedule_return`). Pesquisa e decisão do dono:
-- docs/pesquisas/fase-4-acordar-sozinho.md; funcionamento: docs/RETORNO.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- A MESMA execução fica estacionada numa situação nova, `waiting_timer`, até a hora marcada. Nenhum
-- worker a segura (como `waiting_user`). Um job do worker acorda as que venceram, em uma transação
-- só: grava o evento `wait_fired` e devolve a execução à fila. Fora das rotinas: nada novo na tela.
--
--   * runs.status ganha `waiting_timer`;
--   * wake_at / wake_note: quando acordar e o que conferir (só enquanto estacionada); a nota também
--     está no evento `wait_scheduled`, que é a fonte da verdade;
--   * wake_count: quantos retornos seguidos já dispararam (o teto está em limits.maxReturns);
--   * a execução em primeiro plano da conversa continua sendo uma só: `waiting_timer` conta como ativa.
--
-- Nada aqui usa expressão regular.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check check (status in (
  'queued', 'running', 'waiting_approval', 'waiting_user', 'waiting_timer', 'done', 'failed', 'cancelled'
));

alter table runs
  add column wake_at timestamptz,
  add column wake_note text,
  add column wake_count integer not null default 0 check (wake_count >= 0);

alter table runs add constraint runs_wake_only_when_waiting_timer
  check (wake_at is null or status = 'waiting_timer');

-- O job de acordar procura só as estacionadas e vencidas.
create index runs_wake_due_idx on runs (wake_at) where status = 'waiting_timer';

drop index runs_one_active_user_run_per_conversation_idx;
create unique index runs_one_active_user_run_per_conversation_idx on runs (conversation_id)
  where conversation_id is not null
    and origin = 'user'
    and status in ('queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_timer');
