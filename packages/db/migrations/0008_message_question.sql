-- 0008_message_question: a mensagem do bot que representa uma pergunta (`escalate`) leva, junto do
-- texto, os dados estruturados da pergunta, para o app desenhar o cartão só com a mensagem.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- `question` é nulo em toda mensagem que não é pergunta. Quando existe, é um objeto
-- `{ "options": [{ "label": "...", "description": "..." }], "reason": "review_tie_break" }`:
-- `options` (de 0 a 5 itens) são as escolhas oferecidas, e `reason` só aparece no desempate do
-- revisor. A resposta continua sendo texto comum (o rótulo escolhido ou texto livre).
alter table messages add column question jsonb
  check (question is null or (jsonb_typeof(question) = 'object' and author_kind = 'bot'));
