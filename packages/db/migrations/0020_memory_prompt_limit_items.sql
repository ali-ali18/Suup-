-- 0020_memory_prompt_limit_items: o teto do que entra sempre no prompt (regras e perfil ativos)
-- passa a ser contado em MEMÓRIAS (padrão 200, como as primeiras 200 linhas do MEMORY.md do Claude
-- Code), não em caracteres. Há também um teto de segurança de 25.000 caracteres, fixo no código
-- (o 25KB do Claude Code), que não é configuração. Pesquisa: docs/pesquisas/memoria-dos-agentes.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- A coluna `prompt_limit_chars` (de 1000 a 50000) sai; qualquer valor antigo vira o padrão novo
-- (200): as duas unidades não se convertem. Nada aqui usa expressão regular.
alter table memory_settings
  drop column prompt_limit_chars,
  add column prompt_limit_items integer not null default 200
    check (prompt_limit_items between 20 and 1000);
