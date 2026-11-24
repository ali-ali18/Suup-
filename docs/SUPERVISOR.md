# O Principal como supervisor da equipe

Decisões do dono (21/11/2026) sobre o bot principal (o bot marcado como padrão, com uma estrela no avatar). Pesquisa que embasa o desenho: [pesquisas/fase-4-supervisor-e-delegacao.md](pesquisas/fase-4-supervisor-e-delegacao.md). Os outros bots continuam conversando direto com o usuário e fazendo o próprio trabalho; o Principal **sabe** o que foi feito porque lê, e **passa** trabalho quando o usuário pede.

## Revisão noturna ("uma vez por noite ele vê o que foi realizado nos outros e lembra")

Um job do worker (`team-review`, a cada 60 s olha o relógio) roda `runNightlyReview` (`packages/runtime/src/supervisor.ts`).

- **Quando.** Ligada por padrão; a partir das **03:00** no fuso do usuário (`defaults.timeZone`). A "noite" é a data local em que a revisão roda. O banco permite **uma revisão viva por noite** (índice único em `team_reviews`), então qualquer número de workers pode chamar; um worker que parou perde a noite depois da posse (10 min) e a noite é tentada de novo (pausa de 30 min, no máximo 3 tentativas).
- **Só se houve atividade** nos outros bots desde a última revisão (entrada de diário, nota, ou execução que mudou). Sem atividade, a noite é registrada como `skipped` e o modelo não é chamado.
- **O que lê (só leitura, por coluna do banco):** as entradas do diário dos outros bots (o que o próprio bot escreveu sobre cada execução), as notas deles, e o que está em aberto (execuções esperando o usuário, uma aprovação ou um retorno agendado; execuções paradas há mais de 6 h), mais as notas que o Principal já tem sobre a equipe. **Nunca** saída de ferramenta, página lida, e-mail, saída de conector, nem o texto das conversas (a pesquisa: o OpenClaw exclui "Tool output, web content, and non-owner turns"; é a defesa contra envenenamento). O conteúdo entra no pedido como dado, e o prompt diz que não é instrução.
- **O que escreve:** **só** notas na memória do **próprio Principal** (camada `note`, sem duplicar, nada que o usuário recusou) e o texto da mensagem da manhã. O modelo não tem ferramenta nenhuma além da que responde (`submit_team_review`). Uma falha não grava nada e os cursores não andam.
- **Modelo:** o do Principal. Uma chamada, forçada. (Não é uma execução do laço: não há ferramentas para a revisão usar, e isso é o que garante a leitura limitada. Por isso não há origem de execução `review`; o registro é `team_reviews`.)
- **Teto de custo:** ajustável, **padrão sem teto** ("muitas vezes colocar um teto trava o bot"). Com teto, antes da chamada o pedido é estimado e os bots que não cabem ficam **para a próxima noite** (o cursor deles não anda); a revisão registra quem ficou (`leftOver`, `capReached`). O custo de cada noite fica em `team_reviews.cost_usd` e na tela.
- **Cursor por bot** (`team_review_cursors`): só avança para os bots lidos; a janela tem no máximo 7 dias.

## Mensagem da manhã

À hora configurada (padrão **08:00**, no fuso do usuário), se a revisão **da data de hoje** achou algo útil (o modelo devolve `morning_message` ou `null`; a maioria das noites deve ser `null`), o Principal posta **uma** mensagem curta no chat dele. Nada se não houver. Só pelos mecanismos que já existem (mensagem nova, não lida): sem notificação nova. Reclamar e postar são uma transação, com chave na mensagem: uma vez, mesmo com vários workers ou queda. Não posta se o chat ainda não existe ou a recepção dele ainda não terminou (a mensagem nunca toma o lugar da recepção).

## Ler a memória dos outros durante o dia: `team_recall`

Só o Principal (e só numa execução normal) tem. Entrada: `{bot, query?, days?, limit?}`. Devolve as notas e o diário daquele bot, as contagens de execuções concluídas e falhas, e o que está em aberto. **Somente leitura** (decisão do dono: "Somente ler!"): a ferramenta e a função que ela chama só fazem `select`; `remember` e `forget` continuam atuando só na memória de quem chama. As regras do usuário não saem por aqui. A saída é marcada como texto de fora (`untrusted`): uma escrita que o Principal fizer depois passa pelo revisor de escrita de memória.

## Delegar: `delegate`

Só o Principal tem (e uma execução delegada **não** o recebe: profundidade 1; `createDelegation` recusa de novo no código). Entrada: `{bot, objective, acceptanceCriteria[], context?}` (o contrato da pesquisa: objetivo, critérios, contexto explícito; o bot de destino não vê a conversa do Principal).

- Cria uma execução de origem `delegation` na **conversa direta do bot de destino**, com um aviso do sistema para o usuário ("… passou esta tarefa para Tutor: …"). Ela é a execução em primeiro plano daquele chat: se o bot perguntar algo, a resposta do usuário vai para ela.
- **Assíncrono:** a ferramenta volta na hora; o Principal diz ao usuário que delegou. Quando a execução delegada termina (concluída, falhou ou cancelada), um resumo curto vai **uma vez** para o chat do Principal (`returnDelegatedResult`, chamado por `finishRun`, derivado da execução gravada, e refeito por `reconcileRunEffects` depois de uma queda; chave `delegation:<id>:result`).
- O bot de destino mantém **as próprias ferramentas, concessões e aprovações**: os cartões vão para o usuário, e ninguém aprova em nome dele (não existe ferramenta de aprovar). O custo é da execução delegada.
- Limites: no máximo **3** delegações abertas; recusa bot arquivado, o próprio Principal e um bot que está no meio de uma conversa (já tem execução ativa no chat). A mesma delegação (mesma execução, bot e objetivo) duas vezes é uma só.
- Se a execução delegada pergunta algo ao usuário, ela fica `waiting_user` no chat do bot de destino e o resultado só volta quando ela termina.

## O que o modelo é dito (prompt)

Bloco "Your team" do Principal (`SUPERVISOR_PROMPT`): é o supervisor; lê a memória dos outros só para ler (`team_recall`); delega a pedido, com objetivo, critérios e contexto, avisa o usuário e não espera; faz a revisão noturna e pode deixar uma mensagem de manhã. Dos outros bots (`SUPERVISED_PROMPT`): o Principal pode delegar uma tarefa a você (chega como tarefa no chat) e lê seu diário e suas notas à noite, só leitura. O papel entra no `context_loaded` (`supervisor`: `principal` ou `member`), então a repetição é a mesma.

## Configurações e API

`GET`/`PATCH /v1/supervisor/settings` (`reviewEnabled`, `reviewTime`, `morningTime` ou `null`, `costCapUsd` ou `null`, mais `timeZone` e o estado do modelo) e `GET /v1/supervisor/reviews` (o histórico). No app: Configurações > Memória > "Principal" e "Revisões da equipe" ([DESIGN.md](DESIGN.md)). A estrela no avatar do Principal vem de `bot.isDefault`.

## O que ainda não existe

Delegar a mais de um nível; devolver ao Principal a pergunta que o bot delegado faz ao usuário; revisão que lê o texto das conversas; proteção de segredos nos diários (sem detecção por padrão, [MEMORIA.md](MEMORIA.md)): a defesa é estrutural, a revisão não lê ferramentas nem mensagens de terceiros.
