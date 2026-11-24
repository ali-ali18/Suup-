-- 0029_routine_reminders: o lembrete de uma vez só é interno, não é rotina (docs/ROTINAS.md,
-- "Lembrete de uma vez"; decisão do dono, 23/11/2026: "lembrete único é interno; rotina é o que se
-- repete"). Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * routines.reminder: a linha é um lembrete do bot, pedido pelo usuário para uma data e hora
--     (mais longe que o retorno interno de até 60 minutos). Usa o mesmo agendador, mas não aparece
--     no painel nem na lista da API, só tem horário de uma vez (`once`) e é apagado depois que
--     dispara. O aviso ao usuário é a mensagem do bot, como no retorno (docs/RETORNO.md).
--
-- Nada aqui usa expressão regular.

alter table routines add column reminder boolean not null default false;
alter table routines add constraint routines_reminder_once
  check (not reminder or schedule ->> 'kind' = 'once');
