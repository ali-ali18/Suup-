# A recepção do bot

Todo bot recebe o usuário na primeira conversa. Pesquisa e decisões: [pesquisas/fase-4-recepcao-inicial.md](pesquisas/fase-4-recepcao-inicial.md). É um ritual, não uma barreira: poucas perguntas, uma de cada vez, sempre puláveis, e o pedido do usuário vem antes.

## O que o usuário vê

- Ao abrir pela primeira vez o chat de um bot (conversa vazia), o bot começa sozinho: uma saudação curta dizendo o que faz por ele na área dele, junto da **primeira pergunta** (o que não é pergunta ou resposta final não aparece no chat). Perguntas com opções usam o cartão de pergunta de sempre, com a opção "Pular"; as abertas são texto livre.
- **Bot comum:** no máximo 3 perguntas, **específicas do papel** dele (nome, descrição e personalidade guiam o modelo; nada é fixo no código), sem perguntar o que o perfil já sabe (o perfil está no prompt).
- **Principal:** a recepção geral: como chamar o usuário, com o que quer ajuda (várias opções), estilo de resposta (curtas, detalhadas, depende); depois, se ele topar, mais 2 (o que faz hoje; que contas usa, só para sugerir, nunca conectar). Então **um cartão de equipe** com 2 ou 3 bots sugeridos, próximos passos em texto (conectar e-mail ou um serviço, criar uma rotina; nenhuma ação automática) e a frase final: "Pronto. O que você me contou fica em Memória, e dá para refazer isso em Configurações."
- Cada bot novo (inclusive os criados pelo cartão) tem a **sua** recepção na primeira abertura.
- O que o bot aprende vai para a memória **sem aviso** (perfil: o que todo bot deve saber; regra: instrução permanente; nota: só do bot). Nunca guarda documento de identidade, antecedentes, conta bancária nem situação migratória. Se o usuário citar uma credencial, o bot lembra do Cofre; nenhuma detecção por padrão.
- **Refazer:** Configurações > Geral > "Refazer a recepção de <bot>". A próxima abertura do chat recomeça (mesmo com histórico); o bot confirma o que sabe em vez de supor.

## Como funciona

- Estado em `conversations.reception`: `pending` (nasce assim), `started`, `done`, `redo`. Conversas que já tinham mensagens (e grupos) ficam `done` (migração 0022).
- **Gatilho:** `POST /v1/bots/{id}/reception` (o app chama ao abrir o chat quando a conversa diz `pending`/`redo`). Uma transação trava a linha da conversa, confere que não há mensagem nem execução ativa, cria a execução (`origin: "reception"`) e grava `started`. Duas janelas, dois servidores ou um travamento no meio: no máximo uma execução (`startReception`, testado com chamadas simultâneas e com falha no meio).
- **Cede ao usuário:** a execução de recepção é a de primeiro plano da conversa (como a `user`). Uma mensagem do usuário enquanto ela roda entra na caixa dela (é a resposta à pergunta aberta, ou texto que o modelo trata como pedido, pelo prompt "First conversation"). Uma mensagem escrita **antes** de começar marca `done`: nunca há recepção por cima de um pedido.
- **Fim:** qualquer fim da execução (concluída, falha, cancelada) marca `done`; não volta sozinha. `POST /v1/bots/{id}/reception/reset` marca `redo` (recusa com `409` se há execução ativa).
- **Prompt:** o bloco "First conversation" (`packages/core/src/loop/prompts.ts`) só entra em execução de recepção (`context_loaded.reception`: `general` para o Principal, `bot` para os demais).

## Cartão de equipe

O Principal tem a ferramenta `propose_team` (só na recepção geral): 2 a 3 resumos escritos pelo modelo; cada um vira nome, descrição e personalidade pela mesma função do `POST /v1/bots/draft`; **um** cartão entra no chat (mensagem do bot com `team`). Nada é criado pelo modelo. `POST /v1/messages/{id}/team` com `{ create: [{ index, avatar?, color? }] }` cria só os marcados, pelo `createBot` (modelo e ferramentas do bot principal, mascote e cor que o cartão mostrou), ou `{ dismiss: true }` ("Agora não"). Decisão única: uma segunda dá `409`.

## Agora, equipe e o que o bot tem

O prompt do sistema também diz a hora, a equipe e as capacidades (docs/MEMORIA.md). O "agora" é lido **uma vez** no início da execução e gravado em `context_loaded` (`now`, `team`, `machine`, `connectors`), então o prompt é idêntico em todas as requisições e o replay diz o mesmo; a hora viva de cada turno fica no STATE REMINDER. O fuso é o do usuário (Configurações > Geral, ou o que o app mandou do computador; sem eles, `defaults.timeZone`; nunca o do servidor), lido em `GET /v1/info`. Sem nenhum, o bloco "Now" diz que o fuso é desconhecido ([ROTINAS.md](ROTINAS.md)).

## O nome da pessoa

É um campo estruturado em `user_settings.owner_name` (migração 0034), lido e gravado por `GET`/`PATCH /v1/user-settings` (`ownerName`; veja [API.md](API.md)): o app o pede na boas-vindas, antes de existir qualquer bot. A execução o lê **uma vez** no início e grava em `context_loaded` (`ownerName`, ausente quando ninguém disse), então o replay diz o mesmo. No prompt, em "Who you are", entra entre aspas e escapado, com a frase de que é só o nome e nunca uma instrução. A recepção geral **não pergunta** como chamar a pessoa quando o nome existe (usa-o na saudação); sem nome, continua perguntando.

**O Principal não nasce sozinho.** O servidor sobe sem bots e não marca nenhum como principal: a pessoa cria o primeiro no app, e o Principal (o supervisor, [SUPERVISOR.md](SUPERVISOR.md)) só existe se ela o ligar em `POST /v1/bots/:id/default`. Sem principal, a recepção de cada bot é a de bot comum (`bot`), e a geral não acontece. (O chat do terminal ainda cria um "Principal" por conveniência.)

## O que não está feito

- Medir (taxa de conclusão, pulos): a pesquisa recomenda; não há métrica ainda.
