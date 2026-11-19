-- 0009_bot_appearance_and_groups: o que a lista de bots do app precisa guardar: fixar um bot,
-- agrupá-lo sob um nome, ordená-lo e escolher a cor do mascote.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * `pinned`: fixado no topo da lista (os fixados aparecem em blocos grandes).
--   * `group_name`: nome do grupo (texto livre, até 60 caracteres); nulo = sem grupo (a lista
--     "Bots"). Os grupos não têm tabela: existem enquanto algum bot os usa.
--   * `sort_order`: posição dentro do bloco (fixados, ou o grupo); nulo ordena depois dos demais.
--   * `color`: id de uma cor da paleta fechada do `@suup/api` (o servidor valida; o banco guarda o
--     id, nunca CSS). O formato do mascote continua em `avatar` (texto opaco).
alter table bots add column pinned boolean not null default false;
alter table bots add column group_name text
  check (group_name is null or length(btrim(group_name)) between 1 and 60);
alter table bots add column sort_order integer;
alter table bots add column color text check (color is null or length(color) between 1 and 40);
