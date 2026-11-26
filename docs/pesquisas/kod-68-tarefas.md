# Pesquisa: tarefas em segundo plano do próprio bot (KOD-68)

Data: 26/11/2026. Card: KOD-68 ("responder rápido no chat e mandar o trabalho longo para uma tarefa"). Pesquisa anterior que esta complementa, sem repetir: [fase-4-supervisor-e-delegacao.md](fase-4-supervisor-e-delegacao.md) (21/11/2026), que já cobre o artigo multiagente da Anthropic, os subagentes do Claude Code, os handoffs da OpenAI e o supervisor do LangGraph para o caso **entre bots** (`delegate`). Aqui o caso é outro: o **mesmo** bot abre uma execução separada para o trabalho longo e continua livre no chat.

## Pergunta

Como produtos e especificações atuais decidem entre responder agora e mandar para uma tarefa, o que vai no pedido da tarefa, como o resultado volta, o que acontece com uma mensagem nova enquanto a tarefa roda, e que problemas eles relatam? Para cada ponto: o que muda no plano do KOD-68.

## Decisões do dono que esta pesquisa não reabre

1. A tarefa é uma execução do **mesmo** bot, fora da regra de uma execução ativa por conversa.
2. O bot decide pela ferramenta `start_task`. No máximo 3 tarefas abertas por bot; uma tarefa não abre outra.
3. A tarefa recebe só o pedido do bot (objetivo, o que já se sabe, o que devolver, até onde ir) e as mensagens do usuário copiadas do banco pelo id, sem reescrita.
4. No fim, um turno curto do bot no chat confere o resultado e responde em poucas linhas.
5. Mensagem nova entra na tarefa no próximo ponto seguro ("para" encerra). Resposta escrita na tela da tarefa vai direto para ela; escrita no chat principal, o bot repassa por `send_to_task`.
6. Os cartões de aprovação da tarefa aparecem no chat onde o pedido foi feito, com o nome da tarefa.
7. Interface: rótulo "↳ nome da tarefa · estado" no chat; tocar abre a conversa da tarefa (título, estado, número de atualizações, caixa "Adicione uma resposta").
8. O KOD-68 vem antes do KOD-66.

Quando uma fonte contradiz o plano, esta pesquisa diz isso e **propõe** a mudança; nada é aplicado aqui.

## Fontes

Todas lidas em 26/11/2026, pela página da própria fonte. Nenhuma foi lida só por resumo de buscador.

1. **Anthropic, "How we built our multi-agent research system"**: https://www.anthropic.com/engineering/multi-agent-research-system (redireciona para `/research/multi-agent-research-system`; publicado em 13/06/2025, atualizado em 09/10/2026). Como o sistema de pesquisa deles divide o trabalho entre um agente líder e subagentes em paralelo: custo em tokens, regras de esforço no prompt, o que vai no pedido do subagente, por que o modo síncrono trava e como a saída volta por arquivo em vez de passar de agente em agente.
2. **Cognition, "Don't Build Multi-Agents"** (Walden Yan, 12/06/2025): https://cognition.ai/blog/dont-build-multi-agents (redireciona para cognition.com). Argumento contra agentes paralelos: compartilhar o contexto inteiro, porque toda ação carrega decisões implícitas e decisões em conflito dão resultado ruim. O padrão recomendado é um agente linear; para tarefas longas, um modelo que comprime o histórico.
3. **Claude Code, "Create custom subagents"**: https://code.claude.com/docs/en/sub-agents. Como o agente principal decide delegar (pela descrição do subagente), quando ficar na conversa principal, subagentes em segundo plano, aprovações que aparecem na sessão principal com o nome do subagente, aviso de conclusão num turno seguinte, limites de profundidade e de quantidade, mensagens no meio da tarefa.
4. **Claude Agent SDK, "Subagents in the SDK"**: https://code.claude.com/docs/en/agent-sdk/subagents. O que passa do pai para o subagente (só o texto do pedido), como volta o relatório, execução em segundo plano por padrão, tetos de profundidade, quantidade e gasto, e o aviso de que instrução no prompt só orienta e o limite tem que ser configurado.
5. **OpenAI Agents SDK, "Handoffs"**: https://openai.github.io/openai-agents-python/handoffs/. Handoff é uma ferramenta; por padrão o agente novo vê o histórico inteiro, com filtros e um resumo opcional (`nest_handoff_history`) para mudar isso.
6. **OpenAI Agents SDK, "Agent orchestration"**: https://openai.github.io/openai-agents-python/multi_agent/. Agente como ferramenta (o gerente mantém o controle) versus handoff (o especialista assume), e orquestração pelo modelo versus pelo código, que é mais previsível em tempo, custo e qualidade.
7. **OpenAI Agents SDK, "Tools", seção "Agents as tools"**: https://openai.github.io/openai-agents-python/tools/. O agente aninhado não herda a conversa do pai; entrada estruturada por esquema; `custom_output_extractor` para validar e recortar o que volta; `needs_approval` pausa a execução; `is_enabled` esconde a ferramenta do modelo conforme o estado.
8. **OpenAI, "Background mode"**: https://platform.openai.com/docs/guides/background (redireciona para developers.openai.com). Resposta longa com `background: true`: estados `queued` e `in_progress`, consulta periódica ou webhook (`response.completed`, deduplicado pelo id do webhook), cancelamento idempotente, retomada do streaming pelo número de sequência.
9. **OpenAI, "Mid-turn steering"**: https://developers.openai.com/api/docs/guides/steering. Entrada nova no meio de um turno: fica na fila, o servidor termina o item de saída e a ferramenta em andamento, e continua com a entrada nova. Não desfaz nada já feito. Se o turno espera resultado de ferramenta ou aprovação, a entrada fica pendente.
10. **LangSmith, "Double texting"**: https://docs.langchain.com/langsmith/double-texting. As quatro políticas para mensagem nova com execução em andamento: enqueue (padrão), reject, interrupt e rollback. É recurso do Agent Server, não do LangGraph aberto.
11. **LangSmith, "How to kick off background runs"**: https://docs.langchain.com/langsmith/background-run. Execução em segundo plano numa thread: criar, consultar o estado (`pending`, depois `success`), `join` para esperar, e ler o estado final da thread.
12. **A2A Protocol, especificação** (versão publicada 1.0.0): https://a2a-protocol.org/latest/specification/. Seções lidas: 3.3.3 (processamento assíncrono), 3.4 (`contextId` e `taskId` em várias trocas), 3.5 (consulta, streaming e push), 4.1.3 (estados da tarefa, inclusive `input-required` e `auth-required`), 7.6 (autorização dentro da tarefa).

Não lidas: **Google ADK** (opcional no pedido; ficou de fora por tempo). Um rascunho anterior desta pesquisa não abriu OpenAI, LangGraph e Cognition por bloqueio de rede; desta vez todas abriram e foram lidas.

## Respostas

Cada resposta separa **fato** (dito pela fonte, com o número da fonte) de **inferência** (conclusão desta pesquisa, marcada como tal).

### a) Responder agora ou mandar para uma tarefa: quem decide e com que critério

**Fatos.**

- No Claude Code, o agente principal decide delegar pela **descrição** do subagente, pelo pedido e pelo contexto; escrever "use proactively" na descrição incentiva a delegação (3). No SDK, `description` é obrigatória e diz "quando usar este agente" (4).
- O Claude Code tem uma lista explícita de quando **não** delegar: troca frequente com o usuário, contexto compartilhado entre fases, mudança rápida, ou quando a latência importa, porque um subagente novo precisa de tempo para juntar contexto. Delegar serve para saída volumosa, ferramentas restritas ou trabalho fechado em si que devolve um resumo (3).
- A Anthropic diz que o modelo erra a escala sozinho: no começo, o sistema abria 50 subagentes para perguntas simples. A correção foi pôr no prompt regras de esforço com números (pergunta simples: 1 agente, 3 a 10 chamadas; comparação: 2 a 4 subagentes; pesquisa complexa: mais de 10) e cuidar das descrições das ferramentas (1).
- O SDK avisa que um modelo mais novo da mesma linha delega com mais facilidade, que instrução no prompt só orienta, e que os limites (profundidade, quantidade, gasto) têm que ser configurados (4). Quando o modelo não delega, a orientação é nomear o agente e escrever uma descrição clara (4).
- A OpenAI separa orquestração pelo modelo da orquestração pelo código e diz que a do código é mais previsível em tempo, custo e qualidade (6). `is_enabled` esconde uma ferramenta do modelo conforme o estado da execução (7).
- A Cognition defende um agente linear como padrão e mostra o caso em que subagentes em paralelo entendem a tarefa de jeitos diferentes (2).

**Onde os critérios falham (fatos).** Delegação demais para pedidos simples (1); delegação de menos quando a descrição é vaga (4); o subagente demora para juntar contexto (3); partes paralelas tomam decisões que não combinam (2).

**Inferência.** Ninguém resolve isso só com o modelo. Todos combinam três coisas: critério escrito na descrição da ferramenta, exemplos com números no prompt e um limite que o código garante. A decisão 2 (o bot decide por `start_task`) está alinhada, desde que venha com os três.

### b) O que vai no pedido da tarefa para ela trabalhar sem ver a conversa

**Fatos.**

- A Anthropic pede, para cada subagente, objetivo, formato de saída, orientação sobre ferramentas e fontes, e limites claros da tarefa. Pedidos vagos deram trabalho duplicado e lacunas (o exemplo dos semicondutores, em que dois subagentes pesquisaram a mesma coisa) (1).
- No SDK, a única coisa que passa do pai para o subagente é o texto do pedido; caminhos de arquivo, erros e decisões têm que estar nele (4). No Claude Code, o subagente começa do zero, com o prompt dele, o texto do pedido, o CLAUDE.md e o estado do git; regras que precisam chegar a ele vão no pedido (3).
- Na OpenAI, o handoff passa o histórico inteiro por padrão, e há filtro e resumo para mudar isso; o resumo aninhado não remove dados sensíveis (5). O agente como ferramenta não herda a conversa do pai e aceita entrada com esquema (7).
- A Cognition prefere passar o rastro inteiro, não só mensagens soltas, porque as decisões implícitas se perdem no resumo (2).

**Inferência.** A decisão 3 fica entre os dois extremos: não passa o histórico (como a OpenAI por padrão), mas também não depende só do texto do bot (como o SDK), porque copia as mensagens do usuário pelo id. Isso evita o "telefone sem fio" nas palavras do usuário. O que a Cognition aponta e o plano ainda não cobre: as **decisões já tomadas** na conversa e as **outras tarefas abertas**. Ver mudanças 2 e 3.

### c) Como o resultado volta e como é resumido

**Fatos.**

- No Claude Code, o resultado de um subagente em segundo plano chega como um aviso de conclusão num turno seguinte; se o usuário pergunta antes, o agente diz que ainda está rodando (3). O relatório final vem marcado como saída de subagente, sem autoridade (3).
- No SDK, a ferramenta volta na hora com `status: "async_launched"` e o relatório chega depois; o pai pode resumir o relatório, e para mantê-lo inteiro é preciso pedir isso no prompt (4).
- A Anthropic grava a saída dos subagentes em arquivo e passa só uma referência leve ao líder, para não perder detalhe de mão em mão (1).
- A OpenAI permite validar e recortar o que volta (`custom_output_extractor`), com um valor de reserva quando a resposta vem faltando ou malformada (7). O background mode avisa o fim por webhook, que pode chegar repetido e deve ser deduplicado pelo id (8). A A2A entrega atualizações por consulta, streaming ou push, sempre na ordem em que foram geradas (12, 3.5).
- O LangSmith espera o fim com `join` e lê o estado final da thread (11).

**Inferência.** A decisão 4 (um turno curto do bot confere e responde) é o mesmo desenho do Claude Code e do SDK. Faltam três detalhes: o resultado inteiro tem que ficar na tarefa e o turno do chat recebe o relatório e uma referência, não o rastro; o aviso de fim tem que ser idempotente (como `delegation:<id>:result` em `returnDelegatedResult`); e o bot precisa saber, no chat, quais tarefas estão abertas para responder "e aí, terminou?" sem inventar. Ver mudanças 4 e 5.

### d) Mensagem nova enquanto a tarefa roda

**Fatos.**

- O LangSmith tem quatro políticas: **enqueue** (padrão; a nova roda depois), **reject** (recusa enquanto há uma em andamento), **interrupt** (para, guarda o progresso e insere a entrada nova; é preciso tratar chamadas de ferramenta pela metade) e **rollback** (para, desfaz tudo, inclusive a entrada original, e trata a nova como execução nova) (10).
- O steering da OpenAI põe a entrada na fila, termina o item de saída e a ferramenta já em andamento, e continua; não reescreve o que já saiu, não desfaz ações e não cancela ferramentas iniciadas. Se o turno espera resultado de ferramenta ou aprovação, a entrada fica pendente (`response.steer.pending`). A fila existe só na conexão, então quem envia deve registrar o que enviou (9).
- No Claude Code, com a conversa de um agente aberta, a mensagem do usuário vai para aquele agente e é lida quando o trabalho atual termina (ou antes, com um atalho). Mensagens de quem lançou o agente valem como correção de rumo, **não** como aprovação do usuário (3).
- Na A2A, a mensagem de continuação cita o `taskId`; um `taskId` que não existe dá erro, e `contextId` e `taskId` que não combinam são recusados. Mensagens podem citar tarefas relacionadas em `referenceTaskIds`. Em `input-required`, o cliente continua mandando mensagem com o mesmo `taskId` (12, 3.4).

**Inferência.** A decisão 5 é a política **interrupt sem rollback**, no mesmo ponto em que a OpenAI e o Claude Code inserem a entrada: depois do item e da ferramenta em andamento. O Suup já tem isso: o `run_inbox` entrega no ponto seguro (todo resultado gravado, nenhuma chamada ao modelo em voo; `packages/core/src/loop/inbox.ts` e `safe-point.ts`). Rollback não serve, porque a tarefa pode já ter feito coisas fora do Suup. O risco está no roteamento pelo chat principal: ali quem escolhe a tarefa é o bot (`send_to_task`), e a A2A mostra a alternativa estrutural, que é a mensagem citar a tarefa. Ver mudança 6.

### e) Problemas que os outros relatam

**Fatos.**

- **Custo.** Agentes gastam cerca de 4 vezes os tokens de um chat; sistemas multiagente, cerca de 15 vezes. Só compensa em tarefa de valor alto e muito paralelizável; tarefas que compartilham contexto ou têm muitas dependências não servem, e programação tem menos partes paralelas (1). O SDK tem `maxBudgetUsd`: no teto, recusa abrir subagente, para os que estão em segundo plano e encerra (4). O background mode da OpenAI cobra menos em janelas mais lentas (8).
- **Contexto perdido e trabalho duplicado.** Pedido vago dá trabalho duplicado e lacuna (1). Subagentes em paralelo tomam decisões implícitas que não combinam (2).
- **Erros que se somam.** Um erro no meio de uma tarefa longa se propaga; a Anthropic retoma do ponto em que parou em vez de recomeçar, com salvaguardas determinísticas (1). Assíncrono traz problemas de coordenação de resultado, consistência de estado e propagação de erro (1).
- **Aprovação dentro da tarefa.** No Claude Code, o pedido de permissão de um subagente em segundo plano aparece na sessão principal com o nome do subagente; negar recusa aquela chamada e não para o subagente (3). Na OpenAI, `needs_approval` pausa e a execução retoma depois de aprovar ou recusar (7). Na A2A, a tarefa vai para `auth-required`, deve aceitar mensagens nesse estado (para negociar, corrigir ou recusar) e pode subir o pedido em cadeia (12, 7.6).
- **Limites.** Claude Code: profundidade 3 por padrão e até 20 subagentes ao mesmo tempo; ao bater no limite, o erro diz para não tentar de novo (3).

**Inferência.** O 15× é o número mais citado e vale para o caso **paralelo** da Anthropic. Uma tarefa do KOD-68 é uma execução só, então o custo extra esperado é o da tarefa ter que reconstruir o contexto (o pedido, as mensagens copiadas) mais o turno de fechamento no chat, e não 15×. Esse custo não foi medido; ver "Riscos". As decisões 2 e 6 já seguem o que as fontes fazem sobre profundidade e aprovação.

### f) O que muda no plano

Ver a seção seguinte. Onde uma fonte **contradiz** o plano, está dito.

## Mudanças propostas no plano

Propostas, não aplicadas. Cada uma diz a fonte e se reforça ou contradiz o plano.

1. **Critério de decisão na descrição de `start_task`, com exemplos e números** (reforça a decisão 2; fontes 1, 3, 4). A descrição diz quando abrir tarefa (trabalho fechado em si, que leva muitos passos e devolve um resultado) e quando ficar no chat (troca frequente com o usuário, mudança rápida, pergunta que se responde com poucas chamadas), com três ou quatro exemplos de pedidos reais e uma faixa de esforço ("até umas 10 chamadas: responda no chat").
2. **Pedido com esquema e campos obrigatórios, no formato do `delegate`** (reforça a decisão 3; fontes 1, 4, 7). `{objective, knownFacts, decisions, returnFormat, limits}`: objetivo; o que já se sabe; **as decisões já tomadas na conversa** (o que a Cognition diz que se perde); o que devolver e em que formato; até onde ir e quando parar para perguntar. Validado por esquema, como `{bot, objective, acceptanceCriteria[], context?}` do `delegate`. As mensagens do usuário continuam copiadas pelo id.
3. **O harness põe no pedido de cada tarefa a lista das outras tarefas abertas daquele bot** (objetivo e estado), sem o modelo decidir (fonte 2, e o exemplo de trabalho duplicado da fonte 1). Junto, uma recusa no código para duas tarefas abertas com o mesmo objetivo exato, como o `delegate` já faz com "mesma execução, bot e objetivo". **Contradição parcial:** a Cognition desaconselha tarefas em paralelo que agem sobre a mesma coisa, e o plano permite 3 abertas sem dizer nada sobre isso. A proposta não muda o limite de 3; deixa as tarefas se enxergarem.
4. **O resultado inteiro fica na conversa da tarefa; o turno de fechamento recebe o relatório final e o id da tarefa** (detalha a decisão 4; fontes 1, 3, 4, 7). O relatório chega ao chat marcado como saída da tarefa, sem autoridade de pedido do usuário. Se vier vazio ou fora do formato pedido, o turno de fechamento diz isso, em vez de inventar (o "valor de reserva" da fonte 7). O aviso de fim é idempotente e refeito depois de uma queda, com chave `task:<id>:result`, como `returnDelegatedResult` (fontes 1, 8).
5. **O contexto do bot no chat traz as tarefas abertas e o estado de cada uma** (fonte 3). Assim "terminou?" se responde lendo o estado, não adivinhando. O turno de fechamento entra na fila do chat (enqueue) se o chat tiver uma execução ativa naquele momento, em vez de abrir uma segunda execução ao lado (fonte 10).
6. **Roteamento pelo chat principal por referência, antes do `send_to_task`** (contradiz em parte a decisão 5; fontes 3, 12). Hoje o plano deixa o bot escolher a tarefa para uma mensagem escrita no chat principal. Proposta: se a mensagem do usuário **responde** a uma mensagem ou ao rótulo de uma tarefa, o servidor manda para aquela tarefa sem passar pelo modelo (como `taskId`/`referenceTaskIds` na A2A). `send_to_task` fica para texto livre. Quando o bot usa `send_to_task`, a mensagem do usuário vai **copiada pelo id**, e o que o bot acrescenta vai marcado como dele: no Claude Code, mensagem de quem lançou o agente é correção de rumo, nunca aprovação do usuário.
7. **Mensagem para uma tarefa parada numa aprovação** (detalha a decisão 5; fontes 9, 12). Fica no `run_inbox` e é entregue depois que a aprovação for decidida, como o steering pendente da OpenAI. "Para" continua encerrando na hora. Negar um cartão recusa só aquela chamada, sem parar a tarefa, como no Claude Code (fonte 3).
8. **Plano B estrutural, pelo vigia** (atende a regra 28; fontes 1, 6). No cartão que o vigia já mostra quando uma execução do chat chega ao limite de passos ([VIGIA.md](../VIGIA.md)), uma terceira opção, "Continuar como tarefa", que move aquela execução para uma tarefa e libera o chat. Ninguém depende do bot ter decidido certo no começo. Fica a dúvida se vale também um gatilho mais cedo (por exemplo, 80% da fatia, onde o vigia já olha); ver "em aberto".
9. **`start_task` some do modelo quando não pode ser usada** (fonte 7). Dentro de uma tarefa e com 3 tarefas abertas, a ferramenta não aparece; o código continua recusando (como `createDelegation` faz com a profundidade). Recusa por limite volta com uma frase que diz para não tentar de novo (fonte 3).
10. **Custo visível por tarefa, sem teto por padrão** (fontes 1, 4). O dono decidiu "sem teto de custo por padrão" ([VIGIA.md](../VIGIA.md)), e esta proposta respeita isso. O que muda: o custo de cada tarefa fica gravado e aparece na tela da tarefa, e o teto por tarefa existe como configuração opcional (como `maxBudgetUsd` no SDK). **Ponto de atenção:** a Anthropic e o SDK tratam o teto como a defesa principal contra o custo multiagente; aqui ele fica desligado por decisão do dono.
11. **Bateria de cerca de 20 pedidos reais antes de ligar** (fonte 1). Cada pedido marcado com o esperado ("responde no chat" ou "abre tarefa"), para medir abertura demais e de menos. Entra na bateria de testes do plano ([TESTES-REAIS.md](../TESTES-REAIS.md)).

## Riscos e o que fica em aberto

**Riscos.**

- **O bot decide mal.** É a regra 28 do dono: a decisão de abrir tarefa é do modelo por definição. As mudanças 1, 8, 9 e 11 reduzem o risco, mas não o eliminam. A Anthropic viu o modelo abrir 50 subagentes para perguntas simples (1), e o SDK avisa que modelos mais novos delegam mais (4).
- **Custo.** O 15× é do caso paralelo com vários subagentes (1); o custo de uma tarefa do Suup **não foi medido**. Sem teto por padrão, uma tarefa que roda muito tempo só é segurada pelo vigia (limite de passos).
- **Tarefas que pisam umas nas outras.** Com 3 abertas, duas podem mexer no mesmo arquivo, conector ou documento. A mudança 3 deixa as tarefas se enxergarem, mas não impede o conflito.
- **Turno de fechamento no meio de uma conversa.** Se o usuário está escrevendo quando a tarefa termina, o resumo entra no meio. A mudança 5 enfileira, mas a ordem que o usuário vê na tela ainda precisa de teste.
- **Cópia das mensagens do usuário.** As mensagens copiadas pelo id podem trazer dados sensíveis para uma execução que roda sozinha; o resumo aninhado da OpenAI tem o mesmo problema e a documentação avisa (5). Não é novo, porque a tarefa é do mesmo bot e com as mesmas concessões, mas fica registrado.
- **Pedido escrito pelo bot.** O objetivo e as decisões do pedido são texto do modelo; um erro ali vira trabalho errado sem o usuário ver. A tela da tarefa deveria mostrar o pedido (inferência; nenhuma fonte trata disso).

**Em aberto.**

- Se "Continuar como tarefa" (mudança 8) aparece só no limite de passos ou também mais cedo, e com que número.
- Se a tarefa que termina com o chat parado abre uma execução nova para o turno de fechamento ou só posta o relatório; o plano diz "turno curto do bot", e o custo desse turno não foi medido.
- Como o roteamento por referência (mudança 6) aparece na interface: responder a uma mensagem da tarefa no chat principal precisa de um gesto claro.
- O formato exato de `returnFormat` (texto livre ou esquema).

**Não verificado.**

- Google ADK: não lido (opcional).
- O comportamento real de cada fonte não foi testado aqui; tudo vem da documentação e dos artigos, na versão lida em 26/11/2026.
- Os números de custo e latência das fontes são dos sistemas delas; nenhum foi medido no Suup.
