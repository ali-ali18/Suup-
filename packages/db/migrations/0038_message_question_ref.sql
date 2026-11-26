-- 0038_message_question_ref: a resposta do usuário dada pelo cartão de pergunta (KOD-15).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * messages.question_ref: quando o usuário responde clicando no cartão de pergunta, a resposta
--     continua sendo uma mensagem dele em texto (é assim que o bot a recebe), mas leva o id da
--     mensagem do bot que fez a pergunta. O app usa esse dado declarado para mostrar a resposta só
--     no cartão respondido, sem um balão próprio. Uma resposta digitada no chat não tem a coluna.
--     Só em mensagem do usuário. Apagar a pergunta deixa a resposta e tira a referência.
--
-- Nada aqui usa expressão regular.

alter table messages add column question_ref uuid references messages (id) on delete set null
  check (question_ref is null or author_kind = 'user');
