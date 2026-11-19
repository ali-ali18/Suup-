-- 0004_conversation_runs_and_dedupe: uma execução em primeiro plano por conversa, mensagens que
-- chegam com a execução em andamento, e escritas que não se repetem.
-- Cada arquivo roda dentro de uma transação aberta pelo runner: não use BEGIN/COMMIT aqui.
--
-- O que o banco garante e o que fica no código (src/conversation-runs.ts, messages.ts, memories.ts):
--   no banco:  no máximo uma execução de usuário ativa por conversa, no máximo uma mensagem por
--              (conversa, chave de deduplicação) e no máximo uma entrada de diário por execução.
--   no código: decidir se a mensagem abre uma execução ou entra na que está ativa (feito sob a trava
--              da linha da conversa, na mesma transação); o texto de cada mensagem.

-- Uma execução em primeiro plano por conversa (seção 4.15 do plano). "Ativa" é qualquer estado que
-- não seja final: a fila, rodando, esperando o usuário ou esperando aprovação. Só vale para
-- execuções abertas pelo usuário: rotinas e tarefas delegadas rodam em segundo plano, em paralelo.
-- Quem decide é o código (sendConversationMessage trava a conversa e olha a execução ativa); este
-- índice garante o invariante mesmo se outro caminho tentar criar a segunda execução.
create unique index runs_one_active_user_run_per_conversation_idx on runs (conversation_id)
  where conversation_id is not null
    and origin = 'user'
    and status in ('queued', 'running', 'waiting_user', 'waiting_approval');

-- Chave de deduplicação de mensagens escritas pelo harness (a resposta do bot ao fim de uma
-- execução, o aviso de falha...): repetir a escrita (retomada, reentrega, outro worker) devolve a
-- mensagem que já existe. Mensagens do usuário não têm chave.
alter table messages add column dedupe_key text;
create unique index messages_dedupe_idx on messages (conversation_id, dedupe_key)
  where dedupe_key is not null;

-- Mensagem do usuário enviada com o bot trabalhando: o item da caixa de entrada aponta para ela,
-- e o evento que entrega o item (user_message, resposta a escalate) a marca como 'delivered' na
-- mesma transação em que é gravado.
alter table run_inbox add column message_id uuid references messages (id);
create index run_inbox_message_idx on run_inbox (message_id) where message_id is not null;

-- O diário tem uma entrada por execução: o runtime a grava ao fim de cada execução, e a chave é
-- a própria execução.
create unique index memories_journal_run_idx on memories (source_run_id)
  where layer = 'journal' and source_run_id is not null;
