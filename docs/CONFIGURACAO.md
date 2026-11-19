# Configuração

Tudo o que a CLI (`suup`) e o servidor (`suup server`) precisam saber para funcionar vem de **um arquivo JSON** mais algumas variáveis de ambiente. O arquivo é validado ao ser lido; um erro aparece em português, com o caminho do campo (por exemplo `models[0].contextWindow: esperado número, recebido texto`) e todos os problemas de uma vez.

Um ponto de partida está em [`suup.config.example.json`](../suup.config.example.json). Para experimentar sem nenhuma chave de API, veja a configuração de demonstração em [`examples/demo/`](../examples/demo/) (provedor roteirizado e sandbox local).

## Onde fica o arquivo

Em ordem de prioridade:

1. `--config <arquivo>` na linha de comando;
2. a variável de ambiente `SUUP_CONFIG`;
3. `./suup.config.json` (relativo à pasta em que o comando roda).

Caminhos relativos **dentro** do arquivo (`sandbox.root`, `scriptPath`) valem a partir da pasta do próprio arquivo de configuração, não da pasta em que você está.

## Chaves de API nunca ficam no arquivo

O arquivo guarda só o **nome** da variável de ambiente que contém a chave (`apiKeyEnv`). Um campo `apiKey` (ou `token`, `secret`...) é recusado com uma mensagem explicando isso. Se a variável não estiver definida, nada quebra na partida: o erro aparece **no momento em que aquele provedor é usado pela primeira vez** (a execução falha com origem `provider` e o nome da variável na mensagem), e `suup doctor` mostra a falha de antemão.

## Campos

### `databaseUrl` (opcional)

URL de conexão do Postgres. A variável de ambiente `DATABASE_URL` **tem prioridade** sobre este campo. Sem nenhum dos dois, os comandos que precisam do banco falham com uma mensagem dizendo isso.

### `providers` (obrigatório, pelo menos um)

Lista de provedores de modelo. Cada item tem `id` (único; é como os modelos se referem a ele) e `kind`:

| `kind` | Para quê | Campos próprios |
|---|---|---|
| `anthropic` | API Messages da Anthropic | `apiKeyEnv` (**obrigatório**), `baseUrl`, `anthropicVersion`, `betas` (lista), `promptCache` (padrão `true`) |
| `openai-compatible` | Qualquer servidor com `/chat/completions` em streaming (nuvem ou local) | `apiKeyEnv` (opcional: sem ele nenhuma chave é enviada, serve para servidores locais), `baseUrl` (até `/v1`), `includeUsage`, `maxTokensParam` (`max_tokens` ou `max_completion_tokens`), `supportsToolChoice`, `capabilities` (`promptCache`, `parallelTools`, `vision`) |
| `scripted` | **Não é um modelo.** Responde a partir de um arquivo JSON, para testes de ponta a ponta e demonstrações sem chave | `scriptPath` (**obrigatório**), `textChunkSize` |

Opções comuns aos dois adaptadores de rede (as mesmas de `@suup/providers`): `baseUrl`, `headers` (objeto), `maxRetries`, `requestTimeoutMs`, `retryBaseDelayMs`, `retryMaxDelayMs`, `extraBody` (campos extras no corpo JSON). Campos que não existem para o `kind` escolhido são recusados, para que um erro de digitação não passe em silêncio.

### `models` (obrigatório, pelo menos um)

| Campo | Significado |
|---|---|
| `id` | Identificador do modelo **como o provedor o conhece**; é o que vai na requisição e o que se passa a `suup bot create --model`. Único no arquivo |
| `provider` | `id` de um provedor de `providers` |
| `contextWindow` | Tamanho da janela de contexto, em tokens (inteiro positivo). Dispara a compactação da conversa |
| `maxOutputTokens` | Limite de tokens de saída por resposta (não pode passar de `contextWindow`) |
| `pricing` (opcional) | `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok` (opcional: tokens lidos do cache), `cacheWriteInputPerMTok` (opcional: tokens gravados no cache, que alguns provedores cobram acima do preço normal; padrão `inputPerMTok`): dólares por milhão de tokens. Sem `pricing`, o custo da execução fica em zero |
| `nativeToolSearch` (opcional) | A busca de ferramentas **nativa** que este modelo aceita, **declarada aqui e nunca adivinhada pelo id**: `true` ou `"bm25"` (o provedor ranqueia por palavras), `"regex"` (o provedor casa um padrão que o **modelo** escreve; exceção em [REGRAS.md](REGRAS.md)), `"client"` (a busca é nossa e devolve as ferramentas a carregar). Só vale se o adaptador do provedor implementa a variante (hoje: `anthropic`; veja [CONECTORES.md](CONECTORES.md), que lista os modelos). Ausente ou `false`: o harness usa o índice e as ferramentas `search_tools`/`use_tool` |
| `supportsForcedToolChoice` (opcional, padrão `true`) | Se o modelo aceita que o pedido **force** uma ferramenta (`tool_choice`). O revisor força a ferramenta `verdict`; alguns modelos respondem a isso com erro HTTP 400. Com `false`, o revisor pede o veredito só por instrução (`auto`). Mesmo com `true`, se a API recusar a escolha forçada (`invalid_request`), o revisor repete a chamada uma vez sem forçar |

Um bot guarda o provedor e o modelo com que foi criado. Se o modelo sair da configuração, ou passar a pertencer a outro provedor, criar execuções para esse bot falha com uma mensagem que cita o bot e o que falta.

### `reviewer` (opcional)

`{ "model": "<id de um modelo>" }`. Quando presente, um revisor independente (outra chamada ao modelo, sem o histórico) confere cada `finish` antes de ele ser aceito. Sem ele, o `finish` é validado só pelas regras do harness.

O revisor vê um resumo das ferramentas (início e fim de cada resultado longo, marcado `[SHORTENED]` com o número `#N`; argumentos longos de uma chamada ficam marcados `[ARGUMENTS SHORTENED]`). Ele pode **pedir evidência** em vez de adivinhar: resultados de ferramenta inteiros (`results`, `#N`), os **argumentos completos de uma chamada** (`calls`, `#N`: o comando de shell inteiro, o conteúdo escrito num arquivo) e/ou arquivos do espaço de trabalho (`files`, lidos só para leitura, pelo mesmo executor da execução; arquivos fora dele continuam ilegíveis, e o aviso diz que o conteúdo pode estar nos argumentos da chamada que o escreveu). São no máximo 3 rodadas por revisão e 60 000 caracteres de evidência por rodada, preenchidos na ordem pedida (teto de sanidade de 24 itens): o que não cabe é cortado, ou fica de fora, e o revisor recebe a lista exata do que ficou de fora para pedir de novo; arquivos acima de 200 000 bytes não são lidos. Cada pedido extra ao revisor conta como turno e entra no custo. Depois das rodadas ele precisa decidir: aprovar, reprovar (só com ao menos uma divergência estruturada: o que o trabalho afirma, o que a evidência mostra, onde; uma reprovação sem isso é perguntada de novo uma vez e, se continuar assim, vira "não conseguiu verificar") ou dizer que **não conseguiu verificar** algo; neste último caso a decisão vai para o dono, com o texto exato do que não foi verificado, em vez de uma reprovação falsa do trabalho.

### `sandbox` (obrigatório)

A máquina dos bots. Cada bot trabalha na própria subpasta `bots/<id do bot>` da máquina compartilhada.

**`docker`** (uso real): contêiner persistente com volume, criado no primeiro uso.

| Campo | Significado |
|---|---|
| `image` | Imagem da máquina (veja `docker/sandbox`, `docker build --tag suup-sandbox:dev docker/sandbox`) |
| `name` | Nome do contêiner |
| `volume` | Volume do workspace (sobrevive ao contêiner) |
| `memory` (opcional) | Limite de memória, por exemplo `"2g"` (padrão `2g`) |
| `cpus` (opcional) | Limite de CPUs (padrão 2) |
| `extraCaBundle` (opcional) | Caminho **absoluto** de um arquivo PEM com uma CA extra, montado **somente leitura** na máquina e nos conectores, para redes que reassinam o TLS. Desligado por padrão; nenhuma CA entra nas imagens. Veja [REDE.md](REDE.md) |
| `network` (opcional) | A rede dos bots: o contêiner **não tem rede própria** e sai por um proxy do harness, só para os hosts da lista. `name` (rede interna, padrão `suup-sandbox-net`), `defaultHosts` (nomes exatos liberados a todos; padrão `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`; `[]` = nenhum), `ports` (padrão `[80, 443]`), `proxy` (`listenHost`, `advertiseHost`, `port`: só se o worker não roda no host). Veja [REDE.md](REDE.md) |
| `connectors` (opcional) | Onde rodam os conectores stdio: `image` (padrão `suup-connector-runner:dev`, de `docker/connector-runner`), `memory` (padrão 512m), `cpus` (padrão 1). Veja [CONECTORES.md](CONECTORES.md) |

**`local`** (só para desenvolvimento e testes): `{ "kind": "local", "root": "<pasta>" }`. Os comandos dos bots rodam **diretamente neste computador, sem nenhum isolamento**, dentro de `<root>/bots/<id>`. Toda vez que esse modo está em uso, a CLI imprime um aviso visível (`AVISO: sandbox LOCAL em uso ...`), e `suup doctor` o marca.

### `worker` (opcional)

| Campo | Padrão | Significado |
|---|---|---|
| `concurrency` | 4 | Execuções ao mesmo tempo em um worker |
| `leaseRenewMs` | 10000 | De quanto em quanto tempo o worker renova a posse de cada execução |
| `staleAfterMs` | 30000 | Uma posse não renovada por este tempo vence, e a execução volta para a fila (precisa ser maior que `leaseRenewMs`) |
| `controlPollMs` | 2000 | De quanto em quanto tempo o worker olha se o servidor pediu para **pausar, interromper ou cancelar** uma execução dele (a verificação é o próprio batimento, que passa a bater no menor entre este valor e `leaseRenewMs`). É o tempo que um "interromper agora" leva para chegar a uma execução parada numa chamada longa ao modelo |

### `server` (opcional)

O servidor da API e do tempo real (`suup server`; [API.md](API.md)). Todos os campos são opcionais.

| Campo | Padrão | Significado |
|---|---|---|
| `host` | `127.0.0.1` | Interface em que escutar. **Escutar fora do próprio computador exige pedir aqui** (ou `--host`), e o servidor fala HTTP puro: ponha um proxy com TLS na frente ([IMPLANTACAO.md](IMPLANTACAO.md)) |
| `port` | 8787 | Porta |
| `allowedOrigins` | `[]` | Origens de navegador que podem chamar a API (CORS): esquema, host e porta, sem barra no fim (`http://localhost:1420`). Vazio: nenhuma. Do app de desktop (Tauri) acrescente `tauri://localhost`, `http://tauri.localhost` e `https://tauri.localhost` |
| `tokenEnv` | `SUUP_SERVER_TOKEN` | O **NOME** da variável de ambiente que guarda o token do app (mínimo 32 caracteres; `suup server --generate-token` gera um). O token em si **nunca** vai no arquivo: um campo `token` é recusado |
| `maxStreams` | 16 | Conexões de tempo real ao mesmo tempo; a seguinte leva `429` |
| `maxBodyBytes` | 1048576 | Maior corpo de requisição aceito (`413` acima) |
| `eventRetentionMinutes` | 360 | Por quanto tempo o diário de mudanças é guardado: a janela em que um cliente consegue retomar o stream de onde parou (fora dela, o servidor manda recarregar) |

### `defaults` (opcional)

Limites usados quando o bot não define os próprios (`suup bot create --max-turns` define o de turnos):

| Campo | Padrão | Significado |
|---|---|---|
| `maxTurns` | 50 | Chamadas ao modelo por execução |
| `maxCostUsd` | sem limite | Custo máximo por execução, em dólares |
| `maxDurationMs` | sem limite | Duração máxima por execução, em milissegundos |
| `maxReturns` | 6 | Quantos retornos seguidos o bot pode marcar para si na mesma execução (`schedule_return`); `0` desliga ([RETORNO.md](RETORNO.md)). Também pode ser definido por bot em `limits.maxReturns` |
| `historyChars` | 12000 | Quanto da conversa anterior (em caracteres, só mensagens inteiras, das mais novas para as mais antigas) uma execução recebe como histórico. As mais antigas ficam de fora e o bot é avisado de que pode buscá-las com `search_conversations` |

Passar de um limite termina a execução como `failed` com origem `limit`.

### `approvals` (opcional)

Como as ações dos bots pedem o seu OK ([APROVACOES.md](APROVACOES.md)). Sem esta seção valem os padrões: leitura executa; com um modelo de `reviewer` configurado, o modo Auto-review o usa para revisar o resto; sem modelo, escrita reversível executa e o que sai para o mundo ou não tem volta vira cartão; e um cartão espera para sempre.

| Campo | Padrão | Significado |
|---|---|---|
| `levels` | nenhum | Fixa o nível de risco de uma ferramenta, por cima do que ela declara: `{ "shell": "external_irreversible" }` faz todo comando perguntar, mesmo na máquina isolada; `{ "shell": "write_reversible" }` libera o shell mesmo na máquina `local`. Valores: `read`, `write_reversible`, `external_irreversible` |
| `expireAfterMinutes` | nunca | Um cartão que ninguém decidiu em tanto tempo vira `expired`: o bot é avisado e segue. Sem o campo, **nada expira em silêncio** |
| `autoReview.model` | o de `reviewer` | O modelo que revisa cada chamada no modo **Auto-review**, lendo as regras que o usuário escreveu ([APROVACOES.md](APROVACOES.md)): um `id` de `models`, de preferência o barato e rápido. **Ausente: o modelo de `reviewer`**; sem nenhum dos dois, o Auto-review só aplica a tabela de níveis e a API (`GET /v1/approval-settings`) e `suup approvals mode` dizem isso. A chave vem do provedor do modelo (`apiKeyEnv`), nunca daqui |
| `autoReview.enabled` | `true` | `false` desliga o revisor por modelo nesta configuração (o Auto-review volta à tabela de níveis, e a API diz por quê). Serve para testes e para quem não quer uma chamada ao modelo por ação |

O **modo** (`auto_review`, o padrão, ou `ask_all`) **não é desta configuração**: é uma escolha do usuário, guardada no servidor (`suup approvals mode`, `PATCH /v1/approval-settings`). Cada revisão custa uma chamada ao modelo (cerca de 1 900 tokens de entrada e 150 de saída), contada no custo da execução e no `maxCostUsd` dela.

```json
"approvals": {
  "levels": { "shell": "external_irreversible" },
  "expireAfterMinutes": 1440,
  "autoReview": { "model": "model-y" }
}
```

Com a máquina `local` (sem isolamento) o `shell` pergunta a cada comando; para um uso diário sem Docker, a regra `suup rules add --tool shell --effect allow` (ou `levels`) diz que você aceita o risco.

### `memory` (opcional)

Só o que **não** é do usuário mudar pelo app ([MEMORIA.md](MEMORIA.md)): qual modelo faz a consolidação da memória em segundo plano. O resto (quando roda, o teto do prompt, a expiração, o ponto da compactação) são escolhas do usuário, guardadas no servidor: `suup memory settings`, `GET`/`PATCH /v1/memory-settings`.

| Campo | Padrão | Significado |
|---|---|---|
| `consolidation.model` | o de `approvals.autoReview.model`, senão o de `reviewer` | Um `id` de `models`, de preferência o barato: lê as conversas em segundo plano e propõe o que guardar, e também revisa o que um bot escreve na memória depois de ler conteúdo de fora. A chave vem do provedor (`apiKeyEnv`), nunca daqui. Sem nenhum modelo, nada é consolidado e a API diz por quê |
| `consolidation.enabled` | `true` | `false` desliga a consolidação nesta configuração (o interruptor do usuário, `consolidation.enabled` das configurações, é outro e vale por cima) |

```json
"memory": { "consolidation": { "model": "model-y" } }
```

Custo medido com o modelo barato: cerca de 1 800 tokens de entrada e 150 a 350 de saída por consolidação, perto de US$ 0,0001 a 0,0004 (TESTES-REAIS.md, item G).

### `vault` (opcional)

O cofre de segredos ([COFRE.md](COFRE.md)). Sem esta seção não há cofre.

| Campo | Padrão | Significado |
|---|---|---|
| `keyEnv` | `SUUP_VAULT_KEY` | O **nome** da variável de ambiente com a chave mestra (32 bytes em base64 ou hexadecimal; gere com `suup vault key generate`). A chave nunca fica no arquivo nem no banco: um campo `key` aqui é recusado |
| `previousKeyEnvs` | nenhum | Nomes de variáveis com chaves antigas, para ler e recifrar (`suup vault rotate`) o que foi escrito com elas |

```json
"vault": { "keyEnv": "SUUP_VAULT_KEY" }
```

`suup doctor` confere a chave (presente, válida) e se todo segredo guardado é legível com as chaves configuradas.

### `untrustedOutputTools` (opcional)

Uma lista de nomes de ferramentas cuja saída chega ao modelo **rotulada como dado não confiável** (o envelope `<<<EXTERNAL_DATA`), além das que já se declaram assim (`web_fetch`). Padrão: nenhuma. Quem faz o bot lidar com conteúdo de fora pode ligar para `["shell", "read_file", "search_files"]`; fica desligado por padrão porque muda o que o modelo lê depois de cada chamada dessas ferramentas.

### `toolSearch` (opcional)

Quando as ferramentas de **conectores** de um bot são **buscadas** em vez de carregadas todas em todo pedido ([CONECTORES.md](CONECTORES.md), "Muitas ferramentas"):

| Campo | Padrão | Significado |
|---|---|---|
| `minTools` | `10` | Adia quando o bot tem pelo menos este número de ferramentas de conectores... |
| `minDefinitionTokens` | `10000` | ...ou quando as definições somam pelo menos estes tokens (**estimativa**, cerca de 2,65 caracteres por token, calibrada com um pedido real: [DIAGNOSTICO.md](DIAGNOSTICO.md); a decisão compara estimativa com estimativa, então o limite vale "cerca de 10 mil tokens reais") |
| `maxIndexChars` | `6000` | Um índice maior que isto vira uma linha por conector |

Abaixo dos dois limites, as ferramentas vão direto. Para desligar a busca, ponha valores enormes. As ferramentas embutidas e de controle nunca são adiadas.

### Conectores

Não há seção de conectores neste arquivo: eles ficam no banco (`suup connectors ...`, [CONECTORES.md](CONECTORES.md)), porque são criados em tempo de execução e carregam referências a segredos do cofre. A seção `vault` é necessária para um conector que use credenciais.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `DATABASE_URL` | URL do Postgres (vale mais que `databaseUrl`). `pnpm suup` lê também o arquivo `.env` |
| `SUUP_CONFIG` | Caminho do arquivo de configuração (vale menos que `--config`) |
| `SUUP_SERVER_TOKEN` | O token do servidor (o nome é o de `server.tokenEnv`) |
| `SUUP_VAULT_KEY` | A chave mestra do cofre (o nome é o de `vault.keyEnv`). Precisa estar no ambiente do servidor, do worker e da CLI que mexem em segredos |
| as de `apiKeyEnv` | As chaves de API dos provedores (nomes à sua escolha, por exemplo `ANTHROPIC_API_KEY`) |
| `SUUP_DOCKER_PATH` | Caminho do executável `docker` (padrão: o do `PATH`) |
| `SUUP_DEBUG` | Com qualquer valor, erros inesperados mostram a pilha |

## O provedor `scripted`

Existe para rodar o sistema inteiro (CLI, worker, loop, revisor, replay) sem chave e de forma determinística. **Não use em produção**: não há modelo nenhum por trás.

O arquivo de roteiro (`scriptPath`) é JSON:

```json
{
  "agent": [
    { "text": "Vou planejar.", "calls": [{ "name": "plan", "args": { "steps": [] } }] },
    { "text": "Pronto." }
  ],
  "review": [
    { "calls": [{ "name": "verdict", "args": { "verdict": "approve", "notes": "ok" } }] }
  ],
  "compaction": [{ "text": "resumo" }],
  "memory": [{ "calls": [{ "name": "propose_memories", "args": { "items": [] } }] }],
  "memoryReview": [{ "calls": [{ "name": "review_memory_write", "args": { "decision": "run", "reason": "ok" } }] }]
}
```

- Cada passo tem `text` e/ou `calls` (`name`, `args`, `id` opcional), ou `blocks` brutos; opcionais: `stopReason`, `usage`, `modelVersion` (padrão `scripted-1`), `delayMs` (espera antes de responder, respeitando o cancelamento: serve para demonstrar Ctrl+C) e `error` (`{ "kind": "rate_limit", "message": "...", "retryable": false }`, faz a chamada falhar).
- **`agent`**: a resposta de um turno é `agent[n]`, onde `n` é o número de mensagens do assistente que já existem na conversa. Como depende só do pedido, uma execução retomada em outro processo (depois de uma pausa, de uma pergunta ao usuário ou de uma queda) continua do passo certo, e `suup resend` recebe a mesma resposta de novo. Não funciona depois de uma compactação de contexto (a conversa encolhe).
- **`review`** e **`compaction`**: consumidos em ordem dentro do processo; o último passo se repete quando a lista acaba.
- Passar do fim de `agent` faz a chamada falhar (origem `provider`), em vez de travar.
- Um arquivo que é só uma lista vale como `agent`.
- **`cases`**: em vez de `agent`/`review`/`compaction` no topo, uma lista de casos `{ "whenObjectiveContains": "texto", "agent": [...], "review": [...] }`. O primeiro caso cujo texto aparece na conversa (o objetivo está na primeira mensagem e no pedido do revisor) responde, cada um com seus próprios passos e contadores. Serve para um mesmo "modelo" de teste responder a várias tarefas, como na avaliação ([AVALIACAO.md](AVALIACAO.md)); um pedido que não casa com nenhum caso falha a chamada.
- O arquivo é lido na primeira chamada: um roteiro ausente ou inválido aparece como falha da execução, e `suup doctor` o confere.
