-- 0037_message_event_seq: a posição, no registro da execução, do texto que o bot escreveu num turno (KOD-64).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- O bot escreve texto no mesmo turno em que chama ferramentas ("vou conferir...", depois o cartão).
-- Esse texto vira uma mensagem do bot (uma por bloco de texto), gravada na mesma transação do evento
-- `model_response`, na ordem em que aconteceu. `event_seq` é o `seq` desse evento na execução: o app
-- compara com o `seq` do evento do cartão (a chamada da ferramenta) e coloca o texto e o cartão na
-- ordem do registro, sem depender de relógio (o `now()` do Postgres é o início da transação, e duas
-- gravações no mesmo instante empatariam). A identidade vem da `dedupe_key`
-- (`run:<execução>:part:<seq>:<bloco>`), que já é única por conversa.
--
-- Só as mensagens de parte têm esta coluna; as demais ficam sem ela.

alter table messages add column event_seq integer
  check (event_seq is null or event_seq > 0);
