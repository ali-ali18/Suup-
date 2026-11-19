-- 0010_isolated_runs: execuções isoladas (as da avaliação, `suup eval`).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * `isolated`: a execução não lê nem escreve na memória do usuário. Ao nascer, o runtime não
--     carrega regras, perfil nem histórico para ela (já era assim); agora o fim dela também não
--     grava diário, nem agora (`finishRun`) nem depois (`reconcileRunEffects`). A marca fica na
--     linha para que isso valha para qualquer worker que a processe, mesmo depois de uma queda.
alter table runs add column isolated boolean not null default false;
