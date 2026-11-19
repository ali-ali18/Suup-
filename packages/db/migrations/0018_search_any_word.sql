-- 0018_search_any_word: a busca por QUALQUER palavra (o plano B de `recall` e `search_conversations`
-- quando a busca por TODAS as palavras não acha nada).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- `suup_search_query_any(texto)` não lê o texto da pessoa como consulta: ela pede ao PostgreSQL os
-- radicais (lexemas) do texto, os MESMOS que `suup_search_query` e o índice usam (português, com e sem
-- acento, palavras vazias já fora), e monta o OU deles. Cada lexema vira um termo por
-- `plainto_tsquery('simple', lexema)`, que trata o valor como texto puro: aspas, `&`, `|`, `!`, `:`
-- e parênteses não viram operadores. Sem lexemas (só palavras vazias ou pontuação), a consulta é
-- vazia e quem chama (`numnode(q) > 0`) não acha nada.

create or replace function suup_search_query_any(q text) returns tsquery language plpgsql immutable parallel safe strict as $$
declare
  result tsquery := ''::tsquery;
  lexeme text;
begin
  for lexeme in
    select distinct l from unnest(
      tsvector_to_array(to_tsvector('portuguese', q))
      || tsvector_to_array(to_tsvector('portuguese', suup_unaccent(q)))
    ) as l
    order by l
  loop
    result := result || plainto_tsquery('simple', lexeme);
  end loop;
  return result;
end
$$;

-- A revisão de uma escrita do bot agora DECIDE: o que a revisão não libera não é gravado (nem
-- fica pendente). A linha de `memory_reviews` guarda isso como `not_saved` (sem memória).
alter table memory_reviews drop constraint memory_reviews_outcome_check;
alter table memory_reviews add constraint memory_reviews_outcome_check
  check (outcome in ('active', 'pending', 'not_saved'));
