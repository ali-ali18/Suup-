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
- **Parar**: `POST /v1/tasks/{id}/stop` é o cancelamento de sempre de uma execução. Para o **bot do chat** não há ferramenta `stop_task`: pela decisão 5 da pesquisa ("para" encerra), um pedido de parar entra na tarefa pelo mesmo `send_to_task` (com o `messageId` da mensagem do usuário) e ela encerra no próximo ponto seguro; o bot só diz que parou se o `send_to_task` deu certo.

## O que o bot do chat sabe das tarefas (bateria com modelo real, 26/11/2026)

O bot do chat nunca conhecia o id de uma tarefa aberta antes (só o resultado de `start_task`, que não está numa execução de chat posterior): não conseguia usar `send_to_task`, abria tarefas duplicadas ou inventava um id. Agora uma execução de chat do usuário recebe, na seção por execução do prompt ("## Tasks", fora do prefixo em cache), **as tarefas deste chat**: id, nome e estado (trabalhando, esperando a resposta do usuário, esperando a aprovação, e as **encerradas** nas últimas 24 horas, no máximo 5, marcadas "ENDED"). Vêm do banco (`openTasksOf`, `listTasks` da conversa) e ficam gravadas em `context_loaded.openTasks`, como `recentUserMessages`, então a retomada e o replay leem a mesma coisa. Uma execução de tarefa não recebe a lista. O texto diz ao bot: para acrescentar algo a uma tarefa em andamento, `send_to_task` com o id (e o `messageId` quando for a fala do usuário); para parar, o mesmo; nunca abrir uma segunda tarefa para um trabalho que uma aberta já cobre; nunca dizer que mudou ou parou uma tarefa sem o `send_to_task` ter dado certo.

**Quando abrir uma tarefa**: a descrição de `start_task` traz o critério (trabalho fechado, de muitos passos, que devolve um resultado: pesquisar em várias fontes, revisar uma pasta ou documento longo, implementar com vários arquivos e testes, analisar um conjunto de dados a fundo, navegar por várias páginas, escrever um documento com várias seções; faixa de esforço: mais de uns 5 usos de ferramenta ou cerca de um minuto, decidido **antes** da primeira chamada, mesmo com terminal ou arquivos à mão), o contrário (pedido rápido, até uns 5 usos de ferramenta, ou que precisa de vai e volta a cada passo); com **vários pedidos** numa mensagem, uma tarefa por pedido longo e os rápidos respondidos no chat, exemplos dos dois lados e "se falta uma ferramenta que o trabalho precisa, só abra a tarefa se ela mesma puder fazer; senão diga o que falta". Quem decide é o modelo; a estrutura só impõe os limites. Nada de regex nem de palavras-chave.

## O freio cedo e a conferência no fim (ligados por padrão)

Ninguém aperta botão para virar tarefa: quem decide é o bot e, se ele não decidir, o harness. As duas checagens só valem numa execução de **chat do usuário** e ficam em `defaults.tasks` da configuração. Os dois vêm ligados; `enabled: false` desliga cada um (decisão do dono, 26/11/2026, depois do eval).

- **Freio cedo** (`handoff`: `enabled`, `atTurns` padrão 5, `atSeconds` padrão 60): no ponto seguro antes de uma chamada ao modelo, se a execução do chat já passou de N chamadas ou de N segundos de trabalho **sem ter aberto tarefa**, o harness abre uma tarefa do mesmo bot com as mensagens do usuário daquela execução (`userMessagesOfRun`) e o que já foi feito (as últimas chamadas, "não repita uma escrita que já deu certo"), e o chat termina com uma frase fixa dizendo o nome da tarefa. Decide por contagem, nunca lendo texto. Gravado como `handed_off` (aberta ou recusada, com o motivo); uma recusa (limite de tarefas) deixa o chat seguir.
- **Conferência no fim** (`askCheck`: `enabled`, `model`, padrão o juiz do vigia ou o do auto-review; sem nenhum desses modelos ela não roda): antes de a execução do chat terminar com a resposta, um modelo barato lista os pedidos da mensagem e diz quais não foram respondidos nem viraram tarefa. Com algum de fora, o bot é avisado **uma vez**, pelo nome do pedido, e segue. Falha do modelo nunca segura a resposta. Gravado como `asks_checked`.

Medição: `suup eval chat-tasks` ([EVAL-CHAT-TAREFAS.md](EVAL-CHAT-TAREFAS.md)) compara a variante A (só a descrição e o prompt reforçados) com a B (os dois ligados).

## Aprovações

O cartão de uma ação da tarefa pertence ao **chat que a pediu** (`approval.conversationId`) e é decidido do jeito normal; o app põe o nome da tarefa acima dele. Ver [APROVACOES.md](APROVACOES.md).

## Eventos

`task.changed` no stream (`created` ou `updated`): a tarefa inteira, com o estado atual. Sai quando a tarefa nasce, quando a situação da execução muda, quando o resultado é entregue e quando a conversa da tarefa recebe mensagem ou tem a leitura movida.

## Respostas novas (decisão do dono, 26/11/2026)

O servidor guarda até onde a pessoa leu cada tarefa: é o cursor de leitura que toda conversa já tem (`conversations.last_read_seq`), o da conversa **da própria tarefa** (a migração `0040_tasks.sql` põe o gatilho do diário de mudanças). `Task.unreadReplies` é o número de mensagens do bot nessa conversa depois do cursor (as do usuário e as linhas de evento da execução não contam). Com `unreadReplies > 0` o rótulo do chat diz "· Novas respostas" no azul de não lida (`--color-status-unread`, o da bolinha do avatar) no lugar do estado. Abrir a tela da tarefa chama `POST /v1/tasks/{id}/read` (de novo a cada resposta que chega com a tela aberta) e o rótulo volta ao estado normal. O app só mostra o que o servidor diz.

## O link da tarefa na mensagem (decisão do dono, 26/11/2026)

No fim do balão da mensagem que **abriu** a tarefa e da que **entrega o resultado** o app desenha um link (ícone de balão de conversa só contorno + o nome, sublinhado, na cor do texto) que abre a tela da tarefa. Vem da **estrutura**, nunca do texto do modelo: a tarefa que o servidor ligou à execução do chat (`fromRunId`, as palavras escritas depois de ela abrir) ou ao turno do resultado (`closingRunId`), ambos em `Task`.

## Não existe (de propósito)

Página ou aba de Tarefas (KOD-66), botão de parar na tela da tarefa, propostas 1 a 11 da pesquisa que não coincidem com o acima.
