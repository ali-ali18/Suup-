# Pesquisa: o MCP do Composio, autenticação, meta-ferramentas, plano e links de autorização

Data da pesquisa: 24/11/2026. Valida a entrada "Composio" da galeria (`packages/connectors/src/catalog.ts`) e a página do plugin. Complementa [fase-4-conectores-galeria-oauth-composio.md](fase-4-conectores-galeria-oauth-composio.md) (itens 9 e 8 e a lista "não verificado" de preço e política de dados, que agora têm fonte).

Marcação usada abaixo: **[lido]** = lido na fonte primária nesta pesquisa (com URL e data); **[não verificado]** = não deu para conferir, ou a fonte não diz.

## Pergunta

Como o endpoint `https://connect.composio.dev/mcp` autentica hoje; o que significa "funciona sem token"; o que as meta-ferramentas `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_MULTI_EXECUTE_TOOL` e `COMPOSIO_REMOTE_BASH_TOOL` fazem e se o bash pode ser desligado; quanto custa e o que é guardado; se há agendamento que concorra com as rotinas do Suup; e quais fluxo, meta-ferramentas, hosts de link e tela o Suup deve adotar.

## Fontes

Todas acessadas em **24/11/2026**. Quando a fonte traz data, ela está entre parênteses.

1. Composio Connect (página de conexão do MCP), https://docs.composio.dev/docs/composio-connect.md (a página traz `last_updated: null`).
2. Índice da documentação, https://docs.composio.dev/llms.txt
3. Documentação completa em um arquivo, https://docs.composio.dev/llms-full.txt (1,8 MB; usada para busca por termo e leitura de trechos).
4. Sessões via MCP, https://docs.composio.dev/docs/sessions-via-mcp.md
5. Autenticação, https://docs.composio.dev/docs/authentication.md (baixada; a leitura foi por busca no `llms-full.txt`, que tem o mesmo conteúdo).
6. Retenção de dados e tratamento, https://docs.composio.dev/docs/security/data-retention (trecho em `llms-full.txt`).
7. Base de conhecimento, guia "Consumer and Developer Project Boundaries", https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection
8. Base de conhecimento, seção "Hosted connect links expire after 10 minutes" (em `https://docs.composio.dev/kb.md`).
9. Planos de For You (uso pessoal com Connect), https://composio.dev/pricing/for-you (o endereço `composio.dev/pricing` redireciona para este).
10. Planos de Platform (SDK), https://composio.dev/pricing/platform
11. Páginas de toolkits: https://composio.dev/toolkits/googlecalendar, `/gmail`, `/googledrive`, `/googledocs`, `/googlesheets`.
12. Skill oficial do Composio (arquivo no repositório da Composio), https://raw.githubusercontent.com/ComposioHQ/composio/next/skills/composio/SKILL.md
13. Sondagem HTTP do endpoint, sem chave real: `https://connect.composio.dev/mcp`, `https://connect.composio.dev/.well-known/oauth-protected-resource`, `https://connect.composio.dev/.well-known/oauth-authorization-server`. Resposta do servidor com `Date: Tue, 24 Nov 2026 15:58:51 GMT`.
14. Apenas para comparação, a nota anterior: [fase-4-conectores-galeria-oauth-composio.md](fase-4-conectores-galeria-oauth-composio.md) (23/11/2026).

## Fatos verificados

### 1. Como o endpoint autentica

- **[lido]** A página de conexão diz que o endpoint é usado "with streamable HTTP and this header" e mostra `"x-consumer-api-key": "YOUR_CONSUMER_KEY"` (https://docs.composio.dev/docs/composio-connect.md, 24/11/2026).
- **[lido]** Base de conhecimento: "Use the consumer MCP URL directly. If the MCP client supports auth, it can trigger the Composio auth flow, open a popup, let the customer authenticate, and let them select the organization." E: "Use the consumer API key when the MCP client does not support auth and only supports API keys/headers. Copy the key from the consumer dashboard and pass it as the `x-consumer-api-key` header." (https://docs.composio.dev/kb/guide/consumer-project-boundaries-and-auth-selection, 24/11/2026).
- **[lido]** A mesma base diz: "Under the hood, a consumer-scoped MCP session is created for the specific user and allowed tools." (mesma URL).
- **[lido]** Outro artigo da base: "The API key does not belong in the URL; configure the `x-consumer-api-key` header" (artigo "LinkedIn", https://docs.composio.dev/kb/toolkit/linkedin, 24/11/2026). Ou seja, a URL não é credencial.
- **[lido]** Skill oficial: a credencial é "`ck_...` consumer key when the client requires a header" (SKILL.md, 24/11/2026). A chave do cliente de consumo tem prefixo `ck_`.
- **[lido]** Sem nenhum cabeçalho, `POST https://connect.composio.dev/mcp` responde **HTTP 401** com `www-authenticate: Bearer error="unauthorized", error_description="No Authorization: Bearer header on request", resource_metadata="https://connect.composio.dev/.well-known/oauth-protected-resource"` (sondagem, 24/11/2026).
- **[lido]** Metadados do recurso: `{"resource":"https://connect.composio.dev/mcp","authorization_servers":["https://connect.composio.dev"],"bearer_methods_supported":["header"]}` (sondagem, 24/11/2026).
- **[lido]** Metadados do servidor de autorização (OAuth): `"authorization_endpoint":"https://connect.composio.dev/oauth/authorize"`, `"token_endpoint":"https://login.composio.dev/oauth2/token"`, `"registration_endpoint":"https://login.composio.dev/oauth2/register"`, `"code_challenge_methods_supported":["S256"]`, `"token_endpoint_auth_methods_supported":["none"]` (sondagem, 24/11/2026). Ou seja, há registro dinâmico de cliente (DCR) e PKCE.
- **[lido]** Teste com um valor falso (`dummy-check-only`, não é chave real) no cabeçalho `x-consumer-api-key`: HTTP 401 com "Bearer token rejected: not a valid AuthKit JWT for this resource, or no matching Composio account" (sondagem, 24/11/2026). O servidor trata esse cabeçalho como credencial. Não testei uma chave `ck_` real, porque ela não está disponível nesta pesquisa.
- **[lido]** Sobre a chave: "Regeneration immediately invalidates the old consumer key." e "Update every MCP client that uses `https://connect.composio.dev/mcp` with the new `x-consumer-api-key` value." (base de conhecimento, guia de limites, 24/11/2026).
- **[lido]** Escopo: "In the normal For You/Connect MCP flow, connected accounts belong to the member who authorized them." (mesma base).
- **[não verificado]** A base diz também: "Composio never mints or returns the consumer project's API key." (página "Sessions" do índice, linha sobre o projeto de consumo). Isso conflita com o fluxo de "Regenerate" da mesma base. Não deu para saber qual vale; é preciso confirmar com o Composio.
- **[não verificado]** Se o endpoint aceita tokens OAuth emitidos pelo servidor de autorização acima, com um cliente que se registra por DCR. Os metadados anunciam isso, mas não houve login real.

**O que "sem token" significa, pelo que foi lido:** o endpoint não funciona sem credencial. Sem cabeçalho, ele recusa com 401. As duas formas de entrar são (a) a chave `ck_` no cabeçalho `x-consumer-api-key`, ou (b) um token Bearer obtido por OAuth no navegador (o cliente se registra sozinho e o usuário aprova). O que dispensa token é a autorização de cada app (Google Calendar etc.), que o Composio faz por um link no navegador. Na página de conexão: "The first time your agent needs an app, Composio generates an OAuth link you approve in your browser; after that the connection persists across sessions." (https://docs.composio.dev/docs/composio-connect.md, 24/11/2026).

### 2. Meta-ferramentas

- **[lido]** A página de conexão diz: "Composio exposes **7 meta-tools**": `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_WAIT_FOR_CONNECTIONS`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL` (24/11/2026).
- **[lido]** A página de sessões (tabela de meta-ferramentas) lista também `COMPOSIO_PROXY_EXECUTE`: "Sends a raw HTTP request to a connected app's own API, authenticated with your connected account, for endpoints no Composio tool covers" (`llms-full.txt`, 24/11/2026). A lista de 7 da página de conexão não a inclui. **Não verificado**: qual conjunto o endpoint `connect.composio.dev/mcp` expõe de fato; só um `tools/list` autenticado mostraria, e não houve chave.

**`COMPOSIO_MANAGE_CONNECTIONS`**

- **[lido]** Descrição: "Checks connection status for a toolkit and returns a branded authentication link when the user needs to connect, covering OAuth, API keys, and every other auth type" (tabela de meta-ferramentas, `llms-full.txt`, 24/11/2026). Ações da página de conexão: "Create, list, rename, or remove OAuth connections to upstream apps." (24/11/2026).
- **[lido]** Formato do resultado para o cartão (exemplo da documentação): `{"successful": true, "data": {"message": "Complete authentication to continue.", "results": {"github": {"toolkit": "github", "status": "initiated", "redirect_url": "https://connect.composio.dev/link/ln_example"}}}}`. Os status previstos são `initiated`, `active` e `failed`, com `redirect_url` e `error_message` (https://docs.composio.dev/docs/authentication.md, trecho "Render connection links as cards", 24/11/2026).
- **[lido]** Host e forma do link: `https://connect.composio.dev/link/...`. Os exemplos trazem `ln_` e `lk_` no caminho (documentação de autenticação e de conexão, 24/11/2026). Na API de toolkit personalizado, o objeto tem `connect_link` com `redirect_url`, `expires_at` e `connected_account_id` (`llms-full.txt`, 24/11/2026).
- **[lido]** Validade: "A hosted connect link/session is short-lived. If the initial authentication flow is not completed within 10 minutes, the link can show wording such as..." e "Generate a fresh connect link for the same user and open it immediately." (base de conhecimento, 24/11/2026). A página de conexão diz também: "OAuth links are short-lived."
- **[lido]** Abrir o link não conecta: "Opening the link does not mean the account is connected. After the user finishes authentication, call `COMPOSIO_MANAGE_CONNECTIONS` again for the same toolkit and session." (documentação de autenticação, 24/11/2026).
- **[lido]** Se o usuário fechar sem terminar, a conexão fica em `INITIATED` até expirar (`llms-full.txt`, 24/11/2026).
- **[não verificado]** O formato da resposta da ação `list` (lista de apps já conectados): a documentação só mostra o formato de `create`/status. A página de referência da meta-ferramenta, no dump, tem só o título (gerada automaticamente).
- **[lido]** Os apps do Google usam OAuth gerenciado pela Composio por padrão: "Composio provides a managed OAuth app for Google Calendar, so you sign in with your normal Google Calendar account and approve access." (página `composio.dev/toolkits/googlecalendar`, 24/11/2026). O nome que aparece na tela de consentimento é o do Composio, a não ser que o dono configure o próprio app OAuth.
- **[não verificado]** Se o link da Composio redireciona depois para um domínio do Google (`accounts.google.com`) durante o consentimento. Não houve login de teste.

**`COMPOSIO_MULTI_EXECUTE_TOOL`**

- **[lido]** "Executes up to 50 tools in parallel and returns structured outputs ready for immediate analysis" (tabela de meta-ferramentas, `llms-full.txt`, 24/11/2026). Na página de conexão: "execute one or more discovered tools in parallel across connected apps (up to 50 per call)".
- **[lido]** Ele pode levar ferramentas de escrita (o próprio nome é de execução genérica de qualquer app conectado). A documentação de aprovação diz que `requireApproval` pode valer para entradas dentro de `COMPOSIO_MULTI_EXECUTE_TOOL`, mas é um recurso "experimental" e só vale para sessões criadas pelo SDK, não pelo endpoint de conexão (`llms-full.txt`, 24/11/2026).

**`COMPOSIO_REMOTE_BASH_TOOL` (e o `COMPOSIO_REMOTE_WORKBENCH`, irmão dele)**

- **[lido]** "Runs bash commands in a remote sandbox for file operations, data processing, and system tasks" (tabela de meta-ferramentas, 24/11/2026). A sandbox é "a persistent environment that provides `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL`" e vem **ligada por padrão** (`llms-full.txt`, seção "Disabling the sandbox", 24/11/2026).
- **[lido]** Desligar: em sessões criadas pelo SDK, com `sandbox: {enable: false}` (ou `"workbench": {"enable": false}` na API). Então: "`COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` are excluded from the session". Isso é configuração de sessão do lado do desenvolvedor, com chave de projeto (`llms-full.txt`, 24/11/2026).
- **[não verificado]** Se o consumidor consegue desligar o bash no endpoint `connect.composio.dev/mcp`. A documentação de conexão não traz essa opção.
- **[lido]** Aviso da própria Composio: "Composio uses a model to find the tools a `COMPOSIO_REMOTE_WORKBENCH` or `COMPOSIO_REMOTE_BASH_TOOL` script calls, so it can miss some. If approval must never be skipped, [disable the sandbox]" (documentação de aprovação, `llms-full.txt`, 24/11/2026). Ou seja, dentro do bash, a aprovação por ferramenta pode ser pulada.
- **[lido]** Persistência: arquivos em `/mnt/files` são apagados após 24 h; outro estado da sandbox "may be cleared after approximately 12 hours of inactivity" (retenção, `llms-full.txt`, 24/11/2026).
- **[lido]** "Sandboxes are not billed today. Composio plans to begin billing for sandbox usage soon (metered by tier and runtime)." (`llms-full.txt`, 24/11/2026).

### 3. Preço, plano gratuito e dados

- **[lido]** Plano **Free** de For You (o que o Suup usa): "$0 For individuals and small teams getting started. No credit card required. Up to 3 members. 10,000 tool calls / month. 1,800+ apps. $2 in credits, one time." (https://composio.dev/pricing/for-you, 24/11/2026).
- **[lido]** No Free, a tabela mostra "Connections and skills: 5 connections" e "Custom MCP servers: Up to 3". A linha "Zero data retention" marca "Not included" no Free e "Included" no Standard (https://composio.dev/pricing/for-you, 24/11/2026).
- **[lido]** Exemplo da tabela: "sending an email or reading a file is one tool call. Each action your AI takes in an app" (https://composio.dev/pricing/for-you, 24/11/2026).
- **[não verificado]** Se meta-ferramentas (busca, conexão, bash) contam como "tool call" da cota de 10.000. A página de preço não diz.
- **[lido]** Plano **Hobby** de Platform (SDK, outro produto): "100,000 tool calls / mo ... Up to 20,000 of these can use Composio-managed apps", "50,000 trigger events / mo" (https://composio.dev/pricing/platform, 24/11/2026). A página de toolkit do Google Calendar cita o mesmo Hobby. **Não confundir**: o endpoint de conexão usado pelo Suup é do For You.
- **[lido]** O que fica guardado: "By default, the **request arguments** and **response data** for each tool execution" (`llms-full.txt`, política de retenção, 24/11/2026). Os logs são mantidos "for up to **one year**" e apagados depois. Na exclusão da organização, os payloads são apagados em até 30 dias.
- **[lido]** "Composio does not use request arguments, response data, or trigger payloads to train or improve AI or machine learning models, on any plan." (política de retenção, 24/11/2026). Metadados de execução (ferramenta, status, tempo, contagens) podem ser usados de forma agregada e sem identificadores.
- **[lido]** Credenciais: "Composio stores each connected account's credentials encrypted at rest and refreshes OAuth tokens before they expire" (`llms-full.txt`, 24/11/2026).
- **[lido]** Arquivos baixados pela ferramenta: link pré-assinado de 1 hora por padrão; os arquivos em staging são apagados em 24 h (política de retenção, 24/11/2026).
- **[lido]** Conta: a Composio guarda os dados da organização e dos membros "until you ask for it to be deleted" (política de retenção, 24/11/2026).

### 4. Agendamento e gatilhos

- **[lido]** Gatilhos (triggers): "Composio delivers every event to one destination you control: your webhook URL." Eles são por evento (ex.: nova mensagem do Gmail), e o intervalo de consulta é em minutos, com padrão de 2 minutos: "Leave `polling_interval` out to use the default of 2 minutes." (documentação de gatilhos, `llms-full.txt`, 24/11/2026).
- **[lido]** Os gatilhos são criados pelo desenvolvedor, com webhook registrado no projeto. A lista de 7 meta-ferramentas do endpoint de conexão não tem nenhuma ferramenta de gatilho (página de conexão, 24/11/2026).
- **[lido]** Não encontrei na documentação lida nenhuma função de agendamento tipo cron para sessões do Composio. As ocorrências de "cron" e "schedule" são exemplos com cron do Vercel ou com a API de logs (busca em `llms-full.txt`, 24/11/2026).
- **[lido]** A nota anterior dizia que disparos periódicos "têm mínimo de 15 minutos na autenticação gerenciada". A documentação atual não traz esse mínimo: o intervalo é configurável em minutos, com padrão de 2 (`llms-full.txt`, 24/11/2026). A nota anterior está desatualizada neste ponto.

### 5. Aplicativos (toolkits) do Google e várias contas

- **[lido]** As páginas de toolkit listam as ferramentas do Google e a autenticação gerenciada: Google Calendar **47** ferramentas, Gmail **61**, Google Drive **92**, Google Docs **46**, Google Sheets **50** (páginas `composio.dev/toolkits/...`, 24/11/2026). As cinco estão no catálogo. Os textos de todas dizem "Built-in OAuth handling with automatic token refresh and rotation".
- **[lido]** Há também o toolkit "Google Super": "a unified/superset toolkit for Google Workspace services ... Gmail, Google Calendar, Google Meet ... through one Google Super connection when the required scopes are configured" (base de conhecimento, 24/11/2026).
- **[lido]** Várias contas: "A user can connect multiple accounts for the same toolkit, like work and personal Gmail. Use the same userID, then select the connected account when a session needs a specific one." Isso é recurso de sessão do SDK, com `multi_account` e um `alias` por conta. Sem esse modo, a sessão usa "the most recently connected" (documentação de múltiplas contas, 24/11/2026).
- **[não verificado]** Se o endpoint de conexão (For You) aceita várias contas do mesmo app e como escolher entre elas. A documentação de múltiplas contas é do SDK.

## Inferências

1. **O dono está certo em parte.** O que não precisa de token é a autorização de cada app, feita no navegador pelo link da Composio. O endpoint em si sempre exige credencial (`ck_` no cabeçalho ou Bearer). Então "sem token" significa "sem colar token no Suup para cada app". A galeria deve dizer isso.
2. **A URL não é credencial.** Segundo a documentação, a chave não vai na URL. A chave `ck_` é o segredo, e deve ficar no cofre, como já está no catálogo.
3. **Há dois fluxos possíveis.** (a) Chave `ck_` no cofre: é o que o catálogo já faz, e é o caso de cliente "que só aceita cabeçalho" previsto pela Composio. (b) OAuth por DCR com PKCE: o Suup se registraria no servidor de autorização e guardaria o token. O (b) evita colar chave, mas é mais trabalho no Suup e não foi testado.
4. **A chave `ck_` é ampla.** Ela dá acesso a todos os apps que o dono conectou no projeto de consumo. Vale tratá-la como senha de conta, com aviso de terceiro, como o catálogo já faz.
5. **Negar o bash é necessário.** O bash e o workbench rodam código na sandbox da Composio, e a própria Composio admite que a aprovação pode ser pulada dentro deles. Como o Suup tem sandbox e aprovações próprias, o bash da Composio contorna as duas coisas.
6. **Gatilhos da Composio concorrem com as rotinas do Suup** só se o Suup reagir a eventos de app (por exemplo, "nova mensagem"). Para isso, o Suup preferiria as próprias rotinas, que disparam no horário, e consultaria os apps quando rodarem. Os gatilhos exigiriam webhook do desenvolvedor, que o endpoint de conexão não expõe.
7. **Os links de autorização vêm de `connect.composio.dev`.** Eles expiram em 10 minutos. O cartão precisa aceitar só esse host e mostrar "link expirou" quando passar do prazo.
8. **Discrepâncias com a nota anterior.** (a) Preço e política de dados agora têm fonte (antes, não verificados). (b) A nota diz "1000+ apps"; a documentação diz "1,500+" e a página de preço "1,800+". (c) O mínimo de 15 minutos de consulta não aparece nas fontes atuais.

## O que não foi verificado

- **[não verificado]** Chave `ck_` real: o teste usou um valor falso, porque a chave não está disponível aqui. Não se sabe se o cabeçalho com a chave devolve `tools/list` no endpoint de conexão.
- **[não verificado]** Lista exata de meta-ferramentas que o endpoint de conexão entrega (7 pela página de conexão, 8 pela página de sessões com `PROXY_EXECUTE`).
- **[não verificado]** Formato da resposta de `COMPOSIO_MANAGE_CONNECTIONS` com a ação `list` e com a ação `remove`.
- **[não verificado]** Se meta-ferramentas contam na cota de 10.000 chamadas do Free.
- **[não verificado]** Se o bash pode ser desligado no endpoint de conexão (a opção documentada é só do SDK).
- **[não verificado]** Várias contas do mesmo app pelo endpoint de conexão.
- **[não verificado]** O fluxo de consentimento do Google depois do link da Composio (domínio de redirecionamento, texto da tela). Não houve login de teste.
- **[não verificado]** Os termos de uso e a política de privacidade da Composio (não foram lidos; só a política de retenção da documentação).
- **[não verificado]** A página de referência de cada meta-ferramenta (`/toolkits/meta-tools/manage_connections`, `multi_execute_tool`, `remote_bash_tool`): no dump completo aparecem só como título. A descrição veio das tabelas e das páginas de conexão e sessões.
- **[não verificado]** Dashboard da Composio e a tela de "AI Clients" (onde se copia a chave `ck_`). Não houve acesso.
- **[não verificado]** A diferença entre o "Hobby" de Platform e o "Free" de For You para o dono. Confirmar qual plano a conta do dono tem.

## Implicação para o Suup

### Fluxo de autenticação

- **Manter a chave `ck_` no cofre**, no cabeçalho `x-consumer-api-key`, como o catálogo já tem. É o caminho documentado para cliente que só aceita cabeçalho, e o Suup nunca vê o valor. Aviso de terceiro: os logins dos apps ficam na nuvem da Composio, e a chave dá acesso a todos os apps conectados.
- **Corrigir a expectativa do dono na galeria**: "sem token" quer dizer "sem colar token para cada app". Para o endpoint, a chave é obrigatória. O passo que o dono faz é o link de cada app.
- **Estudar o fluxo OAuth (DCR)** como alternativa futura: evitaria a chave, mas o Suup guardaria tokens de um servidor de terceiro. Não recomendo trocar antes de testar com uma conta real.
- **Passo de conexão**: quando um app não estiver ativo, o Suup chama `COMPOSIO_MANAGE_CONNECTIONS` para o app, recebe `redirect_url` e mostra o cartão. Depois de o usuário voltar, chama de novo para o mesmo app e só usa o app quando o status for `active`.

### Meta-ferramentas permitidas por padrão

Como o endpoint de conexão não deixa desligar o bash (não verificado), a regra precisa estar no Suup, com nomes exatos (lista fixa, sem regex, como manda o `CLAUDE.md`).

| Meta-ferramenta | Padrão | Motivo |
| --- | --- | --- |
| `COMPOSIO_SEARCH_TOOLS` | permitir | busca de ferramentas, sem efeito em app |
| `COMPOSIO_GET_TOOL_SCHEMAS` | permitir | leitura de esquema |
| `COMPOSIO_MANAGE_CONNECTIONS` | permitir, com a ação checada | usada para status e link; ações `remove`/`rename` pedem aprovação. Se o Suup não conseguir ler a ação do argumento, pede aprovação a cada chamada |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | permitir, com aprovação por ferramenta | pode levar escrita de qualquer app. O Suup classifica cada slug dentro do lote; se um slug não for classificado, nega o lote |
| `COMPOSIO_REMOTE_BASH_TOOL` | **negar** | roda código na sandbox da Composio, fora das aprovações do Suup; arquivos somem em 12–24 h |
| `COMPOSIO_REMOTE_WORKBENCH` | **negar** | mesmo motivo (Python na sandbox) |
| `COMPOSIO_PROXY_EXECUTE` | **negar** | chamada HTTP crua à API do app, que contorna as ferramentas nomeadas. Confirmar se aparece no endpoint |
| `COMPOSIO_WAIT_FOR_CONNECTIONS` | **negar** | o Suup tem o próprio fluxo de espera; evita travar o agente |

Se for preciso bash para processar um arquivo grande, o caminho é a sandbox do próprio Suup (rotinas e ambiente próprios), não a da Composio.

### Hosts aceitos nos links de autorização

- **Aceitar só `https://connect.composio.dev/link/...`**: host exato `connect.composio.dev`, caminho começando com `/link/`. Rejeitar qualquer outro host, inclusive o do Google, se aparecer como `redirect_url`.
- Usar o link exatamente como veio (não reescrever).
- Mostrar a validade (10 minutos). Quando passar, o cartão diz "o link expirou; peça outro" e chama `COMPOSIO_MANAGE_CONNECTIONS` de novo.
- O `egressHosts` do catálogo (`connect.composio.dev`) já cobre esse host.

### Página do plugin

- **Lista dos apps conectados dentro da Composio**, vinda de `COMPOSIO_MANAGE_CONNECTIONS` (ação `list`, formato a confirmar). Mostrar o nome do app e o estado:
  - `active` → "conectado"
  - `initiated` → **"falta autorizar"**, com botão que abre o link de conexão (aceito só pelo host acima)
  - `failed` / `expired` → "precisa reconectar", com novo link
- Não mostrar a chave `ck_` nem o cabeçalho. Não mostrar nenhum app que o backend não devolveu (regra de `docs/FRONTEND.md`).
- Manter o aviso de terceiro: "Pelo Composio, seus logins ficam guardados na nuvem deles."
- Múltiplas contas por app: só mostrar se a ação `list` devolver contas separadas (não verificado).

### Ajustes que dependem do dono

- O comentário de `packages/connectors/src/catalog.ts` diz que "Price, free plan and data policy of Composio were not verified". Agora há fonte para esses pontos (For You Free: 10.000 chamadas/mês, 5 conexões, ZDR não incluído). Atualizar o comentário e o `disclosure` só quando o dono decidir, junto com o `DESIGN.md` se a tela mudar.
- Definir se o Suup usa a chave `ck_` (padrão atual) ou o fluxo OAuth.
- Testar com uma chave real antes de fechar a lista de meta-ferramentas: `tools/list` e uma chamada de `COMPOSIO_MANAGE_CONNECTIONS` com ação `list`.
