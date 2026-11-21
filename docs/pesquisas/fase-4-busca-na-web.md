# Pesquisa: busca na web para os bots (fase 4)

Data da pesquisa: 21/11/2026. Serve de base para decidir como o Suup dá busca real na web aos bots, além do `web_fetch` atual (`packages/tools/src/web-fetch.ts`, que só baixa uma URL conhecida pela máquina do bot). Ver também [fase-3-muitas-ferramentas-mcp.md](fase-3-muitas-ferramentas-mcp.md) para cache de ferramentas e contagem de ferramentas, e [REDE.md](../REDE.md) para a lista de saída da rede do bot.

## Pergunta

1. Quais ferramentas de busca e de leitura de página os provedores oferecem de forma nativa (no servidor deles), com que versão, como são declaradas, quanto custam, quais modelos as suportam e onde os dados são buscados?
2. Como se comparam Firecrawl, Brave Search, Tavily, Exa e SearXNG (o que retornam, preço ou plano gratuito, servidor MCP, tratamento da chave, licença)?
3. Quais riscos de segurança trazem resultados de busca e páginas buscadas (injeção de instrução, exfiltração), e como a busca hospedada se relaciona com uma lista de saída (allowlist) feita pelo cliente?
4. O que isso implica para o Suup?

## Fontes

Lidas em 21/11/2026, salvo quando indicado. "Host bloqueado" significa que o acesso falhou pelo proxy do ambiente (código 000 no curl); nesses casos nada foi lido da página.

Anthropic (documentação oficial):

- Web search tool, "Web search tool" (Claude Platform Docs): https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool (sem data na página)
- Web fetch tool, "Web fetch tool" (Claude Platform Docs): https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool (sem data na página)
- Pricing, "Pricing" (Claude Platform Docs): https://platform.claude.com/docs/en/about-claude/pricing (sem data na página)
- Claude Code, "Tools reference" (contém WebSearch e WebFetch): https://code.claude.com/docs/en/tools-reference (sem data na página)

OpenAI (documentação oficial):

- "Web search | OpenAI API": https://developers.openai.com/api/docs/guides/tools-web-search (lida; a página traz o modelo `gpt-6.2-astra` como exemplo)
- "Pricing | OpenAI API": https://developers.openai.com/api/docs/pricing (lida)

Firecrawl (repositórios oficiais e npm):

- README do servidor MCP, `firecrawl/firecrawl-mcp-server`: https://raw.githubusercontent.com/firecrawl/firecrawl-mcp-server/main/README.md (lido em 21/11/2026)
- Pacote `firecrawl-mcp` no npm, versão 3.41.0, licença MIT: https://registry.npmjs.org/firecrawl-mcp/latest (lido em 21/11/2026)
- LICENSE do repositório principal `firecrawl/firecrawl`, texto AGPL v3: https://raw.githubusercontent.com/firecrawl/firecrawl/main/LICENSE (lido em 21/11/2026)
- Página de preços do Firecrawl (firecrawl.dev/pricing): **host bloqueado**, não lida.

Brave, Tavily, Exa e SearXNG:

- README de `brave/brave-search-mcp-server`: https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/README.md (lido). Pacote npm `@brave/brave-search-mcp-server` 2.2.0, licença MIT: https://registry.npmjs.org/@brave/brave-search-mcp-server/latest (metadados lidos via `package.json` do repositório, https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/package.json)
- README de `tavily-ai/tavily-mcp`: https://raw.githubusercontent.com/tavily-ai/tavily-mcp/main/README.md (lido). Pacote npm `tavily-mcp` 0.2.22, MIT (metadados de `package.json` do repositório). O arquivo LICENSE desse repositório devolveu 404 e não foi lido; a licença MIT vem dos metadados do pacote.
- README de `exa-labs/exa-mcp-server`: https://raw.githubusercontent.com/exa-labs/exa-mcp-server/main/README.md (lido). Pacote npm `exa-mcp-server` 3.5.1; LICENSE do repositório, MIT: https://raw.githubusercontent.com/exa-labs/exa-mcp-server/main/LICENSE
- LICENSE do SearXNG, `searxng/searxng`, texto AGPL v3: https://raw.githubusercontent.com/searxng/searxng/master/LICENSE (lido)
- Páginas de preços e de documentação de Brave (`api-dashboard.search.brave.com`, `brave.com/search/api`), Tavily (`docs.tavily.com`, `tavily.com/pricing`), Exa (`docs.exa.ai`, `exa.ai/pricing`) e SearXNG (`docs.searxng.org`): **host bloqueado**, não lidas.

## Fatos verificados

### 1. Anthropic: web search (ferramenta de servidor)

- Versões. "web_search_20250305 : basic web search", "web_search_20260209 : adds dynamic filtering", "web_search_20260318 : adds response inclusion control for agentic workflows". (web-search-tool)
- Declaração. "Add a web_search tool to the request's tools . Settings such as max_uses , domain lists and user_location go on that tool." Exemplo com `"type": "web_search_20250305", "name": "web_search", "max_uses": 5`. (web-search-tool)
- Domínios. "Provide allowed_domains or blocked_domains , not both. If a request includes both, the API returns a 400 error. Entries are bare domains with an optional path, for example example.com or example.com/blog , without a scheme." (web-search-tool)
- Localização. "The user_location parameter allows you to localize search results based on a user's location. Provide at least one of city , region , country , or timezone." (web-search-tool)
- Limite por turno. "The max_uses parameter limits the number of searches in a single turn." "Failed searches count against the limit." Quando estoura: "the web_search_tool_result is an error with the max_uses_exceeded error code". (web-search-tool)
- Citações. "Citations are always enabled for web search, and each web_search_result_location includes:" url, title, encrypted_index e cited_text ("Up to 150 characters of the cited content"). "The web search citation fields cited_text , title , and url do not count toward input or output token usage." (web-search-tool)
- Obrigação de devolver o conteúdo. "To continue a conversation that contains search results, send the assistant's content blocks back exactly as you received them, including each result's encrypted_content." "If encrypted_content is missing or modified, the request fails with a 400 validation error." (web-search-tool)
- Preço. "On the Claude API, web search costs $10 USD per 1,000 searches, plus standard token costs for search-generated content." "Each web search counts as one use, regardless of the number of results returned. A web search that fails with an error is not billed." "Search results count as input tokens, both while Claude keeps searching within a turn and in later conversation turns." (web-search-tool)
- Preço, página de preços: "For server-side tools, additional usage-based pricing (for example, web search charges per search performed)." (pricing). A contagem aparece no uso como `"web_search_requests" : 1` dentro de `server_tool_use`. (web-search-tool)
- Filtragem dinâmica. "With web_search_20260209 and later versions, Claude can write and run code that filters the search results before they reach the context window (dynamic filtering)." "Dynamic filtering is available with Claude 4.6 and later models and Claude Mythos Preview." (web-search-tool)
- Código de execução é grátis nesse caso: "Code execution is free when used with web search or web fetch." (pricing)
- Chamada direta ou por código: "All web search tool versions accept allowed_callers". Em `web_search_20260209` e posteriores o padrão é `["code_execution_20260120"]`; para chamada direta, `allowed_callers: ["direct"]`. "Models that don't support programmatic tool calling require this setting." (web-search-tool)
- ZDR: a tabela de dados da página diz "Zero data retention Eligible" para a busca básica; "Dynamic filtering for web search is not eligible for ZDR or HIPAA." (web-search-tool)
- Plataformas. "The web search tool (with and without dynamic filtering) is available on the Claude API, Claude Platform on AWS, Claude Models on Google Cloud (Anthropic managed), and Microsoft Foundry." "On Claude Models on Google Cloud (Google managed), only the basic web search tool (without dynamic filtering) is available." (web-search-tool)
- Claude Code, ferramenta WebSearch: "Amazon Bedrock doesn't expose the server-side web search tool." (tools-reference, seção WebSearch)

### 2. Anthropic: web fetch (ferramenta de servidor)

- Versões. "web_fetch_20260318" é a mais nova, com filtragem dinâmica e controle de inclusão de resposta; "web_fetch_20260309 for dynamic filtering and cache bypass, web_fetch_20260209 for dynamic filtering only, web_fetch_20250910 for basic fetch". (web-fetch-tool)
- Quem busca. "Web fetch is a server tool: the API fetches the content during the request and inserts the results into the conversation. You don't run anything or return a tool_result." (web-fetch-tool)
- Parâmetros: `max_uses` ("There is no default limit."), `allowed_domains`, `blocked_domains` ("cannot be combined with allowed_domains"), `citations` (opcional, desligado por padrão: "citations are optional for web fetch and disabled by default"), `max_content_tokens` ("limits the amount of content included in the context"), `use_cache` (padrão `true`, exige `web_fetch_20260309` ou posterior). (web-fetch-tool)
- Preço: "The web fetch tool is available on the Claude API at no additional cost. You only pay standard token costs for the fetched content that becomes part of your conversation context." (web-fetch-tool)
- Exfiltração. "Enabling the web fetch tool in environments where Claude processes untrusted input alongside sensitive data poses data exfiltration risks. Only use this tool in trusted environments or when handling non-sensitive data." (web-fetch-tool)
- Regra de URL: "To minimize exfiltration risks, Claude cannot fetch URLs that appear only in its own output. Claude can only fetch URLs that have previously appeared in the conversation: URLs in user messages, URLs in client-side tool results, and URLs from previous web search or web fetch results." (web-fetch-tool)
- Credenciais na URL: "Claude also cannot fetch a URL that appears to contain a credential, such as an API key or a password, unless that credential appears in the system prompt or in the text of a user message." (web-fetch-tool)
- Erro `url_not_allowed`: "URL blocked by domain filtering rules (including your organization's settings) or by Anthropic-side restrictions, such as private addresses, robots.txt, and URLs that appear to contain a credential you did not provide". Erro `url_not_in_prior_context`: "URL did not appear earlier in the conversation". (web-fetch-tool)
- ZDR: "Dynamic filtering for web fetch is not eligible for ZDR or HIPAA. Website publishers might retain request data (such as fetched URLs and request metadata) according to their own policies." (web-fetch-tool)
- Código de execução: como acima, grátis com web search ou web fetch de versão 20260209 ou posterior. (pricing)

### 3. Claude Code: WebSearch e WebFetch (referência)

- WebSearch: "runs a query against Anthropic's web search backend and returns result titles and URLs. It doesn't fetch the result pages. To read a page Claude finds in search results, it follows up with WebFetch." Pode fazer "up to eight backend searches per call". (tools-reference)
- Limite de sessão: "An interactive terminal session has a limit of 200 WebSearch calls." (tools-reference)
- WebFetch: "For most pages, Claude doesn't see the full text. It asks a question about the page, and a separate model call reads the page and returns an answer." (tools-reference)
- Permissões: a regra de WebSearch "take no specifier. A bare WebSearch entry in allow or deny is the only form." As regras de WebFetch aceitam domínio, por exemplo `WebFetch(domain:example.com)`. (tools-reference)

### 4. OpenAI: web search (Responses API)

- Ferramenta: "For new Responses API integrations, use { "type": "web_search" }. The earlier web_search_preview tool remains available for legacy integrations, but it does not support newer controls such as filters, external_web_access, and return_token_budget." (oai web search)
- Modelos citados na página: "For a question that needs several sources, use a reasoning model such as gpt-6.2-astra. It can refine its searches as it reads results." A página também cita `gpt-5-search-api` (Chat Completions, para integrações antigas). (oai web search)
- Ação registrada: "web_search_call.action is one of: search ... open_page ... find_in_page". "Search actions incur a tool call cost." (oai web search)
- Filtro de domínio: "With the filters parameter you can configure up to 100 allowed_domains or up to 100 blocked_domains. When formatting domains, omit the HTTP or HTTPS prefix." (oai web search)
- Modo só cache: "Set external_web_access: false on the web_search tool to run in offline/cache-only mode." (oai web search)
- Preço (página de preços): "Web search (incl. images) $10.00 / 1k calls, + Search content tokens billed at model rates." Para "Web search preview (other models) $25.00 / 1k calls, + Search content tokens are free." (oai pricing)
- Tokens: "Tokens used for built-in tools are billed at the chosen model's per-token rates." (oai pricing)
- Tokens de conteúdo de busca: "Web search content tokens are tokens retrieved from the search index and fed to the model alongside your prompt to generate an answer." (oai pricing)

### 5. Firecrawl

- Ferramentas (README, versão 3.41.0). Escolha de uso: "Use `firecrawl_scrape` when you have a known URL and want its content as markdown"; "Use `firecrawl_map` when you need to discover URLs on a site without fetching their content."; "Use `firecrawl_crawl` when you need content from many pages under a site"; "Use `firecrawl_search` when you're starting from a query rather than a URL and want ranked web results. Results carry excerpts; fetch full pages with `firecrawl_scrape`...". (README)
- Página com clique e formulário: "Use `firecrawl_interact` when a page needs a click, type, or navigate action before you can read it". Descrição: "Interact with pages in a real browser: click, type, fill forms, and navigate dynamic pages". (README)
- Limite do interact: "each `firecrawl_interact` call runs one `prompt` or `code` turn to completion and returns control." Sessão longa com sua própria lógica de nova tentativa não é o caso de uso indicado. (README)
- Outras ferramentas nomeadas: `firecrawl_parse` (PDF e documentos), `firecrawl_agent` (pesquisa em várias fontes com dados estruturados), `firecrawl_monitor_*` (monitorar mudança de página), `firecrawl_credit_usage` (créditos restantes e gastos). O README diz que o servidor lista "34 tools" no perfil completo. (README)
- Chave. "FIRECRAWL_API_KEY: Your Firecrawl API key." "Optional when using self-hosted instance with FIRECRAWL_API_URL." (README, Variáveis de ambiente). Modo remoto: "Authorization: Bearer <FIRECRAWL_API_KEY>". (README)
- Sem chave: "On the keyless free tier, `scrape`, `search`, and `parse` work without an API key (rate-limited). Other tools such as `crawl`, `map`, and `agent` still need a key." (README)
- Self-hosted: o README aponta `FIRECRAWL_API_URL` para instância própria. (README)
- Licença. O servidor MCP é MIT (README "MIT License" e npm). O repositório principal `firecrawl/firecrawl`, que é a API, tem LICENSE em AGPL v3 ("GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007"). (LICENSE, raw)
- Preço e limites de taxa: o README diz "Automatic retries and rate limiting" como recurso do servidor, mas não dá números de limite nem de preço por página. A página de preços estava bloqueada. **Não verificado.**

### 6. Brave, Tavily, Exa e SearXNG

- Brave (`brave-search-mcp-server` 2.2.0, MIT). Ferramentas: `brave_web_search`, `brave_local_search`, `brave_video_search`, `brave_image_search`, `brave_news_search`, `brave_answers` (plano "Answers"), `brave_llm_context`, `brave_place_search`. O `brave_summarizer` está depreciado. Chave: "BRAVE_API_KEY: Your Brave Search API key (required unless BRAVE_API_KEY_FILE is set)". "Summarizer requires a Pro AI plan. Answers requires an Answers plan subscription." (README)
- Tavily (`tavily-mcp` 0.2.22, MIT). Ferramentas: busca (`tavily-search`), extração (`tavily-extract`), e também mapa e rastreio ("search, extract, map, crawl tools"; os nomes exatos dessas duas não foram lidos). Servidor remoto com chave na URL: `https://mcp.tavily.com/mcp/?tavilyApiKey=<your-api-key>`. O README também cita um cabeçalho `DEFAULT_PARAMETERS`. Chave local: variável `TAVILY_API_KEY`. (README)
- Exa (`exa-mcp-server` 3.5.1, MIT). Ferramentas padrão: `web_search_exa`, que "Search the web for any topic and get clean, ready-to-use content". Opcionais: `web_search_advanced_exa`, `web_fetch_exa`, `agent_run`. Servidor hospedado: "The hosted MCP server works anonymously with rate limits." Chave: "pass it on the URL as ?exaApiKey=…. You can also send it as a Authorization: Bearer … header or an x-api-key header." (README)
- SearXNG. Metasearch autohospedado. Licença AGPL v3 (LICENSE, raw). A documentação em docs.searxng.org está bloqueada; **o formato de resposta e a API de JSON não foram verificados.**
- Preços de Brave, Tavily, Exa e Firecrawl: **não verificado**, as páginas de preço não abriram. Os READMEs não trazem preço por busca, só menções a planos (acima).

### 7. Segurança e fonte dos dados

- Anthropic, fetch: a própria documentação admite "residual risk" ao buscar páginas (ver seção 2). A medida que ela descreve é limitar as URLs às que já apareceram na conversa, e nenhuma URL só na saída do modelo.
- Onde a busca roda. Na ferramenta de servidor, a busca e o download são feitos pelo provedor (Anthropic ou OpenAI), não pela máquina do bot. Por isso uma lista de saída do cliente (como a de `docs/REDE.md`) não se aplica a essa chamada. O controle passa a ser o domínio permitido ou bloqueado enviado no próprio pedido, e as regras do provedor (`url_not_allowed`).
- Resultado como dado externo: em todos os casos, o texto da página entra no contexto do modelo. A Anthropic não documenta, nas páginas lidas, proteção específica contra injeção de instrução em resultados de busca. **Não verificado** se há mecanismo de detecção de injeção do lado do servidor para `web_search`.

## Inferências

Rotuladas como inferência: não estão escritas em nenhuma fonte lida.

- I1. Com busca de servidor, o pedido inclui a configuração (domínios, `max_uses`), e o provedor decide o que baixa. A lista de saída do bot (`docs/REDE.md`) não é o guarda para essas páginas. Isso precisa aparecer em `REDE.md` como exceção explícita.
- I2. A obrigação de devolver `encrypted_content` e `encrypted_index` sem alteração (ver seção 1) exige que o histórico do Suup guarde os blocos brutos da resposta, não só o texto. Um histórico que reduz a resposta a texto quebra a conversa com erro 400 na rodada seguinte.
- I3. Os resultados de busca contam como tokens de entrada também nos turnos seguintes ("Search results count as input tokens ... in later conversation turns"); já os campos de citação `cited_text`, `title` e `url` não contam. Isso afeta o custo de cada turno e a economia de cache, e deve ser medido.
- I4. Bedrock não oferece a busca de servidor (ver Claude Code, seção 1). Se um bot usar Claude por Bedrock, precisa de uma busca no cliente.
- I5. Custo. A busca da Anthropic e a da OpenAI custam aproximadamente o mesmo por chamada de busca ($10 por 1.000 buscas em ambos, mas a OpenAI soma tokens de conteúdo cobrados ao preço do modelo). O custo real depende muito dos tokens de conteúdo, por isso é preciso medir.
- I6. O `web_fetch` do Suup (máquina do bot, sem JS, sem login) continua útil para URLs internas, ou quando a rede de saída do bot precisa passar pela política própria do Suup. A busca de servidor não substitui isso.

## O que não foi verificado

- Lista completa de modelos que suportam a busca básica (`web_search_20250305`) na API da Anthropic. A página lida diz só que a filtragem dinâmica é para "Claude 4.6 and later models and Claude Mythos Preview"; a lista dos modelos da busca básica não apareceu no texto lido.
- Padrão de `max_uses` da busca (a página não diz; para o fetch, "There is no default limit").
- Preço por busca, plano gratuito e limites de taxa de Brave, Tavily, Exa e Firecrawl (páginas de preço bloqueadas, sem preço nos READMEs).
- Formato de resposta, parâmetros e plano gratuito do SearXNG (docs bloqueados).
- Se o Firecrawl faz renderização de JavaScript por padrão em `firecrawl_scrape` (não encontrei a resposta no trecho lido do README; só `firecrawl_interact` foi descrito como browser).
- Se a OpenAI aplica detecção de injeção em resultados de busca; a página não trata disso.
- Os preços de tokens dos modelos citados (Claude Opus 5, gpt-6.2-astra etc.) não foram usados nas contas.
- LICENSE do `tavily-ai/tavily-mcp` (404); a licença MIT vem só dos metadados do pacote.
- Os números da seção 1 sobre quais versões de modelo aceitam cada ferramenta valem para a data de leitura (21/11/2026) e podem mudar.

## Implicação para o Suup

Inferência, com base nos fatos acima. Não decide nada: é uma proposta para o dono.

| Assunto | Proposta | Base |
|---|---|---|
| Padrão para modelos Anthropic | Busca de servidor (`web_search`, versão 20260318 se o modelo aceitar, senão 20250305), ligada por bot, com `max_uses` na configuração do bot | Seção 1; I1 |
| Padrão para outros provedores | Ferramenta `web_search` no cliente, apoiada por uma API de busca configurada (candidatas: Brave, Tavily ou Exa, todas com servidor MCP MIT). A escolha depende de preço e limites, ainda não verificados, e de medição | Seção 6 (preços não verificados) |
| Provedor ChatGPT / OpenAI | Busca de servidor com `{ "type": "web_search" }` e filtros de domínio; `external_web_access: false` para modo só cache | Seção 4 |
| Concessão por bot | Mesma concessão por ferramenta que os conectores já usam (`docs/CONECTORES.md`). Um bot sem a concessão não recebe a ferramenta | Projeto |
| Aprovação | Nível de leitura, sem cartão (como `docs/APROVACOES.md`), porque a busca não altera nada. Limite de buscas por execução fica como guarda de custo, não como aprovação | Projeto |
| Como o resultado entra | Como dado externo, marcado como o `web_fetch` atual já faz. Para busca de servidor, guardar os blocos brutos com `encrypted_content` sem alterar (I2) | Seção 1; I2 |
| Domínios | Mapear `allowed_domains` ou `blocked_domains` para uma configuração por bot ou global. Nunca os dois juntos (Anthropic dá erro 400; OpenAI aceita até 100 em um dos dois) | Seções 1 e 4 |
| Saída de rede | Documentar em `docs/REDE.md` que a busca de servidor e o fetch de servidor não passam pela lista de saída do bot. A única contenção é o domínio enviado no pedido e a regra de URL já vista na conversa | Seção 7; I1 |
| Exfiltração | Não usar o fetch de servidor onde o bot também lê dado sensível sem necessidade. A Anthropic recomenda isso expressamente | Seção 2 |
| Custo | Registrar `web_search_requests` (Anthropic) e o número de chamadas de busca (OpenAI) como custo da execução, junto com tokens de conteúdo. Preço de referência: $10 por 1.000 buscas (Anthropic e OpenAI) | Seções 1 e 4; I5 |
| Firecrawl | Conector opcional (MCP, chave `FIRECRAWL_API_KEY` no cofre, enviada como cabeçalho). Usar para páginas que precisam de clique (`firecrawl_interact`), PDF (`firecrawl_parse`) ou rastreio. Não é o padrão de busca. Antes de hospedar a API própria, revisar a licença AGPL v3 do repositório principal | Seção 5 |
| Chave na URL | Não usar a forma de chave na URL do Tavily (`?tavilyApiKey=`) nem a `?exaApiKey=` do Exa. Usar cabeçalho, que o cofre já injeta | Seção 6; `docs/COFRE.md` |
| SearXNG | Opção para quem quer busca sem chave e autohospedada. Licença AGPL v3 e documentação não verificada: só depois de ler os docs | Seção 6 |
| Como medir | Conjunto pequeno de tarefas de pesquisa com resposta conhecida (5 a 10 perguntas com fonte), comparando: acerto da resposta, presença da fonte correta nas citações, número de buscas por tarefa, tokens por tarefa e custo por tarefa, para cada provedor e cada modo | Projeto; seção "O que não foi verificado" |

Próximo passo sugerido: antes de implementar, pesquisar preços e limites de Brave, Tavily e Exa com acesso à página de preços (a rede do ambiente bloqueou esses hosts nesta pesquisa), e definir a lista de tarefas de medição.
