# Tarefas em segundo plano (KOD-68)

O bot responde rápido no chat e manda o **trabalho longo** para uma **tarefa**: uma execução do **mesmo bot**, em segundo plano, numa conversa própria. O chat fica livre enquanto ela trabalha. Pesquisa: [pesquisas/kod-68-tarefas.md](pesquisas/kod-68-tarefas.md). A interface está em [DESIGN.md](DESIGN.md), "Tarefas"; a API, em [API.md](API.md).

## O que é

- Tabela `tasks` (migração 0040): bot, o chat que pediu (`conversation_id`), a execução do chat que abriu (`from_run_id`), a execução da tarefa (`run_id`), a conversa da tarefa (`task_conversation_id`, tipo `task`), título, pedido (`brief`), ids das mensagens do usuário citadas, `closing_run_id` e `closed_at` (a entrega do resultado).
- A execução da tarefa tem origem `task` e **fica fora do índice** de uma execução ativa por conversa: o chat segue aceitando mensagens e abrindo execuções normais. A conversa `task` não aparece na lista de conversas e não recebe mensagem pelo chat.
- **O estado é o da execução**, nunca copiado: trabalhando (fila, rodando, esperando um retorno), esperando resposta, esperando aprovação, concluída, não concluída, parada (`taskStateOf`, `GET /v1/tasks`).

## Como o bot abre uma tarefa

Ferramenta `start_task` (só em execução de **chat** do usuário; nunca dentro de uma tarefa nem no turno que entrega o resultado). A descrição dela traz o critério: pergunta, resumo, rascunho curto ou consulta → responde no chat; implementar, revisar, pesquisar em muitas fontes, navegar num site → tarefa. Argumentos: `title` (o nome que o usuário vê), `objective`, `known`, `deliver`, `scope` (o pedido) e `userMessageIds`.

Limites no código (`createTask`), não no prompt: no máximo **3 tarefas abertas por bot**; uma tarefa **não abre outra**; cada id citado precisa ser **mensagem do usuário do mesmo chat**. Recusas voltam como frase dizendo para não tentar de novo. A mesma tarefa (mesma execução, título e pedido) duas vezes é uma só. A ferramenta volta na hora.

## O que a tarefa vê

Só o **pedido** (o objetivo da execução) e as **mensagens do usuário citadas**, copiadas do banco pelo id (`taskStartContext`), nunca reescritas pelo modelo. Sem histórico da conversa. O bot do chat vê os ids das últimas 8 mensagens do usuário (`context_loaded.recentUserMessages`) para citar.

## Quando termina

`finishRun` chama `deliverTaskResult`: abre um turno curto do bot **no chat que pediu** (origem `task_result`, a execução em primeiro plano do chat), cujo objetivo é o relatório da tarefa **como dado externo** (`wrapUntrusted`), marcado como relatório de tarefa e sem autoridade do usuário. O bot responde em poucas linhas; o detalhe fica na conversa da tarefa.

- **Idempotente**: `openTaskResult` trava o chat e a linha da tarefa e grava `closing_run_id` e `closed_at` na mesma transação.
- **Chat ocupado**: se o chat tem uma execução ativa, **nada é aberto**; quando ela termina, `finishRun` entrega os relatórios que esperavam (`deliverPendingTaskResults`). Uma pergunta aberta que espera o usuário segura a entrega até ele responder.
- **Queda**: `reconcileRunEffects` entrega o que faltou (tarefa terminada sem `closed_at`).
- **Parada pelo usuário**: não abre turno nenhum; só marca `closed_at`.

## Mensagens para a tarefa

- Resposta escrita na **tela da tarefa**: `POST /v1/tasks/{id}/messages` vai direto para a caixa da execução da tarefa (o id da tarefa escolhe a execução). Lida no próximo ponto seguro; uma tarefa que perguntou e espera é retomada.
- No **chat principal**: ferramenta `send_to_task(taskId, messageId | text)`. Com `messageId`, o texto é o da mensagem do usuário, copiado do banco; com `text`, são palavras do bot e a tarefa é avisada de que não foram digitadas pelo usuário. Só tarefa pedida **naquele chat**.
- **Parar**: `POST /v1/tasks/{id}/stop` é o cancelamento de sempre de uma execução.

## Aprovações

O cartão de uma ação da tarefa pertence ao **chat que a pediu** (`approval.conversationId`) e é decidido do jeito normal; o app põe o nome da tarefa acima dele. Ver [APROVACOES.md](APROVACOES.md).

## Eventos

`task.changed` no stream (`created` ou `updated`): a tarefa inteira, com o estado atual. Sai quando a tarefa nasce, quando a situação da execução muda e quando o resultado é entregue.

## Não existe (de propósito)

Página ou aba de Tarefas (KOD-66), botão de parar na tela da tarefa, propostas 1 a 11 da pesquisa que não coincidem com o acima.
