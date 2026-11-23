-- 0027_message_routine_ref: a mensagem do usuário que se refere a uma rotina (docs/ROTINAS.md).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * messages.routine_ref: o "Editar" de uma rotina, no app, leva o usuário ao chat do bot com o
--     rascunho preenchido e a referência à rotina presa a ele. A referência vai na mensagem como
--     dado estruturado (o id da rotina), nunca no texto que o usuário vê; o harness a dá ao modelo
--     numa nota própria, e o bot chama update_routine com o id certo. Só em mensagem do usuário.
--     Apagar a rotina deixa a mensagem e tira a referência.
--
-- Nada aqui usa expressão regular.

alter table messages add column routine_ref uuid references routines (id) on delete set null
  check (routine_ref is null or author_kind = 'user');
