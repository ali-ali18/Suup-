-- 0013_exact_rules_outbound: regras só por igualdade exata; mensagens para outras pessoas.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- 1. Regras. Uma regra passa a casar só por IGUALDADE EXATA de campos nomeados dos argumentos (mais o
--    bot e a ferramenta). Os operadores `starts_with`, `contains` e `glob` deixaram de existir: nada
--    que decide o que roda sem perguntar é um padrão. Uma regra guardada com um deles é DESATIVADA
--    aqui (nunca apagada nem ampliada em silêncio): ela deixa de valer, continua listada com o motivo,
--    e `suup doctor` a aponta. As condições antigas ficam guardadas como estavam, para o usuário ver o
--    que ela dizia e criar a regra exata que quiser. Não há expressão regular aqui: a comparação é
--    de texto simples.
-- 2. Aprovações. `approvals.outbound` guarda a declaração de que a chamada é uma mensagem para outra
--    pessoa (`{"kind":"message","recipientFields":[...]}`), copiada do evento `approval_requested`.
--    É o que faz o cartão ser o cartão de mensagem; nada a deduz do nome da ferramenta.

alter table approval_rules
  add column enabled boolean not null default true,
  add column disabled_reason text check (disabled_reason is null or length(disabled_reason) <= 1000),
  add constraint approval_rules_disabled_has_reason check (enabled or disabled_reason is not null);

update approval_rules r
set enabled = false,
    disabled_reason = left(
      'Desativada: usava uma condição por padrão (começa com, contém ou glob), que não existe mais. Condições: '
      || (
        select string_agg(
          (m.value ->> 'field') || ' ' || coalesce(m.value ->> 'op', 'equals') || ' ' || to_json(m.value ->> 'value')::text,
          ' e '
        )
        from jsonb_array_elements(r.matchers) as m(value)
      ),
      1000)
where exists (
  select 1 from jsonb_array_elements(r.matchers) as m(value)
  where coalesce(m.value ->> 'op', 'equals') <> 'equals'
);

alter table approvals
  add column outbound jsonb check (outbound is null or jsonb_typeof(outbound) = 'object');
