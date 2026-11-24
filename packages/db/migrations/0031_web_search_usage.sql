-- 0030_web_search_usage: quantas buscas cada motor de busca geral respondeu em cada mês
-- (docs/BUSCA.md, "A fila da busca geral"). É o que a tela de Ajustes mostra ("12 buscas este mês").
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Só uma contagem por motor e mês. Nunca o texto da busca, nunca um resultado, nunca uma chave.
-- O mês é o mês civil em UTC, escrito `2026-11`.
--
-- Nada aqui usa expressão regular.

create table web_search_usage (
  engine text not null,
  month text not null,
  searches integer not null default 0 check (searches >= 0),
  primary key (engine, month)
);
