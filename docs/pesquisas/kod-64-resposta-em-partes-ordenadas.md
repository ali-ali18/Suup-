# Pesquisa: respostas intercaladas (balão de texto, cartão de ferramenta, balão de texto) em chat com agente

Data de leitura de todas as fontes: 25/11/2026. Todas as fontes abaixo foram lidas no texto baixado via `curl -sL`, não via resumo de buscador.

## Pergunta

Como um chat com agente (LLM com ferramentas) mostra a resposta como "balão de texto → cartão (ferramenta/ação) → balão de texto", na ordem em que os fatos acontecem, com streaming ao vivo e sem balões duplicados ou piscando?

## Fontes

1. **Anthropic, Messages API: streaming**
   URL: https://platform.claude.com/docs/en/build-with-claude/streaming
   Lida em 25/11/2026.

2. **Anthropic, Messages API: tool use (implementar, resposta com tools)**
   URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
   Lida em 25/11/2026.

3. **OpenAI, Responses API: referência de streaming (eventos e esquemas)**
   URL: https://platform.openai.com/docs/api-reference/responses-streaming
   Lida em 25/11/2026. Trechos usados: `ResponseOutputItemAddedEvent`, `ResponseOutputItemDoneEvent`, `ResponseOutputMessage`, `ResponseTextDeltaEvent`, `ResponseFunctionCallArgumentsDeltaEvent`, `ResponseCompletedEvent`.

4. **OpenAI, guia de streaming de respostas**
   URL: https://platform.openai.com/docs/guides/streaming-responses
   Lida em 25/11/2026. Serve de contexto; o detalhe de eventos está na referência acima.

5. **Vercel AI SDK, UI: Stream Protocols**
   URL: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
   Lida em 25/11/2026.

6. **Vercel AI SDK, UI: Chatbot Message Persistence**
   URL: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
   Lida em 25/11/2026.

7. **Vercel AI SDK, referência: useChat**
   URL: https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat
   Lida em 25/11/2026.

8. **LangGraph, streaming (opcional)**
   URL: https://docs.langchain.com/oss/python/langgraph/streaming
   Lida em 25/11/2026. A URL `langchain-ai.github.io/langgraph/...` redireciona por JavaScript para esta página, por isso usei a URL final.

9. **assistant-ui (opcional): NÃO LIDA.**
   As URLs `https://www.assistant-ui.com/docs` e `https://assistant-ui.com` retornaram erro de conexão pelo proxy (código 000), e o repositório no GitHub não está habilitado nesta sessão. Esta seção fica sem fonte primária.

## O que cada uma faz

### 1. Anthropic Messages API

- Uma resposta do assistente é **uma mensagem com um array `content` ordenado**. Cada item é um bloco (`text`, `tool_use`, `thinking`, `server_tool_use`, `web_search_tool_result` etc.).
- Streaming por SSE: `message_start` (com `content` vazio), depois uma sequência de blocos, cada um com `content_block_start`, zero ou mais `content_block_delta` e `content_block_stop`, depois `message_delta` e `message_stop`.
- O campo `index` do evento corresponde à posição no array `content` da mensagem final. Esse é o identificador de posição do bloco dentro da resposta.
- Em `tool_use`, os deltas são `input_json_delta` (JSON parcial em string). O `input` final só é um objeto depois de `content_block_stop`.
- A doc diz que o Claude "muitas vezes comenta o que está fazendo ou responde naturalmente antes de chamar ferramentas". O exemplo de resposta mostra o bloco `text` e, no mesmo array, o bloco `tool_use` depois. Ou seja, o texto antes da ferramenta é um bloco separado do `tool_use`.
- O `tool_use` tem `id` (`toolu_...`). A resposta da ferramenta volta do cliente como bloco `tool_result` que referencia esse id, numa nova requisição.
- Blocos de ferramenta do lado do servidor (`server_tool_use`) e seus resultados (`web_search_tool_result`) também são blocos no mesmo array, com `tool_use_id`.

### 2. OpenAI Responses API

- A resposta é uma **lista de itens de saída** (`output`). Cada item tem `id`, `type` e um `output_index` na resposta. Os tipos vistos na referência incluem `message` (com `content` de `output_text` ou `refusal`) e itens de chamada de função (`function_call`).
- Eventos de streaming: `response.output_item.added` (traz o `item` e o `output_index`), `response.output_item.done` (item finalizado), `response.content_part.added`, eventos de delta de texto (`ResponseTextDeltaEvent`, com `item_id`, `content_index`, `delta`), e eventos de delta de argumentos de função (`ResponseFunctionCallArgumentsDeltaEvent`, com `item_id` e `output_index`). Todo evento tem `sequence_number` para ordenação.
- A doc diz que, para itens de raciocínio, o `item` em `output_item.added` pode estar incompleto; o item correto vem em `output_item.done`.
- Texto antes e depois de uma chamada de função são **itens separados** (um `message` e um `function_call`, com `output_index` diferentes).
- Não há um evento de "balão". O conceito de mensagem é o item `message`; o cartão de ferramenta é o item `function_call`.

### 3. Vercel AI SDK UI (UIMessage, parts, stream protocol)

- `UIMessage` tem `id`, `role` e `parts`. O front itera `message.parts` e renderiza cada parte pelo `part.type` (`text`, `tool-*`, `data-*`, `reasoning` etc.). **Uma mensagem do assistente é uma mensagem com partes ordenadas.**
- O protocolo de stream de dados (UI message stream) usa SSE com partes em padrão start/delta/end:
  - Texto: `text-start` (com `id`), `text-delta` (com `id` e `delta`), `text-end` (com `id`). O `id` identifica o bloco de texto dentro da mensagem.
  - Ferramenta: `tool-input-start` (com `toolCallId` e `toolName`), `tool-input-delta` (com `toolCallId`), `tool-input-available` (com `input` completo), `tool-output-available` (com `output`), e `tool-output-denied`/`tool-approval-request` para aprovação.
  - Passos: `start-step` e `finish-step` marcam cada chamada ao modelo dentro de uma mensagem com várias chamadas. A doc diz que `finish-step` é necessário para processar mensagens "costuradas" quando há ferramentas no backend e `steps` no `useChat`.
  - `reset-step` remove as partes recebidas desde o último `start-step`, para descartar a saída parcial de uma tentativa que foi refeita.
  - `start` traz o `messageId`. `finish` encerra a mensagem. `abort` indica interrupção. O stream termina com `data: [DONE]`.
- Partes de ferramenta são identificadas por `toolCallId`. O guia de persistência diz que é preciso usar ids estáveis antes de salvar.
- Ids de mensagem: o `useChat` gera o id no cliente por padrão. Para persistência, a doc recomenda ids estáveis gerados no servidor, com `generateMessageId` em `toUIMessageStream` ou com a parte `start` do `createUIMessageStream`. O id do usuário é gerado no cliente antes do envio e deve ser mantido ao salvar.
- Reconexão: o `useChat` tem `resumeStreamIsReplay` (padrão `true`): ao retomar um stream, a resposta interrompida é zerada no primeiro chunk `start` e reconstruída a partir do replay. Com `false`, o endpoint envia só o restante.
- `onFinish` recebe as mensagens, incluindo a resposta completa, quando o stream termina.
- Não encontrei nas páginas lidas um `id` próprio para cada parte de texto no `UIMessage`. O id do bloco de texto aparece no stream (`text-start`). Não afirmo que ele persiste no objeto `UIMessage`.

### 4. LangGraph (opcional)

- O streaming é por **modos** (`stream_mode`): `values`, `updates`, `messages`, `custom`, `checkpoints`, `tasks`, `debug`. Podem ser combinados.
- `updates` emite a mudança de estado após cada passo do grafo, com o nome do nó. Várias atualizações no mesmo passo saem separadas.
- `messages` emite tuplas `(message_chunk, metadata)` de chamadas ao LLM, token a token, de qualquer nó, ferramenta ou subgrafo. O `metadata` traz o nó e a invocação.
- `custom` permite emitir dados arbitrários do nó, para LLMs que não são integração LangChain.
- Ou seja, LangGraph separa "mudança de estado por passo" de "tokens do modelo". Quem monta os balões e cartões é o cliente, a partir desses eventos.

## Tabela comparativa

| Pergunta | Anthropic Messages | OpenAI Responses | Vercel AI SDK (UIMessage) | LangGraph |
|---|---|---|---|---|
| Unidade de "mensagem do assistente" | Uma mensagem com array `content` ordenado | Lista `output` de itens (cada item: `message`, `function_call`, `reasoning`) | Uma `UIMessage` com `parts` ordenadas | Não define mensagem; emite estado por passo e tokens |
| Ordem entre texto e ferramenta | Blocos no mesmo array, na ordem de geração | Itens com `output_index` | Partes na ordem do stream | Ordem dos eventos de stream |
| Id estável do bloco/item | `index` (posição na resposta); `id` nos `tool_use` (`toolu_...`) | `item_id` e `output_index`; `sequence_number` por evento | `id` no `text-start`; `toolCallId` nas ferramentas; `messageId` na mensagem | `metadata` do nó e id da task/namespace (`ns`) |
| Texto antes e depois de ferramenta é parte separada? | Sim: blocos `text` e `tool_use` separados | Sim: itens `message` e `function_call` separados | Sim: partes `text` e `tool-*` separadas | Não se aplica diretamente (tokens em `messages`, eventos em `updates`) |
| Streaming | SSE: `content_block_start/delta/stop` | SSE: `output_item.added/done`, deltas com `item_id` | SSE: `text-start/delta/end`, `tool-input-*`, `start-step/finish-step` | Modos `updates`, `messages`, `custom`... |
| Reconexão/replay | Não descrito nas páginas lidas | Não descrito nas páginas lidas | `resumeStreamIsReplay` no `useChat` | Não descrito nas páginas lidas |
| Mecanismo oficial para dividir texto puro em vários balões sem ferramenta | Não encontrado nas páginas lidas | Não encontrado; texto pode ter várias partes `output_text` dentro do mesmo item, mas isso não é apresentado como balão | Não encontrado como recurso; o protocolo tem blocos `text` múltiplos, mas a doc não o apresenta como balão | Não se aplica |

## Respostas às perguntas

**1. Uma "mensagem do assistente" é uma mensagem com partes ordenadas ou várias mensagens?**
É **uma mensagem com partes (blocos/itens/partes) ordenadas** nas três APIs que li. Anthropic: um `message` com `content`. OpenAI: uma resposta com `output`. Vercel: uma `UIMessage` com `parts`. Quem divide em balões e cartões é o cliente, a partir dessas partes. A doc não pede uma mensagem nova a cada passo do loop.

**2. Como cada parte recebe id estável, para que stream e recarregamento não dupliquem nada?**
- Anthropic: o `index` do bloco é a posição final no `content`, e o `id` do `tool_use` é estável e referenciado pelo `tool_result`.
- OpenAI: cada item tem `id` e `output_index`, e os deltas trazem `item_id`. Eventos têm `sequence_number`.
- Vercel: o `id` do bloco de texto vem em `text-start`, as ferramentas usam `toolCallId`, e a mensagem tem `messageId`. A doc recomenda gerar esses ids no servidor e mantê-los ao salvar, para não haver conflito após restaurar.
A regra comum: **o id é atribuído quando a parte começa (start), não quando ela termina**, e os deltas se acumulam nessa parte. Recarregar é reconstruir a partir da mesma sequência de partes, sem criar novas.

**3. Texto antes e depois de uma chamada de ferramenta é parte separada?**
Sim, nas três APIs. São blocos/itens/partes diferentes na ordem em que aparecem. Na Anthropic, o texto antes do `tool_use` está no mesmo `content` da resposta; o texto depois vem na requisição seguinte, depois do `tool_result`. Esse segundo texto é uma nova resposta do modelo, mas a ordem na exibição continua sendo a da sequência de eventos.

**4. Existe mecanismo oficial para dividir texto puro em vários balões, sem ferramenta, estilo WhatsApp?**
**Não existe nas fontes que li.** Nenhuma das quatro páginas oficiais apresenta "múltiplos balões de texto" como recurso. Há blocos `text` múltiplos no protocolo, e partes de texto podem aparecer várias vezes, mas as docs tratam isso como detalhe de transporte, não como quebra de balão. Se o produto quer balões separados, a divisão tem de ser decisão da aplicação (regra determinística no backend ou no renderizador), não uma feature do modelo. Não conferi se a assistant-ui ou outra biblioteca oferece isso, porque não consegui ler a documentação dela.

## Conclusão prática para um harness que persiste eventos no Postgres e desenha o chat a partir deles

1. **Uma execução (run) = uma mensagem do assistente** com `message_id` estável, criado no início da execução. Cada passo do loop **acrescenta partes** a essa mensagem; não cria mensagem nova. O resumo final também não é uma mensagem nova: é texto que, se já foi transmitido, não é reemitido.

2. **Modele a mensagem como lista de partes persistidas**, com esta chave única: `(run_id, part_id)`. Tipos sugeridos: `text`, `tool` (com `tool_call_id`, `name`, `input`, `output`, `status`), e eventos de controle. `part_id` vem do provedor sempre que existir (`toolu_...`, `item_id` da OpenAI, `toolCallId`), e é gerado pelo harness apenas quando o provedor não dá id (blocos de texto), **no momento do start**.

3. **Ordem:** use uma sequência monotônica (`seq`) por run, atribuída ao gravar cada evento. A renderização ordena por `seq`. Isso evita depender de horário de relógio e da ordem de chegada de deltas paralelos.

4. **Streaming sem duplicar:** cada delta é um `UPSERT` ou um `append` no `part_id` já existente; o evento de fim (`part.done`) **substitui** o texto acumulado pelo valor final, em vez de somar de novo. A tela assina os eventos do run e aplica pelo `part_id`. Se a tela recarregar, ela busca os eventos ordenados por `seq` e reconstrói as mesmas partes com os mesmos ids.

5. **Texto antes e depois de ferramenta** vira partes separadas porque o provedor já as separa (bloco `text` antes do `tool_use`; novo bloco `text` na resposta seguinte). O harness só precisa gravar cada bloco na ordem em que chegou.

6. **Balões extras de texto puro:** não dependa do modelo para declarar partes ou "finish com partes". Isso já falhou no teste anterior, e as APIs lidas não oferecem esse mecanismo. Se o produto quiser múltiplos balões, o harness decide a fronteira por regra fixa (por exemplo, um bloco de texto do provedor = um balão) e grava isso como evento persistido (`segment.start`), nunca como saída do modelo.

7. **Diagnóstico dos bugs antigos:** (a) mensagem por passo do loop = balões duplicados e fora de ordem; (b) resumo final que reemite o conteúdo = duplicação. A correção é a regra 1 (uma mensagem por run, partes acrescidas) e a regra 4 (fim do bloco substitui, não soma).

8. **Lacunas desta pesquisa:** assistant-ui não foi lida; não confirmei nas páginas lidas se a parte de texto do `UIMessage` tem id próprio; não confirmei o nome literal de todos os tipos de evento da OpenAI além dos citados acima (usei os nomes de classe da referência).

## Decisão adotada (KOD-64, 25/11/2026)

A conclusão prática acima virou isto no Suup, com uma diferença: a "mensagem do assistente com partes" do chat é a **sequência de mensagens do bot na tabela `messages`**, e não uma coluna `parts` numa mensagem só (uma mensagem que cresce no tempo faria o chat piscar e a contagem de não lidas disparar uma vez só, no começo).

- **Uma parte = uma mensagem do bot por bloco de texto** de um `model_response` que também traz chamadas de ferramenta. É gravada **na mesma transação do evento** (`appendRunEvent`), então o log e o chat nunca divergem.
- **Identidade determinística**: chave única da conversa `run:<execução>:part:<seq do evento>:<posição do bloco>`, atribuída quando a parte começa (regra 2 da conclusão). Reentrega, nova tentativa e retomada de execução abandonada não duplicam (o evento é imutável e a resposta já registrada é reaproveitada).
- **Ordem**: a mensagem carrega `eventSeq` (o `seq` do evento) e o app a compara com o `seq` do evento da chamada do cartão; o relógio só entra quando falta o `seq` (`now()` do Postgres é o início da transação, e duas gravações podem empatar).
- **Nada de dividir texto puro**: um turno só de texto continua uma mensagem (a resposta, gravada pelo fim da execução). Um turno com `finish` não posta fala (o resumo já é a mensagem final), e só execuções que respondem a uma conversa (`user`, `reception`) postam falas.
- Sem streaming por token (fica para o KOD-34); a fala aparece quando a resposta do modelo termina.
