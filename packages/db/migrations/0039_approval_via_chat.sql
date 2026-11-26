-- 0039_approval_via_chat: aprovar um cartão escrevendo no chat (KOD-33).
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- Com UM cartão esperando, se o usuário escreve no chat, o revisor lê o cartão e o texto e diz se é um
-- sim claro àquele cartão. Se for, vale como o clique: a mesma `decideApproval`, só que a linha guarda
-- COMO foi decidido, para o app desenhar "Aprovado pelo chat" e para o replay não depender de modelo
-- (docs/APROVACOES.md, "Aprovar pelo chat"):
--
--   * approvals.decided_via: `click` (o botão ou a API) ou `chat`; nulo enquanto pendente e quando a
--     decisão não é do usuário (cancelada, expirada);
--   * approvals.decided_message_id: a mensagem do usuário que aprovou (só com `chat`);
--   * approvals.chat_review: o que o revisor disse (resposta, motivo, modelo, versão do prompt, uso e
--     custo): o loop grava isso no `approval_decided` e soma o custo na execução.
--
-- Nada aqui usa expressão regular.

alter table approvals
  add column decided_via text check (decided_via is null or decided_via in ('click', 'chat')),
  add column decided_message_id uuid references messages (id) on delete set null,
  add column chat_review jsonb,
  add constraint approvals_chat_has_message
    check (decided_via is distinct from 'chat' or chat_review is not null);
