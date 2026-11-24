# Pesquisa: alternativas legítimas ao DuckDuckGo para a busca geral na web

Data da pesquisa: 24/11/2026. Complementa [fase-4-busca-na-web.md](fase-4-busca-na-web.md) e [fase-4-busca-apis-diretas.md](fase-4-busca-apis-diretas.md); o desenho atual está em [BUSCA.md](../BUSCA.md).

Contexto: no computador do dono (Windows, conexão residencial no Brasil), o DuckDuckGo (`html.duckduckgo.com`, pelo SearXNG, com o `User-Agent` honesto `SuupBot/...`) responde com captcha a quase toda consulta. A busca geral fica fora do ar; só a Wikipédia, o arXiv e o Stack Overflow respondem, pelas APIs oficiais.

## Pergunta

Quais são os jeitos **legítimos** (sem resolver captcha, sem rodízio de IP, sem disfarce de navegador, respeitando `robots.txt` e termos) de o Suup ter uma busca geral na web confiável, quanto custa cada um (plano gratuito e cerca de 1000 buscas por mês), como se sai em português e no Brasil, o que os termos permitem para um agente pessoal, qual a latência, qual o formato da API e como cada um cabe no desenho de motores diretos do Suup (`EgressProxy`, limites, cache)? E o DuckDuckGo deve continuar?

## Fontes

### Leitura de 24/11/2026 (esta revisão)

Acesso em **24/11/2026**. Nesta revisão, a maioria dos hosts **abriu** (a nota anterior dizia que quase tudo estava bloqueado por DNS; isso não se repetiu). Páginas lidas, com URL:

- Brave, página do produto (com os planos de preço e exemplos de parâmetros): https://brave.com/search/api/ (mesmo conteúdo de https://api-dashboard.search.brave.com, que responde igual).
- Brave, termos da API (cache, armazenamento, atribuição, uso proibido): https://api-dashboard.search.brave.com/terms-of-service
- Tavily, documentação (página inicial apenas): https://docs.tavily.com
- Exa, documentação (página inicial apenas): https://docs.exa.ai
- Exa, preços: https://exa.ai/pricing
- Kagi, central de ajuda (página inicial; **não traz preço da API**): https://help.kagi.com
- Mojeek, página inicial: https://www.mojeek.com ; Web Search API: https://www.mojeek.com/services/search/web-search-api/ ; planos: https://www.mojeek.com/services/api.html ; parâmetros da busca: https://www.mojeek.com/support/api/search/request_parameters.html ; termos do site: https://www.mojeek.com/about/terms.html
- Marginalia, sobre: https://about.marginalia-search.com ; documentação da API: https://about.marginalia-search.com/article/api
- Google, visão geral da Custom Search JSON API: https://developers.google.com/custom-search/v1/overview
- DuckDuckGo, termos de serviço: https://duckduckgo.com/terms

**Não lidos (bloqueio ou fora do pedido):**

- Tavily, em 24/11/2026, após o coordenador liberar `www.tavily.com` (uma primeira tentativa, antes da liberação, foi recusada pela proxy com HTTP 403): **lidos** https://www.tavily.com/pricing , https://www.tavily.com/terms (Platform Terms, link "Platform Terms of Use" do rodapé), https://docs.tavily.com/documentation/api-credits e https://docs.tavily.com/api-reference/endpoint/search. Não lido: https://www.tavily.com/acceptable-use (404 nesse caminho); a política de uso aceitável citada nos termos (§3.8) fica como pendência.
- `https://api-dashboard.search.brave.com/app/documentation/web-search/rate-limiting`: 404 (página inexistente, não bloqueio). `https://brave.com/terms-of-service/`: 404.
- `https://kagi.com/api/pricing`: não foi pedido nesta revisão; o preço da Kagi continua vindo do repositório oficial (abaixo).
- `https://duckduckgo.com/acceptable-use`: linkada pelos termos, não foi pedida; não lida.
- Termos da Exa (`exa.ai/terms`) e subpáginas de `docs.tavily.com` e `docs.exa.ai` (limites, créditos, parâmetros): só se vê o menu; não lidos.

### Repositórios oficiais (leitura da revisão anterior, mantida)

Lidos via `raw.githubusercontent.com`:

- Kagi, documentação oficial (`kagisearch/kagi-docs`, ramo `main`): "Quick Start" https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/overview.md ; "Search API" https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/search.md ; "API Portal" https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/api-portal.md
- SearXNG, módulos de motor e configuração padrão (ramo `master`): `duckduckgo.py`, `mojeek.py`, `qwant.py`, `marginalia.py`, `braveapi.py`, `mwmbl.py` e `settings.yml`, em https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/ e https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml
- SearXNG, `duckduckgo.py` na versão fixada pelo Suup (commit `541c6c3cb`): https://raw.githubusercontent.com/searxng/searxng/541c6c3cb/searx/engines/duckduckgo.py
- Marginalia Search, modelo da resposta (`ApiSearchResults.java`): https://raw.githubusercontent.com/MarginaliaSearch/MarginaliaSearch/master/code/services-application/api-service/java/nu/marginalia/api/model/ApiSearchResults.java

### [resumo] Vistas só pelo resumo da busca (não abertas)

- Brave: documentação de preços e de parâmetros da busca web, https://api-dashboard.search.brave.com/documentation/pricing e https://api-dashboard.search.brave.com/app/documentation/web-search/query
- Tavily: créditos e preço por crédito (`US$ 0,008`), https://docs.tavily.com/documentation/api-credits ; endpoint de busca, https://docs.tavily.com/api-reference/endpoint/search
- Exa: latência (números da própria Exa), https://exa.ai/blog/fastest-search-api e https://exa.ai/docs/changelog/new-fast-search-type ; filtro de localização, https://exa.ai/docs/changelog/geolocation-filter-support
- Google: blog do Programmable Search Engine, https://programmablesearchengine.googleblog.com/2026/ ; processo contra a SerpApi, https://blog.google/technology/safety-security/serpapi-lawsuit/
- Microsoft: aposentadoria das Bing Search APIs, https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- DuckDuckGo: termos do Duck.ai, https://duckduckgo.com/duckai/privacy-terms
- Qwant: páginas legais, https://about.qwant.com/en/legal/confidentialite/

## Fatos verificados

### 1. DuckDuckGo

- **[lido] O próprio módulo do SearXNG descreve um "bot blocker".** Na versão fixada (`541c6c3cb`) e no `master`: o `User-Agent` "is generated by the WEB-client and are checked by DDG's bot blocker"; "it is possible that certain UA headers (such as curl) are filtered"; "In DDG's bot blocker, the IP will be blocked (DDG does not have a client session!)"; houve "changes to the bot blocker in the period of Q3/Q4 2025: in the past, the IP blocking was implemented as a 'sliding window' (unblock after about 1 hour without requests from this IP)". Os campos do formulário são "reverse-engineered from DDG-html and may be subject to additional bot detection mechanisms".
- **[lido] O `master` do SearXNG passou a se disfarçar de navegador** para o DuckDuckGo: `params["impersonate"] = "firefox"` (biblioteca `curl_cffi`), mais `Sec-Fetch-*` e `Referer` "to simulate the behavior of a real browser session". A versão fixada ainda usa `_HTTP_User_Agent`, sem `impersonate`.
- **[lido]** Ao ver o captcha, o módulo levanta `SearxEngineCaptchaException(suspended_time=0, ...)` (comentário: "set suspend time to zero is OK --> ddg does not block the IP").
- **[lido] Termos de serviço do DuckDuckGo (https://duckduckgo.com/terms, lidos em 24/11/2026).** Dizem que "We expect you to use our Services as authorized, or we may otherwise suspend access" e que é preciso "comply with the DuckDuckGo Acceptable Use Policy". **Não há cláusula sobre busca automática no texto lido.** A política de uso aceitável **não foi lida**. A proibição de "automated querying" que a nota anterior citava é dos termos do **Duck.ai** [resumo], outro serviço.
- **[resumo] API oficial.** A ajuda do DuckDuckGo descreve as "Instant Answers" como respostas mostradas acima dos resultados. Nenhuma página oficial de uma API de **resultados web** foi encontrada.
- **Declaração oficial sobre captcha em IP residencial: não encontrada.**

Consequência: o argumento contra o DuckDuckGo **não é** que os termos proíbam a busca. O argumento é técnico: o SearXNG descreve um bloqueador de robôs, e o motor só passa a funcionar imitando um navegador (fato [lido] acima), o que o Suup não faz.

### 2. APIs de busca pagas (com chave)

**Brave Search API**

- **[lido] Preço (página do produto, https://brave.com/search/api/, lida em 24/11/2026):** plano Search com "**$5 per 1,000 requests**", "**Includes $5 in free credits every month**" ("Credits are automatically applied to your account"), capacidade "**50 queries per second**". Plano Answers: "$4 per 1,000 requests + $5 per million input/output tokens", também com US$ 5 de crédito mensal.
- **[lido] Contradição a registrar:** a mesma página, no topo, diz "**Up to $20 in free calls every month** · Prepaid credits, no subscription". Os planos listados dão US$ 5 por produto. Este relatório usa o valor do plano de busca (US$ 5). Se o dono quiser o total de US$ 20, é preciso conferir no painel. Também não foi lido se o cadastro pede cartão ("Prepaid credits" sugere pagamento antecipado, mas isso não está confirmado).
- **[lido] Formato (exemplos da página):** `GET https://api.search.brave.com/res/v1/web/search` com o cabeçalho `X-Subscription-Token`, parâmetros `q`, `count`, `country` (código de 2 letras, exemplo `us`) e `search_lang` (exemplo `en`). Os exemplos usam `country=us` e `search_lang=en`; a página não traz valores para Brasil nem para português. Os valores `country=BR` e `search_lang=pt-br` continuam **inferência**, pois a lista de valores aceitos não foi lida.
- **[lido] Termos de serviço da API (https://api-dashboard.search.brave.com/terms-of-service, lidos em 24/11/2026):**
  - Cache e armazenamento: o cliente não pode "store, cache, or create a database of Search Results, in whole or in part, other than transient storage required for operation of Customer Applications or related software, service or systems". **Cache de 3 horas no banco não cabe** nessa frase, a não ser que seja "transient storage required for operation" (interpretação a confirmar com o dono).
  - IA: é proibido "use the Search Results to create, evaluate, train, re-train, fine-tune, benchmark or otherwise improve artificial intelligence models or services". Isso pega **avaliações (`evals/`)** que usem resultados da Brave.
  - Limites: é proibido "circumvent or bypass rate limits or service limits through any method, including by creating multiple accounts".
  - Identidade: é proibido "attempt to obfuscate or conceal Customer's identity ... when requesting authorization to use the API".
  - Atribuição: **opcional**. "Customer may provide attribution ... 'POWERED BY BRAVE'". A nota anterior dizia que o crédito "é vinculado a dar atribuição"; **isso estava errado**.
  - Redistribuição: não pode "redistribute, resell, or sublicense the Search Results".
- **[lido] SearXNG (`braveapi.py`):** host `api.search.brave.com/res/v1/web/search`, paginação (`offset`, até 10 páginas), `safesearch`, filtro de tempo, JSON, até 20 resultados por página.
- **Latência:** não verificada.

**Tavily**

- **[lido] Grátis (https://www.tavily.com/pricing, https://docs.tavily.com/documentation/api-credits, lidos em 24/11/2026):** plano "Researcher": "**1,000 API credits / month**", "No credit card required". Docs: "You get 1,000 free API Credits every month. No credit card required."
- **[lido] Preço depois da cota:** "Pay As You Go: **$0.008 / credit**". Planos mensais: Project US$ 30 por 4000 créditos (US$ 0,0075 cada); Bootstrap US$ 100 por 15 000 (US$ 0,0067); Startup US$ 220 por 38 000 (US$ 0,0058); Growth US$ 500 por 100 000 (US$ 0,005). Os créditos viram "requests stop until your credits reset or you upgrade" ao acabar.
- **[lido] Custo por busca:** "Basic Search (basic): Each request costs 1 API credit." "Advanced Search (advanced): Each request costs 2 API credits." Ou seja, **1000 buscas `basic` por mês cabem exatamente no plano gratuito**, sem cartão.
- **[lido] Formato (https://docs.tavily.com/api-reference/endpoint/search):** `POST` com `Authorization: Bearer`; campos `query`, `search_depth`, `topic` (`general` ou `news`), `max_results`, `include_domains`, `time_range`, `country`, `language`, `filter_by_language`, `auto_parameters`.
- **[lido] Brasil e português:** `country` é um **enum por nome em minúsculas**, não código de duas letras: aparece `brazil` (e `portugal`). Descrição: "Boost search results from a specific country. This will prioritize content from the selected country ... Available only if topic is general." Logo, `country=brazil` (**a nota anterior dizia ISO de duas letras; está errado**). `language` aceita "an ISO 639-1 code (e.g. en, fr, zh-cn) or an English language name", ou seja `language=pt` (ou `portuguese`). Por padrão só **realça** o idioma no ranking; `filter_by_language: true` filtra de forma estrita e exige `language`, senão devolve erro 400.
- **[lido] Termos (https://www.tavily.com/terms, Platform Terms):**
  - Agente: "Tavily may make available to Customer an Agent Key that enables **automated interaction between Customer's agents and the Services**" (§ introdutório). Ou seja, uso por agente é previsto e **permitido por chave de agente**; o cliente responde pelo que o agente faz.
  - Uso pessoal: "The Services are provided **solely for Customer's internal business purposes**, including for integration with Customer Applications" (§3). **Uso como agente pessoal não está claramente coberto**; isso precisa de decisão do dono.
  - AUP: "Customer shall comply with ... Tavily's Acceptable Use Policy" (§3.8). **A política em si não foi lida** (o caminho `/acceptable-use` deu 404).
  - Cache e armazenamento de resultados (Output): **nenhuma cláusula de cache, armazenamento ou retenção de resultados encontrada** no texto lido. A cláusula de licença (§11) é sobre o que o **cliente envia** (Customer Input), que a Tavily pode usar para melhorar serviços; o Output tem regras de uso de IA (§6): a Tavily e seus provedores "may use, process, analyze, and retain Customer Input ... and Outputs generated by the AI Functionality for purposes of training". **Isso vale para o AI Functionality, não para a busca.**
  - Atribuição: **nenhuma exigência** encontrada no texto lido.
  - Limites de taxa: a seção "Rate Limits" aparece no índice, mas o **conteúdo não foi lido**. Os termos só citam "Higher rate limits" nos planos pagos.
  - Pagamento: renovação automática em planos pagos (§4.5). O plano gratuito não cobra.

**Exa**

- **[lido] Preços (https://exa.ai/pricing, lido em 24/11/2026):**
  - Plano gratuito "Starter": "**$10 credits every month plus a $10 onboarding bonus. No payment method required**". A nota anterior tinha "US$ 10 ou 20"; a página diz **US$ 10 por mês e US$ 10 de bônus na entrada**.
  - Busca "**Lite**": **US$ 4 por 1000 pedidos**, descrita como "low-latency Lite search" para "latency-sensitive agent loops".
  - Busca "**Auto**": **US$ 7 por 1000**. Busca "**Deep**": **US$ 12 por 1000**. Acima de 10 resultados: US$ 1 por 1000 por resultado extra.
  - Os valores de "US$ 7" da nota anterior correspondem à Auto; a opção mais barata é a **Lite, US$ 4**.
- **[lido] Autenticação (https://docs.exa.ai, página inicial):** exemplos com `Authorization: Bearer $EXA_API_KEY`.
- **[resumo] Latência (números da própria Exa, em blog):** `instant` cerca de 250 ms, `fast` cerca de 450 ms, `auto` cerca de 1 s. Não lido nesta revisão.
- **[resumo] Brasil:** `userLocation` com código de 2 letras, só viés. Não aparece na página inicial lida.
- **Termos de uso: não lidos.**

**Kagi Search API**

- **[lido] Preço e acesso (repositório oficial `kagi-docs`, lido em revisão anterior):** "The Kagi Search API is priced at **$12 per 1,000 queries** ($0.012 per search)." Criar conta, gerar o token em `kagi.com/api`, pôr saldo.
- **[lido] Formato:** `GET https://kagi.com/api/v1/search?q=...` com `Authorization: Bot <token>`; também `POST` com JSON e `Authorization: Bearer`. "The Search API inherits settings from your account".
- **Nesta revisão, a central de ajuda de `help.kagi.com` não traz nenhuma página de API nem preço.** O preço de US$ 12 vem do repositório, não do site de ajuda. Não confirmado no site.
- Se é preciso **assinatura** Kagi além do saldo: **não verificado**.

**Mojeek Web Search API**

- **[lido] Planos (https://www.mojeek.com/services/api.html, lido em 24/11/2026):**
  - **Startup: £ 2 por 1000 pedidos**, 5 consultas por segundo, até 100 000 por dia, **cache de 1 hora** (FAQ), **sem "storage rights"**.
  - **Business: £ 3 por 1000**, 10 por segundo, até 400 000 por dia, com direito de armazenamento ("storage rights", retenção indefinida).
  - Enterprise: sob consulta. Preços sem impostos.
- **[lido] Teste gratuito:** "sign up to our Startup Plan and claim a free credit. A bank card is required to open an account however no automatic payments are processed". A nota anterior dizia "teste a pedido"; **está errado**: é crédito gratuito ao abrir conta no Startup, **com cartão**.
- **[lido] Parâmetros (https://www.mojeek.com/support/api/search/request_parameters.html):** `api_key` (parâmetro na URL, `/search`), `rb` (região, ISO 3166-1 alfa-2, por exemplo `GB`; `rbb` de 1 a 100, recomendado 10), `lb` (idioma, ISO 639-1, por exemplo `EN`; `lbb` de 1 a 100, recomendado 100). **Brasil e português são possíveis via `rb=BR` e `lb=PT`**. O parâmetro `arc` citado pelo módulo do SearXNG **não aparece** nessa página.
- **[lido] Termos do site (https://www.mojeek.com/about/terms.html):** proíbe "use or access Our Services by any automated means (**unless you are an authorised Mojeek API user**)"; permite "crawling ... if done in accordance with the provisions of the robots.txt file", e proíbe "scraping the Services without Our prior consent". **Uso pela API autorizada é o caminho permitido.** Termos próprios da API não foram lidos.
- **[lido] Anúncios:** "We don't require attribution" (FAQ da Web Search API).
- **[lido] SearXNG (`mojeek.py`):** lê a página HTML (`"use_official_api": False`), **resolve o captcha de prova de trabalho do Mojeek** e usa `curl_cffi`; desligado no `settings.yml`. **Nunca usar esse motor do SearXNG.**

**Revendedores tipo SerpApi (raspam o Google)**

- **[resumo]** O Google processou a SerpApi em 19/12/2025, alegando contorno da proteção do Google ("SearchGuard") e violação dos termos. A SerpApi nega. O estado atual **não foi verificado**.
- [lido na pesquisa anterior, 21/11/2026] O `robots.txt` do Google tem `Disallow: /search` para todos os robôs.

**Google Custom Search JSON API**

- **[lido] (https://developers.google.com/custom-search/v1/overview, lido em 24/11/2026):** "The API offers **100 free queries per day**, with additional queries available for a fee." Mas: "The Custom Search JSON API is **closed to new customers**." "Existing Custom Search JSON API customers have **until January 1, 2027** to transition to an alternative solution." Sugestão: "Vertex AI Search ... for searching **up to 50 domains**". Para a web inteira, só "contact us to express your interest".
- Faltam **pouco mais de 5 semanas** (contadas a partir de 24/11/2026) para o fim para clientes existentes.

**Bing Web Search API**

- **[resumo]** Aposentada em 11/08/2025 (aviso da Microsoft, não lido nesta revisão). O substituto só entrega resposta gerada, não resultados brutos.

### 3. Gratuitas ou sem chave

**Marginalia Search**

- **[lido] Chaves (https://about.marginalia-search.com/article/api, lido em 24/11/2026):**
  - Chave `public`: compartilhada, "for experimentation"; "often hits a rate limit"; "This key has a shared rate limit across all consumers; when the limit is hit, HTTP 503 is returned"; sem filtros próprios.
  - **Gratuita não comercial:** pedida por e-mail (`contact@marginalia-search.com`), "necessary to prevent mass signup abuse"; CC-BY-NC-SA 4.0.
  - **Paga não comercial:** opcional, pagamento único.
  - **Comercial:** "metered commercial key with no commercial usage restriction or attribution requirement". O preço **não foi lido**.
- **[lido] Endpoint:** `https://api2.marginalia-search.com/search?query=...` com cabeçalho `API-Key`. Os endereços `api.marginalia.nu` são "deprecated API", sem funções novas.
- **[lido] Licença:** a documentação da API é CC-BY-NC-SA 4.0; o software é AGPL.
- **[lido] Sobre o projeto:** "independent open source Internet search engine operating out of Sweden"; "bills in the ballpark of $200/month".
- **[lido] SearXNG (`marginalia.py`):** `api2.marginalia-search.com`, `require_api_key: True`, 20 resultados por página, `User-Agent` do próprio SearXNG.
- **[lido] Português:** a API não tem parâmetro de idioma ou de país.

**Wiby**

- **[lido]** O `settings.yml` do SearXNG traz `wiby` como `json_engine` em `https://wiby.me/json/?q={query}&p={pageno}`, desligado por padrão. Termos e documentação: **não encontrados**.

**Mwmbl**

- **[lido]** API JSON sem chave, "little more than an idea together with a proof of concept implementation ... on a small index"; "does not support regions, languages, safe-search or time range".

**Qwant**

- **[lido]** O módulo `qwant.py` do SearXNG: "The API is undocumented but can be reverse engineered by reading the network log"; usa `curl_cffi` com cabeçalhos de navegador. Desligado no `settings.yml`.
- **[resumo]** A política de privacidade fala em "automated activity". Condições gerais de uso **não lidas**.

### 4. SearXNG com outros motores

- **[lido]** Mojeek (raspagem, resolve captcha), Qwant (API não documentada, cabeçalhos de navegador) e DuckDuckGo no `master` (imitação de navegador) dependem do que a regra do Suup proíbe. Marginalia, Brave API, Mwmbl e Wiby usam API ou JSON oficial, os dois primeiros com chave.

## Inferências

- **I1. O captcha do DuckDuckGo é o comportamento esperado, não um defeito.** O bloqueador de robôs olha o `User-Agent`, cabeçalhos e o IP; um cliente que se declara robô é o que ele pega. O SearXNG só passa imitando navegador. Sem declaração oficial.
- **I2. Não existe busca geral gratuita, sem chave, com bons resultados em português.** Marginalia, Mwmbl e Wiby têm índices pequenos, majoritariamente em inglês. Complemento, não substituto.
- **I3. O "grátis" exige cadastro e chave.** Tavily (1000 créditos por mês, sem cartão, [lido]) e Exa (US$ 10 por mês, sem cartão, [lido]) cobrem o uso de uma pessoa. Brave (US$ 5 por mês, [lido]) também, se a conta permitir sem cartão (não lido).
- **I4. Português e Brasil.** Brave (`country`, `search_lang`: parâmetros aparecem nos exemplos [lido], mas os valores aceitos para BR/pt não foram lidos). Mojeek (`rb=BR`, `lb=PT`, [lido] nos nomes; a qualidade não foi medida). Tavily (`country=brazil`, enum por nome, e `language=pt`, [lido]). Exa (`userLocation`, [resumo]). Kagi herda a conta. **Nada disso foi medido.**
- **I5. SerpApi e parecidos estão fora pela regra do Suup.**
- **I6. Google e Bing não são opção:** o Google fecha para clientes existentes em 1/1/2027 e não aceita cliente novo [lido]; a Bing já acabou [resumo].
- **I7. Cache e termos (agora [lido] para a Brave e a Mojeek).** A Brave proíbe cache além do transitório; o cache de 3 h do banco (`web_search_cache`) não cabe nisso. A Mojeek Startup permite cache de **1 hora**. A Tavily, a Exa e a Kagi não tiveram os termos lidos.
- **I8. Custo de 1000 buscas por mês** (sem impostos, sem câmbio): Tavily **grátis** pelo basic (1000 créditos, [lido]); Brave **grátis** com o crédito de US$ 5 ([lido] o preço, [lido] o crédito); Exa **grátis** com US$ 10 por mês ([lido]) se for só Lite (US$ 4 por 1000, o que dá 4 dólares por 1000 sem crédito) ou Auto (US$ 7); Mojeek **cerca de £ 2** pelo Startup; Kagi **US$ 12**; Marginalia **zero** se não comercial; Google 100 por dia para clientes existentes.

## O que não foi verificado

- **Tavily**: preço, termos e docs de parâmetros foram lidos em 24/11/2026. Não lidos: a política de uso aceitável (§3.8 dos termos) e a seção de limites de taxa.
- **Termos completos da Exa, da Kagi e da API da Mojeek**: não lidos.
- **Latência** de todas: nenhum número lido de fonte oficial nesta revisão (a Exa é [resumo]).
- **Qualidade em português e no Brasil**: nada foi medido.
- **Se a Brave exige cartão** para o crédito mensal (a página diz "prepaid credits" e não diz se o cadastro pede cartão).
- **O total de "US$ 20" na página da Brave** (contradiz os US$ 5 por plano).
- **Preço comercial da Marginalia**.
- **Se a Kagi exige assinatura paga** além do saldo.
- **Política de uso aceitável do DuckDuckGo** (linkada nos termos, não lida).
- **Declaração oficial do DuckDuckGo sobre captcha em IP residencial**: não encontrada.
- Estado atual do processo Google contra SerpApi.
- **Nenhuma API foi chamada de verdade**, com chave ou sem: o pedido do dono foi ler páginas oficiais, não consultar APIs.

## Tabela comparativa

Custo em dólar salvo indicação. "1000/mês" é o custo aproximado de 1000 buscas por mês. PT-BR é inferência, não medição.

| Opção | Grátis | 1000/mês | PT-BR | Termos para agente pessoal | Latência | API | Cabe no Suup |
|---|---|---|---|---|---|---|---|
| **Brave Search API** | US$ 5/mês de crédito [lido] | US$ 5 por 1000, zero com o crédito [lido] | `country`, `search_lang` (valores BR/pt não lidos) | **cache só transitório; proibido usar para avaliar ou treinar IA; atribuição opcional** [lido] | não verificada | `GET api.search.brave.com/res/v1/web/search`, `X-Subscription-Token`, JSON [lido] | motor `direct`; **cache desligado para ele**; evals não podem usar seus resultados |
| **Tavily** | 1000 créditos/mês, sem cartão [lido]; 1000 buscas `basic` cabem no grátis | 0 (basic); depois US$ 0,008 por crédito [lido] | `country=brazil` (enum por nome), `language=pt` (ISO 639-1) [lido] | **agente previsto por Agent Key [lido]; "uso interno/empresarial" [lido]; sem cláusula de cache ou atribuição achada; limites de taxa não lidos** | não verificada | `POST`, `Authorization: Bearer`, JSON [lido] | motor `direct`; travar `search_depth=basic` e `auto_parameters=false`; decidir uso pessoal antes |
| **Exa** | US$ 10/mês + US$ 10 de entrada, sem cartão [lido] | Lite US$ 4; Auto US$ 7; Deep US$ 12 [lido] | `userLocation` só viés [resumo] | não lidos | ~0,25 a 1 s (números da Exa, [resumo]) | `Authorization: Bearer` [lido] | motor `direct`, se os termos permitirem; a Lite é a mais barata |
| **Mojeek API** | crédito grátis no Startup, com cartão [lido] | £ 2 por 1000, Startup [lido] | `rb=BR`, `lb=PT` [lido nos nomes] | **API autorizada é o caminho; scraping proibido** [lido]; cache 1 h no Startup | não verificada | `GET .../search?api_key=` [lido] | motor `direct` pela API; **nunca** o motor SearXNG (resolve captcha) |
| **Kagi Search API** | não | US$ 12 por 1000 [lido, repositório] | herda a conta | não lidos | não verificada | `Authorization: Bot`, JSON [lido, repositório] | motor `direct`; a mais cara |
| **Marginalia** | chave `public` (limite compartilhado) ou chave grátis não comercial por e-mail [lido] | zero se não comercial | não tem parâmetro de idioma/país [lido] | não comercial, CC-BY-NC-SA; comercial sem restrição [lido] | não verificada | `GET api2.marginalia-search.com`, `API-Key`, JSON [lido] | motor `direct`, host exato; complemento honesto |
| SerpApi e parecidos | varia | varia | boa (é o Google) | **fere a regra do Suup** | n/a | n/a | **não** |
| Google CSE JSON | 100/dia, só para clientes existentes [lido] | n/a | n/a | **fecha em 1/1/2027; fechada a novos** [lido] | n/a | n/a | **não** |
| Bing Web Search | aposentada [resumo] | n/a | n/a | acabou | n/a | n/a | **não** |
| Mwmbl / Wiby | sem chave | zero | muito fraca [lido] | termos não encontrados | não verificada | JSON simples | só se o dono quiser |
| Qwant | n/a | n/a | n/a | API não documentada, cabeçalhos de navegador [lido] | n/a | n/a | **não** |
| **Firecrawl (MCP ou REST)** | 1000 créditos/mês (cerca de 500 buscas), sem cartão [lido] | 1000 buscas = 2000 créditos, fora do grátis; Hobby US$ 16/mês anual (US$ 19 mensal), 5000 créditos [lido] | `country` ISO (padrão US); sem idioma no `/search`; BR e pt **não verificados** [lido/não verificado] | sem cláusula de uso automatizado nos termos lidos; o site prevê agentes [lido] | não verificada | `POST api.firecrawl.dev/v2/search`, `Authorization: Bearer` [lido]; MCP em `mcp.firecrawl.dev/v2/mcp` [lido] | **não passa por padrão**: `auto` escala para proxy enhanced em 401/403/429; só com `proxy: "basic"` (a confirmar) [lido/não verificado] |
| DuckDuckGo (atual) | sem chave | zero | boa quando responde | **termos lidos não proíbem busca automática**; o bloqueador de robôs e o disfarce de navegador são o problema [lido] | n/a (captcha) | raspagem do HTML | **desligar** |

## Firecrawl (via MCP)

Acesso em **24/11/2026**. Pergunta do dono: o Firecrawl, ligado como conector MCP, serve de busca geral no lugar do DuckDuckGo e da Tavily? Regra do projeto: sem resolver captcha, sem rodízio de IP, sem proxy residencial ou stealth para passar bloqueio, sem `User-Agent` falso, e respeitando `robots.txt`.

### Fontes lidas nesta seção

- Preço e créditos: https://www.firecrawl.dev/pricing (vigência do modelo de créditos: "Effective September 4, 2026").
- Busca: https://docs.firecrawl.dev/features/search.md e https://docs.firecrawl.dev/api-reference/endpoint/search.md
- Proxies e modo enhanced: https://docs.firecrawl.dev/features/proxies.md e https://docs.firecrawl.dev/features/enhanced-mode.md
- Scrape (cache e `location`): https://docs.firecrawl.dev/features/scrape.md
- MCP: https://docs.firecrawl.dev/mcp-server.md, https://docs.firecrawl.dev/mcp-server/keyless.md, https://docs.firecrawl.dev/mcp-server/local.md e https://docs.firecrawl.dev/mcp-server/tools.md
- Repositório do MCP, arquivos raw: https://raw.githubusercontent.com/firecrawl/firecrawl-mcp-server/main/README.md e https://raw.githubusercontent.com/firecrawl/firecrawl-mcp-server/main/LICENSE
- Termos: https://www.firecrawl.dev/terms-of-service
- Núcleo open source, arquivos raw: https://raw.githubusercontent.com/firecrawl/firecrawl/main/LICENSE e https://raw.githubusercontent.com/firecrawl/firecrawl/main/SELF_HOST.md

**Não lidos:** https://github.com/firecrawl/firecrawl-mcp-server e https://github.com/firecrawl/firecrawl/blob/main/LICENSE (proxy recusou com 403 nas duas tentativas, a segunda após espera de 30 s); https://www.firecrawl.dev/terms-of-use (404); política de uso aceitável (não achada nos links lidos); lista de locais https://firecrawl.dev/search_locations.json.

### Fatos

**1. Preço e cota**

- **[lido]** Plano grátis: "1,000 credits every month, refreshed monthly, no credit card required". É cota mensal renovada, não crédito único. O site a traduz como "500 searches or 1,000 pages scraped", com 2 requisições simultâneas e 10 por minuto em `/scrape`, `/map` e `/search`.
- **[lido]** Custo por operação: busca = 2 créditos a cada 10 resultados (de 1 a 10 resultados = 2); scrape = 1 crédito por página; map = 1 por chamada; formatos JSON, Question e Highlight em scrape e crawl somam 4 por página. "A scrape that returns no result is not charged"; página que responde 403 ou 404 cobra 1 crédito.
- **[lido]** Planos (anual / mensal): Hobby US$ 16 / 19 com 5.000 créditos; Standard US$ 83 / 99 com 100.000; Growth US$ 333 / 399 com 500.000; Scale US$ 599 / 749 com 1.000.000. Excedente em plano pago (pay-as-you-go): Hobby, "1,000 extra credits per $5".
- **[lido, conta]** 1.000 buscas por mês (até 10 resultados cada) = 2.000 créditos, acima do grátis (1.000, que cobre cerca de 500 buscas). 1.000 buscas mais 1.000 páginas lidas = 3.000 créditos, que cabem no Hobby (US$ 16 no anual, US$ 19 no mensal). Acima disso, no Hobby, cada 1.000 buscas extras custam cerca de US$ 10.

**2. Busca (`POST https://api.firecrawl.dev/v2/search`)**

- **[lido]** Sem chave, a busca funciona com limite de taxa. Com chave: `Authorization: Bearer fc-...`.
- **[lido]** Resposta padrão: `url`, `title`, `description` e `position`. Os **Highlights** (trechos relevantes para a consulta) vêm por padrão; `highlights: false` troca pela descrição. **O conteúdo da página só vem com `scrapeOptions`** (markdown, html, links, screenshot), cobrado como scrape por resultado.
- **[lido]** País: `country` (código ISO de 2 letras, padrão `US`) e `location` (texto, por exemplo "Germany"). **Não há parâmetro de idioma no `/search`.** `languages` existe só no `location` do `/scrape`, com o padrão "the language of the specified location".
- **[não verificado]** Se `country: "BR"` é aceito no `/search` (BR consta como país de proxy no `/scrape`). Se `location` "Brazil" muda o idioma dos resultados. Qualidade em português.
- **[lido]** Motor: "our upstream search provider", sem nome (texto de ZDR). Qual motor e qual índice: **[não verificado]**. Latência: **[não verificado]**.
- **[lido]** Extras: `sources` (web, news, images), `categories` (research, pdf, developer, gov), `includeDomains` e `excludeDomains`, `timeout`.

**3. Servidor MCP oficial (`firecrawl/firecrawl-mcp-server`)**

- **[lido]** Licença: **MIT** (arquivo LICENSE do próprio repositório). O README cita 34 ferramentas no perfil completo; variáveis como `FIRECRAWL_NO_SEARCH_FEEDBACK=1` reduzem esse número.
- **[lido]** Ferramentas principais: `firecrawl_search`, `firecrawl_scrape`, `firecrawl_map`, `firecrawl_crawl` (e `firecrawl_check_crawl_status`), `firecrawl_interact` (e `_stop`), `firecrawl_agent` (e `_status`), `firecrawl_parse`, `firecrawl_developer_search`, `firecrawl_gov_search`, quatro `firecrawl_research_*`, `firecrawl_monitor_*`, `firecrawl_credit_usage`, `firecrawl_feedback`, `firecrawl_search_feedback`, `firecrawl_find_tools`, `firecrawl_save_skill`.
- **[lido]** Autenticação, três caminhos: (a) sem chave, `https://mcp.firecrawl.dev/v2/mcp`, com limite e só `scrape`, `search` e `parse`; (b) login OAuth no navegador, `https://mcp.firecrawl.dev/v2/mcp-oauth`; (c) chave em cabeçalho, `Authorization: Bearer <chave>` em `https://mcp.firecrawl.dev/v2/mcp`. O README diz: "Never put an API key in the server URL."
- **[lido]** Local ou remoto: local por stdio com `env FIRECRAWL_API_KEY=... npx -y firecrawl-mcp` (a chave vem do ambiente), por imagem Docker `ghcr.io/firecrawl/firecrawl-mcp-server`, ou por HTTP local em `http://localhost:3000/mcp` com `HTTP_STREAMABLE_SERVER=true`. Remoto e hospedado: `https://mcp.firecrawl.dev/v2/mcp`.
- **[lido]** Endpoint só de busca: `https://mcp.firecrawl.dev/v2/mcp-search`, com 12 ferramentas fixas; o `firecrawl_search` dele não traz conteúdo de página.
- **[não verificado]** Se as ferramentas MCP aceitam `proxy` e `location` por chamada: a página de ferramentas não mostra o esquema de parâmetros.

**4. Proteção contra bloqueio (a regra)**

- **[lido]** "By default, Firecrawl routes all requests through proxies ... even if you do not specify a proxy type or location." O padrão é `proxy: "auto"`.
- **[lido]** `auto`: "Firecrawl will automatically retry scraping with enhanced proxies if the basic proxy fails." Se o site responde **401, 403 ou 429**, o Firecrawl repete a mesma URL por proxies enhanced, no máximo uma vez por requisição (enhanced-mode.md). **Isso é troca de proxy para passar por bloqueio, o que a regra do Suup proíbe, e vem ligado por padrão.**
- **[lido]** `proxy: "basic"` é valor aceito. A documentação diz que a escalada começa no básico e que o padrão é `auto`, mas **não diz que `basic` desliga a escalada**. **[não verificado]**: precisa de teste.
- **[lido]** O parâmetro `proxy` está **depreciado** ("We recommend `auto`"). Pode mudar ou sumir.
- **[lido]** A palavra "stealth" não aparece em nenhuma página lida. O modo "enhanced" é descrito como "for scraping complex sites while maintaining privacy", sem dizer se é residencial. **[não verificado]**.
- **[lido]** Mesmo em `basic`, as requisições passam por proxies. Se proxy comum é aceitável pela regra, é decisão do dono.
- **[não verificado] robots.txt:** nenhuma página lida menciona `robots.txt` nem oferece opção para obedecê-lo ou forçá-lo. Não dá para garantir que o Firecrawl o respeite.
- **[não verificado] Motor upstream da busca:** sem nome. Não dá para saber se ele raspa buscadores ou contorna proteções. É o ponto mais fraco da regra.
- **[lido]** Cache: `maxAge` padrão de 2 dias; `storeInCache: false` desliga o armazenamento; `maxAge: 0` pula o cache. Resultado de cache também cobra 1 crédito por página.

**5. Termos (https://www.firecrawl.dev/terms-of-service)**

- **[lido]** Os termos lidos não proíbem uso automatizado nem por agente. A lista de atividades proibidas (§5.d) trata de uso comercial não autorizado, reprodução de partes dos Serviços, obras derivadas, fraude e temas semelhantes, sem citar rastreamento nem automação.
- **[lido]** O site diz: "If you are an AI agent, LLM, or automated system, use the Firecrawl ..." e oferece plano sem chave para agentes. Uso por agente é previsto.
- **[lido]** Nos termos lidos, não há limite de cache ou de armazenamento de resultados nem exigência de atribuição. A retenção fica nas opções da API (`storeInCache`). A retenção zero (ZDR) é só do plano Enterprise, segundo a página de preços.
- **[lido]** §8.c: o Firecrawl não garante conteúdo de terceiros. §9: dados de terceiros (catálogo Alexandria) seguem termos próprios.
- **[não verificado]** Política de uso aceitável; data de vigência dos termos; termos próprios do MCP; a página `terms-of-use` (404).

**6. Self-hosting**

- **[lido]** Núcleo `firecrawl/firecrawl`: **AGPL-3.0**. MCP: **MIT**.
- **[lido]** `SELF_HOST.md`: a raspagem usa Playwright embutido com fallback de fetch básico; um motor separado, como o Fire-engine, só se precisar. Os recursos de IA não têm provedor e exigem OpenAI, endpoint compatível ou Ollama. O painel da fila vem desligado. O guia não menciona proxies gerenciados.
- **[não verificado]** Se o `/search` funciona no self-host e de onde vem o índice; se o modo `auto` com escalada existe no self-host; latência.
- **[lido]** O MCP pode apontar para uma API própria com `FIRECRAWL_API_URL`.

### Comparação com Tavily e Brave

| | Firecrawl | Tavily | Brave |
|---|---|---|---|
| Grátis | 1000 créditos/mês (cerca de 500 buscas), sem cartão [lido] | 1000 créditos/mês, sem cartão [lido] | US$ 5/mês de crédito [lido] |
| 1000 buscas/mês | 2000 créditos, fora do grátis. Hobby US$ 16/mês anual (US$ 19 mensal), que cobre também 1000 páginas [lido] | 0 em `basic` (1 crédito por busca) [lido]; `advanced` seria 2000 × US$ 0,008 = US$ 16 [lido] | US$ 5 por 1000, zero com o crédito mensal [lido] |
| Cota e limite | 10/min em `/search` no grátis; 100/min no Standard [lido] | 1000 créditos/mês; depois US$ 0,008 por crédito [lido] | 50 consultas/s no plano Search [lido, revisão anterior] |
| Cache | 2 dias por padrão em scrape [lido] | nenhuma cláusula achada nos termos lidos [lido] | só transitório [lido] |
| Regra do projeto | **Não passa por padrão**: `auto` troca para proxy enhanced em 401/403/429. Passa só com `proxy: "basic"` (a confirmar) e se o motor upstream for limpo (não verificado) | Nas quatro páginas lidas, nenhuma menção a proxy ou escalada; política de uso aceitável não lida [não verificado] | API oficial com chave; termos proíbem contornar limites de taxa [lido]; nenhum mecanismo de proxy na documentação lida |

**MCP ou integração direta.**

- **MCP:** entra como conector pronto, já que o Suup suporta MCP. Dá 34 ferramentas (crawl, interação, agente), e não só busca. Em modo local, a chave vem de variável de ambiente. Pelo que o próprio documento descreve, os motores diretos passam pelo `EgressProxy`, com limite e cache próprios; um conector MCP ficaria fora desse caminho. **[inferência; o código não foi conferido]**.
- **Integração direta (`POST /v2/search`):** mesmo custo, um só endpoint, chave em cabeçalho, país controlável, sem as ferramentas extras. Exige um adaptador, como os motores diretos atuais.

**Conclusão desta seção.** Pelo padrão, o Firecrawl **viola a regra**, porque troca de proxy quando o site bloqueia. Só serve com `proxy: "basic"` confirmado por teste, desligado por padrão, e com a decisão do dono sobre proxies básicos e sobre o motor upstream. Para 1000 buscas por mês, custa US$ 16 a 19 ao mês; Tavily `basic` e Brave cabem no grátis.

### Não verificado (resumo desta seção)

- Latência; motor e índice do `/search`; qualidade em português.
- `country: "BR"` e idioma no `/search`.
- Se `proxy: "basic"` desliga a escalada.
- Se as ferramentas MCP aceitam `proxy` e `location` por chamada.
- Menção a robots.txt (não há nas páginas lidas).
- Política de uso aceitável; vigência dos termos; termos do MCP.
- Se o `/search` roda no self-host.
- Se o modo "enhanced" usa IP residencial.

## Implicação para o Suup

### Como uma API paga cabe no desenho atual

- **Mesmo caminho dos motores diretos.** Cada uma vira uma entrada em `packages/web/src/engines.ts` com `via: "direct"`, `access: "api"`, `general: true`, `defaultOn: false` e os hosts exatos: `api.search.brave.com`, `api2.marginalia-search.com`, `kagi.com` (fonte [lido]), `api.exa.ai` e `api.mojeek.com` ou o host que a documentação indicar (**não confirmados**; a Tavily fica fora). O `EgressProxy` em `127.0.0.1` deixa passar só esses hosts, com TLS e sem redirecionamento. O `User-Agent` honesto continua o mesmo.
- **Chave: mudança de desenho, decisão do dono.** O BUSCA.md diz que os motores diretos saem "sem credencial". Uma API paga leva a chave num **cabeçalho**, nunca na URL: `X-Subscription-Token` (Brave), `Authorization: Bearer` (Exa), `Authorization: Bot` (Kagi), `API-Key` (Marginalia). A Mojeek recebe `api_key` na URL, o que é uma exceção a evitar: o ideal é confirmar se aceita cabeçalho. A chave vem **só** de `apiKeyEnv` ou do cofre; nunca no `suup.config.json`, nunca no chat. Sem a variável, o motor aparece como "sem chave" em `suup doctor` e fica fora da busca (falha fechada).
- **Limites.** Os limites por minuto que já existem servem. A Brave declara 50 consultas por segundo no plano Search [lido]; a Mojeek Startup, 5 por segundo [lido]. **Falta um teto mensal por motor** (orçamento): por exemplo `perMonth`, contado no banco, que suspende o motor quando chega e diz até quando. HTTP 429 e 402/403 de cota entram na suspensão que já existe.
- **Cache.** Para a **Brave**, cache de 3 h no banco **não cabe** nos termos lidos: o motor precisa declarar cache desligado (ou transitório), e o dono precisa dizer se "transient storage required for operation" cobre um cache de 3 h. Para a **Mojeek Startup**, o limite é 1 hora [lido]. Para a Tavily, a Exa e a Kagi, os termos **não foram lidos**: não há base para cache longo.
- **Evals.** Pelos termos da Brave, resultados dela **não podem alimentar avaliações** de modelos. Isso vale para `evals/`. Se o Suup usar a Brave, as avaliações têm de ignorar esse motor ou ter uma exceção contratual.
- **SearXNG.** Nenhuma das opções recomendadas precisa do SearXNG. Se o DuckDuckGo sair, o contêiner de busca deixa de ser necessário no padrão. Mojeek e Qwant no SearXNG ferem a regra.
- **Regra da pesquisa antes do código.** Antes de cada módulo: ler a documentação e os termos do serviço escolhido. Para a Tavily, falta ler a política de uso aceitável e os limites de taxa; para a Exa, os termos.

### Recomendação

1. **Sem custo:** Wikipédia, arXiv, Stack Overflow **mais Marginalia** (chave gratuita por e-mail para uso não comercial). **A Tavily volta como segunda opção gratuita**, com preço e termos agora lidos: 1000 buscas `basic` por mês sem cartão, agente previsto por Agent Key, `country=brazil` e `language=pt`. **Condição:** o termo "solely for Customer's internal business purposes" precisa de decisão do dono antes de usar para uso pessoal, e a política de uso aceitável ainda não foi lida. Dizer na ferramenta e na tela que **isso não é uma busca geral boa em português**.
2. **Pagar pouco:** **Brave Search API** continua a melhor opção com termos lidos: US$ 5 por 1000 com crédito de US$ 5 por mês, sem atribuição obrigatória, índice próprio e parâmetros de país e idioma. Condições: **cache desligado ou transitório** e **resultados fora de avaliações de IA**, que são exigências dos termos. Alternativas: Mojeek Startup (£ 2 por 1000, cache de 1 hora, API autorizada, português possível via `lb`), e Exa Lite (US$ 4 por 1000, após ler os termos).
3. **DuckDuckGo: desligar por padrão** (`defaultOn: false`) e, de preferência, tirar da lista. Corrigido: os termos lidos **não** proíbem busca automática; o motivo é o bloqueador de robôs e o disfarce de navegador que o SearXNG usa para passar, o que o Suup não faz (I1). Mantê-lo ligado só gera "busca indisponível" e suspensão a cada tentativa.

Isto muda o plano (BUSCA.md: "duckduckgo ligado por decisão do dono" e "o Suup não traz adaptadores de Brave, Tavily nem Exa"). **O dono decide** antes de qualquer código: (a) tirar ou desligar o DuckDuckGo, (b) aceitar motores com chave no núcleo, opcionais e desligados por padrão, (c) quais entram primeiro, (d) se a Brave aceita cache transitório de 3 h e se as avaliações `evals/` podem usar resultados dela.

## Adendo de 24/11/2026: o que mudou em relação à nota anterior

- **[resumo] virou [lido]** nestes pontos: preço da Brave (US$ 5 por 1000, crédito de US$ 5 por mês); termos da Brave sobre cache, IA e atribuição; preço da Exa (planos Lite, Auto e Deep, e crédito de US$ 10 por mês); crédito da Tavily (1000 por mês, sem cartão); Google (fechado a novos, fim em 1/1/2027, 100 por dia para clientes existentes); termos do DuckDuckGo (lidos, sem cláusula de busca automática); planos, cache e parâmetros da Mojeek; chaves e preço não comercial da Marginalia.
- **Corrigido:** a Brave **não** vincula o crédito à atribuição (é opcional nos termos). A Exa **não** tem "US$ 20 no cadastro": são US$ 10 por mês mais US$ 10 de bônus. A Mojeek **não** tem teste "a pedido": o crédito vem ao abrir conta no Startup, com cartão. A Exa **tem** uma opção mais barata (Lite, US$ 4 por 1000) que a nota anterior não citava.
- **Mudou a recomendação:** a Tavily saiu do "caminho recomendado" porque o preço e os termos não puderam ser lidos. A Brave ficou com termos mais restritivos do que a nota dizia (cache transitório, sem avaliações de IA). A Mojeek Startup passou a ser alternativa concreta (cache de 1 hora).
- **Corrigido:** a nota dizia que a maioria dos hosts estava bloqueada por DNS. Nesta revisão, quase todos abriram. Só `www.tavily.com` foi recusado pela proxy.
- **Corrigido:** a nota citava `arc` como parâmetro da Mojeek. A documentação oficial lista `rb` e `lb`.
- **Corrigido:** a nota citava os termos de "automated querying" como se fossem do DuckDuckGo. Eles são do Duck.ai.
- **Tavily (leitura de 24/11/2026, após a liberação de `www.tavily.com`):** preço e grátis agora [lido]: 1000 créditos por mês, sem cartão; US$ 0,008 por crédito depois. Recomendação: a Tavily volta como segunda opção gratuita, com a condição de uso interno dos termos. **Corrigido:** o país da Tavily é um enum por nome (`brazil`), não código ISO de duas letras. O idioma é ISO 639-1 (`pt`).
