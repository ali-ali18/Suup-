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

## Adendo: busca e leitura próprias, sem depender de provedor (21/11/2026)

Data da leitura: 21/11/2026. Acrescentado depois da seção "Implicação para o Suup", com a decisão do dono:

> "Não, quero criar a nossa, não vale a pena se prender a provedor."

O objetivo passa a ser uma capacidade própria do Suup, equivalente ao Firecrawl (busca, leitura de página em Markdown, depois rastreio), sem usar as ferramentas hospedadas do provedor do modelo. As seções de fatos acima continuam valendo para o caso em que o provedor oferece a busca de servidor; este adendo trata do caminho próprio.

### Fontes deste adendo

Lidas em 21/11/2026, com acesso direto ao texto (GitHub raw ou registro npm):

- SearXNG, documentação de API de busca: https://raw.githubusercontent.com/searxng/searxng/master/docs/dev/search_api.rst
- SearXNG, instalação em contêiner: https://raw.githubusercontent.com/searxng/searxng/master/docs/admin/installation-docker.rst
- SearXNG, compose oficial: https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml e https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example
- SearXNG, configuração padrão: https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml
- SearXNG, limitador: https://raw.githubusercontent.com/searxng/searxng/master/searx/limiter.toml, https://raw.githubusercontent.com/searxng/searxng/master/searx/botdetection/ip_limit.py e https://raw.githubusercontent.com/searxng/searxng/master/searx/limiter.py
- SearXNG, formato do JSON: https://raw.githubusercontent.com/searxng/searxng/master/searx/webutils.py e https://raw.githubusercontent.com/searxng/searxng/master/searx/result_types/_base.py
- SearXNG, licença AGPL v3 (texto já lido acima): https://raw.githubusercontent.com/searxng/searxng/master/LICENSE
- searxng-docker (repositório antigo): https://raw.githubusercontent.com/searxng/searxng-docker/master/README.md
- Firecrawl, auto-hospedagem: https://raw.githubusercontent.com/firecrawl/firecrawl/main/SELF_HOST.md
- Firecrawl, dependências da API: https://raw.githubusercontent.com/firecrawl/firecrawl/main/apps/api/package.json
- Firecrawl, serviço de Playwright: https://raw.githubusercontent.com/firecrawl/firecrawl/main/apps/playwright-service-ts/package.json, https://raw.githubusercontent.com/firecrawl/firecrawl/main/apps/playwright-service-ts/README.md e https://raw.githubusercontent.com/firecrawl/firecrawl/main/apps/playwright-service-ts/api.ts
- Pacotes npm (versão `latest` lida no registro): `@mozilla/readability`, `turndown`, `linkedom`, `jsdom`, `playwright`, `playwright-core`, `robots-parser`, `crawlee`, `firecrawl`, `@mendable/firecrawl-js`. Endereço: `https://registry.npmjs.org/<pacote>/latest`
- Mozilla Readability, README e LICENSE: https://raw.githubusercontent.com/mozilla/readability/main/README.md e https://raw.githubusercontent.com/mozilla/readability/main/LICENSE.md
- Turndown, README: https://raw.githubusercontent.com/mixmark-io/turndown/master/README.md
- Playwright, LICENSE (Apache 2.0): https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE
- Chromium, LICENSE: https://raw.githubusercontent.com/chromium/chromium/main/LICENSE
- Crawlee, código do crawler base (branch `master`, não necessariamente a versão 3.18.2 do npm): https://raw.githubusercontent.com/apify/crawlee/master/packages/basic-crawler/src/internals/basic-crawler.ts e README em https://raw.githubusercontent.com/apify/crawlee/master/README.md
- Google, biblioteca de robots.txt (README e LICENSE): https://raw.githubusercontent.com/google/robotstxt/master/README.md e https://raw.githubusercontent.com/google/robotstxt/master/LICENSE
- Google, robots.txt do domínio principal: https://www.google.com/robots.txt
- Whoogle, README (com aviso de encerramento) e LICENSE: https://raw.githubusercontent.com/benbusby/whoogle-search/main/README.md e https://raw.githubusercontent.com/benbusby/whoogle-search/main/LICENSE
- YaCy, README: https://raw.githubusercontent.com/yacy/yacy_search_server/master/README.md; arquivo `gpl.txt`: https://raw.githubusercontent.com/yacy/yacy_search_server/master/gpl.txt
- Marginalia Search, README: https://raw.githubusercontent.com/MarginaliaSearch/MarginaliaSearch/master/README.md

**Host bloqueado ou não lido:**

- `docs.searxng.org`: não lido nesta rodada (o SearXNG tem a documentação no próprio repositório, e foi usada a versão do GitHub).
- RFC 9309 (`rfc-editor.org`, `ietf.org`, `datatracker.ietf.org`): **host bloqueado** (código 000 em todas as tentativas). O texto da RFC **não foi lido** e não é citado aqui.
- Documentação do Google sobre robots (`developers.google.com`): **host bloqueado**.
- Termos de uso de Google, Bing e DuckDuckGo (`policies.google.com`, `bing.com`, `duckduckgo.com`): **host bloqueado**. Não há como dizer o que eles proíbem.
- Mojeek (página de API) e Marginalia (`api.marginalia.nu`): **host bloqueado**.
- LICENSE do Crawlee (`apify/crawlee`, branches `main` e `master`), do robots-parser (repositório não localizado) e do Stract (`stract`, `StractOrg`): **404** nas tentativas. A licença do Crawlee e a do robots-parser vêm só dos metadados do npm.

### 1. SearXNG: o que é, como roda e como responde

**Instalação em contêiner (oficial).**

- Imagem e Valkey, do `container/docker-compose.yml`: `image: docker.io/searxng/searxng:${SEARXNG_VERSION:-latest}` e `image: docker.io/valkey/valkey:9-alpine`. O Valkey guarda o estado do limitador (ver abaixo).
- Passos da documentação: baixar o compose oficial com `curl -fsSL -O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml`, copiar `.env.example`, `docker compose up -d`, e depois ajustar `core-config/settings.yml`. (installation-docker.rst)
- O repositório `searxng/searxng-docker` está marcado como superado: "*searxng-docker* repository is superseded." Usar o compose do repositório principal. (searxng-docker README)
- A documentação avisa: "DockerHub now applies rate limits to unauthenticated image pulls." Há um espelho no GHCR (`ghcr.io/searxng/searxng`). (installation-docker.rst)
- Variáveis do `.env.example`: `SEARXNG_VERSION` (com exemplo "2026.3.25-541c6c3cb"), `SEARXNG_HOST` e `SEARXNG_PORT` (padrão 8080 no compose). Recomenda-se fixar a versão, não usar `latest`. (inferência a partir do exemplo do arquivo)
- Segredo: em `settings.yml`, `secret_key: "ultrasecretkey"  # Is overwritten by ${SEARXNG_SECRET}`. O valor de exemplo precisa ser trocado por variável de ambiente. Se a instância roda com o valor padrão, não verificado o efeito exato; tratar como obrigatório trocar.

**API JSON.**

- O formato JSON vem desligado: em `settings.yml`, `search: formats: - html`. O comentário diz: "# remove format to deny access, use lower case. # formats: [html, csv, json, rss]". Para ligar, acrescentar `json` na lista. (settings.yml)
- Regra da API: "If you want to consume the results as JSON, CSV, or RSS, you need to set the `format` parameter accordingly... Requesting an unset format will return a 403 Forbidden error. Be aware that many public instances have these formats disabled." (search_api.rst)
- Exemplo oficial: `curl 'https://searx.example.org/search?q=searxng&format=json'`. Aceita `GET /search` e `POST /search`, com `q` obrigatório e, entre outros, `categories`, `language`, `pageno`, `time_range` (`day`, `month`, `year`) e `safesearch`. (search_api.rst)
- Campos da resposta JSON (`get_json_response`): `query`, `results`, `answers`, `corrections`, `infoboxes`, `suggestions`, `unresponsive_engines`. (webutils.py)
- Campos de cada resultado: a classe base traz `url`, `engine` e `parsed_url`; o tipo de resultado principal acrescenta `title`, `content`, `img_src`, `iframe_src` e `template`. (result_types/_base.py) Não verificado: a presença de data de publicação e de pontuação no JSON final (o trecho lido não as mostrou).

**Motores consultados por padrão.**

- O arquivo `settings.yml` lista 358 motores. Pela leitura do YAML em 21/11/2026, 82 não têm `disabled` nem `inactive` (contagem feita sobre o arquivo, não por execução). Entre os motores de web geral, o arquivo mostra:
  - `google`: `disabled: true`; `bing`: `disabled: true`; `duckduckgo web` (`duckduckgo_web`): `disabled: true`; `brave`: `disabled: true`; `qwant`: `disabled: true`.
  - `startpage` e `mojeek`: `inactive: true`.
  - `duckduckgo` (entrada sem `disabled`), `wikipedia` (categoria `general`), `google cse` (sem `disabled`, mas a entrada não traz `api_key`; não verificado se responde sem chave).
- Consequência: a configuração padrão não consulta Google nem Bing na web geral. Quais destinos cada motor ativo realmente chama, e com que taxa, não foi verificado.

**Bloqueio e captcha (o motor que é bloqueado para a instância toda).**

- Comentário no `settings.yml`, em `search.suspended_times`: "# For error "CAPTCHA"" com `SearxEngineCaptcha: 3600`; "# For error "Too many request" and "HTTP error 429"" com `SearxEngineTooManyRequests: 180`; "# For error "Access denied" and "HTTP error [402, 403]"" com `SearxEngineAccessDenied: 180`. Cloudflare e reCAPTCHA têm tempos próprios (`cf_SearxEngineCaptcha: 1296000`, `recaptcha_SearxEngineCaptcha: 604800`).
- Ou seja: o próprio SearXNG suspende o motor que devolve captcha ou 429. Essa suspensão é a instância inteira, para todos os usuários, porque todos saem pelo mesmo IP. Esse é o risco central de um metabuscador sem chave.

**Limitador (controle de bots).**

- Ligado por `server: limiter:`, que no `settings.yml` lido está como `limiter: false`. (settings.yml)
- Quando ligado, as janelas do método `ip_limit` (ip_limit.py) são: `BURST_WINDOW = 20` com `BURST_MAX = 15`; `LONG_WINDOW = 600` com `LONG_MAX = 150`; e `API_WINDOW = 3600` com `API_MAX = 4`. O comentário de `API_WINDOW` diz: "Time (sec) before sliding window for API requests (format != html) expires." Ou seja, pedidos em formato `json` do mesmo IP têm teto de 4 por hora, se o limitador estiver ligado. (ip_limit.py)
- `limiter.toml`: `pass_ip` dá "unrestricted access" a IPs da lista; `trusted_proxies` faz o SearXNG tirar o IP do cliente de `X-Forwarded-For` e `X-Real-IP`, só para IPs de proxy confiáveis; `pass_searxng_org = true` libera a lista de IPs da própria organização SearXNG. (limiter.toml)
- Inferência: com o limitador desligado (padrão), o `API_MAX` não se aplica; a proteção fica só com os bloqueios por motor. Não testado.

**Recursos.** A documentação lida não dá requisitos de CPU ou memória. O exemplo de listagem de imagens em installation-docker.rst mostra imagem de "271 MB", mas isso é só um exemplo de saída, não requisito. Não verificado.

**Licença (AGPL v3), texto lido.**

- Seção 13, "Remote Network Interaction; Use with the GNU General Public License.": "Notwithstanding any other provision of this License, if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network (if your version supports such interaction) an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge..." (LICENSE, lido em 21/11/2026)
- Inferência sobre o nosso caso: a obrigação da seção 13 começa com "if you modify the Program". Rodar o SearXNG sem alteração, como serviço interno chamado por HTTP, não aciona essa oferta pelo texto lido. Se alterarmos código, template ou motor do SearXNG, a oferta de código-fonte passa a valer para quem interage com a versão modificada pela rede. Se os "usuários" dessa interação são só os bots internos ou também as pessoas do Suup, é questão jurídica. **Não verificado; consultar o dono ou o jurídico antes de modificar o SearXNG.** Também não verificado: se usar a API HTTP de um serviço AGPL torna o código do Suup AGPL (a leitura comum é que não, mas não foi checado aqui).

### 2. Leitura de página: o que o Firecrawl usa (fatos)

**Auto-hospedagem (SELF_HOST.md, lido em 21/11/2026).**

- "**Scraping: bundled Playwright with basic fetch fallback.** Connect and configure a separate engine such as Fire-engine only when you need it."
- "At this revision, Compose runs the Firecrawl API and workers, Playwright, Redis, RabbitMQ, NuQ PostgreSQL, and FoundationDB services for the optional queue backend. Only the API is published to the host by default, on port `3002`."
- "The default API is unauthenticated." e "If the API will leave a trusted network, add a complete authentication design, TLS termination, and network policy first."

**Dependências da API (apps/api/package.json).** `cheerio` `^1.0.0-rc.12`, `jsdom` `^29.1.1`, `robots-parser` `^3.0.1`, `turndown` `^7.1.3`, `bullmq`, `ioredis`, `pdf-parse` e `@mendable/firecrawl-rs` (workspace, Rust). O `package.json` não lista `@mozilla/readability`. Não verificado: qual caminho converte HTML em Markdown dentro do pacote Rust. Quanto a `turndown`, o arquivo confirma o uso como dependência da API, não o fluxo exato.

**Serviço de Playwright (apps/playwright-service-ts).**

- `package.json`: `playwright` `^1.65.0`, `express` `^5.2.1`, `ipaddr.js`, `proxy-chain`, `user-agents`. Licença declarada no `package.json`: ISC. Exige `node` `>=22.13.0`.
- README: "Blocks requests to known ad-serving domains." e "Uses random user-agent strings to avoid detection." Este segundo ponto vai contra a identificação honesta de um robô (ver seção 3).
- `api.ts`: há um proxy de SSRF local (`startSSRFProxy`, `ssrfPrepareRequest`) e as mensagens "resolves to a private/internal address" e "navigation to private/internal resource is not allowed". Ou seja, o serviço recusa navegar para endereços privados.
- Fórmula de integração: "Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env`". (README do serviço)

**Licença do Firecrawl.** O repositório principal é AGPL v3 (já registrado acima). O pacote do servidor MCP e o SDK são MIT: `firecrawl` 4.54.0 e `@mendable/firecrawl-js` 4.54.0 (npm, MIT). Copiar código da API do Firecrawl para o Suup tornaria o Suup AGPL (inferência a partir da licença do repositório). Usar as ideias, não o código.

**Bibliotecas permissivas (npm `latest`, lidos em 21/11/2026).**

| Pacote | Versão | Licença (npm) | Para que serve | Nota |
|---|---|---|---|---|
| `@mozilla/readability` | 0.6.0 | Apache-2.0 | Extrai o texto principal da página | README: "new Readability(document).parse()"; recomenda sanitizar a saída |
| `turndown` | 7.2.5 | MIT | HTML para Markdown | README: `new TurndownService()` e `turndown('<h1>Hello world!</h1>')` |
| `jsdom` | 31.0.1 | MIT | DOM em Node para o Readability | Scripts vêm desligados por padrão (ver segurança); Firecrawl usa `^29.1.1` |
| `linkedom` | 0.18.15 | ISC | DOM leve em Node, alternativa ao jsdom | Não testado com o Readability nesta rodada |
| `playwright` / `playwright-core` | 1.65.1 | Apache-2.0 | Chromium headless para páginas com JavaScript | LICENSE da Microsoft: Apache License 2.0 |
| `robots-parser` | 3.1.1 | MIT | Lê robots.txt | Versão do npm; o repositório não foi localizado |
| `crawlee` | 3.18.2 | Apache-2.0 | Rastreio com limites de concorrência e atraso | Ver abaixo |

- Chromium (o navegador que o Playwright baixa): o arquivo LICENSE do repositório `chromium/chromium` tem o texto de redistribuição do BSD de três cláusulas, com "Neither the name of Google LLC nor the names of its". Inferência: o Chromium é BSD-3; a lista de componentes de terceiros do próprio navegador não foi lida. **Não verificado** para os binários distribuídos pelo Playwright.
- Mozilla Readability, sobre entrada não confiável: "If you're going to use Readability with untrusted input (whether in HTML or DOM form), we **strongly** recommend you use a sanitizer library like [DOMPurify] to avoid script injection when you use the output of Readability."
- jsdom, sobre scripts: "For security reasons these are disabled by default ... and we **strongly** recommend you keep them that way." (README do Readability, citando o jsdom)
- Crawlee, o que o código lido do branch `master` oferece no crawler base: as opções `maxConcurrency`, `maxRequestsPerMinute`, `respectRobotsTxtFile` e `sameDomainDelaySecs` (esta última com a lógica de "one clock per site"). A documentação dela diz: "If set to `true`, the crawler will automatically try to fetch the robots.txt file for each domain,". (basic-crawler.ts, linhas 511 a 517 e 1018 a 1124). README do Crawlee: "Integrated **proxy rotation** and session management" e "Integrated fast **HTML parsers**. Cheerio and JSDOM". **Não verificado** que a versão 3.18.2 publicada tenha exatamente este código.

### 3. Politeness e legal (com o que foi possível ler)

- RFC 9309 (Robots Exclusion Protocol): **não lida** (host bloqueado). O que se pode dizer com fonte lida: o README da biblioteca do Google cita "[Robots Exclusion Protocol standard](https://www.rfc-editor.org/rfc/rfc9309.html)" como o padrão de referência. Não foi citada nenhuma frase da RFC.
- Biblioteca de referência do Google: "The repository contains Google's robots.txt parser and matcher as a C++ library (compliant to C++14)." Licença Apache License, Version 2.0 (LICENSE lido). Serve como referência de comportamento, não como dependência de Node.
- robots.txt do Google (lido em 21/11/2026): o grupo `User-agent: *` tem `Disallow: /search` e `Allow: /search/about`. Isso mostra que a própria página de busca do Google está marcada para não ser rastreada por robôs que respeitam o padrão. Um metabuscador que consulta o Google raspando a página de resultados vai contra essa diretiva, independentemente dos termos de uso, que não foram lidos.
- Identificação do robô: não há fonte lida que defina o formato do user-agent. Recomendação (inferência): identificar o Suup com um nome e um contato, sem fingir ser navegador. O README do serviço de Playwright do Firecrawl faz o contrário ("random user-agent strings to avoid detection"); não copiar essa prática.
- Limite de taxa: as fontes lidas não trazem números de limite por site. Os números que temos são os do limitador do SearXNG (acima), que são limites de servidor, não de cliente. O Crawlee oferece as opções, sem valor recomendado.
- Termos de uso dos buscadores: **não verificado** (host bloqueado). Antes de usar qualquer motor de busca raspado em produção, ler os termos. Nenhuma conclusão jurídica aqui.
- Whoogle: o README traz aviso de encerramento. "Since early 2025, Google has steadily shut the door on search queries made without JavaScript, banning working User-Agent strings as fast as they were found." e "active work on this repository has come to an end: No further commits or releases". Licença MIT (LICENSE lido). Não usar como base: o projeto diz que não funciona mais.
- YaCy (README lido): "a full search engine application containing a server hosting a search index ... and a production-ready web crawler with a scheduler to keep a search index fresh." Tem rede peer-to-peer. O arquivo `gpl.txt` do repositório é o texto da GPL versão 2. A licença declarada do projeto **não foi confirmada** (o LICENSE da raiz devolveu 404).
- Marginalia Search (README lido): "The bulk of the project is available with AGPL 3.0, with exceptions. Some parts are co-licensed under MIT". A API pública não foi lida (host bloqueado).
- Mojeek e Stract: **não verificado** nesta rodada (host bloqueado ou licença não localizada).

### 4. Segurança

**Navegador sobre páginas não confiáveis.**

- Renderizar JavaScript de página desconhecida executa código de terceiros. O Readability recomenda sanitização antes de usar a saída (ver seção 2). Não fica dentro do bot sem isolamento: inferência, a partir do modelo de ameaça do Firecrawl (que roda o navegador num serviço separado, com checagem de SSRF) e do aviso do Readability.
- O serviço de Playwright do Firecrawl bloqueia navegação para endereços privados: "navigation to private/internal resource is not allowed". Isso confirma que o risco de SSRF por navegador é real e precisa de uma checagem no próprio serviço de renderização. (api.ts)

**SSRF e a lista de saída do Suup (`docs/REDE.md`, lido).**

- "O proxy só deixa passar nomes de host da lista. Comparação por **igualdade exata** do nome normalizado ... Não há curinga, sufixo nem padrão."
- "Endereços IP, `localhost` e o endereço de metadados são recusados sempre, mesmo que alguém os ponha na lista ... Depois de resolver o nome, o endereço é conferido **numericamente** contra as faixas privadas ... O proxy resolve **uma vez** e conecta ao endereço que validou (contra *DNS rebinding*)."
- REDE.md já avisa: "Um host liberado é um canal."

**Consequências para a busca e a leitura (inferência).**

- O navegador de renderização precisa de saída para qualquer site, porque a página pede recursos de terceiros (CDN, fontes, anúncios). Uma lista exata de hosts não cobre isso. Então a renderização de JS não pode usar a lista fechada do bot. Opções: (i) um contêiner de renderização separado, com saída para a internet pública mas sem faixas privadas, usando o mesmo tipo de checagem do proxy; ou (ii) restringir o navegador a uma lista de hosts da página pedida, o que quebra páginas com recursos de terceiros. Escolha para o dono. **Não verificado** se o Chromium do Playwright respeita a variável `HTTP_PROXY` do ambiente; precisa de teste.
- O SearXNG precisa de saída para os motores que consulta. Como a lista é de igualdade exata, cada motor exige seus hosts listados um por um, sem curinga. Um contêiner de busca com saída só para esses hosts é compatível com `REDE.md`, mas a lista muda quando um motor muda de domínio. **Não verificado** quais hosts cada motor padrão usa.
- Injeção de instrução: o texto de página e de resultado é dado externo. Não há fonte lida sobre detecção de injeção nesse caminho próprio. Tratar como nas seções anteriores: dado, nunca instrução.
- Auto-hospedar o Firecrawl inteiro é pesado (ver seção 2: sete serviços, incluindo banco, filas e o contêiner de Playwright), e a própria documentação diz que a API vem sem autenticação por padrão. Inferência: para o Suup, não compensa importar o Firecrawl inteiro; é melhor reproduzir o fluxo (busca, extração, Markdown) com as bibliotecas acima.

### Implicação para o Suup

Inferência, com base nos fatos acima. Não decide nada: é uma proposta para o dono.

| Assunto | Proposta | Base |
|---|---|---|
| (a) `web_search`, ferramenta embutida com backend trocável | Interface única `web_search` com backend plugável. Padrão: contêiner SearXNG, versão fixada (não `latest`), `formats: [html, json]`, segredo por variável, motores padrão revistos. Adaptadores opcionais para Brave, Tavily ou Exa, com a chave no cofre (`docs/COFRE.md`) e no cabeçalho, nunca na URL. Trocar de backend não exige mudar o bot | Seções 1 e 6 do texto acima; `search_api.rst`; `settings.yml` |
| Limite do SearXNG por IP | Antes de confiar no SearXNG, medir: captcha ou 429 suspendem o motor para todos os usuários por 3600 s ou 180 s. Se o limitador for ligado, o formato JSON tem teto de 4 por hora por IP | `settings.yml`; `ip_limit.py` |
| (b) `web_read`, evolução do `web_fetch` atual | Pipeline: baixar, extrair o texto principal com `@mozilla/readability` (Apache-2.0), sanitizar, converter com `turndown` (MIT). `jsdom` com scripts desligados. Respeitar `robots.txt` com `robots-parser` (MIT), identificando o Suup. Sem JS por padrão | Seção 2 e 3 |
| Renderização de JS | Opcional, num serviço separado (Playwright, Apache-2.0), com checagem de faixa privada na navegação, como o do Firecrawl faz. Só quando `web_read` não extrai conteúdo suficiente, ou se o dono pedir | Seções 2 e 4 |
| (c) `web_crawl` / `web_map`, depois | `crawlee` (Apache-2.0) com `maxConcurrency`, `maxRequestsPerMinute`, `sameDomainDelaySecs` e `respectRobotsTxtFile`, limites de páginas, profundidade e mesmo domínio. Fase posterior; não é necessário para a primeira entrega | Seção 2 (código lido em `master`, não na 3.18.2) |
| (d) Rede | Contêiner SearXNG: saída só para os hosts dos motores ativos, listados um a um (`REDE.md` não aceita curinga). Leitura de página: não cabe na lista fechada do bot, porque cada site tem recursos de terceiros e o universo de sites é aberto. Duas opções para o dono: (i) a leitura usa uma rede própria de "web aberta", que continua bloqueando IP literal, loopback, metadados e faixas privadas, e passa por `REDE.md`; (ii) a leitura usa a lista do bot, com `request_network_access` para cada domínio novo. A opção (i) é a que faz `web_read` funcionar; a (ii) é mais segura e limita o uso | `REDE.md`; seção 4 |
| Aprovação | Nível de leitura, sem cartão (como `docs/APROVACOES.md`), porque busca e leitura não alteram nada. Limite de buscas e de páginas por execução fica como guarda de custo, não como aprovação | Projeto |
| Custo | Busca pelo SearXNG: zero por consulta, custo de máquina e de rede. Busca paga (Brave, Tavily, Exa): preço por consulta **não verificado** nesta pesquisa (páginas de preço bloqueadas). Registrar a contagem de chamadas por execução em qualquer caso | Seções 1 e 6 do texto acima; I5 |
| Conteúdo como dado | Todo texto de busca ou de página entra marcado como dado externo, como o `web_fetch` atual faz. Nunca em instrução | Seção 7 |
| Licença | Não copiar código do Firecrawl (AGPL v3). Não modificar o SearXNG sem revisão jurídica (seção 13 da AGPL). Usar só como serviço por HTTP, sem alteração | Seção 1 e 2 deste adendo |
| Medição | Conjunto pequeno de tarefas de pesquisa com resposta conhecida (5 a 10 perguntas com fonte), comparando SearXNG, um provedor pago e a leitura própria: presença da fonte correta, qualidade da página extraída (texto principal sem menus), buscas por tarefa, tempo e falhas por motor (captcha, 429). Antes disso, nada de produção | Projeto |

**Riscos principais (inferência):**

- O IP do Suup é único. Se um motor bloquear o IP, a instância toda fica sem aquele motor. A medida é a suspensão já prevista no SearXNG e um backend pago de reserva. Sem chave, não há garantia de disponibilidade.
- Com o padrão do SearXNG, o Google e o Bing web estão desligados. A qualidade de busca dependerá dos motores que restarem. Não medido.
- Se o SearXNG for modificado, passa a valer a seção 13 da AGPL.
- Renderizar JS sem contêiner separado e sem checagem de faixa privada reabre o SSRF que `REDE.md` fecha no proxy.

### O que não foi verificado

- RFC 9309 (texto e frases): host bloqueado. Nenhuma frase da RFC foi citada.
- Termos de uso de Google, Bing, DuckDuckGo: host bloqueado. Não há conclusão sobre eles.
- Documentação e preços de Brave, Tavily, Exa e Firecrawl (`firecrawl.dev` não foi tentado nesta rodada): preço e limites continuam não verificados.
- Documentação do SearXNG em `docs.searxng.org`: não tentada nesta rodada (na pesquisa anterior estava bloqueada); a leitura usou só o repositório.
- Motores que o SearXNG consulta de fato, os hosts de cada um e se respondem sem chave. Contagem de 82 motores "ativos" é só leitura do YAML.
- Requisitos de CPU e memória do SearXNG e do Playwright, em produção.
- Se o Chromium do Playwright respeita `HTTP_PROXY` do ambiente do bot.
- Licença declarada do YaCy (LICENSE da raiz, 404), de Marginalia (só o README), do Stract e do Mojeek.
- Código do Crawlee na versão publicada 3.18.2 (lido o branch `master`) e a licença do Crawlee pelo LICENSE do repositório (404).
- Caminho de conversão HTML para Markdown dentro do `@mendable/firecrawl-rs` (pacote Rust, não lido).
- Se a checagem de faixa privada no serviço de Playwright do Firecrawl cobre DNS rebinding (só se leu a mensagem de erro e a existência do proxy SSRF, não a lógica completa de `helpers/ssrf`).
- Se o limitador do SearXNG está ativo no padrão da imagem oficial: `settings.yml` diz `limiter: false`, mas não foi lido o código de inicialização da imagem.
- Efeito real de usar o `secret_key` padrão do SearXNG, se não for trocado.

### Próximo passo sugerido

Antes de implementar: (1) ler `docs.searxng.org` e a página de preços de Brave, Tavily e Exa com outro acesso, para fechar os itens bloqueados acima; (2) rodar o SearXNG em um contêiner de teste, com a versão fixada, e medir captcha e 429 em um conjunto de consultas; (3) decidir com o dono a opção de rede para a leitura de página, (i) ou (ii) da tabela; (4) só então desenhar a tela de configuração do `web_search`, pelo `docs/DESIGN.md`.
