# @suup/providers

Adaptadores que implementam `Provider` (de `@suup/core`) sobre `fetch` e SSE próprios, sem SDKs de fornecedor.

- `createAnthropicProvider(config)`: API Messages da Anthropic.
- `createOpenAICompatibleProvider(config)`: qualquer servidor com `/chat/completions` em streaming e ferramentas de função (nuvem ou local).
- `createProvider({ kind: "anthropic" | "openai-compatible", ...config })`: despacha pelo `kind`.

## Configuração comum

| Campo | Padrão | Observação |
|---|---|---|
| `id` | (obrigatório) | Vira `Provider.id` e o `provider` dos blocos `provider_data`. |
| `apiKey` | (obrigatório) | Nunca vai para log; é removida das mensagens de erro. Vazia = sem cabeçalho de autenticação (servidores locais). |
| `baseUrl` | API oficial de cada adaptador | Anthropic: raiz ou `.../v1`. Compatível: até `/v1`, o adaptador acrescenta `/chat/completions`. |
| `headers` | | Sobrescrevem os cabeçalhos padrão. |
| `fetch` | `globalThis.fetch` | Injetável. |
| `maxRetries` | 3 | Só para erros retentáveis antes do primeiro evento entregue. |
| `requestTimeoutMs` | sem limite | Tempo máximo sem atividade por tentativa (conexão, cabeçalhos e intervalo entre pedaços do stream). |
| `onExchange` | | Chamado uma vez por tentativa HTTP, ao fim dela, com o corpo JSON exato enviado, status, cabeçalhos de resposta, número da tentativa (1, 2, ...) e `error` quando falhou. Nunca recebe cabeçalhos da requisição. |
| `retryBaseDelayMs`, `retryMaxDelayMs` | 500, 30000 | Espera exponencial com jitter; `retry-after` acima do teto não é aguardado. |
| `sleep`, `random` | | Injetáveis, para testes instantâneos e determinísticos. |
| `extraBody` | | Campos extras no topo do corpo JSON (os campos do adaptador prevalecem). |

Específicos: Anthropic tem `anthropicVersion`, `betas`, `promptCache` (padrão `true`). O compatível tem `includeUsage` (padrão `true`, envia `stream_options.include_usage`), `maxTokensParam` (`max_tokens` ou `max_completion_tokens`) e `capabilities`.

## Testes

```sh
pnpm vitest run packages/providers
```

Os testes normais não usam rede: um `fetch` injetado devolve respostas SSE roteirizadas. `test/conformance.test.ts` roda o mesmo conjunto de cenários contra os dois adaptadores (cada um com sua "wire fixture" em `test/wire-fixtures.ts`) e exige o mesmo `GenerateResult`.

### Testes ao vivo (opcionais)

Ficam desligados por padrão (aparecem como "skipped" com o motivo no nome) e **nunca rodam em CI**: se `CI` estiver definida, só rodam com `SUUP_LIVE_ALLOW_CI=1`. Podem gerar custo.

Anthropic:

| Variável | Uso |
|---|---|
| `SUUP_LIVE_ANTHROPIC=1` | Liga a suíte. |
| `SUUP_LIVE_ANTHROPIC_API_KEY` | Chave (obrigatória). |
| `SUUP_LIVE_ANTHROPIC_MODEL` | Identificador do modelo (obrigatório). |
| `SUUP_LIVE_ANTHROPIC_BASE_URL` | Opcional. |

Compatível com OpenAI:

| Variável | Uso |
|---|---|
| `SUUP_LIVE_OPENAI_COMPAT=1` | Liga a suíte. |
| `SUUP_LIVE_OPENAI_COMPAT_BASE_URL` | URL base até `/v1` (obrigatória). |
| `SUUP_LIVE_OPENAI_COMPAT_MODEL` | Identificador do modelo (obrigatório). |
| `SUUP_LIVE_OPENAI_COMPAT_API_KEY` | Opcional (servidores locais). |

```sh
SUUP_LIVE_ANTHROPIC=1 SUUP_LIVE_ANTHROPIC_API_KEY=... SUUP_LIVE_ANTHROPIC_MODEL=... \
  pnpm vitest run packages/providers/test/live.test.ts
```

Cada suíte faz um pedido de texto curto e uma ida e volta com uma ferramenta.
