-- 0022_reception: a recepção do bot (docs/RECEPCAO.md) e o cartão de proposta de equipe.
-- Pesquisa e decisão do dono: docs/pesquisas/fase-4-recepcao-inicial.md.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
--   * runs.origin ganha `reception`: a execução que o próprio servidor abre quando o usuário abre,
--     pela primeira vez, o chat de um bot. Ela é a execução em primeiro plano da conversa, como a do
--     usuário (o índice único passa a cobrir as duas origens), então a mensagem que o usuário
--     escrever enquanto ela roda entra na caixa dela e a recepção cede ao pedido.
--   * conversations.reception: o estado da recepção da conversa, para ela acontecer UMA vez.
--       pending  ainda não começou (a conversa nova nasce assim). Começa só se a conversa estiver
--                vazia; uma mensagem do usuário antes disso a dispensa (`done`).
--       started  a execução da recepção foi aberta (na mesma transação que muda o estado).
--       done     acabou, foi dispensada ou a conversa já tinha história (não volta sozinha).
--       redo     o usuário pediu para refazer (Configurações): começa na próxima abertura, mesmo
--                com história.
--     Conversas que já existem e têm mensagens, e as de grupo, ficam `done`.
--   * messages.team: a proposta de equipe de uma mensagem do bot (o cartão "Criar selecionados"):
--     { items: [{ name, description, personality }], status: pending|created|dismissed,
--       created: [{ index, botId }] }. Só mensagem do bot tem; quem decide é o usuário, pela API.
--
-- Nada aqui usa expressão regular.

alter table runs drop constraint runs_origin_check;
alter table runs add constraint runs_origin_check
  check (origin in ('user', 'routine', 'delegation', 'proactive', 'reception'));

drop index runs_one_active_user_run_per_conversation_idx;
create unique index runs_one_active_user_run_per_conversation_idx on runs (conversation_id)
  where conversation_id is not null
    and origin in ('user', 'reception')
    and status in ('queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_timer');

alter table conversations add column reception text not null default 'pending'
  check (reception in ('pending', 'started', 'done', 'redo'));
update conversations set reception = 'done'
  where kind = 'group' or exists (select 1 from messages m where m.conversation_id = conversations.id);

alter table messages add column team jsonb
  check (team is null or (jsonb_typeof(team) = 'object' and author_kind = 'bot'));
