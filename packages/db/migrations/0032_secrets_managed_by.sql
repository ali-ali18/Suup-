-- 0032_secrets_managed_by: segredos que um conector cuida sozinho (o login OAuth dele).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- O cofre é para o que o dono dá aos bots. Os tokens de acesso e de renovação e a chave secreta do
-- cliente de um conector (SUUP_OAUTH_<CONECTOR>_ACCESS, _REFRESH, _CLIENT_SECRET) são internos
-- dele: ficam cifrados aqui, como sempre, mas marcados com o NOME EXATO do conector que os cuida
-- (`managed_by`). Marcados, somem da lista do dono e não podem ser concedidos a um bot.
--
-- Os que já existem são marcados por comparação exata: o nome do segredo tem de ser igual ao que
-- o conector de nome X produz (SUUP_OAUTH_ + X em maiúsculas, hífen virando sublinhado, + sufixo).
-- As concessões que algum deles já tenha são apagadas.
--
-- Nada aqui usa expressão regular.

alter table secrets
  add column managed_by text check (managed_by is null or length(managed_by) between 1 and 64);

update secrets s set managed_by = c.name
from connectors c
where s.name in (
  'SUUP_OAUTH_' || upper(replace(c.name, '-', '_')) || '_ACCESS',
  'SUUP_OAUTH_' || upper(replace(c.name, '-', '_')) || '_REFRESH',
  'SUUP_OAUTH_' || upper(replace(c.name, '-', '_')) || '_CLIENT_SECRET'
);

delete from secret_grants where secret_id in (select id from secrets where managed_by is not null);
