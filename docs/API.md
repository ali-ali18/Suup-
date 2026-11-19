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
| `limits` | `{ maxTurns?, maxCostUsd?, maxDurationMs? }` | Sem o campo, vale o padrão da configuração |
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
| `POST /v1/bots/draft` | `{ description, modelId? }` | `200 { name, description, personality }`: uma proposta a partir de texto livre; **não cria nada**; `502` se o modelo falhar |

`draft` faz uma chamada ao modelo (`modelId`, ou o do bot principal). Para criar com a proposta, chame `POST /v1/bots` com ela.

---

## Conversas e mensagens

`Conversation`: `id`, `kind` (`direct` ou `group`; só a direta recebe mensagens por enquanto), `title`, `createdAt`, `updatedAt`, `lastMessageAt`, `archivedAt`, `members` (`[{ botId, name, avatar, joinedAt }]`), `lastMessage` (a última mensagem, cortada em 200 caracteres: `{ id, seq, authorKind, authorBotId, text, createdAt }` ou `null`), `lastReadSeq`, `unreadCount` e `activeRun` (a execução em primeiro plano, a que trabalha ou espera você, ou `null`).

`Message`: `id`, `conversationId`, `seq` (1, 2, 3... sem buracos), `authorKind` (`user`, `bot`, `system`), `authorBotId`, `text`, `runId` (a execução que a sua mensagem abriu, ou que a do bot produziu), `status` (`sent` ou `delivered`, só em mensagem sua enviada com o bot trabalhando; senão `null`) e `createdAt`.

A mensagem do bot que **é uma pergunta** (o `escalate` do bot, ou o desempate do revisor) traz também `question`, sempre no mesmo formato: `{ questions: [{ question, options?, multiple?, allowOther? }], reason? }`. `questions` tem de 1 a 5 itens (uma pergunta comum é um item só); `options` (`[{ label, description? }]`, de 2 a 6) existe só quando as respostas possíveis são discretas; `multiple` deixa escolher várias; `allowOther` deixa responder com algo fora da lista; `reason` é `"review_tie_break"` só no desempate. `text` é a pergunta (ou a lista numerada delas). O app desenha o cartão só com a mensagem. **A resposta é sempre texto comum**, enviado como qualquer mensagem: com uma pergunta, os rótulos escolhidos separados por `"; "` (ou o texto digitado); com várias, uma linha por pergunta, `1. <pergunta> → <rótulos>` ou `→ (pulou)`. `buildAnswerText` e `parseAnswerText` (no `@suup/api`) montam e leem esse texto, e o modelo o recebe como resultado do `escalate`. Nas demais mensagens o campo não existe.

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
- `chat`: tudo igual, **exceto** que o `payload` de `model_request` vira `{ "omitted": true, "provider", "model", "purpose"?, "messageCount", "toolCount" }`. O corte é feito no banco, então os megabytes nem saem dele. O pedido inteiro está em `GET /v1/runs/{id}/requests/{seq}`.

`lastSeq` é o `seq` do último evento devolvido (ou o `afterSeq` pedido, se nenhum veio): é o `afterSeq` da próxima página.

### Pausar, interromper, cancelar, retomar

O servidor **não roda o loop**: quem trabalha é um worker, que pode ser outro processo (outro contêiner). O servidor grava o pedido no banco e o worker o obedece:

| Ação | O que acontece | Estados aceitos | Depois |
|---|---|---|---|
| `pause` | O worker termina a volta em andamento (a chamada ao modelo **e** as ferramentas que ela pediu) e, no próximo ponto seguro, para sem iniciar outra chamada ao modelo | `queued`, `running` | `status: queued`, `paused: true` |
| `interrupt` | O worker vê o pedido no próximo batimento (`worker.controlPollMs`, padrão 2 s) e **aborta** a chamada ao modelo e a ferramenta em curso; a ferramenta cortada fica registrada como interrompida, com resultado desconhecido | `queued`, `running` | `status: queued`, `paused: true` |
| `resume` | Tira a pausa; um worker pega a execução e ela continua de onde o log parou | pausada | volta a `queued`/`running` |
| `cancel` | Posta o pedido de parada, tira a pausa (para um worker poder aplicar) e, se a execução trabalha agora, também interrompe; ela termina `cancelled` e a conversa recebe o aviso | `queued`, `running`, `waiting_user` (o pedido a recoloca na fila), `waiting_approval` | `cancelled` |

Erros: `404` se a execução não existe; `409` para `pause` e `interrupt` numa execução que terminou ou espera você ou uma aprovação (`pause` numa já pausada é idempotente, e `interrupt` a endurece); para `resume`, numa execução que não está pausada ou que terminou; para `cancel`, numa que já terminou. **`cancel` e a retomada precisam de um worker vivo** para serem aplicados.

---

## Memória

`Memory`: `id`, `layer` (`rule`, `profile`, `note`, `journal`), `scope` (`shared` ou `bot`), `botId`, `text`, `sourceConversationId`, `sourceRunId`, `sourceMessageId` (de onde veio, quando foi um bot), `createdBy` (`user` ou `bot`), `createdAt`, `updatedAt`, `archivedAt`. Esquecer é **arquivar**: dá para restaurar.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/memories?layer=&scope=&botId=&includeArchived=&limit=` | | `200 { items: [Memory] }`, do mais antigo ao mais novo (`limit` até 1000, padrão 500). `botId` filtra o que **pertence** ao bot |
| `POST /v1/memories` | `{ layer, text, scope?, botId? }` | `201 Memory`, `createdBy: "user"`; `400` |
| `PATCH /v1/memories/{id}` | `{ text }` | `200 Memory`; `400`, `404` |
| `POST /v1/memories/{id}/archive` | | `200 Memory` (idempotente); `404` |
| `POST /v1/memories/{id}/restore` | | `200 Memory`; `404` |
| `GET /v1/memories/search?q=&botId=&layers=&limit=` | | `200 { items: [{ memory, excerpt, matches, rank }] }` |
| `GET /v1/messages/search?q=&conversationId=&botId=&limit=` | | `200 { items: [{ message, excerpt, matches, rank }] }` |

- Só `rule`, `profile` e `note` são escritas pela pessoa; o diário (`journal`) é escrito pelo sistema ao fim de cada execução. Regras de camada e escopo: perfil é sempre compartilhado; nota é sempre de um bot (`botId` obrigatório); regra é compartilhada, ou de um bot se vier `botId`.
- Uma memória nova, editada ou esquecida vale **a partir da próxima execução**, nunca no meio de uma ([MEMORIA.md](MEMORIA.md)).
- **Busca**: em português (radicais: "provas" acha "prova") e **sem diferenciar acentos** ("avaliacao" acha "avaliação") onde o PostgreSQL tem a extensão `unaccent` (a imagem Docker tem; `suup doctor` informa). `excerpt` é o trecho em texto puro e `matches`, os trechos achados nele (`start` inclusive, `end` exclusivo, em caracteres). Quando o texto só casou por causa dos acentos, `matches` pode vir vazio. `botId` na busca de memória diz quem busca (vê as compartilhadas e as dele); sem ele, só as compartilhadas.

---

## Aprovações e regras

Uma chamada de ferramenta que precisa do seu OK vira um **cartão** (`Approval`); a execução fica em `waiting_approval` e libera o worker até você decidir. Como e por quê: [APROVACOES.md](APROVACOES.md).

`Approval`: `id`, `runId`, `botId`, `conversationId` (a da execução, ou `null`), `callId`, `tool`, **`args`** (o conteúdo exato que vai rodar, com segredos como `{{secret:NOME}}`, nunca valores), `level` (`read`, `write_reversible`, `external_irreversible`), `summary` (uma linha: o título do cartão), `secrets` (nomes usados), `source` (`rule`, `reviewer` ou `default`: quem mandou perguntar), `status` (`pending`, `approved`, `denied`, `cancelled`, `expired`), `reason` (o motivo de uma negação), `ruleId` (a regra criada por "aprovar e sempre permitir"), `expiresAt` (só se a configuração faz cartões expirarem), `decidedAt`, `createdAt`.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/approvals?status=&botId=&conversationId=&runId=&limit=` | | `200 { items: [Approval] }`, do mais novo ao mais antigo (`limit` até 200, padrão 50). `status=pending` é a lista de cartões esperando você |
| `GET /v1/conversations/{id}/approvals?status=&botId=&runId=&limit=` | | O mesmo, só da conversa; `404` |
| `GET /v1/approvals/{id}` | | `200 Approval`; `404` |
| `POST /v1/approvals/{id}/decision` | `{ "decision": "approve", "always"?: { "scope"?: "bot"\|"global", "matchers"?: [ArgMatcher] } }` ou `{ "decision": "deny", "reason"?: "..." }` | `200 { approval, rule }` (`rule` é a regra criada, ou `null`); `404`; `409` se já foi decidido, cancelado ou expirado |

- Decidir **volta a execução para a fila** (um worker precisa estar rodando); a decisão é gravada no log da execução (`approval_decided`) por ela mesma, ao retomar. Aprovada, a ferramenta roda **exatamente** com `args`.
- Negar não falha a execução: o modelo recebe a negação (com `reason`) e continua.
- "Aprovar e sempre permitir": `always` cria uma regra `allow` para esta ferramenta, para o bot do cartão (`scope: "bot"`, padrão) ou todos. Sem `matchers`, vale para chamadas com os mesmos argumentos de texto; com `matchers: []`, para qualquer chamada da ferramenta.
- Uma mensagem no chat **não** decide nada.
- `POST /v1/runs/{id}/cancel` numa execução que espera cancela o cartão (`cancelled`).

`Rule` (regra permanente do usuário): `id`, `botId` (`null` = todos os bots), `tool` (nome, ou `*`), `effect` (`allow` ou `deny`), `matchers` (lista de `{ field, op, value }`, todos precisam valer; `op`: `equals`, `starts_with`, `contains`, `glob`; `field` é um caminho com pontos nos argumentos; vazio = qualquer chamada), `note`, `createdBy` (`user` ou `approval`), `sourceApprovalId`, `createdAt`, `updatedAt`. Quem proíbe vale mais que quem libera.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/approval-rules?botId=` | | `200 { items: [Rule] }`, da mais antiga à mais nova. Com `botId`: as desse bot e as globais |
| `POST /v1/approval-rules` | `{ tool, effect, botId?, matchers?, note? }` | `201 Rule`; `400` |
| `PATCH /v1/approval-rules/{id}` | `{ effect?, matchers?, note? }` | `200 Rule`; `400`, `404` |
| `DELETE /v1/approval-rules/{id}` | | `200 { deleted: true }`; `404` |

Tempo real: o quadro `approval.changed` (`{ change: "created"\|"updated", approval }`) chega a toda conexão quando um cartão aparece ou muda de situação. As regras e o cofre não têm quadro: leia de novo depois de escrever.

---

## Cofre de segredos

Só **escrita**: não existe rota nem campo que devolva um valor. O que é e o que não protege: [COFRE.md](COFRE.md). Sem a seção `vault` na configuração, ou sem a chave no ambiente, as rotas de escrita respondem `503 unavailable` com a mensagem que diz o que falta (a listagem funciona sem chave).

`Secret`: `name` (letras maiúsculas, números e `_`, começando por letra, até 64), `description`, `keyId` (impressão digital da chave que o cifrou), `grantedBotIds` (quem pode usar), `createdAt`, `updatedAt`, `lastUsedAt`.

| Método e caminho | Corpo | Resposta |
|---|---|---|
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

`Connector`: `id`, `name` (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, até 24), `description`, `transport` (`{ kind: "stdio", command, args, env, cwd? }` ou `{ kind: "http", url, headers }`; um valor de `env`/`headers` é um texto **ou** `{ secret: "NOME", prefix?: "Bearer " }`), `scope` (`read_only` ou `read_write`), `toolOverrides` (`{ "<ferramenta no servidor>": { risk } }`: o que o usuário afirma), `trustAnnotations`, `timeoutMs`, `enabled`, `origin` (`user`; `proposal` é o gancho do futuro "o bot propõe", sempre criado desligado), `grantedBotIds`, `secretNames`, `connection` (`{ connected, failures, lastError }`: **do processo que respondeu**), `discovery` (`{ discoveredAt, lastError, lastErrorAt }`: o que **qualquer** processo viu por último), `tools` e as datas.

`ConnectorTool` (de `tools`, a última listagem guardada, com o risco recalculado pela configuração de agora): `tool` (nome no servidor), `name` (`conn_<conector>__<ferramenta>`: o que o modelo chama e o que as regras casam), `description` (texto do servidor, limpo e limitado a 800 caracteres: **não confiável**), `risk`, `riskBasis` (`default`, `user`, `trusted_hint`, `tightened_by_hint`), `available` (e `reason` quando não: esquema não suportado, escopo somente leitura, nome repetido...), `hints` (`readOnlyHint`, `destructiveHint` como o servidor os declarou). `tools` é `null` até o servidor ser listado uma vez.

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/connectors` | | `200 { items: [Connector] }` |
| `POST /v1/connectors` | `{ name, transport, description?, scope?, tools?, trustAnnotations?, timeoutMs?, enabled?, grantBotIds? }` | `201 Connector`; `400` (configuração recusada: shell com `-c`, `http://` fora de localhost, segredo que não existe no cofre...); `409` nome repetido |
| `GET /v1/connectors/{nome}` | | `200 Connector`; `404` |
| `PATCH /v1/connectors/{nome}` | `{ description?, transport?, scope?, tools?, trustAnnotations?, timeoutMs? (null: o padrão), enabled? }` | `200 Connector`. `transport` e `tools` **substituem** o que havia; a conexão aberta com a configuração antiga é descartada |
| `DELETE /v1/connectors/{nome}` | | `200 { deleted: true }`; `404` |
| `PUT /v1/connectors/{nome}/grants/{botId}` | | `200 Connector`: o bot passa a ver as ferramentas na próxima execução; `404` |
| `DELETE /v1/connectors/{nome}/grants/{botId}` | | `200 Connector`; `404` |
| `PUT /v1/connectors/{nome}/tools/{ferramenta}/risk` | `{ risk: "read" \| "write_reversible" \| "external_irreversible" \| null }` | `200 Connector`: o que o usuário afirma dessa ferramenta (`null` limpa). O servidor pode **apertar** isso por uma dica, nunca afrouxar |
| `POST /v1/connectors/{nome}/test` | | `200 { ok, serverName, serverVersion, durationMs, error, tools }`: liga o servidor **do zero, no processo que atende** (um programa local precisa existir onde o servidor da API roda), lista as ferramentas e desliga. Uma falha do servidor MCP é `ok: false` com `error` (que nomeia o conector), não um erro HTTP |

Sem tempo real próprio: o app lê de novo depois de escrever. `GET /v1/doctor` ganha uma linha `Conector <nome>` por conector ligado (e, numa instalação em que a API não roda os bots, diz que não verificou).

---

## Diagnóstico (o Inspetor)

Os mesmos cálculos de `suup inspect --request`, `replay`, `resend` e `doctor`, que a CLI e o servidor compartilham (um código só, em `@suup/runtime`).

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /v1/runs/{id}/requests/{seq}` | | `200 { runId, seq, purpose, turn, request, response }`: o pedido exato ao modelo (sistema, mensagens, ferramentas...) e a resposta gravada (ou `null`); `404`; `409` se o evento não é um `model_request` (a mensagem lista os que a execução tem) |
| `POST /v1/runs/{id}/replay` | | `200 { runId, identical, finalStatus, firstDivergence, requestDiffs, stoppedBecause, reading }`: reexecuta o loop atual com as respostas gravadas, sem chamar nada de verdade; `reading` é a leitura em português; `409` se não há o que reexecutar |
| `POST /v1/runs/{id}/resend` | `{ seq, times?, model? }` | `200` com as tentativas e o resumo: reenvia o pedido gravado **como está**, `times` vezes (1 a 20, padrão 1) ou a `model`, outro modelo da configuração. Não altera a execução nem soma custo a ela. `400`, `404`, `409`, `502` |
| `GET /v1/doctor?live=true` | | `200 { ok, checks: [{ component, ok, detail }] }`: banco e migrações, busca sem acento, fila, máquina dos bots, provedores, ferramentas; com `live`, uma chamada minúscula (alguns tokens) a cada modelo |

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
| `memory.changed` | `{ change, memory }` | `change`: `created`, `updated`, `archived`, `restored` |
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
