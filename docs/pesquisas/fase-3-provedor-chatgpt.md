# Pesquisa: provedor ChatGPT (login com a assinatura)

Data da pesquisa: 19/11/2026. Valida a entrega "provedor ChatGPT" da fase 3 (`docs/PLANO.md`, seção 4.16). **Resultado: não validado.** As páginas oficiais não puderam ser lidas neste ambiente (a página de autenticação redireciona para um host bloqueado), e o código do Codex não diz que terceiros podem usar o login nem o identificador de cliente dele. Enquanto isso não for confirmado em fonte oficial, o provedor não deve ser implementado.

## Pergunta

O login "Sign in with ChatGPT" para apps de terceiros é oficial e vigente? Quem pode usar, há registro de app/client id, qual o fluxo OAuth, como chamar o modelo com o token, quais limites existem, como o Codex CLI (openai/codex) faz isso, e quais riscos e proibições se aplicam. Data de hoje: 2026-11-19.

**Limitação central desta pesquisa:** as páginas oficiais da OpenAI (developers.openai.com, openai.com, help.openai.com) não puderam ser lidas. O proxy recusou (403) developers.openai.com e não abriu túnel para openai.com e help.openai.com. Não houve nova tentativa. A evidência abaixo vem do código-fonte público do openai/codex (Apache-2.0), que é fonte primária da própria OpenAI, mas não é documentação de terceiros.

## Fontes

- Código do openai/codex, branch `main`, lido em 2026-11-19 (commit não fixado; a API do GitHub do repositório não estava liberada para esta sessão):
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/server.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/auth/manager.rs (`CLIENT_ID`, endpoints de refresh, revogação)
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/auth/storage.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/auth/revoke.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/device_code_auth.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/token_data.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/model-provider-info/src/lib.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/model-provider/src/chatgpt_base_url.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-api/src/endpoint/responses.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/client.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-api/src/error.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/codex-api/src/rate_limits.rs
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json
  - https://raw.githubusercontent.com/openai/codex/main/README.md (seção "Using Codex with your ChatGPT plan")
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
  - https://raw.githubusercontent.com/openai/codex/main/LICENSE (Apache 2.0)
- Páginas oficiais recusadas ou inalcançáveis nesta sessão (sem conteúdo lido): https://developers.openai.com/codex/auth (403 do proxy); https://openai.com/policies/terms-of-use/ e https://openai.com/policies/usage-policies/ (sem túnel); https://help.openai.com/en/articles/11369540-codex-in-chatgpt (citado no README, sem túnel).

## Fatos verificados

1. **Documentação oficial de "Sign in with ChatGPT" para terceiros: não verificada.** A página oficial de auth (developers.openai.com/codex/auth) não pôde ser lida. Não encontrei no código do Codex nenhuma página ou termo que autorize apps de terceiros a usar esse fluxo. O README do Codex diz apenas: "Run `codex` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use Codex as part of your Plus, Pro, Business, Edu, or Enterprise plan."
2. **Registro de app / client id:** o Codex usa `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (manager.rs, linha 1897). Existe override por variável de ambiente `CODEX_APP_SERVER_LOGIN_CLIENT_ID` (manager.rs, linha 245). Não há nenhum texto que diga se terceiros podem reutilizar esse client id. Declaração explícita: **não declarado**. A busca no GitHub por esse client id retornou cerca de 14 mil arquivos em projetos de terceiros, o que mostra reuso de fato, não permissão.
3. **Fluxo de autorização (Codex):**
   - Autorização: `https://auth.openai.com/oauth/authorize` (`{issuer}/oauth/authorize`, issuer = `https://auth.openai.com`).
   - Troca de código e refresh: `https://auth.openai.com/oauth/token` (manager.rs, linha 241).
   - Revogação: `https://auth.openai.com/oauth/revoke` (manager.rs, linha 242; revoke.rs envia `token_type_hint` e `client_id`).
   - Escopo: `openid profile email offline_access api.connectors.read api.connectors.invoke` (server.rs, linha ~612).
   - Parâmetros extras: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<valor>`, e opcionalmente `allowed_workspace_id`.
   - Callback em loopback: `http://127.0.0.1:{porta}/auth/callback`. Porta padrão 1455, porta de reserva 1457 (server.rs, linhas 78–81).
   - PKCE: o código gera `code_challenge` e `state` (server.rs, linhas 183–203). O código de PKCE está em `crate::oauth`, que não foi lido. Não verifiquei o método (S256), mas é esperado.
   - Fluxo alternativo por código de dispositivo: `{base}/api/accounts/deviceauth/usercode` e `/deviceauth/token`, com página `{base}/codex/device` (device_code_auth.rs). Expira em 15 minutos.
4. **Tokens devolvidos:** `id_token`, `access_token`, `refresh_token` (server.rs, `ExchangedTokens`). `chatgpt_account_id` vem nas claims do JWT, em `https://api.openai.com/auth`. O plano vem em `chatgpt_plan_type` (token_data.rs). O auth é salvo com `auth_mode = Chatgpt`.
5. **Refresh:** o refresh é JSON (`TokenEncoding::Json`, timeout de 45 s). Ele ocorre quando o access token está a 5 minutos ou menos de expirar (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`) ou quando `last_refresh` tem mais de 8 dias (`TOKEN_REFRESH_INTERVAL = 8`) (manager.rs, linhas 232–233, 3672–3676). Erros tratados: `refresh_token_expired`, reuso, revogação, e mensagem "Please log out and sign in again" (manager.rs, linhas 235–240).
6. **Logout:** `logout_with_revoke` chama `/oauth/revoke` e depois apaga o auth local. Se a revogação falhar, o local é apagado mesmo assim (revoke.rs, cabeçalho).
7. **Armazenamento local:** o arquivo é `$CODEX_HOME/auth.json` (storage.rs, linha 168). A escrita é atômica (arquivo temporário criado com permissão 0600 no Unix, storage.rs, linha 282). Há modo keyring: serviço `"Codex Auth"` (storage.rs, linha 307). O modo padrão é `Auto` (keyring com fallback para arquivo).
8. **Chamada ao modelo:**
   - Base URL: `https://chatgpt.com/backend-api/codex` (model-provider-info, linha 87). Endpoint `/responses` (API Responses), com streaming SSE e também WebSocket (core/client.rs, `RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE`).
   - Headers observados: `OpenAI-Beta` (valor de WebSocket v2), `x-client-request-id`, `x-openai-subagent` (opcional), `x-codex-turn-state`, `x-codex-window-id`, `x-oai-attestation` (quando gerado), `chatgpt-account-id` (`CHATGPT_ACCOUNT_ID_HEADER`, usado no auth_manager), e `originator`.
   - O corpo usa `store: false` e `prompt_cache_key` (core/client.rs, linhas 1384–1391).
   - Ferramentas: a busca de ferramentas (tool search) existe no Codex, com ferramentas "Deferred" (core/src/tools/handlers/tool_search.rs). O modelo tem flag `supports_search_tool`.
9. **Modelos disponíveis:** o catálogo `codex-rs/models-manager/models.json` lista 14 modelos. Os de visibilidade `list` incluem `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, além de `codex-auto-review` (oculto). Todos têm `supported_in_api: true` e `supports_parallel_tool_calls: true`. A lista `available_in_plans` varia por modelo: por exemplo `gpt-5.5` inclui `plus`, `pro`, `free`, `go`, `team`, `business`. Este catálogo não diz se é o conjunto vigente para terceiros.
10. **Limites e erros (Codex):**
    - Códigos de erro de terminal: `insufficient_quota` e `credit_balance_exhausted` viram `QuotaExceeded` (sem status HTTP). `usage_not_included` vira `UsageNotIncluded` ("upgrade to Plus"). (codex-api/src/error.rs, linhas 106–107)
    - Erro de limite de uso (`UsageLimitReached`) traz `plan_type` e mensagem "You've hit your usage limit" (protocol/src/error.rs, linhas 870–980).
    - Erros de taxa: `rate_limit_exceeded` e `slow_down`, com `retry_after` (sse/responses.rs).
    - Cabeçalhos de uso: `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, `x-codex-secondary-*`, `x-codex-rate-limit-reached-type`, `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-credits-balance` (rate_limits.rs). Há também evento SSE `codex.rate_limits`.
11. **Licença do Codex:** Apache-2.0 (LICENSE).
12. **Sobre o escopo de uso:** o README do Codex apresenta o login como forma de usar o Codex com o plano ChatGPT. O código tem uma seção de "remote control requires ChatGPT authentication" e "cloud" com o mesmo login, mas não há texto que defina proibição ou permissão para outros apps.

## Inferências

- Inferência: o fluxo pode ser técnicamente reproduzido por um app local, porque é um OAuth público com PKCE e loopback. Isso não prova que é permitido. O próprio código do Codex deixa explícito que o client id é do app "Codex CLI" (há `codex_cli_simplified_flow`, `originator`, e a allow-list de redirect "Hydra", server.rs, linha 80).
- Inferência: o `originator` e a allow-list de redirect (porta 1455/1457) parecem ser controles do lado do servidor da OpenAI. Um app de terceiros pode ser recusado se usar outra porta ou outro client id.
- Inferência: o endpoint `chatgpt.com/backend-api/codex/responses` é uma API interna do produto Codex. Não é a API pública `api.openai.com/v1/responses`. Por isso, pode mudar sem aviso e não tem contrato de versão.
- Inferência: o contador de limite de uso do plano é do lado do servidor. O app deve ler `x-codex-*` e `UsageLimitReached` para exibir o estado e pausar, sem tentar contornar.
- Inferência: a interpretação do "Sign in with ChatGPT para terceiros" como oficialmente permitido depende da página oficial e dos termos, que não consegui ler. Pela minha leitura, o status é incerto e não "validado" como o plano anterior afirmou.

## O que não foi verificado

- Página oficial de autenticação (developers.openai.com/codex/auth) e qualquer seção sobre apps de terceiros: não lida (403 do proxy).
- Termos de Uso (Terms of Use), Política de Uso (Usage Policies) e Termos de Serviço para o uso de credenciais de assinatura em software de terceiros: não lidos (sem túnel para openai.com).
- Se há processo de registro, revisão ou lista de espera para obter client id próprio: não verificado.
- Se a OpenAI permite reuso do client id `app_EMoamEEZ73f0CkXaXp7hrann` por terceiros: não declarado no código lido.
- Método PKCE exato (S256) e os valores de `state` e `code_verifier`: o módulo `crate::oauth` não foi lido.
- Duração exata do access token e do refresh token (campo `exp` do JWT): não verificado; o código só mostra as janelas de refresh.
- Como o servidor responde a um client id ou porta fora da allow-list: não testado.
- Existência e formato exato de `UsageLimitReached` no caminho HTTP (o código de erro `usage_limit_reached` não foi localizado nos arquivos lidos).
- Commit exato do openai/codex lido: não verificado (API do GitHub do repositório recusada, "GitHub access to this repository is not enabled for this session").
- Se o catálogo de modelos é o conjunto vigente para contas de terceiros: não verificado.
- Nenhum teste real foi feito contra auth.openai.com ou chatgpt.com (fora do escopo de pesquisa).

## Implicações para o Suup

**O que construir (se a decisão for seguir):**
- Adaptador de provedor separado do adaptador de API key, com `auth_mode` próprio.
- Login por loopback com PKCE (S256) e `state`, porta fixa a ser testada, escopo `openid profile email offline_access`.
- Armazenamento em arquivo com permissão 0600, escrita atômica, e opção de keyring do sistema. Nunca gravar tokens em log, em config versionada ou em `localStorage` de UI.
- Refresh proativo (janela de 5 min) e tratamento explícito de `refresh_token_expired`, `reused` e `revoked`, com pedido de novo login.
- Logout com revogação em `/oauth/revoke` e depois apagar o arquivo local.
- Cliente HTTP para `https://chatgpt.com/backend-api/codex/responses` com `chatgpt-account-id`, streaming SSE, `store: false`.
- Tratamento de cota: `insufficient_quota`, `credit_balance_exhausted`, `usage_not_included` e `UsageLimitReached` como "cota esgotada"; `rate_limit_exceeded` e `slow_down` como "tente depois" com `retry_after`; ler `x-codex-*` para exibir o uso.

**O que o dono deve fazer sozinho antes de implementar:**
- Ler a página oficial de autenticação e os termos de uso (developers.openai.com/codex/auth, openai.com/policies) a partir de uma rede liberada, e registrar a leitura com data em `docs/pesquisas/`.
- Perguntar à OpenAI por canal oficial (suporte para desenvolvedores ou formulário de parceiros) se um app de código aberto local pode usar o login com assinatura, e se precisa de client id próprio e de revisão.
- Decidir se aceita usar o client id do Codex. Sem permissão escrita, isso não deve entrar no produto.

**O que bloqueia:**
- Se os termos proibirem credenciais de assinatura em software de terceiros, ou exigirem client id registrado com aprovação, o provedor fica bloqueado até a aprovação.
- Se a OpenAI responder que a API interna `backend-api/codex` é só para o Codex oficial, o provedor não deve ser entregue como caminho de produto.
- Sem a página oficial, a recomendação ao dono é tratar o provedor como "não validado". Não deve virar a opção padrão do Suup.
