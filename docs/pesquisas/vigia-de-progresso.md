# Vigia de progresso: detectar laço e estender o limite de turnos

Data de acesso das fontes: 24/11/2026. Marcação: **[lido]** = li o texto da fonte primária nesta pesquisa; **[não verificado]** = não consegui conferir, ou a fonte não diz.

## Pergunta

Quando uma execução do Suup atinge `maxTurns` (padrão 50 chamadas ao modelo) ela termina como `failed` com origem `limit`, e o trabalho útil se perde. Dá para detectar laço de forma barata e estrutural, deixar um modelo barato julgar "avançando" ou "dando voltas" perto do limite, estender o orçamento quando há progresso, dar um aviso ("mude de abordagem") quando há laço, e parar e perguntar ao dono quando o laço continua? Como os outros projetos fazem isso?

## Fontes

Primárias, com URL e data de acesso (24/11/2026). A data da própria fonte, quando não aparece no texto, está como "não verificada".

1. OpenHands SDK, `stuck_detector.py`: https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/conversation/stuck_detector.py (acesso 24/11/2026; data da fonte: não verificada; é a branch `main`).
2. OpenHands SDK, `types.py` (limites padrão): https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/conversation/types.py (acesso 24/11/2026).
3. OpenHands SDK, `local_conversation.py` (o que acontece quando dispara): https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py (acesso 24/11/2026).
4. OpenHands, versão antiga do controlador (tag 0.9.0), `stuck.py` e `agent_controller.py`: https://raw.githubusercontent.com/All-Hands-AI/OpenHands/0.9.0/openhands/controller/stuck.py e https://raw.githubusercontent.com/All-Hands-AI/OpenHands/0.9.0/openhands/controller/agent_controller.py (acesso 24/11/2026).
5. OpenHands, `README.md` da branch `main`, que aponta o código do agente para o repositório do SDK: https://raw.githubusercontent.com/All-Hands-AI/OpenHands/main/README.md (acesso 24/11/2026).
6. LangGraph, página de erro `GRAPH_RECURSION_LIMIT`: https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT (acesso 24/11/2026; a URL antiga em langchain-ai.github.io redireciona para ela).
7. LangGraph, código: `langgraph/_internal/_config.py` (valor padrão de `recursion_limit`), `langgraph/pregel/main.py` (mensagem ao estourar), `langgraph/errors.py` (classe `GraphRecursionError`), todos em https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/langgraph/langgraph/ (acesso 24/11/2026).
8. OpenAI Agents SDK (Python), guia "Running agents": https://openai.github.io/openai-agents-python/running_agents/ (acesso 24/11/2026).
9. OpenAI Agents SDK, referência de exceções: https://openai.github.io/openai-agents-python/ref/exceptions/ (acesso 24/11/2026).
10. OpenAI Agents SDK, código: `src/agents/run_config.py` e `src/agents/run_internal/run_loop.py`, em https://raw.githubusercontent.com/openai/openai-agents-python/main/src/agents/ (acesso 24/11/2026).
11. Anthropic, "Building effective agents" (engenharia): https://www.anthropic.com/engineering/building-effective-agents (acesso 24/11/2026; data de publicação 2024-12-19, segundo o JSON-LD da própria página).
12. Anthropic, documentação de `stop_reason` da API: https://docs.claude.com/en/api/handling-stop-reasons (acesso 24/11/2026; data da fonte: não verificada).
13. arXiv 2611.25363, "Stop Going in Circles: Loop-Triggered Routing for System 1 Decision Agents" (LoopRoute): https://arxiv.org/abs/2611.25363 e https://arxiv.org/html/2611.25363 (acesso 24/11/2026; data de submissão: não verificada).
14. arXiv 2610.12375, "OnTrack: Real-Time Monitoring and Intervention in LLM Agent Trajectories via Streaming Structure-Aware Optimal Transport": https://arxiv.org/abs/2610.12375 e https://arxiv.org/html/2610.12375 (acesso 24/11/2026; data de submissão: não verificada).
15. Código do Suup (lido em `/home/user/suup-`): `packages/core/src/loop/safe-point.ts`, `packages/core/src/loop/loop.ts`, `packages/core/src/loop/state.ts` (função `trackRepeat`), `packages/core/src/loop/model-call.ts`, `packages/core/src/loop/prompts.ts` (`repetitionNudge`), `packages/runtime/src/config.ts` (linha 579), `docs/CONFIGURACAO.md` (seção `defaults`), `docs/REGRAS.md`.

## Fatos verificados

### OpenHands (SDK atual e versão antiga)

- **Padrões detectados e limites** [lido, `types.py`]: `action_observation` padrão 4 ("Threshold for action-observation loop detection"), `action_error` 3, `monologue` 3, `alternating_pattern` 6.
- **Janela** [lido, `stuck_detector.py`]: `MAX_EVENTS_TO_SCAN_FOR_STUCK_DETECTION: int = 20`, e só eventos depois da última mensagem do usuário.
- **Cinco cenários** [lido, `stuck_detector.py`, docstring: "1. Repeating action-observation cycles 2. Repeating action-error cycles 3. Agent monologue 4. Repeating alternating action-observation patterns 5. Context window errors"]:
  1. Mesma ação e mesma observação, repetidas `action_observation` vezes (4): `logger.warning("Action, Observation loop detected")`.
  2. Mesma ação com erro: o detector sinaliza quando a sequência passa do limite ("one repeat past the threshold", ou seja, a 4ª repetição com limite 3). Antes disso, um aviso é gerado uma vez por sequência (`get_action_error_nudge`), com texto como "will not work — review the error message and either correct the arguments or try a different approach."
  3. Monólogo: "Look for N consecutive agent messages without user interruption", com N = 3.
  4. Alternância: `[A, B, A, B, A, B]` com ações e observações iguais por posição, com limite 6.
  5. Erro de janela de contexto: **não implementado**. O código diz `# TODO: blocked by https://github.com/OpenHands/agent-sdk/issues/282` e `return False`.
- **Igualdade de eventos** [lido]: `_event_eq` "Compare two events for equality, ignoring irrelevant details like ids, metrics." Ações inválidas são comparadas sem o campo de pensamento (`_validated_arguments` tira `security_risk` e `summary`). Chamadas paralelas de uma mesma resposta do modelo não contam como repetição (`_invalid_calls_share_response`).
- **O que acontece ao disparar, SDK** [lido, `local_conversation.py`]: `_check_stuck_or_nudge` faz primeiro o aviso, uma vez: "Nudge once on a repeating action-error streak, else apply is_stuck()". Se `is_stuck()` for verdadeiro: `self._state.transition(ConversationExecutionStatus.STUCK, "stuck pattern detected")`, e o laço para ("Returns True if STUCK was set and the run loop should stop"). Ao retomar uma conversa parada, o detector abre uma janela nova (`mark_resumed`: "Start a fresh detection window at the current end of the history."), para os eventos antigos não dispararem de novo na hora.
- **O que acontece ao disparar, versão antiga 0.9.0** [lido, `agent_controller.py`]: `if self._is_stuck(): await self.report_error('Agent got stuck in a loop')` e estado `ERROR`.
- **Limite de iterações, versão antiga 0.9.0** [lido, `agent_controller.py`]: ao atingir `max_iterations`, fora do modo headless, o agente pausa com "Agent reached maximum number of iterations, task paused." e o lembrete "Please click on resume button if you'd like to continue, or start a new task." Quando o usuário escolhe continuar: "User has chosen to deliberately continue - lets double the max iterations" (`max_iterations += _initial_max_iterations`). No modo headless: "Agent reached maximum number of iterations in headless mode, task stopped." e estado `ERROR`.
- **Caminho antigo do detector** [lido]: `openhands/controller/stuck.py` retorna 404 na branch `main`. Existe na tag 0.9.0. O código atual está no repositório do SDK (`README.md` da `main` aponta para lá).
- **Documentação oficial do OpenHands** [não verificado]: `docs.all-hands.dev` redireciona para `docs.openhands.dev`, e esse host foi recusado pelo proxy (403, "connect_rejected"). Não li a página e não tentei contornar.

### LangGraph

- **O que a doc diz** [lido, `GRAPH_RECURSION_LIMIT`]: "Your LangGraph StateGraph reached the maximum number of steps before hitting a stop condition. This is often due to an infinite loop caused by code like the example below." E a solução: "If you have a complex graph, you can pass in a higher recursion_limit value into your config object when invoking your graph".
- **Valor padrão, código** [lido, `_internal/_config.py`]: `DEFAULT_RECURSION_LIMIT = _DefaultRecursionLimit(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))`. Ou seja, o padrão atual é 10007, a não ser que a variável de ambiente mude. A doc não cita o número: [não verificado na doc].
- **O que acontece ao estourar** [lido, `pregel/main.py` e `errors.py`]: no código, `if loop.status == "out_of_steps"` cria a mensagem "Recursion limit of {recursion_limit} reached without hitting a stop condition. You can increase the limit by setting the `recursion_limit` config key." `GraphRecursionError(RecursionError)` tem o docstring "Raised when the graph has exhausted the maximum number of steps." No trecho que li não há ramo de pausa, pergunta ou extensão: o grafo falha com erro. (Inferência: é o comportamento de "parar" sem decisão do usuário.)

### OpenAI Agents SDK

- **Limite e exceção** [lido, guia "Running agents"]: "If we exceed the max_turns passed, we raise a MaxTurnsExceeded exception. Pass max_turns=None to disable this turn limit."
- **Referência** [lido, exceções]: `MaxTurnsExceeded` "is raised when the agent's run exceeds the max_turns limit ... It indicates that the agent could not complete its task within the specified number of agent-loop turns (LLM calls)."
- **Tratamento controlado** [lido, guia]: "All Runner entry points accept error_handlers, a dict keyed by error kind. The supported keys are "max_turns", "model_refusal", and "invalid_final_output". Use them when you want to return a controlled final output instead of ending the run with the corresponding error." O exemplo passa `max_turns=3` com um handler que devolve uma saída final.
- **Padrão** [lido, `run_config.py`]: `DEFAULT_MAX_TURNS = 10`. Mensagem no código [lido, `run_loop.py`]: `MaxTurnsExceeded(f"Max turns ({max_turns}) exceeded")`, e o handler é chamado se estiver configurado.
- **Detecção de laço**: nenhuma detecção de repetição encontrada nas páginas e no código lidos [não verificado: não li o módulo inteiro].

### Anthropic

- **Engenharia** [lido, "Building effective agents"]: "The task often terminates upon completion, but it’s also common to include stopping conditions (such as a maximum number of iterations) to maintain control." E: "Agents can then pause for human feedback at checkpoints or when encountering blockers." E ainda: "it’s crucial for the agents to gain “ground truth” from the environment at each step (such as tool call results or code execution) to assess its progress."
- **Stop reasons** [lido, documentação da API]: `pause_turn` = "A server-tool loop reached its iteration limit. Send the assistant content back to continue." `model_context_window_exceeded` = "The response filled the model’s context window. Treat the response as truncated." Não há orientação sobre detecção de laço nessa página.
- **Detecção de laço ou limiares oficiais da Anthropic**: não encontrei página oficial sobre isso [não verificado].

### Artigos (arXiv)

**LoopRoute, arXiv 2611.25363** [lido: resumo e método]

- Resumo: "We observe that recurring state-action pairs can signal stalled execution." E: "The decision model acts by default. When a loop is detected, the LLM provides brief, feedback-driven assistance and then returns control to the decision model. Later loops can request further assistance." Resultados: ganhos médios de 21,0% (ALFWorld), 60,1% (MapReader) e 30,1% (TextWorld cooking) sobre o modelo de decisão sozinho, com uso limitado do LLM e menos tempo de API e custo que o LLM em todos os passos.
- Método: o detector usa o par (estado observado selecionado, ação). O histórico e o número do passo ficam de fora, porque mudam mesmo num laço. "When the same pair has already been executed twice, we treat rt=1 as a signal of stalled execution." Cada intervenção do LLM é limitada: "each LLM takeover is bounded by B=2 actions". Sem treino e sem calibração de confiança.
- Limite: os testes são em ambientes textuais de jogo (ALFWorld, MapReader, TextWorld), não em código.

**OnTrack, arXiv 2610.12375** [lido: resumo e partes do método]

- Resumo: monitor em streaming que "compares an agent’s steps and dependencies against recorded successful runs", com alerta ou bloqueio em cerca de um milissegundo por passo, e que sinaliza "loops, stalls, and repeated tool calls". Com política de aborto: "we save about 18% of compute that would be burned on failing runs, where 83% of interrupted runs were actually heading to failure (5 out of 6 aborts were correct)."
- Método: o sinal de laço (L1) é "near-duplicate predecessor (action, tool, arguments), with a retry exemption: duplicates of an errored step are exempt up to rmax attempts". Ou seja: a comparação ignora o resultado, e uma repetição de passo com erro tem tolerância limitada. Estagnação: "coverage velocity" = progresso medido em janela, e "stall = activity without progress". Laço estrito: ciclo de 2 passos.
- Limite: os dados são trajetórias do SWE-bench. O intervalo de Wilson de 95% é de cerca de ±15 pontos percentuais com essas amostras (o próprio artigo avisa). Sem trajetórias de referência, a detecção é mais fraca.

### Código atual do Suup

- **Constantes** [lido, `safe-point.ts`]: `MAX_NO_PROGRESS_TURNS = 3` (3 turnos seguidos sem chamar ferramenta, falha), `REPEAT_NUDGE_AT = 3` (aviso), `REPEAT_FAIL_AT = 5` (falha).
- **Assinatura de repetição** [lido, `state.ts`, `trackRepeat`]: `${call.name}\u0000${canonicalJson(call.args)}\u0000${isError}\u0000${content}`. Ou seja: nome, argumentos canônicos, flag de erro e conteúdo do resultado precisam ser idênticos. O aviso é uma vez por sequência (`repeat.nudged`).
- **Aviso** [lido, `prompts.ts`]: `repetitionNudge` diz que repetir não muda nada e pede outra abordagem ou "one precise question if you are stuck".
- **Limites** [lido, `safe-point.ts`, `checkLimits`]: `turn limit reached`, `cost limit reached` (`maxCostUsd`) e `duration limit reached` (`maxDurationMs`, sem contar o tempo parado para retorno). Os três terminam a execução com `fail(... "limit")`.
- **Padrões** [lido, `docs/CONFIGURACAO.md`]: `maxTurns` 50, `maxCostUsd` e `maxDurationMs` sem limite. Passar de um limite termina a execução como `failed` com origem `limit`.
- **Chamadas que não contam como turno** [lido, `model-call.ts`]: `purpose: "agent" | "review" | "compaction"`, e `turns: spec.purpose === "agent" || spec.countsAsTurn === true ? 1 : 0`. Ou seja: já existe o caminho para chamadas de modelo que custam mas não gastam turno.
- **Pedir ao dono** [lido, `safe-point.ts`]: já existe o estado `waiting_user`, com `transition(ctx, "running", "waiting_user", ...)`.

## Inferências

1. **A forma já existe, o que falta é a decisão.** O Suup já tem contagem de repetição exata, aviso uma vez e falha no 5º. O OpenHands faz o mesmo (aviso e depois parada). A mudança do dono é trocar "falhar" por "perguntar ao dono", e acrescentar um laço de decisão antes de perguntar.
2. **Os limiares do OpenHands são parecidos com os do Suup.** Repetição de ação com erro em 3 (aviso) e parada depois; monólogo em 3; alternância em 6. Não há motivo para inventar números novos. Os do Suup (3 e 5) são coerentes com o OpenHands.
3. **Juiz por modelo não aparece como solução para laço em nenhum dos projetos lidos.** OpenHands e LangGraph usam regra estrutural. LoopRoute usa gatilho estrutural e ajuda limitada do LLM. OnTrack usa comparação com trajetórias e uma pontuação determinística. Isso não prova que o juiz não ajuda, mas significa que ele não deve ser o único critério para estender o limite.
4. **Pergunta ao dono precisa de alguém presente.** O OpenHands, no modo headless, para com erro. O Suup tem execuções agendadas (rotinas), onde ninguém responde "Continuar?".
5. **Repetição com resultado diferente passa despercebida hoje.** A assinatura do Suup exige resultado idêntico. O OnTrack compara só ação, ferramenta e argumentos, com tolerância para repetição de erro. Um poller cujo resultado muda a cada vez (um horário, um id) não dispara nada no Suup hoje.

## O que não foi verificado

- **`docs.all-hands.dev` / `docs.openhands.dev`**: bloqueado pelo proxy (403, host `docs.openhands.dev`, destino do redirect). Não li a documentação do OpenHands. Não tentei contornar.
- **`openhands/controller/stuck.py` na branch `main`**: não existe mais (404). Não verifiquei a versão do SDK nem o commit exato do código lido.
- **Página de erros do LangGraph em langchain-ai.github.io** (`/reference/errors/`): o HTML estático não tem o texto. Usei docs.langchain.com.
- **Valor padrão do `recursion_limit` na documentação**: não verificado na doc; só no código (10007, com variável de ambiente).
- **Anthropic**: não há página oficial sobre detecção de laço nem limiares recomendados. A única orientação é a frase de stopping conditions.
- **Datas de submissão dos artigos e da documentação de `stop_reason`**: não verificadas.
- **`export.arxiv.org`** (API de busca do arXiv): falha de conexão (código 000). Usei `arxiv.org/search`.
- **Reprodução dos resultados dos artigos**: não reproduzi. Os números são os dos autores.
- **Erro estruturado nas ferramentas do Suup**: vi `isError` (booleano) em `trackRepeat`. Não verifiquei se há um código de erro declarado que sirva para "mesmo tipo de erro" sem olhar texto. Antes de implementar, conferir.

## Implicação para o Suup

### Onde a ideia do dono confirma a pesquisa

- Detectar repetição de forma estrutural, sem regex, é o que OpenHands, LoopRoute e OnTrack fazem.
- Dar um aviso antes de parar é o que o OpenHands faz (aviso uma vez, depois parada).
- Parar e perguntar quando o laço continua é o que o OpenHands faz na versão antiga, com "click on resume button", e o Suup já tem `waiting_user`.
- Estender o limite depois de uma pergunta é o que o OpenHands 0.9.0 faz (dobra `max_iterations` quando o usuário continua).

### Onde a pesquisa contradiz a ideia do dono (decidir antes de codar)

1. **O juiz não deve ser quem decide sozinho a extensão.** O sinal que estende deve ser fato verificável (arquivo alterado, chamada nova com sucesso, evidência nova). O juiz entra como segunda opinião, e "incerto" vai para o dono, sem estender.
2. **"Mesmo resultado" é limite estreito.** O OnTrack ignora o resultado para detectar quase-repetição. Recomendo acrescentar esse sinal, mas com limite mais alto, porque polling legítimo se parece com isso.
3. **Parar com erro versus perguntar.** Hoje o Suup falha no 3º turno sem ferramenta (`MAX_NO_PROGRESS_TURNS`) e no 5º repetido (`REPEAT_FAIL_AT`). O plano do dono troca isso por pergunta, o que muda o contrato de `failed`. Precisa de decisão explícita.
4. **Execução sem dono.** "Continuar?" não tem resposta em rotina agendada. O OpenHands headless para com erro. Proposta: em execução sem dono, o laço ou o limite termina como `failed` com origem `limit` e com o resumo parcial. **Decisão do dono.**

### Desenho recomendado (proposta inicial, não validada)

**Sinais estruturais** (todos com campos declarados e igualdade canônica, nunca texto nem regex):

| Sinal | Gatilho inicial | Ação |
|---|---|---|
| S1. Repetição exata | mesmo nome, mesmos argumentos canônicos, mesmo `isError`, mesmo resultado | aviso no 3º (já existe); no 5º, pergunta ao dono (troca `REPEAT_FAIL_AT`) |
| S2. Quase-repetição | mesmo nome e mesmos argumentos canônicos, resultado qualquer, 4 vezes em 8 chamadas, sem mudança no workspace | sinal para o juiz; não para sozinho. Erro repetido tolerado até 3 vezes (r_max do OnTrack) |
| S3. Erro recorrente | mesmo nome, mesmo tipo de erro declarado, 3 seguidos | aviso no 3º; pergunta no 4º (espelha o OpenHands) |
| S4. Sem progresso | 2 turnos seguidos sem ferramenta: aviso; 3: pergunta (troca `MAX_NO_PROGRESS_TURNS`) | aviso e pergunta |
| S5. Alternância | A, B, A, B, A, B (igualdade por posição) | aviso; pergunta se continuar por mais 2 pares |

**Sinais de progresso** (usados para estender, nunca para parar): arquivos com hash novo desde o último ponto de controle; chamada com nome e argumentos inéditos e com sucesso; evidência nova registrada; ferramenta nova usada. "Progresso" = pelo menos um desses nos últimos 10 turnos.

**Quando chamar o juiz**: no limite flexível (80% de `maxTurns`, ou seja, turno 40 de 50) e em cada ponto de extensão. Nunca a cada turno. Se um sinal de laço estiver ativo, o juiz confirma antes de qualquer aviso.

**O que o juiz vê** (resumo compacto, sem segredos):
- o objetivo e os critérios de aceitação, cortados em 500 caracteres e redigidos pelo cofre (troca de valores exatos conhecidos);
- as últimas 10 chamadas: nome, hash dos argumentos canônicos, sucesso ou erro, tamanho do resultado, e no máximo 100 caracteres do início e do fim do resultado, redigidos;
- os contadores de progresso (chamadas distintas, arquivos alterados, turnos sem ferramenta);
- a última mensagem do bot, cortada.

Nada de arquivos inteiros, histórico completo, cofre ou credenciais. A saída é JSON validado por esquema (zod): `{ veredito: "avanca" | "laco" | "incerto", motivo (até 200 caracteres), eventos citados }`. Resposta inválida conta como "incerto". Usar um `purpose` novo, por exemplo `"progress"`, com `countsAsTurn: false`, em modelo barato. O custo entra em `maxCostUsd` e não em `maxTurns`.

**Extensão**: "avanca" e pelo menos um sinal de progresso, então `+25` turnos (metade do padrão). No máximo 2 extensões automáticas por execução. "incerto", "laco" ou sem progresso: não estende; se ainda não houve aviso, faz o aviso; senão, pergunta ao dono.

**Aviso (nudge)**: uma vez por execução, como em `repetitionNudge`. Diz o que se repete e pede outra abordagem ou uma pergunta objetiva ao dono. Não aparece como erro para o dono.

**Pergunta ao dono**: pelo estado `waiting_user`, com duas opções, "Continuar (+25)" e "Parar e entregar o que tem". Ao continuar: abre nova janela de detecção (como `mark_resumed` no OpenHands), para os eventos antigos não dispararem de novo.

**Tetos fixos (não extensíveis pelo juiz)**:
- `maxTurns` absoluto de 150 (3 vezes o padrão), mesmo com extensões e "Continuar" do dono.
- `maxCostUsd` e `maxDurationMs`: o dono define. Hoje são sem limite por padrão. **Decisão do dono**; proposta: definir um padrão não nulo.
- Chamadas do juiz contam no custo e no tempo.

**Como aparece para o dono** (tom amigável, na conversa):
- Progresso: "Ainda estou avançando: já mexi em 4 arquivos e rodei 2 testes. Vou dar mais 25 passos."
- Laço: "Estou repetindo a mesma busca sem resultado novo. Vou tentar outro caminho."
- Pergunta: "Cheguei no limite de 50 passos e ainda não terminei. Quer que eu continue mais 25? (Continuar / Parar aqui)"
- No registro (inspetor): um evento `progress_check` com veredito, motivo e sinais citados.

**O que testar**:
- Um teste por sinal, com sequências sintéticas (repetição exata em 2, 3 e 5; quase-repetição com resultados variando; erro recorrente; monólogo; alternância).
- Falsos positivos: polling em que o estado muda, build longo, releitura depois de edição. Esses não podem disparar aviso.
- Juiz com resposta fixa: "avanca" sem progresso não estende; resposta inválida vira "incerto" e vai para o dono; o juiz não conta em `maxTurns`, mas soma em `maxCostUsd`; o teto absoluto segue valendo com "avanca" repetido.
- Aviso uma vez só; pergunta e retomada abrem janela nova.
- Execução sem dono: sem pergunta, termina como `failed` com origem `limit` e resumo parcial.
- `packages/core/test/no-regex.test.ts` continua passando (a assinatura de repetição usa `canonicalJson`, sem padrão de texto).
- Cenário com o modelo de teste (script de passos em `CONFIGURACAO.md`, `agent[n]`) reproduzindo um laço e um progresso de ponta a ponta. Depois, calibrar com execuções reais (`TESTES-REAIS.md`) antes de fixar os números.

**Decisões que precisam do dono antes de codar**: (a) o que acontece em execução agendada ou sem dono; (b) os padrões de `maxCostUsd` e `maxDurationMs`; (c) "incerto" vai para o dono (proposta: sim); (d) o limite de 2 extensões automáticas por execução; (e) se a quase-repetição (S2) entra já ou só depois de calibrar.
