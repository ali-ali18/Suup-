-- 0007_accent_insensitive_search: a busca de mensagens e memórias passa a ignorar acentos
-- ("avaliacao" acha "avaliação" e o contrário).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Como funciona e por que é assim:
--   * `suup_unaccent(text)` é uma função IMUTÁVEL com um nome fixo. Onde a extensão `unaccent` (do
--     pacote contrib do PostgreSQL, presente na imagem Docker) existe, ela tira os acentos; onde
--     não existe (um PostgreSQL puro, sem contrib), ela devolve o texto como veio. A MESMA
--     migração roda nos dois, e o resto do esquema e das consultas não sabe a diferença.
--   * O vetor de busca ganha, além do vetor de sempre (radicais do português, com acento),
--     os radicais do texto sem acento, sem posições (para não duplicar o tamanho do vetor). Assim
--     a busca com acento continua igual, e a sem acento passa a achar.
--   * `suup_search_query(texto)` monta a consulta com as duas formas (acentuada OU sem acento).
--   * Por que não uma configuração de busca com o dicionário unaccent na frente do stemmer? Porque
--     tirar o acento antes do stemmer muda os radicais ("pães" e "pão" deixam de coincidir) e
--     desativa as palavras vazias que têm acento ("você", "não").
--   * A extensão é instalada no schema `public` (ou fica onde já estiver), nunca no schema desta
--     migração: nos testes cada arquivo usa um schema próprio que é apagado, e a extensão não pode
--     ir junto. Falta de permissão ou de contrib não derruba a migração: cai no texto sem mudança.
--     `suup doctor` informa qual dos dois casos está valendo.
--   * Para forçar o caso sem extensão (testes): `set suup.disable_unaccent = 'on'` na sessão.

do $migration$
declare
  v_schema text;
  v_ok boolean := false;
begin
  if coalesce(current_setting('suup.disable_unaccent', true), '') <> 'on'
     and exists (select 1 from pg_available_extensions where name = 'unaccent') then
    -- Duas migrações em schemas diferentes ao mesmo tempo não podem criar a extensão juntas.
    perform pg_advisory_xact_lock(hashtext('suup:unaccent-extension'));
    begin
      if not exists (select 1 from pg_extension where extname = 'unaccent') then
        create extension unaccent with schema public;
      end if;
      select n.nspname into v_schema
        from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'unaccent';
      execute format(
        'create or replace function suup_unaccent(text) returns text language sql immutable parallel safe strict as $f$ select %I.unaccent(%L::regdictionary, $1) $f$',
        v_schema, v_schema || '.unaccent');
      -- Confere que funciona de verdade (o dicionário e o arquivo de regras existem).
      v_ok := suup_unaccent('ação') = 'acao';
    exception when others then
      v_ok := false;
    end;
  end if;
  if not v_ok then
    create or replace function suup_unaccent(text) returns text language sql immutable parallel safe strict
      as 'select $1';
  end if;
end
$migration$;

create or replace function suup_search_query(q text) returns tsquery language sql immutable parallel safe strict as $$
  select websearch_to_tsquery('portuguese', q) || websearch_to_tsquery('portuguese', suup_unaccent(q))
$$;

drop index messages_search_idx;
alter table messages drop column search;
alter table messages add column search tsvector generated always as (
  to_tsvector('portuguese', text) || strip(to_tsvector('portuguese', suup_unaccent(text)))
) stored;
create index messages_search_idx on messages using gin (search);

drop index memories_search_idx;
alter table memories drop column search;
alter table memories add column search tsvector generated always as (
  to_tsvector('portuguese', text) || strip(to_tsvector('portuguese', suup_unaccent(text)))
) stored;
create index memories_search_idx on memories using gin (search);
