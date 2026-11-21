# API do servidor

O servidor (`suup server`) é a API HTTP e o fluxo em tempo real que o app de desktop usa. Tudo o que a linha de comando faz com bots, conversas, execuções, memória e diagnóstico existe aqui. O contrato inteiro (esquemas, tipos, códigos de erro, o cliente tipado e o `subscribe`) está no pacote `@suup/api`, que o servidor e o app compartilham; este documento é a mesma coisa em texto.

- Base: `http://<endereço>:<porta>` (padrão `http://127.0.0.1:8787`). Todas as rotas, menos `/health`, ficam sob `/v1`.
- Formato: JSON em UTF-8. Datas são texto ISO 8601 em UTC (`2026-11-18T20:13:08.123Z`). Ids são UUIDs. Custo (`costUsd`) é texto decimal (`"0.034100"`), para o dinheiro nunca passar por número de ponto flutuante.
- Listas vêm como `{ "items": [...] }`; listas paginadas, como `{ "items": [...], "hasMore": true }`.
- Toda resposta leva `X-Request-Id` (o servidor aceita um que você mande, com letras, números, `.`, `_` e `-`, até 64 caracteres) e `Cache-Control: no-store`. O id aparece no log do servidor ao lado da linha da requisição.

## Autenticação

Um único usuário, um único token (`Authorization: Bearer <token>`), comparado em tempo constante.

- O token vem **só** de uma variável de ambiente, cujo nome está em `server.tokenEnv` (padrão `SUUP_SERVER_TOKEN`). Ele nunca fica no arquivo de configuração.
- O servidor **não sobe** sem token, nem com menos de 32 caracteres. `suup server --generate-token` imprime um novo (43 caracteres, 256 bits aleatórios).
- `GET /health` é a única rota sem token e só diz `{"status":"ok"}`.
- Qualquer outra rota sob `/v1`, **inclusive as que não existem**, responde `401` sem token válido: quem não tem o token não descobre quais rotas existem. O token na query string não vale.
- O servidor fala **HTTP puro**. Fora do seu próprio computador, ponha um proxy com TLS na frente ([IMPLANTACAO.md](IMPLANTACAO.md)); sem ele, o token e as conversas trafegam sem criptografia.

### CORS

Só as origens de `server.allowedOrigins` podem chamar a API de um navegador ou da webview. Uma requisição que traz `Origin` fora da lista (inclusive `/health`) leva `403 origin_not_allowed`, sem cabeçalhos CORS. Quem não manda `Origin` (curl, scripts) não é afetado. A preflight (`OPTIONS`) de uma origem permitida responde `204`, sem token, com `Access-Control-Allow-Methods`, `Allow-Headers` (`Authorization, Content-Type, Last-Event-ID, X-Request-Id`) e `Max-Age`.

Origens do app de desktop (Tauri) para acrescentar à lista, que por padrão é vazia:

| Plataforma | Origem |
|---|---|
| macOS e Linux | `tauri://localhost` |
| Windows | `http://tauri.localhost` (ou `https://tauri.localhost`, com o esquema HTTPS do Tauri) |
| Desenvolvimento (Vite) | `http://localhost:1420` |

## Erros

Todo erro tem o mesmo formato, e a lista de códigos é fechada:

```json
{ "error": { "code": "conflict", "message": "A execução já terminou e não pode ser pausada." } }
```

`message` é para a pessoa, em português; quem programa decide pelo `code`.

| `code` | HTTP | Quando |
|---|---|---|
| `invalid_request` | 400 | JSON malformado, campo ausente ou inválido, parâmetro de consulta inválido (a mensagem lista os campos) |
| `unauthorized` | 401 | Sem token, ou token errado (vem com `WWW-Authenticate: Bearer`) |
| `origin_not_allowed` | 403 | `Origin` fora de `server.allowedOrigins` |
| `not_found` | 404 | A rota ou o recurso não existe (um id que não é UUID também é "não existe") |
| `method_not_allowed` | 405 | A rota existe, não para este método |
| `request_timeout` | 408 | O corpo demorou demais para chegar, ou a resposta demorou além do limite (30 s; mais nas rotas que chamam modelos) |
| `conflict` | 409 | O recurso existe, mas o estado dele não permite: pausar uma execução terminada, mensagem para um bot arquivado... |
| `payload_too_large` | 413 | Corpo acima de `server.maxBodyBytes` (padrão 1 MiB) |
| `unsupported_media_type` | 415 | Corpo que não é `application/json` |
| `too_many_streams` | 429 | Já há `server.maxStreams` (padrão 16) streams abertos |
| `provider_error` | 502 | O provedor do modelo falhou (rascunho de bot, reenvio) |
| `internal_error` | 500 | Defeito do servidor; o detalhe fica no log, nunca na resposta |
| `unavailable` | 503 | O banco ou a máquina dos bots não responde, o servidor está desligando, ou o cofre está sem a chave (a mensagem diz qual variável falta) |

---

## Saúde e catálogos

### `GET /health`

Sem token. `200 {"status":"ok"}`. É o teste do `HEALTHCHECK` da imagem.

### `GET /v1/models`

Os modelos da configuração, para o formulário de bot. `200 { "items": [ModelInfo] }`:

```json
{ "id": "model-x", "provider": "anthropic", "providerKind": "anthropic",
  "contextWindow": 200000, "maxOutputTokens": 8192, "priced": true,
  "available": false, "unavailableReason": "a variável de ambiente ANTHROPIC_API_KEY não está definida" }
```

`available` diz se o provedor tem o que precisa (a chave de API no ambiente do servidor); `priced`, se há preço na configuração (só então o custo das execuções é contado).

### `GET /v1/tools`

As ferramentas que se pode liberar a um bot. `200 { "items": [ToolInfo], "control": ["plan","finish","escalate"] }` (com um cofre configurado, `control` traz também `request_secret`). `ToolInfo`: `name`, `summary` (a primeira frase do que o modelo lê, até 200 caracteres), `risk` (o nível **padrão** de uma chamada: `read`, `write_reversible` ou `external_irreversible`), `dynamicRisk` (a ferramenta classifica cada chamada pelos argumentos e pela máquina: o nível de uma chamada pode ser outro; é o caso do `shell`), `acceptsSecrets` (algum campo aceita `{{secret:NOME}}`), `externalOutput` (a saída chega ao modelo rotulada como dado não confiável) e `memory` (uma das quatro ferramentas de memória). As de `control` existem em todo bot, seja qual for `allowedTools`. A mudança de `write`/`external` para os níveis novos veio com a fase 3.

---

## Bots

`Bot`:

| Campo | Tipo | |
|---|---|---|
| `id`, `name`, `description`, `personality` | texto | |
| `modelProvider`, `modelId` | texto | O provedor sai do modelo, pela configuração |
| `allowedTools` | lista de textos | |
| `limits` | `{ maxTurns?, maxCostUsd?, maxDurationMs?, maxReturns? }` | Sem o campo, vale o padrão da configuração |
| `avatar` | texto ou `null` | Referência opaca que o app interpreta (emoji, id de arquivo...) |
| `isDefault` | booleano | O bot principal: recebe as mensagens quando nenhum é escolhido |
| `pinned` | booleano | Fixado no topo da lista do app |
| `groupName` | texto ou `null` | O grupo sob o qual o bot aparece (1 a 60 caracteres, sem espaços nas pontas); `null` é a lista padrão ("Bots"). Os grupos não têm tabela: existem enquanto algum bot os usa |
| `sortOrder` | inteiro ou `null` | Posição dentro do bloco (fixados, ou o grupo); `null` vem depois dos demais |
| `color` | id da paleta ou `null` | A cor do mascote e do balão do usuário na conversa: `laranja`, `azul`, `verde`, `roxo`, `rosa`, `amarelo`, `cinza`, `grafite` ou `branco`. O servidor guarda **só** esses ids, nunca CSS (`BOT_PALETTE` no `@suup/api` traz a cor e a cor do texto sobre ela, com contraste de pelo menos 4,5:1). `avatar` continua sendo o formato do mascote (por exemplo `mascot:gota`), texto opaco que o app interpreta |
| `createdAt`, `updatedAt`, `archivedAt` | data (a última ou `null`) | |
| `latestRun` | `{ id, status, paused, objective, createdAt }` ou `null` | A execução mais recente do bot, de qualquer origem: é o indicador da lista |
| `conversationId` | UUID ou `null` | A conversa direta do bot (só existe depois de aberta) |
| `unreadCount` | inteiro | Mensagens do bot ou do sistema ainda não lidas nessa conversa |

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/bots?includeArchived=true` | | `200 { items: [Bot] }`, o mais novo primeiro |
| `GET /v1/bots/{id}` | | `200 Bot`; `404` |
| `POST /v1/bots` | `{ name, modelId, description?, personality?, allowedTools?, limits?, avatar?, pinned?, groupName?, sortOrder?, color? }` | `201 Bot`; `400` (modelo ou ferramenta que não existem, nome vazio, cor fora da paleta, grupo vazio ou com mais de 60 caracteres) |
| `PATCH /v1/bots/{id}` | qualquer subconjunto dos campos acima, pelo menos um (é por aqui que o app fixa, agrupa e pinta: `{ pinned }`, `{ groupName }`, `{ color }`; `null` limpa `groupName`, `sortOrder` e `color`) | `200 Bot`; `400`, `404` |
| `POST /v1/bots/{id}/archive` | | `200 Bot` (idempotente); `404` |
| `POST /v1/bots/{id}/default` | | `200 Bot`; `404`; `409` se estiver arquivado |
| `POST /v1/bots/{id}/conversation` | | `200 Conversation`: a conversa direta do bot, criada na primeira chamada; `404`; `409` se arquivado |
| `POST /v1/bots/{id}/reception` | | `200 { conversationId, started, runId }`: começa a recepção do bot se ela é devida (conversa vazia e ainda não feita, ou "refazer"); idempotente, no máximo uma vez; `404`; `409` se arquivado |
| `POST /v1/bots/{id}/reception/reset` | | `200 { reset: true }`: a próxima abertura recomeça a recepção; `409` com execução ativa |
| `POST /v1/messages/{id}/team` | `{ create: [{ index, avatar?, color? }] }` ou `{ dismiss: true }` | `200 { message, bots }`: decide o cartão de equipe (cria só os marcados, pelo mesmo caminho do `POST /v1/bots`); `409` se já decidido; `400` para escolha vazia ou repetida |
| `GET /v1/info` | | `200 { timeZone }`: o fuso dos bots (`defaults.timeZone`, padrão o do servidor) |
| `POST /v1/bots/draft` | `{ description, modelId? }` | `200 { name, description, personality }`: uma proposta a partir de texto livre; **não cria nada**; `502` se o modelo falhar |

`draft` faz uma chamada ao modelo (`modelId`, ou o do bot principal). Para criar com a proposta, chame `POST /v1/bots` com ela.

---

## Conversas e mensagens

`Conversation`: `id`, `kind` (`direct` ou `group`; só a direta recebe mensagens por enquanto), `title`, `createdAt`, `updatedAt`, `lastMessageAt`, `archivedAt`, `members` (`[{ botId, name, avatar, joinedAt }]`), `lastMessage` (a última mensagem, cortada em 200 caracteres: `{ id, seq, authorKind, authorBotId, text, createdAt }` ou `null`), `lastReadSeq`, `unreadCount` e `activeRun` (a execução em primeiro plano, a que trabalha ou espera você, ou `null`).

`Message`: `id`, `conversationId`, `seq` (1, 2, 3... sem buracos), `authorKind` (`user`, `bot`, `system`), `authorBotId`, `text`, `runId` (a execução que a sua mensagem abriu, ou que a do bot produziu), `status` (`sent` ou `delivered`, só em mensagem sua enviada com o bot trabalhando; senão `null`) e `createdAt`.

A mensagem do bot que **propõe uma equipe** traz `team`: `{ items: [{ name, description, personality }], status: pending|created|dismissed, created: [{ index, botId }] }`. `Conversation` traz `reception` (`pending`, `started`, `done`, `redo`) e a origem de execução `reception` existe ([RECEPCAO.md](RECEPCAO.md)).

A mensagem do bot que **é uma pergunta** (o `escalate` do bot, ou o desempate do revisor) traz também `question`, sempre no mesmo formato: `{ questions: [{ question, options?, multiple?, allowOther? }], reason? }`. `questions` tem de 1 a 5 itens (uma pergunta comum é um item só); `options` (`[{ label, description? }]`, de 2 a 6) existe só quando as respostas possíveis são discretas; `multiple` deixa escolher várias; `allowOther` deixa responder com algo fora da lista; `reason` é `"review_tie_break"` só no desempate. `text` é a pergunta (ou a lista numerada delas). O app desenha o cartão só com a mensagem. **A resposta é sempre texto comum**, enviado como qualquer mensagem: com uma pergunta, os rótulos escolhidos separados por `"; "` (ou o texto digitado); com várias, uma linha por pergunta, `1. <pergunta> → <rótulos>` ou `→ (pulou)`. `buildAnswerText` e `parseAnswerText` (no `@suup/api`) montam e leem esse texto, e o modelo o recebe como resultado do `escalate`. **Uma opção respondida só pelo número ou pela letra** (`1`, `2`... como a CLI numera, `A`, `B`... como o cartão do app desenha): quando a resposta inteira é exatamente o índice de uma opção, o laço a troca pelo rótulo antes de o modelo ver, e o resultado nomeia a pergunta (`Answer to your question "..." (option 2): SQLite`). É comparação exata (em `answerForModel`, `@suup/core`): número fora das opções, texto em volta, ou pergunta sem opções chegam como foram escritos; com `multiple`, `1,3` ou `1; 3` valem se todos forem índices; num questionário só o formato `N. <pergunta> → ...` é lido. Vale igual para `suup say`, o chat da CLI e a rota de mensagens, porque está no ponto por onde toda resposta passa. Nas demais mensagens o campo não existe.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/conversations?includeArchived=&limit=` | | `200 { items: [Conversation] }`, pela atividade mais recente |
| `GET /v1/conversations/{id}` | | `200 Conversation`; `404` |
| `GET /v1/conversations/{id}/messages?before=&after=&limit=` | | `200 { items: [Message], hasMore }` |
| `POST /v1/conversations/{id}/messages` | `{ text }` | `201 { message, run, queuedForRun }`; `400` (vazia); `404`; `409` (bot arquivado, grupo, modelo fora da configuração) |
| `POST /v1/conversations/{id}/read` | `{ upToSeq? }` | `200 Conversation`; `404` |

- **Paginação** (`limit` de 1 a 200, padrão 50): sem cursor, as mensagens **mais novas**; `before=<seq>`, as imediatamente anteriores (rolar para cima); `after=<seq>`, as seguintes (pôr a conversa em dia). Sempre em `seq` crescente. `hasMore` diz se há mais na direção pedida.
- **Enviar** usa as regras da conversa ([MEMORIA.md](MEMORIA.md)): sem execução ativa, a mensagem abre uma (`queuedForRun: false`, `run.status` `queued`); com uma ativa, a mensagem entra na caixa dela (`queuedForRun: true`, `message.status` `sent`, e vira `delivered` quando o bot a lê no próximo ponto seguro); se o bot tinha feito uma pergunta, a mensagem **é a resposta**. Uma execução **pausada** guarda a mensagem até ser retomada.
- **Marcar como lida** leva `lastReadSeq` até `upToSeq` (ou até a última mensagem, sem corpo). Nunca anda para trás, e um número além do fim vale o fim.

---

## Execuções

`Run`: `id`, `botId`, `parentRunId`, `conversationId`, `origin` (`user`, `routine`, `delegation`, `proactive`), `objective`, `acceptanceCriteria`, `plan` (`[{ id, title, status, note? }]`), `status`, `paused`, `failureOrigin`, `failureDetail`, `result` (`{ summary, evidence? }` ou `null`), `turns`, `inputTokens`, `outputTokens`, `costUsd`, `traceId`, `createdAt`, `updatedAt`, `startedAt`, `finishedAt`. Os estados e as origens de falha são os de [FRONTEND.md](FRONTEND.md), seções 3 e 4.

**`paused`** é o que o estado não diz: `true` quando você pausou a execução. Com `status: "queued"`, ela está **parada, esperando `resume`** (nenhum worker a pega); com `"running"`, está a caminho de parar. Fica `false` de novo ao retomar e sempre que a execução termina ou passa a esperar você.

| Método e caminho | Resposta |
|---|---|
| `GET /v1/runs?conversationId=&botId=&status=&before=&limit=` | `200 { items: [Run], hasMore }`, as mais novas primeiro (`limit` 1 a 200, padrão 50; `before` é uma data ISO) |
| `GET /v1/runs/{id}` | `200 Run`; `404` |
| `GET /v1/runs/{id}/events?afterSeq=&limit=&types=&view=` | `200 { items: [RunEvent], hasMore, lastSeq }` |
| `POST /v1/runs/{id}/pause` | `200 Run`: pausa **suave** |
| `POST /v1/runs/{id}/interrupt` | `200 Run`: pausa **dura** |
| `POST /v1/runs/{id}/cancel` | `200 Run`: cancela |
| `POST /v1/runs/{id}/resume` | `200 Run`: retoma uma execução pausada |

### Eventos

`RunEvent`: `{ seq, type, createdAt, payload }`. Os tipos e o `payload` de cada um estão em [FRONTEND.md](FRONTEND.md), seção 5; `seq` é a posição na execução (1, 2, 3...). Parâmetros: `afterSeq` (padrão 0), `limit` (1 a 1000, padrão 200), `types` (lista separada por vírgula, dos tipos conhecidos) e `view`:

- `full` (padrão): tudo, inclusive o `model_request` inteiro, que carrega a conversa e a lista de ferramentas e **pode ter megabytes**.
- `chat`: tudo igual, **exceto** que o `payload` de `model_request` vira `{ "omitted": true, "provider", "model", "purpose"?, "messageCount", "toolCount", "toolStats"? }` (`toolStats`: `definitions`, `deferred`, `estimatedTokens`, `loadedTokens`, o custo das definições de ferramentas do pedido; só números). O corte é feito no banco, então os megabytes nem saem dele. O pedido inteiro está em `GET /v1/runs/{id}/requests/{seq}`.

`lastSeq` é o `seq` do último evento devolvido (ou o `afterSeq` pedido, se nenhum veio): é o `afterSeq` da próxima página.

### Pausar, interromper, cancelar, retomar

O servidor **não roda o loop**: quem trabalha é um worker, que pode ser outro processo (outro contêiner). O servidor grava o pedido no banco e o worker o obedece:

| Ação | O que acontece | Estados aceitos | Depois |
|---|---|---|---|
| `pause` | O worker termina a volta em andamento (a chamada ao modelo **e** as ferramentas que ela pediu) e, no próximo ponto seguro, para sem iniciar outra chamada ao modelo | `queued`, `running` | `status: queued`, `paused: true` |
| `interrupt` | O worker vê o pedido no próximo batimento (`worker.controlPollMs`, padrão 2 s) e **aborta** a chamada ao modelo e a ferramenta em curso; a ferramenta cortada fica registrada como interrompida, com resultado desconhecido | `queued`, `running` | `status: queued`, `paused: true` |
| `resume` | Tira a pausa; um worker pega a execução e ela continua de onde o log parou | pausada | volta a `queued`/`running` |
| `cancel` | Posta o pedido de parada, tira a pausa (para um worker poder aplicar) e, se a execução trabalha agora, também interrompe; ela termina `cancelled` e a conversa recebe o aviso | `queued`, `running`, `waiting_user` (o pedido a recoloca na fila), `waiting_approval`, `waiting_timer` (cancelada na hora, sem worker) | `cancelled` |

Uma execução em `waiting_timer` (o bot marcou um retorno para si, [RETORNO.md](RETORNO.md)) tem `wakeAt` (a hora) e `wakeNote` (o que conferir) na `Run`, e as duas são `null` em qualquer outro estado. Nenhum worker a segura: `cancel` a cancela na hora (o log guarda `wait_cancelled`, motivo `cancelled`), uma mensagem em `POST /v1/conversations/{id}/messages` cancela o retorno (`user_message`) e a execução segue com ela, e `pause`/`interrupt` dão `409`.

Erros: `404` se a execução não existe; `409` para `pause` e `interrupt` numa execução que terminou ou espera você, uma aprovação ou a hora de um retorno (`pause` numa já pausada é idempotente, e `interrupt` a endurece); para `resume`, numa execução que não está pausada ou que terminou; para `cancel`, numa que já terminou. **`cancel` e a retomada precisam de um worker vivo** para serem aplicados.

---

## Memória

`Memory`: `id`, `layer` (`rule`, `profile`, `note`, `journal`), `scope` (`shared` ou `bot`), `botId`, `text`, `sourceConversationId`, `sourceRunId`, `sourceMessageId` (de onde veio, quando foi um bot), `createdBy` (`user` ou `bot`), `createdAt`, `updatedAt`, `archivedAt`, e (sempre enviados pelo servidor; opcionais só no tipo, para não quebrar quem monta um `Memory` à mão) `status` (`active`, `pending` ou `rejected`; ausente = `active`), `summary` (o fato curto, até 200 caracteres, de notas e diário), `lastUsedAt` (a última vez que o `recall` a achou), `supersedesId` (uma pendente que propõe **trocar** outra: confirmá-la arquiva a outra) e `review` (só numa pendente que o bot escreveu depois de ler conteúdo de fora: `{ decision, reason }` do revisor, para o cartão dizer por que espera). Esquecer é **arquivar**: dá para restaurar. Uma regra ou um fato sobre você que um **bot** ou a **consolidação em segundo plano** propõem nasce **`pending`**: não entra em nenhum prompt nem na busca até você confirmar ([MEMORIA.md](MEMORIA.md)).

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/memories?layer=&scope=&botId=&includeArchived=&status=&limit=` | | `200 { items: [Memory] }`, do mais antigo ao mais novo (`limit` até 1000, padrão 500). `botId` filtra o que **pertence** ao bot. **`status`** (`active` por padrão, `pending`, `rejected`): sem ele, só as ativas; `?status=pending` lista as propostas de antes (o fluxo normal não cria pendentes: o bot e a consolidação gravam ativo) |
| `POST /v1/memories` | `{ layer, text, scope?, botId? }` | `201 Memory`, `createdBy: "user"`; `400` |
| `PATCH /v1/memories/{id}` | `{ text }` | `200 Memory`; `400`, `404` |
| `POST /v1/memories/{id}/archive` | | `200 Memory` (idempotente); `404` |
| `POST /v1/memories/{id}/restore` | | `200 Memory`; `404` |
| `POST /v1/memories/{id}/confirm` | | `200 Memory` (agora `active`; vale a partir da próxima execução; se ela trocava outra, a outra foi arquivada); `404`; `409` se não está `pending` |
| `POST /v1/memories/{id}/reject` | | `200 Memory` (`rejected`: não é proposta de novo); `404`; `409` se não está `pending` |
| `GET /v1/memories/{id}/revisions` | | `200 { items: [MemoryRevision] }`, da mais nova para a mais antiga; `404` |
| `POST /v1/memories/{id}/revisions/{revisionId}/undo` | | `200 Memory` devolvida ao estado de **antes** daquela mudança. Só a mais recente da memória pode ser desfeita (`409` se não é); desfazer cria uma mudança `undone`, então desfazer de novo refaz; `404` |
| `GET /v1/memories/search?q=&botId=&layers=&limit=` | | `200 { items: [{ memory, excerpt, matches, rank }] }` |
| `GET /v1/messages/search?q=&conversationId=&botId=&limit=` | | `200 { items: [{ message, excerpt, matches, rank }] }` |

- `MemoryRevision`: `id`, `memoryId`, `kind` (`created`, `edited`, `confirmed`, `rejected`, `archived`, `restored`, `promoted`, `undone`), `actor` (`user`, `bot`, `consolidation`, `expiry`), `prev` (`null` na criação) e `next` (cada um: `text`, `summary`, `status`, `layer`, `scope`, `botId`, `archived`), `originRunId`, `originConversationId`, `originMessageId`, `originConsolidationId`, `createdAt`.
- Só `rule`, `profile` e `note` são escritas pela pessoa; o diário (`journal`) é escrito pelo sistema ao fim de cada execução. Regras de camada e escopo: perfil é sempre compartilhado; nota é sempre de um bot (`botId` obrigatório); regra é compartilhada, ou de um bot se vier `botId`.
- Uma memória nova, editada ou esquecida vale **a partir da próxima execução**, nunca no meio de uma ([MEMORIA.md](MEMORIA.md)).
- **Busca**: em português (radicais: "provas" acha "prova") e **sem diferenciar acentos** ("avaliacao" acha "avaliação") onde o PostgreSQL tem a extensão `unaccent` (a imagem Docker tem; `suup doctor` informa). `excerpt` é o trecho em texto puro e `matches`, os trechos achados nele (`start` inclusive, `end` exclusivo, em caracteres). Quando o texto só casou por causa dos acentos, `matches` pode vir vazio. `botId` na busca de memória diz quem busca (vê as compartilhadas e as dele); sem ele, só as compartilhadas.

### Supervisor (o Principal)

Veja [SUPERVISOR.md](SUPERVISOR.md).

| Chamada | Corpo | Resposta |
|---|---|---|
| `GET /v1/supervisor/settings` | | `200 SupervisorSettings`: `reviewEnabled`, `reviewTime` (`HH:MM`, padrão `03:00`), `morningTime` (`HH:MM` ou `null`, padrão `08:00`), `costCapUsd` (`null`: sem teto, o padrão), `timeZone`, `model {available, id, reason}` |
| `PATCH /v1/supervisor/settings` | só as chaves que mudam | `200 SupervisorSettings`; `400` com a mensagem em português (`reviewTime: use o formato HH:MM`); chave desconhecida é recusada |
| `GET /v1/supervisor/reviews?limit=` | | `200 {items: TeamReview[]}`, mais nova primeiro: `night`, `status` (`done`, `skipped`, `failed`, `running`), `botsRead`, `leftOver`, `capReached`, `costCapUsd`, `noted`, `morningText`, `morningPostedAt`, `model`, tokens, `costUsd`, `error` |

O cliente: `api.supervisor.settings.get/update` e `api.supervisor.reviews`. Uma execução delegada aparece como as demais, com `origin: "delegation"` e `parentRunId` (a execução do Principal).

### Configurações da memória e consolidação

O que é seu escolher sobre a memória fica no servidor (uma linha só, como o modo de aprovação), vale para o app, a CLI e a API, e muda na hora ([MEMORIA.md](MEMORIA.md)).

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/memory-settings` | | `200 MemorySettings` |
| `PATCH /v1/memory-settings` | só as chaves que mudam | `200 MemorySettings`; `400` com a mensagem em português (`consolidation.maxTurns: deve ser um número inteiro entre 3 e 100`); qualquer chave desconhecida é recusada |
| `GET /v1/memory-consolidations?conversationId=&limit=` | | `200 { items: [MemoryConsolidation] }`, da mais nova para a mais antiga (somente leitura) |

`MemorySettings` (e o corpo do `PATCH`, com as mesmas chaves, todas opcionais):

```json
{
  "consolidation": { "enabled": true, "idleMinutes": 5, "maxTurns": 15 },
  "promptLimitItems": 200,
  "expiryDays": 90,
  "compactionThreshold": 0.8,
  "reviewer": { "available": true, "model": "claude-haiku-5-5", "reason": null },
  "promptUsage": { "limitItems": 200, "ceilingChars": 25000, "sharedItems": 12, "sharedChars": 1450, "overLimit": [] }
}
```

| Chave | Padrão | Faixa |
|---|---|---|
| `consolidation.enabled` | `true` | verdadeiro ou falso |
| `consolidation.idleMinutes` | 5 | inteiro de 1 a 120 |
| `consolidation.maxTurns` | 15 | inteiro de 3 a 100 |
| `promptLimitItems` | 200 | inteiro de 20 a 1000 (memórias: regras e perfil ativos que entram em todo prompt) |
| `expiryDays` | 90 | inteiro de 7 a 3650, ou `null` (nunca expira) |
| `compactionThreshold` | 0.8 | número de 0.5 a 0.95 |

`reviewer` diz se a consolidação (e a revisão do que o bot escreve depois de ler conteúdo de fora) tem um modelo agora: `available`, o `model` configurado e `reason` (em português) quando não tem; é só leitura, como o `reviewer` de `/v1/approval-settings`. `promptUsage` é o aviso do teto: `overLimit` lista os bots (`botId`, `name`, `usedItems`, `usedChars`) cujas regras e perfil **ativos** passam de `promptLimitItems` memórias ou de `ceilingChars` (o teto de segurança de 25000 caracteres, fixo e sem configuração, como o 25KB do `MEMORY.md` da Claude Code; veja [pesquisas/memoria-dos-agentes.md](pesquisas/memoria-dos-agentes.md)); `sharedItems`/`sharedChars` contam o que todos os bots carregam; o app deve pedir que você apague ou encurte memórias, ou aumente o teto (nada é cortado em silêncio, o que não cabe só fica fora do prompt).

`MemoryConsolidation` (uma tentativa da consolidação): `id`, `conversationId`, `botId`, `reason` (`idle`, `max_turns`, `pre_compaction`), `status` (`queued`, `running`, `done`, `skipped`, `failed`), `fromSeq`, `toSeq`, `userTurns`, `model`, `promptVersion`, `inputTokens`, `outputTokens`, `costUsd`, `latencyMs`, `proposed` (o que o modelo disse), `kept` (o que foi gravado: ação, id da memória), `dropped` (o que o código descartou e por quê), `error`, `createdAt`, `finishedAt`.

---

## Aprovações e regras

Uma chamada de ferramenta que precisa do seu OK vira um **cartão** (`Approval`); a execução fica em `waiting_approval` e libera o worker até você decidir. Como e por quê: [APROVACOES.md](APROVACOES.md).

`Approval`: `id`, `runId`, `botId`, `conversationId` (a da execução, ou `null`), `callId`, `tool`, **`args`** (o conteúdo exato que vai rodar, com segredos como `{{secret:NOME}}`, nunca valores), `level` (`read`, `write_reversible`, `external_irreversible`), `summary` (uma linha: o título do cartão), `secrets` (nomes usados), `source` (`rule`, `reviewer` ou `default`: quem mandou perguntar), `reviewReason` (uma frase em português dizendo por que o cartão existe, quando foi o revisor ou um piso fixo; senão `null`), `writtenRuleId` (a regra escrita em que essa frase se apoia, se citou uma; ela pode ter sido apagada depois), `status` (`pending`, `approved`, `denied`, `cancelled`, `expired`), `reason` (o motivo de uma negação), `outbound` (`null`, ou `{ kind: "message", recipientFields, recipients }`: a ferramenta **declarou** que a chamada é uma mensagem a outra pessoa; `recipients` é o que "Permitir destinatário" fixaria, ou `null` se não dá para dizer exatamente), `ruleId` (a regra criada por "Permitir destinatário"), `expiresAt` (só se a configuração faz cartões expirarem), `decidedAt`, `createdAt`, `waitedMs` (quanto o cartão esperou até a decisão, em ms; `null` enquanto pendente) e `stale` (`true` se foi **aprovado** depois de esperar mais que o limite `staleAfterMinutes` que valia na hora: a ação não rodou na hora, o bot foi avisado e a aprovação ficou como permissão de uma vez para a chamada idêntica, nesta execução; veja [APROVACOES.md](APROVACOES.md), "Aprovação depois de muito tempo").

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/approvals?status=&botId=&conversationId=&runId=&limit=` | | `200 { items: [Approval] }`, do mais novo ao mais antigo (`limit` até 200, padrão 50). `status=pending` é a lista de cartões esperando você |
| `GET /v1/conversations/{id}/approvals?status=&botId=&runId=&limit=` | | O mesmo, só da conversa; `404` |
| `GET /v1/approvals/{id}` | | `200 Approval`; `404` |
| `POST /v1/approvals/{id}/decision` | `{ "decision": "approve", "allowRecipient"?: true }` ou `{ "decision": "deny", "reason"?: "..." }` | `200 { approval, rule }` (`rule` é a regra criada, ou `null`); `404`; `409` se já foi decidido, cancelado ou expirado |

- Decidir **volta a execução para a fila** (um worker precisa estar rodando); a decisão é gravada no log da execução (`approval_decided`) por ela mesma, ao retomar. Aprovada, a ferramenta roda **exatamente** com `args`.
- Negar não falha a execução: o modelo recebe a negação (com `reason`) e continua.
- "Permitir destinatário": `allowRecipient: true` só vale num cartão com `outbound` (senão `409`) e cria uma regra `allow` para esta ferramenta e **este bot**, com os campos de destinatário **iguais** aos desta chamada (`409` se `recipients` é `null`). O corpo é estrito: `always` e campos desconhecidos dão `400`. Não há outra forma de criar regra por uma decisão.
- Uma mensagem no chat **não** decide nada.
- `POST /v1/runs/{id}/cancel` numa execução que espera cancela o cartão (`cancelled`).

`Rule` (regra permanente do usuário): `id`, `botId` (`null` = todos os bots), `tool` (nome, ou `*`), `effect` (`allow` ou `deny`), `matchers` (lista de `{ field, value }`: o campo nomeado dos argumentos precisa ser **exatamente** o valor, todos precisam valer; não há operador (`op` é recusado com `400`); `field` é um caminho com pontos nos argumentos; **vazio = qualquer uso da ferramenta**), `enabled` e `disabledReason` (a migração 0013 desativou as regras que usavam padrões; elas não valem e aparecem aqui com o motivo), `note`, `createdBy` (`user` ou `approval`), `sourceApprovalId`, `createdAt`, `updatedAt`. Quem proíbe vale mais que quem libera.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/approval-rules?botId=` | | `200 { items: [Rule] }`, da mais antiga à mais nova. Com `botId`: as desse bot e as globais |
| `POST /v1/approval-rules` | `{ tool, effect, botId?, matchers?, note? }` | `201 Rule`; `400` |
| `PATCH /v1/approval-rules/{id}` | `{ effect?, matchers?, note?, enabled? }` | `200 Rule`; `400`, `404`; `409` ao ativar (`enabled: true`) uma regra que ainda guarda condições antigas (troque `matchers` na mesma chamada) |
| `DELETE /v1/approval-rules/{id}` | | `200 { deleted: true }`; `404` |

### Modo de aprovação

Dois modos, guardados **no servidor**: `auto_review` (padrão: um modelo lê as suas regras escritas e decide cada chamada que não é leitura) e `ask_all` ("Perguntar tudo": toda chamada que não é leitura vira cartão). Como funcionam: [APROVACOES.md](APROVACOES.md).

`ApprovalSettings`: `{ mode: "auto_review" | "ask_all", reviewer: { available, model, reason } }`. `reviewer.available` é `false` quando não há modelo de revisão configurado, a chave do provedor falta ou a configuração o desliga: o `auto_review` então só aplica a tabela de níveis de risco, e `reviewer.reason` diz por quê (uma frase para a pessoa); `model` é o modelo configurado, ou `null`. A tela deve mostrar isso, sem fingir que há revisão.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/approval-settings` | | `200 ApprovalSettings` |
| `PATCH /v1/approval-settings` | `{ mode?, staleAfterMinutes? }` (estrito; pelo menos um) | `200 ApprovalSettings`; `400` para um modo que não existe, ou `staleAfterMinutes` que não é inteiro de 5 a 10080. Vale para as próximas chamadas, também nas execuções em andamento |

`ApprovalSettings`: `mode`, `staleAfterMinutes` (padrão 60, de 5 minutos a 1 semana: aprovar um cartão que esperou mais que isto não executa a ação na hora; cartões **nunca** expiram por causa disto) e `reviewer`. O limite é gravado no cartão na hora em que você decide (`waitedMs` e o limite daquele momento), então mudar o valor depois não reescreve o que já aconteceu.

### Regras escritas

`WrittenRule`: `id`, `kind` (`never`: nunca permitir, `ask`: sempre perguntar, `allow`: permitir sem perguntar), `text` (**texto livre** do usuário, aparado, 1 a 500 caracteres: nenhum código o interpreta; quem o lê é o modelo revisor), `botId` (`null` = todos os bots), `enabled`, `createdAt`, `updatedAt`. Só o usuário cria; o modelo nunca. No máximo 100.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/written-rules?botId=` | | `200 { items: [WrittenRule] }`, da mais antiga à mais nova (as desligadas também). Com `botId`: as desse bot e as de todos |
| `POST /v1/written-rules` | `{ kind, text, botId?, enabled? }` (estrito: `tool`, `matchers` e outros campos dão `400`) | `201 WrittenRule`; `400` (texto vazio ou com mais de 500 caracteres, tipo desconhecido, `botId` que não existe); `409` se já são 100 |
| `PATCH /v1/written-rules/{id}` | `{ kind?, text?, enabled? }` (estrito) | `200 WrittenRule`; `400`, `404` |
| `DELETE /v1/written-rules/{id}` | | `200 { deleted: true }`; `404` |

Os eventos novos do log da execução (`GET /v1/runs/{id}/events`): `approval_review` (uma revisão do modelo: `decision`, `ruleId`, `reason`, `outcome`, `adjusted?`, `skipped?`, `model`, `promptVersion`, `usage`, `costUsd`, `latencyMs`) e, no `policy_checked` de uma chamada recusada pela regra `never`, `writtenRuleId` e `reason` (`Bloqueado pela regra "…"`). O cartão da pergunta traz `reason` e `writtenRuleId` no `approval_requested`.

Tempo real: o quadro `approval.changed` (`{ change: "created"\|"updated", approval }`) chega a toda conexão quando um cartão aparece ou muda de situação. As regras e o cofre não têm quadro: leia de novo depois de escrever.

---

## Cofre de segredos

Só **escrita**: não existe rota nem campo que devolva um valor. O que é e o que não protege: [COFRE.md](COFRE.md). Sem a seção `vault` na configuração, ou sem a chave no ambiente, as rotas de escrita respondem `503 unavailable` com a mensagem que diz o que falta (a listagem funciona sem chave).

`Secret`: `name` (letras maiúsculas, números e `_`, começando por letra, até 64), `description`, `keyId` (impressão digital da chave que o cifrou), `grantedBotIds` (quem pode usar), `createdAt`, `updatedAt`, `lastUsedAt`.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/vault` | | `200 { configured, ok, keyEnv, reason }`: o servidor consegue guardar segredos? `configured`: a seção `vault` está na configuração; `ok`: a chave existe no ambiente e é válida; `keyEnv`: o **nome** da variável (nunca a chave); `reason`: o que falta, em português. O app usa para avisar antes de tentar escrever |
| `GET /v1/secrets` | | `200 { items: [Secret] }` |
| `PUT /v1/secrets/{nome}` | `{ value, description?, grantBotIds? }` | `200 Secret`. Cria ou **substitui** o valor (as concessões ficam); `value` de 8 a 16 384 caracteres; `400`; `503` |
| `DELETE /v1/secrets/{nome}` | | `200 { deleted: true }`; `404` |
| `PUT /v1/secrets/{nome}/grants/{botId}` | | `200 Secret`: o bot passa a poder usar; `404` |
| `DELETE /v1/secrets/{nome}/grants/{botId}` | | `200 Secret`: o bot deixa de poder; `404` |
| `GET /v1/runs/{id}/secret-request` | | `200 { request: { runId, botId, name, reason } \| null }`: o segredo que a execução (em `waiting_user`) pediu com `request_secret` |
| `POST /v1/runs/{id}/secret-request/answer` | `{ value?, declined?, description? }` | `200 { name, provided }`. O valor vai **direto ao cofre**, o bot é concedido e a execução volta à fila; o modelo só fica sabendo que o segredo está disponível. `409` se a execução não espera um segredo |

Qualquer resposta ou quadro do stream que mencione um valor conhecido (por exemplo, um texto digitado no chat antes de o segredo existir) sai com `[REDACTED:NOME]` no lugar.

---

## Conectores (MCP)

Servidores MCP externos cujas ferramentas os bots podem usar, com autorização por conector (concessão por bot), escopo e risco por ferramenta. Como funciona, o que protege e o que não: [CONECTORES.md](CONECTORES.md). **Nenhuma resposta traz uma credencial**: um conector só cita segredos do cofre pelo nome (`secretNames`, e `{ secret, prefix? }` no lugar do valor em `env` e `headers`). Criar, editar ou ligar um conector pela API é o usuário agindo (o token do servidor): não há cartão. (O bot propor um conector, com cartão, não existe ainda.)

`Connector`: `id`, `name` (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, até 24), `description`, `transport` (`{ kind: "stdio", command, args, env, cwd? }` ou `{ kind: "http", url, headers }`; um valor de `env`/`headers` é um texto **ou** `{ secret: "NOME", prefix?: "Bearer " }`), `scope` (`read_only` ou `read_write`), `toolOverrides` (`{ "<ferramenta no servidor>": { risk?, outbound? } }`: o que o usuário afirma; `outbound` é `{ kind: "message", recipientFields }`, a marca "envia mensagem para outra pessoa", que **só o usuário** põe), `trustAnnotations`, `timeoutMs`, `enabled`, `origin` (`user`; `proposal` é o gancho do futuro "o bot propõe", sempre criado desligado), `grantedBotIds`, `secretNames`, `connection` (`{ connected, failures, lastError }`: **do processo que respondeu**), `discovery` (`{ discoveredAt, lastError, lastErrorAt }`: o que **qualquer** processo viu por último), `tools` e as datas.

`ConnectorTool` (de `tools`, a última listagem guardada, com o risco recalculado pela configuração de agora): `tool` (nome no servidor), `name` (`conn_<conector>__<ferramenta>`: o que o modelo chama e o que as regras casam), `description` (texto do servidor, limpo e limitado a 800 caracteres: **não confiável**), `risk`, `riskBasis` (`default`, `user`, `trusted_hint`, `tightened_by_hint`, `outbound`), `outbound` (a marca do usuário, ou `null`), `available` (e `reason` quando não: esquema não suportado, escopo somente leitura, nome repetido...), `hints` (`readOnlyHint`, `destructiveHint` como o servidor os declarou). `tools` é `null` até o servidor ser listado uma vez.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/connectors` | | `200 { items: [Connector] }` |
| `POST /v1/connectors` | `{ name, transport, description?, scope?, tools?, trustAnnotations?, timeoutMs?, enabled?, grants? }` com `grants: [{ botId, tools: "all" \| ["a", "b"] }]` | `201 Connector`; `400` (configuração recusada: shell com `-c`, `http://` fora de localhost, segredo que não existe no cofre...); `409` nome repetido |
| `GET /v1/connectors/{nome}` | | `200 Connector`; `404` |
| `PATCH /v1/connectors/{nome}` | `{ description?, transport?, scope?, tools?, trustAnnotations?, timeoutMs? (null: o padrão), enabled? }` | `200 Connector`. `transport` e `tools` **substituem** o que havia; a conexão aberta com a configuração antiga é descartada |
| `DELETE /v1/connectors/{nome}` | | `200 { deleted: true }`; `404` |
| `PUT /v1/connectors/{nome}/grants/{botId}` | `{ tools: "all" \| ["a", "b"] }` (obrigatório; nomes **no servidor**) | `200 Connector`: **substitui** o que o bot pode usar do conector (`"all"`: todas as aprovadas; uma lista: só essas; `[]`: nenhuma). Vale a partir da próxima execução. `400` corpo ausente ou ferramenta que o conector não tem (se ele nunca foi listado, o servidor o lista antes de conferir); `404`. Uma ferramenta não concedida não existe para o bot |
| `DELETE /v1/connectors/{nome}/grants/{botId}` | | `200 Connector`; `404` |
| `PUT /v1/connectors/{nome}/tools/{ferramenta}/outbound` | `{ outbound: { kind: "message", recipientFields: ["to"] } \| null }` | `200 Connector`: o usuário marca (ou, com `null`, desmarca) a ferramenta como "envia mensagem para outra pessoa" e diz onde está o destinatário. Uma ferramenta marcada nunca é `read` |
| `PUT /v1/connectors/{nome}/tools/{ferramenta}/risk` | `{ risk: "read" \| "write_reversible" \| "external_irreversible" \| null }` | `200 Connector`: o que o usuário afirma dessa ferramenta (`null` limpa). O servidor pode **apertar** isso por uma dica, nunca afrouxar |
| `GET /v1/connectors/{nome}/review` | | `200 { items: [{ tool, status: "changed" \| "new", approvedFingerprint, approved, currentFingerprint, current, seenAt }] }`: as ferramentas cuja **definição mudou** depois de aprovada (ou que apareceram depois da primeira listagem). `approved` e `current` são `{ name, description, inputSchema, annotations }` (texto do servidor, não confiável). Enquanto estiver aqui, a ferramenta está **desligada para todos os bots** |
| `POST /v1/connectors/{nome}/tools/{ferramenta}/review` | `{ fingerprint }` (o `currentFingerprint` que a pessoa viu) | `200 Connector`: aprova a definição atual. `409` se ela mudou de novo desde então; `404` se a ferramenta nunca foi vista. Só o usuário faz isso |
| `GET /v1/connectors/{nome}/events` | | `200 { items: [{ id, tool, kind, fromFingerprint, toFingerprint, detail, createdAt }] }`, do mais novo ao mais antigo: `baseline`, `pinned_on_grant`, `changed`, `new`, `restored`, `approved` |
| `POST /v1/connectors/{nome}/test` | | `200 { ok, serverName, serverVersion, durationMs, error, tools }`: liga o servidor **do zero, no processo que atende** (um programa local precisa existir onde o servidor da API roda), lista as ferramentas e desliga. Uma falha do servidor MCP é `ok: false` com `error` (que nomeia o conector), não um erro HTTP |

O objeto `Connector` traz `grants: [{ botId, all, tools }]` (o que cada bot pode usar; `grantedBotIds` continua com os bots que têm concessão), `pendingReviews` (quantas ferramentas esperam revisão) e, em cada ferramenta de `tools`, `pin` (`approved` \| `changed` \| `new` \| `unseen`) e `fingerprint` (SHA-256 da definição que o servidor mostra agora). O evento `model_request` de uma execução traz `toolStats` (`definitions`, `deferred`, `estimatedTokens`, `loadedTokens`) e `hostedToolSearch`; o evento `tool_catalog` diz como as ferramentas de conectores foram oferecidas (`direct`, `hosted`, `client`, `meta`). O `transport` stdio aceita `egressHosts` (nomes exatos de host que o servidor, no contêiner, pode alcançar; veja [REDE.md](REDE.md)), e o `Connector` traz `runsIn` (`container` ou `host`; `null` em HTTP: onde o servidor roda, e `host` é SEM isolamento).

A rede da máquina dos bots ([REDE.md](REDE.md)): `GET /v1/bots/{id}/network` (`defaults`, `hosts` do bot, últimas recusas do proxy), `PUT /v1/bots/{id}/network/hosts/{host}` (libera um host de nome exato para o bot) e `DELETE` no mesmo caminho (`404` se o host não está na lista). Um host pedido pelo bot vale só para a execução e passa por um cartão de aprovação da ferramenta `request_network_access`.

Sem tempo real próprio: o app lê de novo depois de escrever. `GET /v1/doctor` ganha uma linha `Conector <nome>` por conector ligado (e, numa instalação em que a API não roda os bots, diz que não verificou).

---

## Diagnóstico (o Inspetor)

Os mesmos cálculos de `suup inspect --request`, `replay`, `resend` e `doctor`, que a CLI e o servidor compartilham (um código só, em `@suup/runtime`).

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/runs/{id}/requests/{seq}` | | `200 { runId, seq, purpose, turn, request, response }`: o pedido exato ao modelo (sistema, mensagens, ferramentas...) e a resposta gravada (ou `null`); `404`; `409` se o evento não é um `model_request` (a mensagem lista os que a execução tem) |
| `POST /v1/runs/{id}/replay` | | `200 { runId, identical, finalStatus, firstDivergence, requestDiffs, stoppedBecause, reading }`: reexecuta o loop atual com as respostas gravadas, sem chamar nada de verdade; `reading` é a leitura em português; `409` se não há o que reexecutar |
| `POST /v1/runs/{id}/resend` | `{ seq, times?, model? }` | `200` com as tentativas e o resumo: reenvia o pedido gravado **como está**, `times` vezes (1 a 20, padrão 1) ou a `model`, outro modelo da configuração. Não altera a execução nem soma custo a ela. `400`, `404`, `409`, `502` |
| `GET /v1/doctor?live=true` | | `200 { ok, checks: [{ component, ok, detail }] }`: banco e migrações, busca sem acento, fila, máquina dos bots, rede dos bots, provedores, cofre, memória, **busca e leitura na web** (ligadas ou não e, depois do primeiro uso, o que roda; o doctor nunca inicia os contêineres), ferramentas; com `live`, uma chamada minúscula (alguns tokens) a cada modelo |

Num servidor sem worker (`suup server` sem `--with-worker`, que por desenho não tem o socket do Docker), a linha "Sandbox" diz que **não foi verificada ali**: veja o worker. A linha "Fila de execuções" falha se há execuções esperando há mais de 2 minutos, o sinal de que nenhum worker as está pegando.

---

## Tempo real: `GET /v1/stream`

Server-Sent Events: uma conexão por instância do app, que traz o que muda, sem recarregar. O cliente `@suup/api` (`api.subscribe`) implementa tudo abaixo, inclusive a reconexão; o `EventSource` do navegador **não serve**, porque não manda o token num cabeçalho.

```
GET /v1/stream?runs=<id>,<id>
Authorization: Bearer <token>
Last-Event-ID: 1234          (opcional; também aceito como ?lastEventId=1234)
```

`runs` (até 50 ids) diz de quais execuções chegam os **eventos** (`run.event`); mudar a lista é abrir outra conexão com o mesmo `Last-Event-ID` (o `subscribe` faz isso por você: `sub.setRuns([...])`). Todo o resto chega para todo mundo.

### Quadros

```
id: 1234
event: run.event
data: {"runId":"...","event":{"seq":7,"type":"tool_call","createdAt":"...","payload":{...}}}
```

| `event` | `data` | Quando |
|---|---|---|
| `ready` | `{ head, resync, runs }` | Primeiro quadro de toda conexão, **sem `id`**. `head` é o id da última mudança naquele instante |
| `resync` | `{ reason }` | **Sem `id`**, logo depois de `ready`: recarregue tudo (veja "Retomada") |
| `run.event` | `{ runId, event }` | Evento novo de uma execução em `runs`. O `model_request` vem resumido, como em `view=chat` |
| `run.updated` | `{ run }` | Qualquer execução (todas, para os indicadores da lista) mudou de estado, de pausa, de plano, de uso ou de resultado. Vai a `Run` inteira |
| `message.created` | `{ message }` | Mensagem nova em qualquer conversa |
| `message.updated` | `{ message }` | Mudou o estado de entrega (`sent`, `delivered`) |
| `conversation.updated` | `{ conversation }` | Mudou a lista de conversas: mensagem nova, lida, arquivada. Vai a `Conversation` inteira, com `unreadCount` e `activeRun` |
| `memory.changed` | `{ change, memory }` | `change`: `created`, **`pending`** (só para linhas de antes: o fluxo normal grava ativo e emite `created`/`updated`; um bot ou a consolidação nunca pede confirmação), `updated` (inclui confirmar e recusar: veja `memory.status`), `archived`, `restored`. Usar uma memória (o `recall` renovar `lastUsedAt`) **não** gera quadro |
| `bot.updated` | `{ bot }` | Bot criado, editado, arquivado ou tornado principal |
| `approval.changed` | `{ change, approval }` | Um cartão de aprovação apareceu (`created`) ou mudou de situação (`updated`: aprovado, negado, cancelado, expirado). Vai o `Approval` inteiro |

Dos quadros com dados de uma linha (`run.updated`, `message.*`, `conversation.updated`, `bot.updated`, `approval.changed`) o servidor manda o **estado atual** da linha, lido do banco quando o quadro é montado: várias atualizações seguidas de uma execução podem chegar como uma só, a última. `run.event` é um evento específico do log (que só cresce), nunca fundido.

### Garantias e retomada

- **Ids** (`id:`) crescem com cada mudança no banco e são **os mesmos em qualquer processo do servidor**: o id visto num servidor retoma em outro. Há buracos (mudanças que não geram quadro para você); não há repetição nem ordem trocada. Na ordem em que as transações ficam visíveis no banco.
- **Retomar**: com `Last-Event-ID: N`, o servidor reenvia exatamente o que veio depois de `N` (para as execuções de `runs`, e os quadros de todo mundo), sem perda e sem repetição, e segue ao vivo.
- **Janela de retenção**: o servidor guarda o diário de mudanças por `server.eventRetentionMinutes` (padrão 6 h). Se o cliente pede para retomar de um id que já saiu da janela (`too_old`), ou de um id de outro banco (`unknown_id`), ou de tantas mudanças atrás que não vale reenviar (`too_many`, mais de 5000), o servidor manda `ready` com `resync: true` e `resync`, e segue ao vivo **a partir do `head`**. O app, então, recarrega o que mostra pelas rotas REST. O `subscribe` já guarda o `head` para as reconexões seguintes.
- **Conexão nova** (sem `Last-Event-ID`): começa do `head`, sem repetir o passado. O jeito certo de abrir uma tela: **conecte o stream primeiro**, espere o `ready` e só então leia o estado pelas rotas REST; o que mudar no intervalo chega pelo stream. Ao passar a seguir uma execução, leia os eventos que faltam por `GET /v1/runs/{id}/events?afterSeq=` e descarte, no stream, os de `seq` que já tem.
- **Pulso**: um comentário `: ping` a cada 15 s. O cliente reabre uma conexão que fica 45 s calada.
- **Cliente lento**: o servidor limita a fila de cada conexão (1 MiB); quem não acompanha é **desconectado** (a memória não cresce sem limite) e, ao reconectar com `Last-Event-ID`, retoma sem perder nada.
- **Limite**: `server.maxStreams` conexões (padrão 16); a seguinte leva `429 too_many_streams`.
- **Vários servidores**: cada processo ouve o mesmo banco (`LISTEN/NOTIFY`, com leitura periódica de segurança a cada 2 s) e entrega os mesmos quadros com os mesmos ids.
- Ao desligar, o servidor encerra as conexões abertas.

### Como o servidor sabe o que mudou

Gatilhos no Postgres (`change_log`, migração 0006) gravam, ao fim de cada transação, uma linha minúscula por mudança (o tipo e os ids, **nunca** texto de mensagem, de memória ou conteúdo de evento) e dão um `NOTIFY` com o id. Cada servidor lê as linhas novas e então as linhas das tabelas. A numeração é feita no `COMMIT`, sob uma trava, para que os ids sigam a ordem em que as mudanças ficam visíveis: ler "id maior que N" nunca perde uma mudança que apareça depois.

---

## Exemplo de sessão com `curl`

```sh
# 1. Um token, e o servidor no ar (um terminal; o outro serve para o resto)
export SUUP_SERVER_TOKEN=$(pnpm --silent suup server --generate-token)
pnpm suup server --with-worker        # escuta em http://127.0.0.1:8787

# 2. Nos outros terminais:
export T="Authorization: Bearer $SUUP_SERVER_TOKEN"
curl -s localhost:8787/health                                  # {"status":"ok"}
curl -s -H "$T" localhost:8787/v1/bots | jq '.items[] | {id,name,unreadCount,latestRun}'

# 3. Abrir a conversa do bot principal e mandar uma mensagem
BOT=$(curl -s -H "$T" localhost:8787/v1/bots | jq -r '.items[0].id')
CONV=$(curl -s -X POST -H "$T" localhost:8787/v1/bots/$BOT/conversation | jq -r .id)
RUN=$(curl -s -X POST -H "$T" -H 'Content-Type: application/json' \
  -d '{"text":"Crie o arquivo ola.txt com a frase Olá, mundo!"}' \
  localhost:8787/v1/conversations/$CONV/messages | jq -r .run.id)

# 4. Ver acontecer: o stream (-N: sem buffer) com os eventos dessa execução
curl -sN -H "$T" "localhost:8787/v1/stream?runs=$RUN"

# 5. Em outro terminal: a linha do tempo sem os pedidos gigantes, e o estado
curl -s -H "$T" "localhost:8787/v1/runs/$RUN/events?view=chat" | jq '.items[] | {seq,type}'
curl -s -H "$T" localhost:8787/v1/runs/$RUN | jq '{status,paused,turns,costUsd,result}'

# 6. Pausar, retomar, cancelar
curl -s -X POST -H "$T" localhost:8787/v1/runs/$RUN/pause     | jq '{status,paused}'
curl -s -X POST -H "$T" localhost:8787/v1/runs/$RUN/resume    | jq '{status,paused}'

# 7. Memória: uma regra, que vale a partir da próxima execução
curl -s -X POST -H "$T" -H 'Content-Type: application/json' \
  -d '{"layer":"rule","text":"Responda sempre em português."}' localhost:8787/v1/memories | jq .id
curl -s -H "$T" "localhost:8787/v1/memories/search?q=portugues" | jq '.items[].memory.text'

# 8. Diagnóstico: o que o modelo viu no primeiro turno, e a saúde de cada componente
SEQ=$(curl -s -H "$T" "localhost:8787/v1/runs/$RUN/events?types=model_request" | jq '.items[0].seq')
curl -s -H "$T" localhost:8787/v1/runs/$RUN/requests/$SEQ | jq '.request.system' -r | head
curl -s -H "$T" localhost:8787/v1/doctor | jq -r '.checks[] | "\(if .ok then "ok   " else "FALHA" end) \(.component): \(.detail)"'
```

## Do app (TypeScript)

```ts
import { createClient } from "@suup/api";

const api = createClient({ baseUrl: "https://suup.exemplo.com", token });

// O stream primeiro; o estado depois. Reconecta e retoma sozinho.
const sub = api.subscribe({
  onEvent(event) {
    if (event.type === "resync") reloadEverything();
    if (event.type === "run.updated") updateBotIndicator(event.data.run);
    if (event.type === "run.event") appendToTimeline(event.data.event);
  },
  onClose(error) { /* token errado ou origem não permitida: não adianta tentar de novo */ },
});

const bots = await api.bots.list();
const conversation = await api.bots.openConversation(bots[0].id);
const { run } = await api.conversations.send(conversation.id, "Olá!");
sub.setRuns([run.id]);                       // passa a receber os eventos dessa execução
await api.runs.pause(run.id);
```

Os tipos de todas as respostas e dos quadros do stream (`Bot`, `Run`, `StreamEvent`...) saem do mesmo pacote.
