-- 0024_web_search_cache: o cache da busca na web (docs/BUSCA.md, "Busca educada").
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Uma busca idêntica (consulta em forma simples, os mesmos motores e opções) feita há pouco é
-- respondida daqui, em vez de ir de novo aos motores. Fica no banco para sobreviver a um reinício e
-- valer para o worker e para o app. A chave é o texto que o código monta; `entry` guarda a resposta
-- (resultados, motores que não responderam, quando foi feita) e `expires_at` a validade.
--
-- Nada aqui usa expressão regular.

create table web_search_cache (
  key text primary key,
  entry jsonb not null,
  stored_at timestamptz not null,
  expires_at timestamptz not null
);

create index web_search_cache_expires_idx on web_search_cache (expires_at);
