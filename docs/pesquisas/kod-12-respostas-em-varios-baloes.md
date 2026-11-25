# KOD-12 — respostas em vários balões

**Pesquisa atualizada em:** 25/11/2026

**Escopo:** mapear a saída de texto, a persistência, a exibição no desktop e os pontos em que uma resposta estruturada em partes pode coexistir com cartões, ferramentas e replay. Sem alterações de código ou chamadas a modelo.

## Conclusão

A unidade persistida e transmitida hoje é uma mensagem com um único `text`. A resposta final de uma execução de conversa nasce do `summary` aceito por `finish`. A mudança mínima é permitir uma lista **opcional e explícita** de partes textuais no próprio resultado de `finish`, validar e registrar essa lista junto ao resumo e gravar cada parte como mensagem própria, em lote e com chave de idempotência por posição. O resumo continua sendo o resultado agregado para diário, delegação e clientes antigos; se a lista não existir, o comportamento atual de uma mensagem permanece.

A separação é escolha do modelo dentro de uma estrutura declarada, nunca inferida de pontuação, quebras de linha, regex ou igualdade de texto. Uma lista vazia/inválida deve seguir a validação do finish, sem criar resposta parcial. Duas partes com texto igual continuam sendo duas partes, pois conteúdo idêntico não prova que uma delas seja duplicata.

## Fontes primárias

- OpenAI, **Structured outputs**, https://platform.openai.com/docs/guides/structured-outputs (redireciona para a documentação atual em `developers.openai.com`). Consultada em 25/11/2026; a página não indica data de publicação no conteúdo lido. Documenta saída validada por schema e diferencia saída estruturada, recusas e respostas incompletas. Serve como evidência de viabilidade de representação estruturada, não como garantia de suporte uniforme entre provedores.
- Anthropic, **Structured outputs**, https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs (redireciona para `platform.claude.com`). Consultada em 25/11/2026; sem data de publicação indicada. Descreve JSON constrained por schema. É corroborativa; o Suup deve continuar validando no seu próprio schema e manter fallback compatível.
- Anthropic, **Tool use**, https://docs.anthropic.com/en/docs/build-with-claude/tool-use (redireciona para `platform.claude.com`). Consultada em 25/11/2026; sem data de publicação indicada. Descreve blocos estruturados de chamada de ferramenta, execução pela aplicação e retorno do resultado ao modelo. Sustenta a separação conceitual entre saída da ferramenta e resposta final do modelo.

- Microsoft Teams, **Send and receive messages**, https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability, consultada em 25/11/2026. A documentação descreve mensagens e cartões estruturados e permite que o agente envie uma ou várias respostas.
- Matrix, **Transaction identifiers**, https://spec.matrix.org/latest/client-server-api/#transaction-identifiers, consultada em 25/11/2026. A especificação usa identidade de envio para reconhecer retransmissões, inclusive quando duas mensagens novas têm o mesmo conteúdo.

## Caminho atual do texto

| Camada | Comportamento verificado |
|---|---|
| Core / `finish` | `finishInputSchema` aceita `summary` textual e `evidence`. A chamada aceita produz `finish_attempt`; o resultado final da execução usa `runResultSchema` (`summary` obrigatório, `evidence` opcional). Não há uma coleção de balões. |
| Eventos e replay | `model_response` guarda blocos da resposta do modelo para reconstruir o contexto da execução; `rebuildState` os usa como mensagens internas do loop. Isso não é a fonte da conversa exibida ao usuário. O replay/reconstrução deve preservar os campos novos como dados do finish, sem converter blocos internos de raciocínio/resposta em balões. |
| Runtime / persistência | `finishRun` chama `outcomeMessage`; em `done`, grava o `summary` como uma mensagem bot, com `run:<id>:done`. A reconciliação após falha do worker e a reentrega usam `appendMessageOnce`. Diário e delegação também leem o resumo, portanto ele continua necessário. |
| API / stream | `messageSchema` expõe uma linha `text` por mensagem. SSE tem `message.created` e replay por identificador de evento; o cliente pode receber cada mensagem persistida e preservar IDs/ordem. Não é necessário transmitir tokens para oferecer vários balões. |
| Desktop | `ChatScreen` constrói `buildTimeline(messages, runs, ...)` a partir das mensagens persistidas e cartões. Eventos de execução ficam em superfícies de atividade/inspeção, não são fonte de texto da conversa. `bubblePositions` já agrupa mensagens consecutivas do mesmo emissor e separa cartões/ações. |

## Auditoria de possíveis duplicidades

**Não foi verificada uma duplicidade atual do mesmo trecho de texto entre esses caminhos.** Há riscos de repetição semântica, mas não se deve resolver removendo texto igual nem escondendo um dos elementos na interface.

| Caminho | O que existe hoje | Estado da hipótese |
|---|---|---|
| Texto intermediário / step | Eventos internos `model_response`, `plan_updated` e ferramentas não entram como texto de `buildTimeline`. | **Não é duplicidade atual da conversa.** Fazer partes finais derivadas desses eventos também apareceria como vazamento de processo e conflitaria com o princípio de mostrar o resultado. |
| Lead de pergunta com cartão | `waiting_user` grava texto compatível com clientes textuais (`lead + pergunta`) e mantém `question.lead`. Desktop, para pergunta com opções, mostra o lead como balão e pergunta/opções no cartão; não desenha `message.text` integral. | **Duplicidade visual não observada.** O teste `what the bot wrote besides the question is the message's lead...` documenta essa distinção. Uma nova representação não pode adicionar outra cópia do lead. |
| Mensagem própria de ferramenta / cartão | `propose_team` persiste um cartão-mensagem; conectores derivam cartões de eventos; descrições de ferramentas orientam o bot a não repetir o cartão/link. O modelo pode mencionar a ação no resumo final. | **Possível repetição semântica**, não provada como emissão do mesmo texto. Preservar mensagem/cartão da ferramenta como saída própria; não a copiar automaticamente para a lista final e não suprimir partes por comparação textual. |
| Resumo final e partes | Hoje só há o resumo. Se o resumo agregado e as partes forem ambos emitidos como mensagens, cada frase sairia duas vezes. | **Risco novo e concreto da proposta.** Quando `parts` estiver presente, gravar somente as partes; manter `summary` no resultado para leitores não visuais e sistemas existentes. Não emitir também o resumo como balão. |
| Redelivery / reconciliação | `finishRun` declara idempotência; teste existente chama a finalização repetidamente e confirma que nada novo é gravado. | **Proteção verificada para uma mensagem.** Multi-partes precisa transação/batch e chave estável por parte para que reentrega não grave subconjunto ou duplique o conjunto. |
| Histórico / replay legado | Histórico e API guardam uma mensagem textual; runs antigos têm somente `summary`. | **Compatibilidade a preservar:** ausência de `parts` significa uma mensagem com o `summary` antigo. Nenhuma divisão retrospectiva por heurística. |

## Solução mínima e limites

1. Acrescentar a `finish` uma lista opcional estruturada, por exemplo `messages: string[]` (nome final a alinhar com convenções do core), com pelo menos um item não vazio quando fornecida. Sem lista, manter o único resumo atual como um balão. O modelo continua livre para responder em uma mensagem.
2. Definir o `summary` armazenado como agregado determinístico das partes quando elas forem fornecidas, para diário, delegação, histórico, recuperação e clientes textuais. A emissão no chat usa as partes, não o agregado. Preservar `summary` existente para finish legado.
3. Persistir as partes como linhas de mensagem consecutivas, na mesma transação do efeito terminal. Identidade baseada em `runId + outcome + índice`, nunca no texto. Isso preserva duas partes iguais e permite uma escrita idempotente após crash/reentrega.
4. Só emitir partes após finish aceito e execução `done`. Tentativa rejeitada, evidência pendente ou finish entregue à pergunta de desempate não pode vazar respostas parciais; no caso de desempate, a pergunta atual continua sendo uma única emissão compatível, sem publicar além disso o resumo agregado.
5. O stream existente encaminha cada linha `message.created`; o desktop renderiza as mensagens em sequência e usa o agrupamento de balões já existente. Cartões são fronteiras visuais e continuam sendo desenhados a partir de seus dados próprios. Não alterar KOD-34 (streaming/token em tempo real).

A proposta é explícita e limitada ao conteúdo final de `finish`. Não adiciona uma entidade “step”, não divide texto por padrões e não transforma cada texto de ferramenta em resposta conversacional.

## Regressões que a implementação deve cobrir

- Finish sem `messages`: exatamente uma mensagem de resumo, compatível com runs e históricos antigos.
- Finish com partes distintas: uma linha por parte, na ordem, sem publicar também o resumo agregado.
- Finish com duas partes de texto exatamente igual: duas linhas preservadas, nunca deduplicadas por conteúdo.
- Repetir `finishRun` e executar reconciliação após a primeira escrita: mesmo conjunto ordenado, sem cópias extras; simular caminho de interrupção/reentrega para garantir escrita atômica.
- Finish recusado/revisão ainda pendente: nenhuma parte final persistida antes de aceitação.
- Pergunta com cartão e lead: um lead visível e uma pergunta no cartão; texto concatenado legado para clientes textuais sem dupla emissão no desktop.
- Saída de ferramenta/cartão seguida de finish: ferramenta/cartão mantém a própria saída; partes finais aparecem uma vez cada e conteúdo distinto, ainda que relacionado, não é descartado.
- Replay/histórico/API: runs antigos sem lista continuam com o resumo original; novos resultados mantêm agregado e emitem as partes na ordem; SSE/reconexão não cria novos IDs nem duplicatas.

## Arquivos de referência no repositório

`packages/core/src/loop/control-tools.ts`, `packages/core/src/loop/finish.ts`, `packages/core/src/loop/state.ts`, `packages/api/src/runs.ts`, `packages/api/src/stream.ts`, `packages/runtime/src/run-end.ts`, `packages/runtime/src/reception.ts`, `packages/runtime/test/conversations.test.ts`, `apps/desktop/src/features/chat/ChatScreen.tsx`, `apps/desktop/src/features/chat/timeline.ts`, `apps/desktop/src/features/chat/MessageList.tsx`, `docs/DESIGN.md`, `docs/FRONTEND.md`.
