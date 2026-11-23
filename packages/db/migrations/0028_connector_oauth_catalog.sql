-- 0028_connector_oauth_catalog: conectores da galeria e login pelo OAuth do MCP
-- (docs/CONECTORES.md, "Galeria" e "OAuth"; pesquisa docs/pesquisas/fase-4-conectores-galeria-oauth-composio.md).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * connectors.oauth: o conector HTTP entra pelo OAuth do protocolo em vez de um cabeçalho. Guarda
--     só configuração (escopos, o ID de um cliente que a pessoa registrou e a REFERÊNCIA ao segredo
--     do cliente no cofre); nunca um token.
--   * connectors.catalog_id: a entrada da galeria de onde o conector veio (id exato), ou nulo.
--   * connector_oauth: o que se sabe do login de um conector que NÃO é segredo: o que a descoberta
--     achou (metadados públicos), o cliente registrado sem a chave secreta, a validade e o escopo do
--     token, o URI de retorno do último login, o estado e o último erro. O token de acesso, o de
--     renovação e a chave secreta do cliente ficam no COFRE (cifrados), com nomes
--     SUUP_OAUTH_<CONECTOR>_ACCESS, _REFRESH e _CLIENT_SECRET.
--
-- Nada aqui usa expressão regular.

alter table connectors
  add column oauth jsonb check (oauth is null or jsonb_typeof(oauth) = 'object'),
  add column catalog_id text check (catalog_id is null or length(catalog_id) between 1 and 64);

create table connector_oauth (
  connector_id uuid primary key references connectors (id) on delete cascade,
  status text not null default 'needs_login'
    check (status in ('needs_login', 'connected', 'error')),
  discovery jsonb check (discovery is null or jsonb_typeof(discovery) = 'object'),
  client jsonb check (client is null or jsonb_typeof(client) = 'object'),
  token_info jsonb check (token_info is null or jsonb_typeof(token_info) = 'object'),
  redirect_uri text check (redirect_uri is null or length(redirect_uri) <= 2048),
  last_error text check (last_error is null or length(last_error) <= 2000),
  updated_at timestamptz not null default now()
);
