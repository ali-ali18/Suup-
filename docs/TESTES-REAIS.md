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
