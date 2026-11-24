# Suup: o que o backend oferece ao front

Guia para desenhar o app de desktop. Cada item diz se **já existe** (fases 1 e 2, no repositório) ou em que **fase** entra. O que já existe tem os nomes exatos dos campos; o que é futuro pode mudar de nome, mas não de natureza.

**Como desenhar** (cartões, tokens, estados, acessibilidade): [DESIGN.md](DESIGN.md) é o padrão obrigatório; este documento diz só *o que* o backend oferece.

A **API de rede existe** (fase 2): HTTP e tempo real por Server-Sent Events, descritos em [API.md](API.md) e tipados no pacote `@suup/api`, que o app importa (esquemas, tipos, o cliente `createClient` e o `subscribe` do stream). Este documento diz *o que* cada tela precisa; o API.md diz *como* pedir. Onde a API real difere do que este guia prometia antes de ela existir, o texto abaixo já foi corrigido (a seção 12 resume as diferenças).

## 1. As três camadas de dados

| Camada | O que é | Como o front usa |
|---|---|---|
| **Conversa** | Mensagens entre você e um bot (existe) | A tela de chat |
| **Execução** (`run`) | Uma rodada de trabalho do bot, com começo, fim e um log de eventos (existe) | O que aparece "dentro" de uma resposta do bot: plano, ferramentas, conclusão |
| **Estado** | Bots, memória, rotinas, aprovações, segredos, dispositivos | Telas de configuração e painéis laterais |

Uma mensagem sua abre uma execução. Uma rotina e uma tarefa delegada por outro bot também abrem. Então nem toda execução nasce numa conversa aberta na tela.

## 2. Bot (existe)

| Campo | Tipo | Observação |
|---|---|---|
| `id` | texto | Identificador |
| `name` | texto | Nome exibido |
| `description` | texto | Uma linha sobre a função |
| `personality` | texto longo | Instruções em texto livre |
| `modelProvider`, `modelId` | texto | Qual modelo o bot usa |
| `allowedTools` | lista de textos | Ferramentas liberadas |
| `limits` | objeto | `maxTurns`, `maxCostUsd`, `maxDurationMs` |
| `avatar` | texto ou vazio | Referência opaca que o app interpreta (`mascot:<formato>` com um dos 25 formatos do motor de avatar, um emoji, id de arquivo...): o servidor só a guarda |
| `isDefault` | verdadeiro/falso | O bot principal, o que recebe a mensagem quando nenhum é escolhido |
| `pinned`, `groupName`, `sortOrder` | booleano, texto ou vazio, inteiro ou vazio | Onde o bot aparece na lista: fixado (blocos grandes no topo), sob um grupo nomeado, ou na lista padrão "Bots" |
| `avatarStyle` | `shapes` ou `pixel` | A família do mascote que `avatar` nomeia: as formas do motor (padrão, e o de todo bot antigo) ou os 17 mascotes pixelados (`mascot:gato`, por exemplo); o app escolhe o desenho por aqui |
| `avatarPixel3d` | verdadeiro/falso | Só vale com `avatarStyle: pixel`: o mascote é desenhado em 3D (voxels girando, rasterizados de volta em pixels); padrão falso (2D). Escolha por bot; movimento reduzido mostra a vista de frente (= 2D) |
| `color` | id da paleta ou vazio | A cor do mascote e do balão do usuário (`laranja`, `azul`, `verde`, `roxo`, `rosa`, `amarelo`, `cinza`, `grafite`, `branco`); o servidor só guarda o id; sem cor, o app escolhe uma pelo id do bot |
| `createdAt`, `updatedAt` | data | |
| `archivedAt` | data ou vazio | Bot arquivado não recebe trabalho novo |

Para a **lista de bots** a API devolve junto, em cada bot: `latestRun` (a execução mais recente, com o `status` e se está `paused`: o indicador de atividade), `conversationId` (a conversa direta, se já existe) e `unreadCount` (mensagens não lidas).

Ainda não existe: nível de autonomia (fase 4), tela própria (fase 5).

Ações: criar, editar, arquivar, tornar principal, listar (com ou sem arquivados), **propor um bot a partir de uma descrição** (`draft`: devolve nome, descrição e personalidade para a pessoa revisar; não cria nada) e listar os **modelos** e as **ferramentas** disponíveis, para o formulário de criar e editar.

## 3. Execução (existe)

| Campo | Tipo | Observação |
|---|---|---|
| `id` | texto | |
| `botId` | texto | |
| `origin` | `user`, `routine`, `delegation`, `proactive` | Quem abriu |
| `parentRunId` | texto ou vazio | Preenchido quando outro bot delegou |
| `objective` | texto | O pedido |
| `acceptanceCriteria` | lista de textos | Critérios de pronto |
| `plan` | lista de passos | Ver abaixo |
| `conversationId` | texto ou vazio | A conversa cuja mensagem abriu a execução; vazio nas de rotina e de delegação |
| `status` | ver seção 4 | |
| `paused` | verdadeiro/falso | **Você pausou a execução** (seções 4 e 6). Não é um estado novo: vem junto de `queued` ou `running` |
| `failureOrigin`, `failureDetail` | texto | Só quando `status` é `failed` |
| `result` | `{ summary, evidence[] }` | Só quando concluída |
| `turns` | número | Idas e vindas com o modelo |
| `inputTokens`, `outputTokens` | número | |
| `costUsd` | texto decimal | Ex.: `"0.034100"` |
| `createdAt`, `startedAt`, `finishedAt` | data | |

**Passo do plano:** `{ id, title, status, note? }`, com `status` em `pending`, `in_progress`, `done` ou `dropped`. No máximo um passo fica `in_progress`. Passo `dropped` sempre tem `note` explicando o motivo.

**Evidência:** lista de `{ criterion, evidence }`, uma entrada por critério de pronto.

## 4. Estados da execução (existe)

| `status` | Significado | O que mostrar |
|---|---|---|
| `queued` | Na fila | "Na fila" ou "Retomando" |
| `running` | Trabalhando | Indicador de atividade, plano vivo |
| `waiting_user` | O bot fez uma pergunta | A pergunta em destaque e o campo de resposta |
| `waiting_approval` | Há uma ação aguardando aprovação (existe): `GET /v1/approvals?runId=&status=pending` | Cartão de aprovação |
| `waiting_timer` | O bot marcou um retorno para si mesmo (`wakeAt`, `wakeNote` na `Run`) e a execução está parada até a hora | **Nada**: sem marcador, sem indicador de trabalho (decisão do dono); o bot já avisou na própria mensagem. Avatar calmo (`idle`). Só o inspetor mostra a hora |
| `done` | Concluída | Resumo e evidência |
| `failed` | Falhou | Origem da falha em destaque |
| `cancelled` | Você mandou parar | "Cancelada" |

Detalhe importante: quando você responde uma pergunta, a execução passa um instante por `queued` antes de voltar a `running`. O front deve tratar `queued` depois de `waiting_user` como "retomando", não como "voltou para o fim da fila".

**Pausada** não é um estado: é `paused: true` junto de `queued` (parada, esperando `resume`) ou de `running` (a caminho de parar, até o worker chegar ao próximo ponto seguro). Mostre "Pausada" sempre que `paused` for verdadeiro, seja qual for o `status`. O servidor tira a pausa sozinho quando a execução termina ou passa a esperar você.

**Origem da falha** (`failureOrigin`), para o diagnóstico ficar visível:

| Valor | Significado |
|---|---|
| `provider` | A API do modelo falhou (rede, chave, limite de taxa) |
| `model` | O modelo se comportou mal (recusou, parou sem concluir, ficou em laço) |
| `tool` | Uma ferramenta falhou |
| `harness` | Defeito do próprio Suup |
| `limit` | Estourou o limite de turnos, custo ou tempo |
| `approval` | Aprovação negada ou expirada (fase 3) |
| `user` | Cancelada por você |

## 5. Linha do tempo de uma execução (existe)

Cada execução tem um log de eventos numerados (`seq`), só de acréscimo. É a fonte de tudo o que aparece na tela durante o trabalho. Cada evento tem `seq`, `createdAt`, `type` e `payload`.

| `type` | `payload` | Componente sugerido |
|---|---|---|
| `run_started` | `botId`, `objective`, `acceptanceCriteria` | Cabeçalho da execução |
| `model_response` | `blocks` (texto e pedidos de ferramenta), `modelVersion`, `durationMs` | Balão de texto do bot |
| `tool_call` | `callId`, `name`, `args` | Linha recolhível "usando ferramenta" |
| `tool_result` | `callId`, `content`, `isError`, `truncated`, `durationMs` | Resultado dentro da mesma linha |
| `plan_updated` | `plan` | Lista de checagem que se atualiza |
| `user_message` | `text`, `inboxId?`, `linkedApprovalId?` | Sua mensagem, marcada como "lida pelo bot". `linkedApprovalId` existe quando ela chegou logo depois de uma recusa sua e antes do próximo turno do bot: o bot a leu como sendo sobre a ação recusada (o app não precisa desenhar nada diferente) |
| `nudge` | `reason`, `text` | Aviso discreto: "o Suup pediu ao bot que continuasse" |
| `finish_attempt` | `summary`, `evidence`, `accepted`, `rejectionReasons` | Conclusão aceita, ou "conclusão recusada" com os motivos |
| `review` | `verdict` (`approve`, `reject` ou `unverified`), `notes`, `discrepancies?` (num `reject`: lista de `{ claimed, shows, where }`, ao menos uma), `warning?` (só em logs antigos), `failed?` (`provider` ou `model`: a revisão falhou e o resultado é `unverified`) | Selo do revisor. `unverified`: o revisor não conseguiu verificar algo mesmo com as evidências, ou a revisão falhou; `notes` diz o quê, e a decisão vai para o dono (numa rotina, a execução termina não concluída) |
| `review_reprompt` | `callId`, `args`, `reason` | O revisor reprovou sem apontar divergência concreta e foi perguntado de novo (no máximo uma vez por revisão); não é uma reprovação |
| `review_evidence` | `round`, `callId`, `notes`, `requested` (`results`, `calls?`, `files`), `supplied`, `missing` (com `hint?`), `omitted?`, `budgetChars` | Aviso discreto ("o revisor pediu mais evidências"). Resultados de ferramenta e argumentos de chamada (`kind: tool_call`) vêm por referência (`ref` = id da chamada, o conteúdo já está no log); `omitted` lista o que só não coube no orçamento; arquivos trazem `content` e `hash`, para a retomada e o replay não dependerem do disco |
| `escalated` | `question`, `questions?`, `reason?` | Pergunta em destaque. `questions` (1 a 5 itens `{ question, options?, multiple?, allowOther? }`) existe quando há escolhas ou várias perguntas; `options` só quando as respostas são discretas |
| `status_changed` | `from`, `to`, `failure?`, `result?` | Mudança de estado |
| `context_loaded` | `rules`, `profile`, `history`, `historyNote?`, `compactionThreshold?`, `memoryOmitted?` | Logo depois de `run_started`: o que a memória e a conversa deram à execução. Aviso discreto ("3 regras, 1 fato do perfil, 6 mensagens anteriores"); `rules` e `profile` têm `id` e `text` e aparecem na tela de memória. `memoryOmitted` (`{ count, chars, limitItems, ceilingChars }`; em logs antigos, `limitChars`) existe quando regras e perfil ativos **não couberam** no teto do prompt: aviso "N memórias ficaram de fora do prompt; apague ou encurte algumas". `compactionThreshold` é o ponto de compactação que a execução usou |
| `model_error` | `kind`, `message`, `retryable`, `attempt` | "Tentando de novo" ou erro |
| `compacted` | `summary`, `droppedMessages` | Aviso discreto: "histórico resumido" |
| `model_request` | A requisição inteira enviada ao modelo | Só no inspetor de diagnóstico |
| `policy_checked` | `callId`, `tool`, `level`, `outcome` (`allow` ou `deny`), `source` (`rule`, `reviewer`, `default`), `ruleId?`, `reason?` | Selo discreto na linha da ferramenta ("liberada pela regra X", "recusada por regra"). Só existe para o que não foi uma leitura simples |
| `approval_review` | `callId`, `tool`, `level`, `decision` (`run`/`ask`/`block`), `ruleId`, `reason`, `outcome` (`allow`/`ask`/`deny`), `adjusted?`, `skipped?`, `model?`, `promptVersion?`, `usage?`, `costUsd?`, `latencyMs?` | O modelo do Auto-review olhou a chamada (vem **antes** do `policy_checked` ou do `approval_requested` dela). Detalhe recolhido ("revisado: pode / perguntar / bloquear, e a frase"); o custo e o modelo vão no detalhe técnico |
| `approval_requested` | `approvalId`, `callId`, `tool`, `args`, `level`, `summary`, `secrets`, `source`, `expiresAt?`, `reason?`, `writtenRuleId?` | **O cartão de aprovação** (seção 8, fase 3). `args` é o conteúdo exato; segredos aparecem como `{{secret:NOME}}` |
| `approval_decided` | `approvalId`, `callId`, `decision` (`approved`, `denied`, `cancelled`, `expired`), `reason?`, `ruleId?` | O cartão resolvido; entra no log quando o worker retoma a execução |
| `approval_stale` | `approvalId`, `callId`, `waitedMs`, `thresholdMs` | Só no inspetor: o cartão foi aprovado depois de esperar mais que o limite (`staleAfterMinutes`); a ação **não** rodou, o bot foi avisado. A linha do chat vem do `Approval` (`stale`, `waitedMs`): "Aprovado depois de 5 h · Escrever a.txt" |
| `approval_grant_used` | `approvalId`, `callId`, `tool` | Só no inspetor: uma chamada idêntica à aprovada tarde rodou sem novo cartão (a permissão de uma vez, desta execução) |
| `wait_scheduled` | `at`, `note`, `minutes`, `callId?` | Só no inspetor: o bot marcou um retorno. A chamada de `schedule_return` não vira cartão |
| `wait_fired` | `at`, `note`, `delayMs?` | Só no inspetor: a hora do retorno chegou (gravado pelo job que acorda as execuções) |
| `wait_cancelled` | `reason` (`user_message`, `cancelled`, `replaced`, `finished`) | Só no inspetor: o retorno não vai disparar |
| `secret_requested` | `callId`, `name`, `reason?` | O bot pede um segredo: abre o formulário seguro (seção 8, fase 3). A execução fica em `waiting_user` |

Observações:

- `tool_call` e `tool_result` se ligam pelo `callId`. Entre um e outro, a ferramenta está rodando.
- Uma chamada **negada** (por você, por regra ou pelo revisor) tem `tool_result` com `outcome: "denied"` e `isError: true`, e as chamadas que vinham depois dela no mesmo turno ganham um `denied` "não foi executada". Uma chamada que espera cartão ainda **não tem `tool_call`**: ele só entra depois da aprovação (o cartão é o `approval_requested`).
- O conteúdo de um evento nunca tem o valor de um segredo: o que o app vê é `{{secret:NOME}}` ou `[REDACTED:NOME]`.
- Em `GET /v1/runs/{id}/events?view=chat` (e no stream), o `payload` de `model_request` vem **resumido** (`omitted: true`, `provider`, `model`, `purpose`, `messageCount`, `toolCount` e `toolStats`, só números): o pedido inteiro pode ter megabytes e só o Inspetor o desenha (`GET /v1/runs/{id}/requests/{seq}`). Todos os outros tipos desta tabela vêm inteiros.
- `model_response`, `model_request` e `model_error` têm `purpose`: `agent` (o bot), `review` (o revisor) ou `compaction` (resumo do histórico). Na conversa, só `agent` aparece.
- O texto do bot chega **por turno**, inteiro, e não letra por letra.
- `escalated` com `reason: "review_tie_break"` é o caso em que o revisor recusou duas vezes (ou não conseguiu verificar, `review` com `unverified`, o que inclui reprovar duas vezes sem apontar divergência) e o Suup pede que você decida; o texto da pergunta diz qual dos dois foi.
- Resultado de ferramenta pode ser grande ou cortado (`truncated`); mostrar recolhido por padrão.

**Ferramentas que existem hoje**, para ícones e rótulos: `shell`, `read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `web_fetch`, `web_search` e `web_read` (busca e leitura de páginas na web, [BUSCA.md](BUSCA.md); `web_search` é leitura, sem cartão; `web_read` só roda sem cartão para um endereço que já apareceu na execução, e para um novo é um cartão "Ler uma página nova: <url>" com o endereço inteiro; na fila de ações aparecem como "Buscar “…” na web" e "Ler <host>", categoria Web), mais as de controle, `plan`, `finish`, `escalate` e (só onde há cofre) `request_secret`. Da fase 2: `remember`, `recall`, `forget` e `search_conversations` (memória; "salvo na memória" quando `remember` dá certo). Entram depois: conectores (fase 3), `delegate` e rotinas (fase 4), navegador (fase 5), dispositivos (fase 6).

## 6. O que você pode fazer numa execução (existe)

| Ação | Efeito |
|---|---|
| Enviar mensagem com o bot trabalhando | Fica gravada na hora; o bot lê no próximo ponto seguro, entre um turno e outro. Estados da mensagem: "enviada" e "lida pelo bot" (quando surge o evento `user_message`) |
| Responder uma pergunta | A execução retoma |
| Pausar | `POST /v1/runs/{id}/pause`. Termina a volta em andamento (o modelo e as ferramentas que ele pediu) e para no próximo ponto seguro; fica retomável: `queued` + `paused: true` |
| Interromper agora | `POST /v1/runs/{id}/interrupt`. Corta a chamada ao modelo e a ferramenta em curso em até alguns segundos (a ferramenta fica registrada como interrompida, resultado desconhecido); fica retomável |
| Retomar | `POST /v1/runs/{id}/resume`. Continua de onde o log parou |
| Cancelar | `POST /v1/runs/{id}/cancel`. Estado final `cancelled`; a conversa recebe o aviso "A execução foi cancelada" |

Quem trabalha é um worker, que pode ser outro processo: pausar, interromper, cancelar e retomar funcionam por meio do banco e **precisam de um worker vivo** para serem aplicados. Pausar não vale para uma execução que espera você (`waiting_user`) ou uma aprovação: a resposta (ou o cartão) é que a move.

Várias mensagens seguidas são entregues juntas.

## 7. Tempo real (existe, `GET /v1/stream`)

Uma conexão por instância do app (Server-Sent Events; o cliente `api.subscribe` do `@suup/api` cuida de reconectar e retomar). Chega ao vivo, sem recarregar:

| Evento do stream | Para quê |
|---|---|
| `run.event` | Novos eventos das execuções que o app **escolheu seguir** (a tela aberta). Com o `model_request` resumido |
| `run.updated` | Mudança de estado, pausa, plano, uso ou resultado de **qualquer** execução (o indicador de cada bot na lista) |
| `message.created` | Mensagem nova em qualquer conversa (inclui a pergunta do bot e os avisos do sistema) |
| `message.updated` | Mudou o estado de entrega de uma mensagem sua (`sent` → `delivered`) |
| `conversation.updated` | Mudou a lista de conversas: mensagem nova, lida, arquivada (com `unreadCount` e `activeRun`) |
| `memory.changed` | Uma memória foi criada, editada, esquecida, restaurada, confirmada ou recusada. Com `change: "pending"` e `memory.status: "pending"`, **um bot ou a consolidação propôs** uma regra, um fato sobre o usuário ou uma nota que espera confirmação: o app **não** mostra cartão no chat nem em Pendências (o dono não quer gerenciar memória); a tela Memória lista as pendentes que sobraram (`memory.review`, quando vem, diz por que o revisor segurou) |
| `bot.updated` | Um bot foi criado, editado, arquivado ou tornado principal |
| `ready` / `resync` | Da conexão: `resync` diz que o app deve **recarregar** o que mostra (veja API.md, "Retomada") |

Cada evento tem um id que só cresce; reconectar com o último id visto retoma **sem perder nada** (dentro da janela de retenção, 6 horas por padrão; fora dela o servidor manda `resync`). Receber o estado por **REST depois de abrir o stream** é o jeito de abrir uma tela sem perder o que muda no intervalo.

Ainda não existem: novo cartão de aprovação (fase 3), notificação do sistema por aviso (a pergunta do bot já chega como `message.created`; mostrar a notificação é do app) e os quadros da tela do bot (fase 5).

## 7b. O Principal como supervisor

O app só desenha o que o backend oferece: a **estrela** no avatar do bot com `isDefault` (barra lateral, cabeçalho do chat, painel, paleta); em Configurações > Memória, "Principal" (`/v1/supervisor/settings`) e "Revisões da equipe" (`/v1/supervisor/reviews`); a mensagem da manhã e o resumo de uma delegação são mensagens comuns do bot no chat dele; a delegação e `team_recall` são linhas de ação da categoria "Equipe"; as chamadas `remember` e `forget` **não** viram linha nem indicador (decisão do dono). Detalhes visuais em [DESIGN.md](DESIGN.md) §5 e §3c; regras do comportamento em [SUPERVISOR.md](SUPERVISOR.md).

## 8. O que entra depois

### Fase 2: conversas e memória (existe)

- **Conversa:** `id`, `kind` (`direct` com um bot; `group` ainda não recebe mensagens), `members` (os bots; você está implícito), `title` (só em grupo), `lastMessageAt`, `lastMessage` (cortada em 200 caracteres), `unreadCount`, `lastReadSeq` e `activeRun` (a execução em primeiro plano). **Não lidas** = mensagens do bot e do sistema depois de `lastReadSeq`; as suas nunca contam. `POST /v1/conversations/{id}/read` marca como lida (até uma mensagem, ou tudo).
- **Mensagem:** `id`, `seq`, `authorKind` (`user`, `bot` ou `system`: o aviso de falha ou cancelamento), `authorBotId`, `text`, `runId`, `status` (`sent` ou `delivered`, só nas suas enviadas com o bot trabalhando) e `createdAt`; `question` (`{ questions: [{ question, options?, multiple?, allowOther? }], reason? }`) só na mensagem do bot que pergunta algo: o cartão de pergunta se desenha a partir dela, e a resposta é texto comum (os rótulos escolhidos, uma linha por pergunta quando são várias, `→ (pulou)` para a que foi pulada).
- **Sala de grupo (fase 4):** uma conversa com vários bots; cada um decide se responde.
- **Memória**, em camadas, tudo visível e editável:

| Camada | Exemplo | Escopo |
|---|---|---|
| Regras | "não faça commit sem autorizar" | Todos os bots ou um só |
| Perfil | nome, curso, rotina, máquinas | Compartilhado |
| Notas do bot | o que ele aprendeu naquela função | Por bot |
| Diário | o que foi feito, quando, com que resultado | Por bot |

Cada item de memória tem texto, camada, escopo, **autor** (`user` ou `bot`), origem (a execução, a conversa e a mensagem de onde veio, quando foi um bot) e datas, e pode estar **arquivado** (esquecido: dá para restaurar). A API lista (por camada, escopo e bot, com ou sem arquivados), cria (regra, perfil e nota; o diário é do sistema), edita, esquece, restaura e busca (por palavras, sem diferenciar acentos). Uma memória nova ou esquecida vale a partir da **próxima** execução. Na conversa aparece um aviso "salvo na memória" quando o bot grava algo: é o `tool_result` de `remember` na linha do tempo.

### Fase 3: aprovações, cofre e conectores

O backend de aprovações e do cofre **existe** (API.md, [APROVACOES.md](APROVACOES.md), [COFRE.md](COFRE.md)); o app o desenha (README do app, "Aprovações, cofre e conectores"). O que ele desenha:

- **Cartão de aprovação** (`Approval`, de `GET /v1/approvals?status=pending`, e ao vivo pelo quadro `approval.changed`). Campos e o que cada um vira na tela:
  - título: `summary` (uma linha; ex.: "Shell em repo: git push origin main");
  - conteúdo exato: `args` (mostrar como código, todos os campos; é o que vai rodar, sem retoques). Um marcador `{{secret:NOME}}` vira um selo "usa o segredo NOME" (e `secrets` lista os nomes), nunca um valor;
  - nível de risco: `level` (`read`, `write_reversible`, `external_irreversible`) como selo; `source` explica por que perguntou (`default`: o nível; `reviewer`: a revisão automática; `rule`: uma regra);
  - de quem: `botId`; onde: `conversationId` e `runId`; quando: `createdAt`; `expiresAt` (só quando a configuração faz expirar) como contagem regressiva;
  - botões (regra do dono): numa **ação comum**, só o texto **Recusar** e a pílula **Aprovar** (sem botão dividido, sem menu, sem "sempre permitir"). Só quando `outbound` não é `null` (a ferramenta declarou que é uma mensagem a outra pessoa; o app nunca adivinha pelo nome) o cartão tem **Descartar** e o botão dividido **Enviar**, com o menu "Permitir destinatário" (`allowRecipient: true`; indisponível se `outbound.recipients` é `null`), "Precisa de aprovação" e "Gerenciar regras". Tudo por `POST /v1/approvals/{id}/decision`. Um segundo clique, ou um cartão já cancelado, volta `409`: recarregue o cartão. Regras permanentes só nascem de um ato explícito do usuário (tela de regras, `suup rules`); a tela diz que uma regra **sem condições vale para qualquer uso da ferramenta**, e que a comparação é sempre "exatamente igual";
  - estados do cartão (`status`): `pending` (botões), `approved`, `denied` (mostra `reason`), `cancelled` (a execução foi cancelada), `expired`. Cartão resolvido vira uma linha do histórico, não some;
  - o cartão fica **dentro da conversa**, no lugar da chamada da ferramenta (a `Run` está em `waiting_approval`, avatar `waiting`), e também na tela **Pendências** (todos os bots, `GET /v1/approvals?status=pending`) e num contador na barra lateral. Pelo chat, escrever "sim" **não** aprova: só os botões.
  - Depois de decidir, a execução volta sozinha para `queued` e segue; mostre "retomando", como após uma resposta.
- **Modo e regras escritas (Auto-review)**, decisão do dono: "é auto review ou tudo". Tudo no backend ([APROVACOES.md](APROVACOES.md), API.md "Modo de aprovação" e "Regras escritas"):
  - **O modo**: `GET`/`PATCH /v1/approval-settings` → `{ mode: "auto_review" | "ask_all", reviewer: { available, model, reason } }`. Duas opções, "Auto-review" e "Perguntar tudo". Com `reviewer.available: false` mostre `reviewer.reason` e diga que o Auto-review está só aplicando a tabela de níveis (leitura e escrita reversível rodam, o resto pergunta); não finja que há revisão.
  - **As regras**: `GET/POST/PATCH/DELETE /v1/written-rules`. Uma regra é uma frase (`text`, 1 a 500 caracteres) com um tipo (`kind`: "Permitir sem perguntar" = `allow`, "Sempre perguntar" = `ask`, "Nunca permitir" = `never`), para um bot (`botId`) ou para todos (`null`), com um interruptor (`enabled`). Dica do campo: "Diga qual é a ação e quem ou o que ela afeta". Só o usuário cria; nada do modelo.
  - **No cartão**: se `reviewReason` não é `null`, mostre a frase ("por que estou perguntando"); `writtenRuleId` liga à regra (pode ter sido apagada).
  - **Chamada recusada pela regra** (`policy_checked` com `outcome: "deny"`, `source: "reviewer"`, `writtenRuleId`, `reason: "Bloqueado pela regra \"…\""`): sem cartão; um registro recolhido "Bloqueado pela regra …" no lugar da chamada.
  - As regras exatas (`approval-rules`) continuam existindo no backend, mas a tela nova mostra só as escritas.
- **Tela de regras** (`GET/POST/PATCH/DELETE /v1/approval-rules`): uma tabela com efeito (libera/proíbe), de quem (um bot ou "todos"), ferramenta (ou "qualquer"), condições (`campo operador valor`: igual, começa com, contém, padrão `*`/`?`), anotação e origem (`createdBy: "approval"` = criada num cartão, com link para o cartão em `sourceApprovalId`). Editar efeito, condições e anotação; apagar. Uma regra que proíbe vale mais que uma que libera; mostre isso.
- **Níveis de risco** de uma ação: leitura, escrita reversível, externa ou irreversível. Cada ferramenta de `GET /v1/tools` traz o `risk` padrão e `dynamicRisk` (o nível depende dos argumentos e de onde roda: o `shell`); use no formulário de criar bot para avisar o que pede cartão.
- **Rascunho:** tudo o que vai para outra pessoa aparece como rascunho que você envia (depende dos conectores: as ferramentas de conector já existem; o rascunho como etapa própria, não).
- **Formulário seguro** (`secret_requested` no log; `GET /v1/runs/{id}/secret-request` devolve `{ name, reason, botId }` enquanto a execução espera). Aparece **dentro da conversa**, no lugar da pergunta do bot: o nome do segredo, o motivo que o bot deu, um campo de senha (sem eco, sem sugestão do navegador, sem colar no histórico) e os botões **Guardar** e **Recusar**. O valor vai por `POST /v1/runs/{id}/secret-request/answer` (`{ value }` ou `{ declined: true }`) **direto ao cofre**; nunca entra no estado do app, numa mensagem, no log nem em armazenamento local. Depois de guardar, o formulário some e a execução volta sozinha. O bot só fica sabendo que o segredo está disponível.
- **Cofre** (`GET /v1/vault` diz antes de escrever se o servidor tem cofre e chave; `GET /v1/secrets`, `PUT/DELETE /v1/secrets/{nome}`, `PUT/DELETE /v1/secrets/{nome}/grants/{botId}`): lista de segredos por nome com descrição, `lastUsedAt` e **quais bots podem usar** (interruptor por bot). "Novo segredo" e "Trocar o valor" abrem o mesmo campo de senha; **não existe** "mostrar o valor" (nem na API). Mostre o aviso quando o servidor responder `503 unavailable` (sem chave do cofre) com a mensagem do servidor.
- **Conectores (MCP)**: o backend **existe** (API.md, [CONECTORES.md](CONECTORES.md)) e o app o desenha. O que ele desenha:
  - **Tela Conectores** (`GET /v1/connectors`): uma linha por conector com nome, descrição, tipo (`transport.kind`: "programa neste computador" ou "servidor HTTP"), **escopo** (`read_only` como selo "só leitura"), `enabled` (interruptor, `PATCH`), quantos bots têm acesso e a **saúde**: `discovery.lastError` (o último erro que qualquer processo viu, já com o nome do conector) e `connection` (só vale para o processo que respondeu: não mostre "desconectado" como problema, é preguiçoso). Botão **Testar** (`POST /v1/connectors/{nome}/test`) que mostra o resultado na hora, incluindo a mensagem de erro.
  - **Adicionar conector:** formulário com dois tipos. Programa local: o **executável** (um campo só, sem espaços) e uma lista de **argumentos** (um por linha, nunca um texto de shell), variáveis de ambiente (cada uma é "texto" ou "segredo do cofre": um seletor com a lista de `GET /v1/secrets`, e um atalho para cadastrar um segredo novo). HTTP: URL e cabeçalhos com a mesma escolha texto/segredo, e o atalho "Authorization: Bearer <segredo>". Escopo e tempo limite. **Avisos obrigatórios** no formulário, em texto visível: um programa local roda **no computador do servidor/worker, fora da máquina isolada dos bots, com as permissões do usuário que roda o Suup**; e "só instale servidores em que você confia". As recusas da API (`400`, com a mensagem em português) aparecem junto do campo.
  - **Por bot e por ferramenta** (no app: dentro de cada conector, em Configurações > Conectores, e dentro de cada segredo, em Configurações > Cofre; não na tela de editar bot): a concessão é **por ferramenta** (`PUT /v1/connectors/{nome}/grants/{botId}` com `{ tools: "all" | [nomes no servidor] }`, que **substitui** o conjunto; `DELETE` tira o acesso; o estado vem de `grants: [{ botId, all, tools }]`). O fluxo que o app deve ter: ao conceder a um bot, **nenhuma ferramenta marcada**, uma caixa por ferramenta (as da lista `tools` com `available: true`) e dois atalhos, **"selecionar todas"** (`tools: "all"`) e **"só as de leitura"** (as marcadas com `risk: "read"`, enviadas como lista). Uma ferramenta não concedida não existe para o bot: mostre-a desmarcada, sem sugerir que "quase" funciona. A mudança vale a partir da **próxima** execução.
  - **Revisão de definição** (`pin` de cada ferramenta e `pendingReviews` do conector): uma ferramenta `changed` ou `new` está **desligada para todos os bots**. Mostre um selo "definição mudou, esperando sua revisão" na linha da ferramenta e na linha do conector (contagem `pendingReviews`), e uma tela de revisão (`GET /v1/connectors/{nome}/review`): por ferramenta, a descrição e o esquema **antes** (`approved`, o que o usuário aprovou; `null` para uma nova) e **agora** (`current`), lado a lado, como citação de texto do servidor, e um botão **Aprovar esta versão** (`POST /v1/connectors/{nome}/tools/{ferramenta}/review` com `{ fingerprint: currentFingerprint }`; `409` = mudou de novo, recarregue e mostre a nova). Não há botão "aprovar tudo". O histórico (`GET /v1/connectors/{nome}/events`) pode ir num detalhe. O doctor também avisa.
  - **Custo de definições** (opcional, no Inspetor): cada `model_request` traz `toolStats` (`definitions`, `deferred`, `estimatedTokens`, `loadedTokens`) e o evento `tool_catalog` diz o modo (`direct`, `hosted`, `client`, `meta`); em `meta`, as chamadas aparecem como `search_tools` e como a **ferramenta real** (o `tool_call` de um `use_tool` é gravado com o nome e os argumentos reais, e o cartão é o da ferramenta real).
  - **Lista de ferramentas de um conector** (`tools` do `Connector`, ou do `test`): nome (`tool`, e `name` em detalhe: é o que aparece nos cartões e nas regras), descrição (texto **do servidor, não confiável**: mostre como citação, com um selo "escrito pelo servidor", nunca como texto do app), o **risco** com o selo igual ao dos cartões e **de onde veio** (`riskBasis`: padrão = "pergunta antes"; definido por você; **mensagem a outra pessoa** (`outbound`, a marca do usuário: caixa "Envia mensagem para outra pessoa" e campo do destinatário por ferramenta); dica do servidor que você aceitou; **apertado pelo servidor**, com o aviso de que ele diz que a ferramenta escreve, e a saída é uma regra criada em Permissões, não marcar como leitura), as `hints` do servidor, e `available`: as que **não** são oferecidas ficam numa seção própria com o `reason` (esquema não suportado, fora do escopo somente leitura...).
  - **Marcar uma ferramenta como leitura:** um seletor de risco por ferramenta (`PUT /v1/connectors/{nome}/tools/{ferramenta}/risk`, com `null` para voltar ao padrão), com a explicação de que "leitura" executa **sem cartão**. Uma opção "Confiar nas dicas do servidor" no conector (`trustAnnotations`), com o aviso do que isso afrouxa.
  - **No cartão de aprovação** de uma ferramenta de conector (`tool` começa com `conn_`): mostre o nome do conector e o da ferramenta separados (a linha `summary` já diz `Conector <nome> → <ferramenta> ...`), e que o conteúdo sai do computador para um servidor externo.
  - **Na linha do tempo**, o resultado de uma ferramenta de conector vem **dentro do envelope** `<<<EXTERNAL_DATA ... <<<END_EXTERNAL_DATA`: desenhe-o como "dado externo" (recuado, com o selo), nunca como fala do bot. Um erro de conector começa com `Conector "nome":`.
  - **Propostas do bot** (`origin: "proposal"`, sempre desligadas): ainda não existem; quando existirem, serão cartões de aprovação com o comando e os argumentos exatos, e o app deve distingui-las na lista.
  - **Galeria de conectores** (backend **existe**; a tela é `features/plugins/ConnectorsScreen.tsx`, ligada a ele em 23/11/2026, DESIGN.md §5d; [CONECTORES.md](CONECTORES.md), "Galeria" e "OAuth"; API.md, "Galeria e login OAuth"). O que o backend oferece e como o app deve usá-lo, sem inventar nada:
    - **Lista** (`GET /v1/connector-catalog`): uma linha por `CatalogItem`, na ordem recebida. Logo: `entry.icon` é um *slug* do Simple Icons (CC0; `github`, `notion`, `linear`, `figma`, `stackoverflow`, `google`), só para identificar o serviço; `null` = ícone genérico. Nome (`entry.name`), uma linha (`entry.description`) e o estado: `available` → "Conectar"; `needs_login` → "Precisa de login" (botão "Fazer login"); `needs_secret` → "Precisa do token" (botão que abre o formulário seguro); `connected` → "Conectado"; `off` → "Desligado" (o interruptor do conector, `PATCH /v1/connectors/{nome}`); `error` → "Erro" com `detail` e "Tentar de novo"; `unverified` → "A confirmar", sem botão, com `entry.unverifiedReason`. O detalhe de uma entrada mostra `entry.notes`, `entry.source`, `entry.license`, `entry.egressHosts` e, quando existe, `entry.disclosure` **antes** de conectar (a Composio).
    - **Conectar** = `POST /v1/connector-catalog/{id}/install` e seguir `next`:
      - `next: "login"` (OAuth): `POST /v1/connectors/{item.connector}/oauth/start` → abrir `authorizationUrl` no **navegador do sistema** (`platform.openUrl`; no Tauri, o comando `open_url`; no navegador e no Playwright, só a URL) e mostrar "Aguardando login…", consultando `GET /v1/connectors/{nome}/oauth/status` (a cada 1 a 2 s) até `connected` (pronto: releia a galeria e os conectores), `error` (mostre `error` e "Tentar de novo", que chama `oauth/start` de novo) ou até `expiresAt` passar (10 min). O servidor recebe o retorno sozinho em `redirectUri`: no ouvinte `http://127.0.0.1:<porta>/callback` do processo do servidor (`GET /v1/info` diz `oauthCallback: "loopback"`; funciona quando o navegador e o servidor estão no mesmo computador, o app com o servidor embutido) ou, numa VPS com `server.publicUrl`, na rota `<publicUrl>/oauth/callback` (`oauthCallback: "public"`; funciona de qualquer lugar). **Nunca há campo para colar endereço** (decisão do dono, 23/11/2026). Conectado a uma VPS (`mode === "vps"`) que diz `loopback`, o login não pode voltar: não ofereça "Conectar" numa entrada OAuth e diga, numa frase, que a VPS precisa do endereço público para conectar por login; as entradas por token continuam. Nunca peça nem mostre token.
      - `next: "secret"` (token): o formulário seguro do cofre com o **nome fixo** `entry.auth.secret` (`PUT /v1/secrets/{nome}` com `{ value }`, o mesmo `SecretInput` do resto do app), mostrando `entry.auth.steps` (onde criar o token); salvo, chame `install` **de novo**: ele liga o conector e responde `next: "none"`.
      - `next: "none"`: pronto.
      - `oauth_owner_client` (Google): hoje é `unverified`; mostre `entry.auth.steps` (o passo a passo do app OAuth do dono) como texto, sem botão de conectar.
    - **Desconectar** (OAuth): `DELETE /v1/connectors/{nome}/oauth` (revoga quando o servidor deixa, apaga os tokens, desliga). Remover o conector (`DELETE /v1/connectors/{nome}`) também apaga o login.
    - Depois de conectar, as ferramentas aparecem no conector como as de qualquer outro (concessão por bot, revisão). As de `entry.readTools` já vêm marcadas como leitura; as demais perguntam.
    - **Cartão do bot propondo um conector** (`tool: "propose_connector"`, nível `external_irreversible`): o `summary` já é a frase do cartão em português ("Instalar o conector Notion da galeria (fonte): … Servidor: … Login: … Fica desligado até você entrar em Configurações > Conectores."), montada **da entrada**, nunca do texto do bot; os `args` são `{ connector, reason }`. Aprovado, o conector aparece na galeria como `needs_login`/`needs_secret` (origem `proposal`).
  - Mudanças de conectores não têm quadro no stream: releia depois de escrever. O cofre continua sendo onde se cria e troca o segredo; o conector só o cita pelo nome.
- **Rede dos bots** (backend existe e o app desenha: seção "Rede" na edição do bot, `runsIn` e hosts nos conectores, cartão `request_network_access`; [REDE.md](REDE.md), padrões em [DESIGN.md](DESIGN.md) §3b). O que a tela precisa:
  - **sem isolamento (sandbox local):** a API não tem um campo para isso; o app olha se `GET /v1/tools` lista `request_network_access` (só o sandbox isolado a registra) e, se não lista, diz que não há proxy nem lista de hosts. Se um dia houver um campo `sandbox` declarado, troque a dedução por ele;
  - dados: `GET /v1/bots/{id}/network` → `defaults` (liberados para todos, vêm da configuração: só leitura), `hosts` (os do bot: `host`, `createdAt`) e `refusals` (as últimas recusas do proxy: `host`, `port`, `reason`, `message`, `createdAt`);
  - ações: **Liberar host** (`PUT /v1/bots/{id}/network/hosts/{host}`; a API devolve `400` com a mensagem em português para IP, `localhost`, curinga ou texto que não é nome) e **Remover** (`DELETE`, `404` se não está na lista do bot). Cada recusa da lista pode virar um botão "Liberar `{host}`". Dizer na tela que é **nome exato** (liberar `api.exemplo.com` não libera `exemplo.com` nem subdomínios) e que um host liberado é um canal de saída;
  - **cartão de "acesso à rede"**: é um cartão comum de aprovação da ferramenta `request_network_access` (`args.host`, `args.reason`; `summary` "Allow network access to HOST until the end of this run. Reason: ..."). Mostre o host exato em destaque e o motivo; só **Recusar** / **Aprovar** (aprovar vale só para esta execução). Um botão dividido "Permitir para este bot" depende de decisão do dono (REDE.md);
  - no conector: o campo novo `runsIn` (`container` ou `host`): para `host`, mostre um aviso visível de que o programa roda **sem isolamento** no computador do worker; para `container`, mostre os hosts (`transport.egressHosts`, mais os padrões) que ele pode alcançar e um campo para editá-los (`PATCH /v1/connectors/{nome}` com `transport.egressHosts`);
  - `suup doctor`/`GET /v1/doctor` ganharam as linhas "Rede dos bots: sem saída direta" e "Rede dos bots: proxy e lista de hosts" (mostre falha com destaque: "a máquina tem saída direta").
- **Entrar com ChatGPT:** fluxo de login para usar a assinatura como modelo.

### Fase 4: rotinas, iniciativa e delegação

- **Rotina (feita, só horário; [ROTINAS.md](ROTINAS.md)):** `GET /v1/routines?botId=` dá nome, instrução, horário estruturado (`schedule`: desenhe com `describeSchedule` de `@suup/api`, nunca texto de cron), fuso, `status` (`active`, `paused`, `ended`), `nextRunAt`, a nota da rotina e `lastFire`; `GET /v1/routines/{id}/fires` dá o histórico (hora marcada, `kind` `scheduled`/`catch_up`/`manual`, `status` com `skipped` por sobreposição, `missedCount`, `resultText`, `runId`, e `sources`: as páginas que as ferramentas declararam ter lido e os conectores usados; desenhe o ícone do site só com a configuração ligada). Ações: `PATCH` só com `paused` (o app não tem formulário de horário: mudar é pedindo ao bot), `POST .../run` ("Rodar agora", `409` se a anterior ainda roda) e `DELETE`. "Editar" é uma mensagem ao bot com `routineRef: { id }` (`POST /v1/conversations/{id}/messages`): a rotina vai como dado, nunca o id no texto. Criar é conversando com o bot (o cartão "Criar uma rotina: … — …" quando o revisor ou o modo pedem). O resultado chega no chat do bot como mensagem com `routineId`. Condição de aviso, "avisou"/"silêncio", evento e monitor **ainda não existem**: não desenhe.
- **Fuso do usuário:** `GET /v1/info` e `GET/PATCH /v1/user-settings` (`timeZone`, `timeZoneSource`: `user`, `device`, `config` ou `null`). O app manda o fuso do computador ao conectar (`source: "device"`), e Configurações > Geral deixa escolher outro (`source: "user"`).
- **Iniciativa:** o que o bot notou, a evidência, o que já preparou, a ação proposta, e os botões aceitar, "agora não" e "não". Estados: aberta, aceita, adiada, recusada.
- **Nível de autonomia** por bot: desligado, só sugerir, preparar e pedir, fazer e avisar.
- **Delegação:** uma execução de um bot abre outra em outro bot; mostrar o vínculo nas duas pontas.
- **Notificações:** teto diário e horário de silêncio, configuráveis.

### Fase 5: tela do bot

- **Aba Desktop:** vídeo da tela do bot, estado da conexão (conectado ou desconectado) e o botão "Assumir controle".
- Enquanto você controla, o bot fica pausado; ao devolver, retoma.
- Área de trabalho com papel de parede em estilo de pintura, barra superior fina e dock com navegador, arquivos e terminal.

### Fase 6: seus computadores

- **Dispositivo:** nome, sistema, estado (online ou offline), última atividade.
- Ações do bot no seu PC sempre passam por cartão de aprovação.

### Fase 7: conteúdo gerado

- **Artefatos:** arquivos e páginas que o bot produziu, com pré-visualização, download e link de compartilhamento.
- Imagens, áudio (respostas em voz) e vídeo dentro da conversa.

## 9. Inspetor de diagnóstico (existe na CLI e na API)

Uma tela separada do chat, para quando algo dá errado. A API serve os mesmos cálculos da linha de comando (`inspect`, `replay`, `resend`, `doctor`):

- linha do tempo crua dos eventos, com filtro por tipo: `GET /v1/runs/{id}/events?types=...` (sem `view=chat`, que é para o chat);
- "o que o modelo viu" num turno: instruções, mensagens e ferramentas enviadas, e a resposta gravada: `GET /v1/runs/{id}/requests/{seq}`;
- **replay:** se o Suup atual reproduz a execução gravada, ou onde diverge, com uma leitura em português: `POST /v1/runs/{id}/replay`;
- **reenviar:** mandar de novo a mesma requisição várias vezes (até 20), ou para outro modelo, e comparar os desfechos: `POST /v1/runs/{id}/resend`;
- uso e custo por execução (`turns`, `inputTokens`, `outputTokens`, `costUsd` na execução);
- **saúde dos componentes** (banco, busca, fila, máquina dos bots, provedores, ferramentas): `GET /v1/doctor`.

## 10. Telas, e de que dados cada uma precisa

| Tela | Dados |
|---|---|
| Lista de bots | `GET /v1/bots` (cada bot já traz `latestRun` e `unreadCount`) e o stream (`run.updated`, `conversation.updated`, `bot.updated`) |
| Conversa | `GET /v1/conversations/{id}/messages` e `GET /v1/runs/{id}/events?view=chat`; no stream, `message.*` e `run.event`. Os arquivos que o bot entregou (`message.attachments`) viram o cartão de arquivo embaixo da mensagem, e `GET /v1/files/{id}` os baixa ([API.md](API.md), "Arquivos que o bot entrega") |
| Sala de grupo | O mesmo, com vários bots |
| Recepção e equipe | `POST /v1/bots/{id}/reception` (ao abrir o chat), `POST /v1/bots/{id}/reception/reset` (Configurações), `POST /v1/messages/{id}/team` (o cartão de equipe, [RECEPCAO.md](RECEPCAO.md)), `GET /v1/info` (fuso, só leitura) |
| Criar e editar bot | `GET /v1/models`, `GET /v1/tools`, `POST /v1/bots`, `PATCH /v1/bots/{id}`, `POST /v1/bots/draft` |
| Memória | `GET /v1/memories` (`?status=pending` é a fila de confirmação), `POST`, `PATCH`, `archive`, `restore`, `confirm`, `reject`, `GET /v1/memories/search`, `GET /v1/memories/{id}/revisions` e `POST .../revisions/{id}/undo` (histórico e desfazer), `GET`/`PATCH /v1/memory-settings` (consolidação, teto do prompt, expiração, compactação, com o aviso `promptUsage.overLimit` e o `reviewer`), `GET /v1/memory-consolidations` |
| Rotinas | Rotinas e histórico de disparos |
| Pendências | Cartões de aprovação (`GET /v1/approvals?status=pending`, quadro `approval.changed`), perguntas abertas, pedidos de segredo (execuções `waiting_user` com `secret-request`) e iniciativas, de todos os bots |
| Regras de aprovação | `GET/POST/PATCH/DELETE /v1/written-rules` (as que o usuário escreve) e o modo em `GET/PATCH /v1/approval-settings`; as exatas em `/v1/approval-rules` |
| Desktop do bot | Vídeo da tela e estado da conexão |
| Conectores | `GET/POST /v1/connectors`, `PATCH`/`DELETE /v1/connectors/{nome}`, concessões por bot, risco por ferramenta, `POST .../test`; galeria: `GET /v1/connector-catalog`, `POST /v1/connector-catalog/{id}/install`, `POST .../oauth/start`, `GET .../oauth/status`, `DELETE .../oauth`; `GET /v1/info` (`oauthCallback`) |
| Cofre | Segredos: `GET /v1/secrets`, `PUT`/`DELETE /v1/secrets/{nome}`, concessões por bot |
| Busca na web | `GET /v1/web-search`: `{ enabled, providers: [{ id, label, position, state, retryInSeconds?, searchesThisMonth, keyNames? }] }`, os motores da busca geral na ordem em que são tentados; a chave entra pelo cofre (`PUT /v1/secrets/{keyNames.secret}`). Configurações > Busca |
| Primeira abertura e Servidor | **Não vêm da API do servidor**: vêm da casca do app (Tauri), que guarda a escolha (`mode`: neste computador ou VPS) e, no servidor local, conta o estado (`local_status`: etapa, motivo da falha, isolamento da máquina dos bots, se há chave). No navegador não existem: o app só conecta a um endereço. Só o que a casca informa é desenhado |
| Dispositivos | Seus computadores e celular |
| Inspetor | Eventos crus, `requests/{seq}`, `replay`, `resend`, `doctor` |
| Configurações | Modelos e chaves, limites padrão, notificações; **Memória** (`GET`/`PATCH /v1/memory-settings`: consolidação, compactação, limite do prompt com o aviso por bot, validade) |

## 11. Momentos em que o avatar do bot pode reagir

O rosto é desenhado pelo motor `@suup/avatar` (formatos, cores e estados no `README` do pacote); o app só escolhe o **estado** do motor a partir da execução, numa função pura (`apps/desktop/src/lib/avatar-state.ts`). A cor do rosto é a do bot (`BOT_PALETTE`; no estilo pixel, sem cor do bot vale a cor do desenho do dono); com "Movimento reduzido" ligado (no app ou no sistema) o rosto é uma imagem parada, com a cara do estado.

| Momento | De onde vem | Estado do avatar |
|---|---|---|
| Parado | Nenhuma execução ativa (ou `cancelled`) | `idle` |
| Pensando | Execução `queued` ou `running`, aguardando `model_response` | `thinking` |
| Trabalhando | Entre `tool_call` e `tool_result`; variações por ferramenta | `working` |
| Com dúvida | `waiting_user` | `asking` |
| Pedindo permissão | `waiting_approval` (há um cartão em `approval_requested` sem `approval_decided`) | `waiting` |
| Concluiu | `finish_attempt` com `accepted: true` (status `done`); aparece por alguns segundos e volta a `idle` | `done` |
| Levou bronca | `finish_attempt` recusado ou `review` com `reject` | `thinking` |
| Falhou | `status` `failed` | `failed` |
| Pausado | `paused: true` (você pausou) ou, na fase 5, você assumiu a tela | `paused` |
| Teve uma ideia | Nova iniciativa (fase 4) | ainda sem estado |

## 12. Onde a API real difere do que este guia dizia antes dela

- **Tempo real é SSE, não WebSocket.** Uma conexão `GET /v1/stream` (cabeçalho `Authorization`, o que o `EventSource` do navegador não faz: use o `api.subscribe`). Seguir os eventos de uma execução é escolher as execuções na conexão (`?runs=`); o resto chega para todas.
- **"Pausado" é uma marca, não um estado.** `paused: true` junto de `queued` ou `running` (seções 3, 4 e 6). Os sete estados da seção 4 continuam os únicos.
- **Pausar tem duas forças:** `pause` (suave, no próximo ponto seguro) e `interrupt` (dura, corta o que está em curso). Os dois deixam a execução retomável.
- **Erros** têm sempre o formato `{ "error": { "code", "message" } }`, com 13 códigos fechados (API.md): o app decide pelo `code` e mostra a `message`, que está em português.
- **A lista de bots já traz o necessário** (`latestRun`, `conversationId`, `unreadCount`): não é preciso uma chamada por bot.
- **O `model_request` não viaja** nem no stream nem em `view=chat`: só o resumo. O Inspetor busca o pedido inteiro.
- **Não lidas** só contam mensagens do bot e do sistema; marcar como lida é uma chamada (`/read`), nunca automática.
- **Datas** são sempre texto ISO 8601 em UTC; **custos**, texto decimal.
- **Mensagem para uma execução pausada** fica guardada (`sent`) e é lida depois do `resume`.
- **`risk` de uma ferramenta** (`GET /v1/tools`) passou de `read`/`write`/`external` para `read`/`write_reversible`/`external_irreversible` (fase 3), e ganhou `dynamicRisk`, `acceptsSecrets` e `externalOutput`.
- **Uma execução em `waiting_timer` também não pode ser pausada** (`409`): nenhum worker a segura. Uma mensagem no chat cancela o retorno e a execução segue com ela; `cancel` a cancela na hora. Ver [RETORNO.md](RETORNO.md).
- **Uma execução em `waiting_approval` não pode ser pausada** (`409`): ela já não usa um worker. Cancelar funciona e cancela o cartão. Mensagem no chat não aprova nada.
