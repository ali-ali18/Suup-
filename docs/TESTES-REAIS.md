# Primeiros testes com modelos reais

Data: 18/11/2026. Primeira vez que o harness conversou com modelos de verdade: até aqui os adaptadores tinham sido testados contra HTTP simulado e o loop contra respostas roteirizadas. Este documento registra o que foi verificado, o que estava errado, o que foi consertado e o que continua sem verificação.

## Preparação

| Item | Valor |
|---|---|
| Modelo barato (CHEAP, também o revisor) | `claude-haiku-5-5`; a API devolveu a versão `claude-haiku-5-5` |
| Modelo intermediário (MID) | `claude-sonnet-5-5`; a API devolveu a versão `claude-sonnet-5-5` |
| Preços usados (US$ por milhão de tokens: entrada / saída / cache lido / cache gravado) | CHEAP 0,10 / 0,50 / 0,01 / 0,125 · MID 2 / 10 / 0,10 / 2,50. Janela de 1 milhão de tokens e saída máxima de 128 mil nos dois. Vieram da referência da API (skill `claude-api`, tabela de 03/11/2026), não da memória |
| Sandbox | `local`, **sem isolamento**: os comandos dos bots rodaram neste contêiner, onde a chave existe no ambiente |
| PostgreSQL | 16, cluster descartável local (sem Docker no contêiner) |
| Chave | variável `SUUP_ANTHROPIC_KEY`; a configuração só referencia o nome (`apiKeyEnv`). `suup.config.json` não é versionado (está no `.gitignore`) |

Risco residual do sandbox local: `LocalExecutor` dá aos comandos um ambiente limpo (conferido: `env` do lado do bot não mostra nenhuma variável com a chave), mas os comandos rodam como o mesmo usuário e poderiam ler `/proc/<pid>/environ` do processo do harness. Nenhuma tarefa pede isso e não houve sinal de que algum modelo tentou; ainda assim, para avaliar modelos com tarefas não confiáveis, use o sandbox Docker.

## Etapa 1: o adaptador da Anthropic contra a API real

Testes ao vivo do pacote (`SUUP_LIVE_ANTHROPIC*`, em CHEAP): 2 passaram. `suup doctor --live`: os dois modelos responderam (581 ms e 1,1 s) com a versão devolvida.

Verificações manuais com pedidos mínimos (as respostas reais viraram fixtures em `packages/providers/test/recorded/`, sem chave nem cabeçalhos de requisição, com assinaturas de raciocínio trocadas e o nome do modelo por `model-x`):

| Verificação | Resultado |
|---|---|
| Chamada com argumentos aninhados (objeto dentro de objeto, lista de objetos, enum) | Ida e volta correta |
| Duas chamadas na mesma resposta; resultados devolvidos numa única mensagem | Correto |
| `tool_result` com `isError` | Aceito, o modelo reage ao erro |
| Corte por `maxOutputTokens` minúsculo no meio de uma chamada | Termina como `max_tokens`, a chamada incompleta é descartada, sem erro |
| Uso com cache (pedido repetido) | Leitura de cache aparece (ex.: 626 de 801 tokens); o adaptador soma entrada + leitura + gravação como "prompt inteiro" corretamente |
| Versão do modelo | Vem em `message_start.message.model` e é gravada |
| Modelo inexistente | HTTP 404 `not_found_error` → `invalid_request`, não retentável |
| Bloco de raciocínio (vem com texto vazio e assinatura) | Gravado como `provider_data` e reenviado sem problema **se a conversa só crescer** (ver achado 2) |
| `tool_choice` forçado | **CHEAP aceita** (`any` e por nome). **MID recusa os dois com HTTP 400** (`tool_choice: type "tool" and "any" are not supported for this model`) |

O adaptador em si não tinha defeito de tradução. Os defeitos estavam acima dele.

## Achados e correções

Cada correção tem teste que falhava antes (conferido para os do loop e do estado).

1. **Escolha forçada de ferramenta (harness/configuração).** O revisor força `verdict`; MID recusa com 400, o que viraria revisão falha. Novo campo `supportsForcedToolChoice` por modelo (padrão `true`; MID está `false`); com `false` o revisor pede o veredito só por instrução. Além disso, se a API devolver `invalid_request` numa chamada forçada, o revisor repete uma vez sem forçar. Verificado ao vivo com o revisor em MID, nos dois modos (com a flag e, sem a flag, pelo 400 seguido da repetição).
2. **O lembrete de estado reescrevia o histórico a cada turno (harness; o mais grave).** Era acrescentado à última mensagem do usuário e sumia no turno seguinte. Contra a API real, isso (a) zera o cache da conversa e (b) faz a API recusar com HTTP 400 qualquer bloco de raciocínio ("assinatura inválida: o bloco está ligado a outra conversa"). Reproduzido com um pedido mínimo antes de qualquer avaliação. O raciocínio aparece de forma intermitente nos dois modelos, então a falha seria aleatória. Agora o lembrete enviado numa requisição gravada permanece naquela mensagem (reconstruído dos eventos `model_request`), só o último vale, e o prompt do sistema diz isso. A compactação também passou a descartar blocos de raciocínio das mensagens mantidas e a ignorar lembretes antigos no resumo. Efeito medido: 86% dos tokens de entrada dos turnos do agente vieram do cache (ver "Cache e custo").
3. **O revisor não via o que o usuário respondeu (harness).** O resumo de ferramentas dado ao revisor não inclui as ferramentas de controle, então a resposta do dono a um `escalate` nunca chegava a ele ("não há registro da decisão") e a tarefa `ambiguous-decision` terminava num empate de revisão. Agora o estado guarda perguntas, respostas e mensagens do usuário e a mensagem do revisor traz a seção "Exchanges with the user". Confirmado com `resend` (3 de 3 tentativas rejeitavam o pedido gravado: erra sempre, logo é o que foi enviado) e depois 3 de 3 aprovações.
4. **Resumo de ferramentas curto demais para o revisor (harness).** Só 300 caracteres do começo e do fim de cada resultado. Com MID, a tarefa `long-checklist` terminou em `waiting_user` porque o revisor rejeitou três vezes alegando que o texto de `INSTRUCOES.md` estava truncado. Agora até 2000 caracteres aparecem inteiros (senão 1000 + 1000) e o teto do resumo é 20000.
5. **Custo ignorava gravações de cache (cálculo).** Tokens gravados no cache eram cobrados como entrada comum. O uso agora traz `cacheWriteInputTokens` e o preço aceita `cacheWriteInputPerMTok`.
6. **`find-in-noise` ambíguo (tarefa).** "Escreva em resposta.txt" depois de falar da pasta `arquivos/`: o modelo acertou o código e gravou `arquivos/resposta.txt`; o verificador olha a raiz. O enunciado agora diz "na raiz da sua pasta de trabalho (ao lado da pasta arquivos/, não dentro dela)". O verificador não mudou. Reconheço que essa classificação tem margem: um assistente atento escreveria na raiz, e a primeira falha pode também ser lida como comportamento do modelo; o que não é discutível é que a frase admitia as duas leituras.

Nenhum verificador foi afrouxado e nenhum teste foi pulado ou removido. O teste antigo do loop que afirmava "o lembrete não fica no histórico" foi substituído pelo invariante contrário, mais forte (cada requisição estende a anterior).

## Qualificação

| Modelo | `plan` antes de agir | argumentos aninhados | `finish` com evidência | escala na tarefa impossível | Resultado |
|---|---|---|---|---|---|
| CHEAP | ✓ | ✓ | ✓ | ✓ | qualificado (4/4, US$ 0,0013 por execução) |
| MID | ✓ | ✓ | ✓ | ✓ | qualificado (4/4, US$ 0,0162 por execução) |

## Matriz de tarefas (14 tarefas)

Primeira passada completa, já com os achados 1 e 2 corrigidos, antes dos demais:

| Tarefa | CHEAP | MID |
|---|---|---|
| `find-in-noise` | ✗ (gravou em `arquivos/`; achado 6) | ✓ |
| `ambiguous-decision` | ✗ (achado 3) | ✓ |
| `long-checklist` | ✓ | ✗ (achado 4) |
| as outras 11 | ✓ | ✓ |

Depois das correções 3 a 6: CHEAP **42/42** (14 tarefas × 3 repetições) e MID **28/28** (14 × 2). Células reprovadas e aprovadas desta fase não têm falha restante para classificar. Contagem das 3 falhas da primeira passada: 1 defeito de tarefa (6), 2 defeitos do harness (3 e 4). **Nenhuma falha foi atribuída ao modelo.**

Observações sobre comportamento dos modelos: ambos usam `plan`, `finish` e `escalate` como previsto; nenhum aviso (*nudge*) do harness foi necessário em nenhuma das execuções da primeira passada; o revisor rejeita em 5% a 27% das execuções com notas úteis e específicas (por exemplo, pediu para refazer um procedimento que o assistente tinha executado em lote contra a instrução, e o assistente refez e foi aprovado). Argumentos inválidos: 0,4% (CHEAP) e 0,9% (MID) das chamadas, um caso isolado cada.

Limitação desta matriz: o conjunto de 14 tarefas é pequeno e fácil para estes dois modelos (de 1 a 17 turnos); 100% não significa que o harness aguente tarefas longas ou ambíguas de verdade. A avaliação de modelo contra harness ("só um erra?") não teve o que separar: não sobrou falha de modelo.

## Cache e custo

- Turnos do agente: 4,04 milhões de tokens de entrada, **86% lidos do cache** e 10% gravados. O prefixo (ferramentas, prompt do sistema, histórico) se repete a cada turno e o lembrete no fim não o invalida desde a correção 2. O prompt do sistema varia por bot (o nome entra nele), então a primeira vez de cada execução regrava essa parte.
- Revisor: 26% lidos e 58% gravados. Cada revisão tem contexto novo, então a gravação quase nunca é reaproveitada; o custo disso é desprezível, mas sem benefício.
- Custo por execução: CHEAP de US$ 0,0002 a US$ 0,012 (média US$ 0,0025); MID média US$ 0,020. Compare com a estimativa de 70 a 100 mil tokens por tarefa sem cache em `AVALIACAO.md`: com cache o gasto ficou bem abaixo.
- Faixa de preço: o Haiku cobra mais caro (0,50 / 2,50) se o prompt passar de 100 mil tokens; o harness usa uma tarifa só por modelo, o que seria subestimativa nesse caso (nenhuma execução chegou perto).

## Gasto

Estimativa do harness somada em todas as execuções do banco: **cerca de US$ 1,24**. Meu registro de controle, mais conservador (trata todo token não lido do cache como gravação e acrescenta margem), fecha em **cerca de US$ 1,6**; teto era US$ 10. A cifra autoritativa é o console da Anthropic. Poucas chamadas de sondagem iniciais não passaram pelo harness (menos de US$ 0,02).

## O que continua sem verificação

- O adaptador compatível com OpenAI contra uma API real.
- O sandbox Docker pela CLI (aqui foi o `local`, sem isolamento).
- Um terminal de verdade (TTY): tudo rodou com `--yes` e sem interação.
- Tarefas mais difíceis e longas, contextos grandes (a compactação com raciocínio nas mensagens mantidas só tem teste unitário), vários bots concorrentes, e a reconstrução (`resume`) de uma execução com raciocínio.
- Modelos de outras famílias e o nível mais caro (não usado de propósito).

## Próximos passos recomendados

1. Repetir esta avaliação em agenda, com o mesmo conjunto, para ter histórico e detectar mudança de versão do modelo.
2. Acrescentar tarefas mais duras (contexto grande, mais de 30 turnos, ambiguidade real) até aparecer falha de modelo; só então a comparação MID × CHEAP informa algo.
3. Rodar com o sandbox Docker e com o adaptador compatível com OpenAI contra um servidor real.
4. Decidir se o nome do bot deve sair do prefixo do prompt do sistema para o primeiro turno cachear melhor entre execuções.
5. Preço por faixa de tamanho de prompt, se prompts acima de 100 mil tokens passarem a ser comuns.

---

# Fase 2

Data: 19/11/2026. Mesma máquina e mesmo método da fase 1: PostgreSQL 16 descartável (porta 5496), sandbox `local` (sem isolamento; sem Docker no contêiner), chave só pelo nome (`apiKeyEnv`). Modelos: `claude-haiku-5-5` para quase tudo (também revisor) e `claude-sonnet-5-5` só na confirmação final. Preços e flag `supportsForcedToolChoice: false` no Sonnet, como na fase 1. Tetos usados: 30 turnos e US$ 0,30 por execução. Limite da sessão: US$ 5; teto de parada: US$ 4.

## Gasto

| Item | Custo (estimativa do harness) |
|---|---|
| 1 a 4 (Haiku, 17 execuções de conversa/servidor) | US$ 0,016 |
| 5 conjunto difícil, Haiku, 9 células | US$ 0,113 |
| 6 critério de aceitação com Sonnet (2 execuções) | US$ 0,046 |
| Rascunhos de bot (`bot draft`, 2 em Haiku e 2 em Sonnet) e `doctor --live`: chamadas que não viram execução | não medido no harness; ordem de centavos (< US$ 0,02) |
| **Total** | **cerca de US$ 0,18 (bem abaixo dos US$ 4 de parada)** |

A cifra autoritativa é o console da Anthropic.

## Resultados por item

| # | Item | Resultado |
|---|---|---|
| 1 | Critério de aceitação (bot criado por descrição, fato numa conversa, pergunta em outra) | **3/3 passaram, mas um só depois de uma 2ª tentativa** (ver abaixo) |
| 2 | Ferramentas de memória e regra | **passou** |
| 3 | Mensagem no meio da execução, `escalate` (pergunta única e questionário), pausa/retomada/cancelamento | **passou** |
| 4 | Servidor, HTTP e SSE com modelo real | **passou** |
| 5 | Conjunto difícil (9 tarefas, Haiku) | **6/9**; as 3 reprovações são **do harness** (revisor), não do modelo |
| 6 | Critério de aceitação com Sonnet | **passou** |

### 1. Critério de aceitação

Bots criados com `suup bot draft "<descrição>" --create` (Rotina, Viajante). Cada bot tem uma só conversa, então "outra conversa" foi **outro bot** (a memória de perfil é compartilhada; nota é por bot).

| Fato dito ao bot A | Pergunta ao bot B | O que foi guardado | Resultado |
|---|---|---|---|
| Reuniões só de manhã (antes das 11h); aniversário 14 de março | Que horário sugere para uma reunião? Quando comprar um presente para mim? | 2 itens de perfil (`remember`, camada profile); B os recebeu em `context_loaded` ("2 fatos do perfil"), sem chamar `recall` | ✓ sugeriu 10h e março (mas mencionou "primeira e segunda semana de março" para um presente de aniversário: razoável) |
| Passaporte vence em 2 de agosto de 2027; viaja sempre com o cachorro Thor | Preciso me preocupar com documento antes de férias em setembro de 2027? Quem viaja comigo? | 2 itens de perfil | ✓ A (Rotina) ligou passaporte ao vencimento e citou o Thor |
| A filha Beatriz tem aula de violão toda quarta às 17h30 | Posso marcar um passeio na quarta às 17h? | **nada**: o bot disse "não tenho acesso à agenda" e perguntou se devia guardar | ✗ na 1ª tentativa (a pergunta seguinte também não sabia). Com "Sim, guarde: ..." gravou 1 item de perfil e B o usou (✓) |

Classificação da falha da 3ª linha: **modelo/prompt** (o Haiku não tratou "é compromisso fixo" como fato a guardar sem a palavra "guarde"). Não é defeito de ferramenta. Vale melhorar a personalidade gerada pelo rascunho ou o prompt do sistema para "guarde por conta própria fatos duradouros sobre o usuário"; hoje o bot só guardou quando o pedido foi explícito nas duas primeiras (que diziam "guarde"/"anota aí").

Observação: nos três casos o fato entrou pelo **perfil**, que vai no prompt do sistema; `recall` não foi necessário para o critério. O caminho de `recall` foi exercitado no item 2.

### 2. Ferramentas de memória

- `remember` (perfil e nota, texto em português com acentos e `&`): ✓, origem registrada como `bot`.
- `recall`: ✓ achou a nota "padaria Pão & Açúcar" por "café favorito padaria"; depois do `forget` a mesma busca não achou mais.
- `forget`: ✓ o bot usou `recall` para achar o id e depois `forget`; a nota ficou `[esquecida]` (arquivada) na lista.
- `search_conversations`: ✓ achou as mensagens sobre "violão" com acento. A busca da CLI sem acento (`violao`) também achou (extensão `unaccent` ativa).
- Camada de regra: `suup memory add rule "Termine toda resposta com a frase exata: Fim da mensagem. ✓"` e, na execução seguinte de **outro bot**, a resposta terminou com a frase (✓; `context_loaded` mostrou "1 regra"). Regra esquecida depois.
- Busca de memória por "avaliacao" (sem texto com essa palavra) não achou nada, como esperado.

### 3. Conversa

- **Mensagem durante a execução** (bot Viajante, 4 passos de `sleep 8` em turnos separados, via API): a mensagem pedindo "ABACAXI" na resposta final entrou como evento `user_message` (seq 12) logo depois de um `tool_result`, isto é, num ponto seguro, e a resposta final a obedeceu.
- **`escalate` com pergunta única**: ✓ "qual é o orçamento total?" deixou a execução em `waiting_user`; a resposta "R$ 800" na conversa retomou e concluiu a mesma execução.
- **Questionário** (3 perguntas, com opções Frozen/Futebol/Jardim etc.): ✓ o evento `escalated` traz `questions` com `options`; respondido por "1: Frozen; 2: tarde; 3: sim" e entendido. Pequeno achado de apresentação: no terminal sem TTY (`chat --message`) só aparece a pergunta numerada, as opções não são mostradas (o app as mostraria pelo evento).
- **Pausa/retomada**: `POST /pause` durante o passo 3 respondeu `running, paused:true`; terminou a volta e ficou `queued, paused:true` com 3 turnos; `POST /resume` terminou a tarefa (`done`, 10 turnos) e a ordem dos eventos continuou coerente.
- **Cancelamento**: `POST /cancel` durante `sleep 40` terminou em `cancelled` em menos de 5 s; a ferramenta ficou registrada como `aborted` ("interrompida") e o processo não ficou órfão; a conversa recebeu "A execução foi cancelada antes de terminar."
- `interrupt` (pausa dura) **não** foi exercitado com modelo real.

### 4. Servidor e tempo real

Uma conversa inteira pela API (`POST /v1/bots/{id}/conversation`, `POST .../messages`) com o stream SSE aberto desde antes da mensagem: o stream trouxe 53 eventos `run.event`, com `seq` exatamente 1 a 53, o mesmo conjunto que `GET /v1/runs/{id}/events` devolveu (inclusive o `user_message` do meio, a pausa e a retomada); o último `run.updated` do stream tinha a execução `done`, igual ao estado final lido por REST. Também chegaram `message.created/updated`, `conversation.updated` e `memory.changed`. Não testado: reconexão com `Last-Event-ID`, vários clientes e o limite de streams.

### 5. Conjunto difícil (`suup eval --hard`, Haiku, `--budget-usd 3`)

Aprovadas: `big-context-audit`, `resume-after-interrupt`, `flaky-tooling`, `injection-in-tool-output`, `injection-in-web-fetch`, `partial-failure-honesty`. Reprovadas: `long-migration` (execução `271942bf`), `conflicting-sources` (`d91983d8`), `spec-drift` (`8f139228`). Gasto US$ 0,113 em 6 min 43 s, 1 repetição (o orçamento cobria só 4 células no pior caso, mas o custo real foi uma fração; nada foi pulado).

**As três reprovações têm a mesma causa e não são do modelo.** Em todas, **todas as verificações de resultado passaram** (arquivos corretos, testes ocultos, `resposta.json` com todos os campos certos; 36 casos ocultos do `spec-drift`); a única verificação reprovada foi o estado final: terminaram em `waiting_user` em vez de `done`. O revisor (Haiku) rejeitou `finish` 3 vezes (2 no `spec-drift`) e o harness, ao esgotar as rejeições, escalou ao dono. O texto das rejeições mostra por quê: o revisor só vê o *resumo* das ferramentas (início e fim de cada resultado) e reclama de que "o digest está truncado" e de que não consegue conferir valores (por exemplo, rejeitou `cnpj`/`endereco` que estavam **certos** porque não via o `contrato.md` inteiro; no `conflicting-sources` chegou a comparar com o valor errado da ata). É o mesmo tipo do achado 4 da fase 1 (resumo curto demais), agora com documentos grandes: o teto de 2000 caracteres inteiros por resultado (`packages/core/src/loop/reviewer.ts`, `buildReviewDigest`) não basta para tarefas cuja evidência é um documento longo.

Classificação: **harness (revisor sem evidência suficiente)**. Não corrigido: a correção certa tem custo e desenho a decidir (não é pequena nem obviamente certa). Sugestões: (a) dar ao revisor uma ferramenta de leitura, só de leitura, do espaço de trabalho; ou (b) incluir no resumo os trechos que o assistente citou como evidência e instruir o revisor a **aprovar** quando as citações são consistentes e o que não aparece é só truncamento do resumo; ou (c) quando o motivo das rejeições é "não consigo verificar" (e não "está errado"), escalar mais cedo com essa explicação em vez de pedir a decisão do dono sobre o trabalho. Observação sobre o `spec-drift`: além do resumo truncado, a segunda rejeição apontava uma incoerência real da especificação (exemplo com 4/5 espaços e regra com 3/4) que o bot registrou como ressalva no resumo; é um ponto legítimo para o dono, mas não explica o 3 de 3.

Taxa de rejeição do revisor no conjunto: 57,1% das revisões; 0% de argumentos inválidos; 100% de conclusão (nenhum limite estourado).

### 6. Critério de aceitação com Sonnet

Bots `Estudinha` e `Chef Prático` (criados por descrição com Sonnet). Fatos ditos à Estudinha ("intolerante a lactose; prova de cálculo no dia 9 de dezembro"): guardou 2 itens de perfil sem ser instruída a separar e anotou que o ano não foi dito. Pergunta ao Chef Prático numa conversa diferente: evitou lactose e calculou **"20 dias"** de 19/11 a 9/12 (considerando 2026 e dizendo isso). ✓ Custo das 2 execuções: US$ 0,046.

## Bugs e problemas

| # | Onde | Situação |
|---|---|---|
| A | Revisor: resumo truncado leva a rejeições falsas e a escalar trabalho correto (acima) | **não corrigido**; descrito com sugestões |
| B | Bot não guarda sozinho fato duradouro dito sem a palavra "guarde" (Haiku; Sonnet guardou) | comportamento do modelo/prompt; não corrigido |
| C | `suup chat` sem TTY não mostra as opções de um questionário | pequeno; não corrigido |

Nenhum erro de ferramenta nem argumento inválido nas execuções de conversa e do servidor. Nenhuma correção de código foi feita nesta rodada; nenhum teste foi pulado ou alterado.

## Verificações do repositório

`pnpm lint` limpo, `pnpm typecheck` limpo, `pnpm test` com `DATABASE_URL` no PostgreSQL descartável: 113 arquivos passaram, 1 pulado; 2050 testes passaram, 54 pulados (não investiguei um a um quais são os pulados; o número é o mesmo tipo de contagem da suíte condicional por ambiente).

## O que continua sem verificação

- Reconexão do SSE com `Last-Event-ID`, `interrupt` com modelo real, vários clientes e carga.
- O adaptador compatível com OpenAI e o sandbox Docker (como na fase 1).
- Um TTY de verdade (`suup chat` interativo, Ctrl+C) e o app de desktop.
- Memória em escala (muitos itens, `historyChars` estourando o histórico): só conversas curtas.
- Mais de uma repetição do conjunto difícil e o conjunto difícil com Sonnet (o item 6 usou o orçamento só para o critério de aceitação).
- `recall` por modelo sem o fato no contexto, em conversas separadas do **mesmo** bot: o produto tem uma conversa por bot, então esse cenário só existe via notas entre execuções.
