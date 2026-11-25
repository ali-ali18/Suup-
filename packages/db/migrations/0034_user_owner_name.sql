-- 0034_user_owner_name: o nome da pessoa, como campo estruturado em `user_settings`
-- (docs/RECEPCAO.md, "O nome da pessoa"). É o nome que ela escolheu na boas-vindas do app; os bots
-- o leem uma vez por execução. Texto livre: sem validar formato de nome, sem mudar maiúsculas
-- (só o tamanho, para o banco). Nulo enquanto a pessoa não disse.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.

alter table user_settings
  add column owner_name text check (owner_name is null or length(owner_name) between 1 and 60);
