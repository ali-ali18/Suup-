# Configuração

Tudo o que a CLI (`suup`) precisa saber para funcionar vem de **um arquivo JSON** mais algumas variáveis de ambiente. O arquivo é validado ao ser lido; um erro aparece em português, com o caminho do campo (por exemplo `models[0].contextWindow: esperado número, recebido texto`) e todos os problemas de uma vez.

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
| `pricing` (opcional) | `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok` (opcional): dólares por milhão de tokens. Sem `pricing`, o custo da execução fica em zero |

Um bot guarda o provedor e o modelo com que foi criado. Se o modelo sair da configuração, ou passar a pertencer a outro provedor, criar execuções para esse bot falha com uma mensagem que cita o bot e o que falta.

### `reviewer` (opcional)

`{ "model": "<id de um modelo>" }`. Quando presente, um revisor independente (outra chamada ao modelo, sem o histórico) confere cada `finish` antes de ele ser aceito. Sem ele, o `finish` é validado só pelas regras do harness.

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

**`local`** (só para desenvolvimento e testes): `{ "kind": "local", "root": "<pasta>" }`. Os comandos dos bots rodam **diretamente neste computador, sem nenhum isolamento**, dentro de `<root>/bots/<id>`. Toda vez que esse modo está em uso, a CLI imprime um aviso visível (`AVISO: sandbox LOCAL em uso ...`), e `suup doctor` o marca.

### `worker` (opcional)

| Campo | Padrão | Significado |
|---|---|---|
| `concurrency` | 4 | Execuções ao mesmo tempo em um worker |
| `leaseRenewMs` | 10000 | De quanto em quanto tempo o worker renova a posse de cada execução |
| `staleAfterMs` | 30000 | Uma posse não renovada por este tempo vence, e a execução volta para a fila (precisa ser maior que `leaseRenewMs`) |

### `defaults` (opcional)

Limites usados quando o bot não define os próprios (`suup bot create --max-turns` define o de turnos):

| Campo | Padrão | Significado |
|---|---|---|
| `maxTurns` | 50 | Chamadas ao modelo por execução |
| `maxCostUsd` | sem limite | Custo máximo por execução, em dólares |
| `maxDurationMs` | sem limite | Duração máxima por execução, em milissegundos |

Passar de um limite termina a execução como `failed` com origem `limit`.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `DATABASE_URL` | URL do Postgres (vale mais que `databaseUrl`). `pnpm suup` lê também o arquivo `.env` |
| `SUUP_CONFIG` | Caminho do arquivo de configuração (vale menos que `--config`) |
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
  "compaction": [{ "text": "resumo" }]
}
```

- Cada passo tem `text` e/ou `calls` (`name`, `args`, `id` opcional), ou `blocks` brutos; opcionais: `stopReason`, `usage`, `modelVersion` (padrão `scripted-1`), `delayMs` (espera antes de responder, respeitando o cancelamento: serve para demonstrar Ctrl+C) e `error` (`{ "kind": "rate_limit", "message": "...", "retryable": false }`, faz a chamada falhar).
- **`agent`**: a resposta de um turno é `agent[n]`, onde `n` é o número de mensagens do assistente que já existem na conversa. Como depende só do pedido, uma execução retomada em outro processo (depois de uma pausa, de uma pergunta ao usuário ou de uma queda) continua do passo certo, e `suup resend` recebe a mesma resposta de novo. Não funciona depois de uma compactação de contexto (a conversa encolhe).
- **`review`** e **`compaction`**: consumidos em ordem dentro do processo; o último passo se repete quando a lista acaba.
- Passar do fim de `agent` faz a chamada falhar (origem `provider`), em vez de travar.
- Um arquivo que é só uma lista vale como `agent`.
- O arquivo é lido na primeira chamada: um roteiro ausente ou inválido aparece como falha da execução, e `suup doctor` o confere.
