-- 0021_stale_approvals: aprovar um cartão que esperou muito tempo.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Um cartão nunca expira sozinho (a não ser que `approvals.expireAfterMinutes` mande). Mas aprovar um
-- cartão que esperou mais que `stale_after_minutes` NÃO executa a ação na hora: a execução retoma
-- com um aviso ao modelo e a aprovação vira uma permissão de uma vez, só para a chamada idêntica,
-- dentro da mesma execução (docs/APROVACOES.md, "Aprovação depois de muito tempo").
--
--   * approval_settings.stale_after_minutes: o limite, em minutos (padrão 60; de 5 a 10080 = 1 semana);
--     é uma configuração do servidor, editável em Configurações > Permissões;
--   * approvals.waited_ms: quanto o cartão esperou até a decisão (decided_at - created_at), gravado
--     na hora em que o usuário decide;
--   * approvals.stale_after_ms: o limite que valia nessa hora. O cartão é "tardio" quando foi
--     aprovado e waited_ms > stale_after_ms; os dois números vão para o evento `approval_stale`, e
--     assim o replay não depende de relógio nem de configuração.
--
-- Nada aqui usa expressão regular.

alter table approval_settings
  add column stale_after_minutes integer not null default 60
    check (stale_after_minutes between 5 and 10080);

alter table approvals
  add column waited_ms bigint check (waited_ms is null or waited_ms >= 0),
  add column stale_after_ms bigint check (stale_after_ms is null or stale_after_ms >= 0);
