# Pesquisa: alternativas legítimas ao DuckDuckGo para a busca geral na web

Data da pesquisa: 24/11/2026. Complementa [fase-4-busca-na-web.md](fase-4-busca-na-web.md) e [fase-4-busca-apis-diretas.md](fase-4-busca-apis-diretas.md); o desenho atual está em [BUSCA.md](../BUSCA.md).

Contexto: no computador do dono (Windows, conexão residencial no Brasil), o DuckDuckGo (`html.duckduckgo.com`, pelo SearXNG, com o `User-Agent` honesto `SuupBot/...`) responde com captcha a quase toda consulta. A busca geral fica fora do ar; só a Wikipédia, o arXiv e o Stack Overflow respondem, pelas APIs oficiais.

## Pergunta

Quais são os jeitos **legítimos** (sem resolver captcha, sem rodízio de IP, sem disfarce de navegador, respeitando `robots.txt` e termos) de o Suup ter uma busca geral na web confiável, quanto custa cada um (plano gratuito e cerca de 1000 buscas por mês), como se sai em português e no Brasil, o que os termos permitem para um agente pessoal, qual a latência, qual o formato da API e como cada um cabe no desenho de motores diretos do Suup (`EgressProxy`, limites, cache)? E o DuckDuckGo deve continuar?

## Fontes

Acesso a todas em **24/11/2026**. Nesta máquina quase todo host é bloqueado (falha de DNS): `brave.com`, `www.tavily.com`, `exa.ai`, `help.kagi.com`, `www.mojeek.com` e `developers.google.com` foram tentados e **não abriram**. Só `raw.githubusercontent.com` respondeu. Por isso há **dois níveis de fonte**, e cada fato abaixo diz de qual veio:

- **[lido]**: texto original lido por inteiro (repositórios oficiais no GitHub, via `raw.githubusercontent.com`).
- **[resumo]**: página **oficial** (documentação, preços, termos do próprio serviço) que apareceu na ferramenta de busca, mas que **não foi aberta**: o que se tem é o resumo que a ferramenta fez dela. É mais fraco que [lido]; os números devem ser conferidos na página antes de cobrar o usuário ou escrever código. Resumos de páginas de terceiros (blogs, agregadores) **não entram** como fato.

### [lido] Repositórios oficiais

- Kagi, documentação oficial (fonte de `help.kagi.com`), repositório `kagisearch/kagi-docs`, ramo `main`:
  - "Quick Start" da API: https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/overview.md
  - "Search API": https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/search.md
  - "API Portal": https://raw.githubusercontent.com/kagisearch/kagi-docs/main/docs/kagi/api/api-portal.md
- SearXNG, módulos de motor e configuração padrão, ramo `master`:
  - `searx/engines/duckduckgo.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/duckduckgo.py
  - `searx/engines/mojeek.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/mojeek.py
  - `searx/engines/qwant.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/qwant.py
  - `searx/engines/marginalia.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/marginalia.py
  - `searx/engines/braveapi.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/braveapi.py
  - `searx/engines/mwmbl.py`: https://raw.githubusercontent.com/searxng/searxng/master/searx/engines/mwmbl.py
  - `searx/settings.yml`: https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml
- SearXNG, `searx/engines/duckduckgo.py` **na versão fixada pelo Suup** (commit `541c6c3cb`): https://raw.githubusercontent.com/searxng/searxng/541c6c3cb/searx/engines/duckduckgo.py
- Marginalia Search, modelo da resposta da API (`ApiSearchResults.java`): https://raw.githubusercontent.com/MarginaliaSearch/MarginaliaSearch/master/code/services-application/api-service/java/nu/marginalia/api/model/ApiSearchResults.java

### [resumo] Páginas oficiais vistas só pelo resumo da busca

- Brave: documentação de preços, https://api-dashboard.search.brave.com/documentation/pricing ; planos, https://api-dashboard.search.brave.com/app/plans?tab=normal ; parâmetros da busca web, https://api-dashboard.search.brave.com/app/documentation/web-search/query ; termos de serviço, https://api-dashboard.search.brave.com/terms-of-service ; página do produto, https://brave.com/search/api
- Tavily: créditos da API, https://docs.tavily.com/documentation/api-credits ; referência do endpoint de busca, https://docs.tavily.com/api-reference/endpoint/search ; boas práticas, https://docs.tavily.com/documentation/best-practices/best-practices-search
- Exa: preços, https://exa.ai/docs/reference/pricing e https://exa.ai/pricing ; tipos de busca e latência, https://exa.ai/docs/changelog/new-fast-search-type e https://exa.ai/blog/fastest-search-api ; filtro de localização, https://exa.ai/docs/changelog/geolocation-filter-support
- Kagi: preços da API, https://kagi.com/api/pricing
- Mojeek: Web Search API, https://www.mojeek.com/services/search/web-search-api/ ; planos da API, https://www.mojeek.com/services/api.html ; termos do site, https://mojeek.com/about/terms.html ; termos de anúncios, https://www.mojeek.com/ads/terms/
- Marginalia: documentação da API, https://about.marginalia-search.com/article/api
- Google: visão geral da Custom Search JSON API, https://developers.google.com/custom-search/v1/overview ; blog oficial do Programmable Search Engine, https://programmablesearchengine.googleblog.com/2026/ ; blog do Google sobre o processo contra a SerpApi (19/12/2025), https://blog.google/technology/safety-security/serpapi-lawsuit/
- Microsoft: aviso de aposentadoria das Bing Search APIs, https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- DuckDuckGo: termos, https://duckduckgo.com/terms ; política de uso aceitável, https://duckduckgo.com/acceptable-use ; termos do Duck.ai, https://duckduckgo.com/duckai/privacy-terms ; ajuda sobre respostas instantâneas, https://duckduckgo.com/duckduckgo-help-pages/features/instant-answers-and-other-features
- Qwant: páginas legais, https://about.qwant.com/en/legal/confidentialite/

## Fatos verificados

### 1. DuckDuckGo

- **[lido] O próprio módulo do SearXNG descreve um "bot blocker".** Na versão fixada (`541c6c3cb`) e no `master`: o `User-Agent` "is generated by the WEB-client and are checked by DDG's bot blocker"; "it is possible that certain UA headers (such as curl) are filtered"; "In DDG's bot blocker, the IP will be blocked (DDG does not have a client session!)"; houve "changes to the bot blocker in the period of Q3/Q4 2025: in the past, the IP blocking was implemented as a 'sliding window' (unblock after about 1 hour without requests from this IP)". Os campos do formulário são "reverse-engineered from DDG-html and may be subject to additional bot detection mechanisms".
- **[lido] O `master` do SearXNG passou a se disfarçar de navegador** para o DuckDuckGo: `params["impersonate"] = "firefox"` (biblioteca `curl_cffi`, que imita a impressão digital TLS de um navegador), mais `Sec-Fetch-*` e `Referer` "to simulate the behavior of a real browser session". A versão fixada ainda usa `_HTTP_User_Agent` (que o Suup troca pelo nome honesto), sem `impersonate`.
- **[lido]** Ao ver o captcha, o módulo levanta `SearxEngineCaptchaException(suspended_time=0, ...)` (comentário: "set suspend time to zero is OK --> ddg does not block the IP").
- **[resumo] Termos.** Os termos do DuckDuckGo mandam seguir a política de uso aceitável; o trecho visto da política fala de invadir, embutir os serviços em outros e interferir na integridade ou no desempenho, sem citar busca automática. Os termos do **Duck.ai** proíbem "automated querying" e contornar limites de ritmo, mas valem para o Duck.ai. O texto inteiro dos termos e da política **não foi lido**.
- **[resumo] API oficial.** A ajuda do DuckDuckGo descreve as "Instant Answers" como respostas mostradas acima dos resultados. Nenhuma página oficial de uma API de **resultados web** foi encontrada. (Que a API de respostas instantâneas não devolve a lista de links vem de fontes de terceiros, não da página oficial.)
- **Declaração oficial sobre captcha em IP residencial: não encontrada.** As páginas oficiais achadas sobre robôs tratam só dos rastreadores do próprio DuckDuckGo (DuckDuckBot, DuckAssistBot).

### 2. APIs de busca pagas (com chave)

**Brave Search API**

- **[resumo] Preço:** a documentação de preços lista **US$ 5,00 por 1000 pedidos** para a busca, com **US$ 5 de crédito grátis por mês** (cerca de 1000 buscas). Uma página antiga da documentação ainda mostra um plano "Free" de 2000 pedidos por mês a 1 pedido por segundo; o painel atual não. O crédito mensal é vinculado a **dar atribuição** à Brave (resumo de notícia, não da página oficial).
- **[resumo] Formato:** `GET https://api.search.brave.com/res/v1/web/search`, chave no cabeçalho `X-Subscription-Token`, parâmetros `q`, `country` (código de 2 letras), `search_lang` (padrão `en`, "two or more characters").
- **[lido]** O módulo `braveapi.py` do SearXNG confirma o host `api.search.brave.com/res/v1/web/search`, paginação (`offset`, até 10 páginas), `safesearch` (`strict`/`moderate`/`off`) e filtro de tempo (`past_day`, `past_week`, `past_month`, `past_year`), resposta JSON, até 20 resultados por página.
- **[resumo] Termos:** "Customer shall not ... store, cache, or create a database of Search Results, in whole or in part, other than transient storage required for operation of Customer Applications". Há planos distintos para busca e para uso com IA ("Data for AI"), e planos com "storage rights" à parte. A regra exata sobre "AI inference" no plano comum **não foi lida** (só resumo de terceiro).

**Tavily**

- **[resumo] Preço:** **1000 créditos por mês grátis, sem cartão**; depois, **US$ 0,008 por crédito** (pague pelo uso). Busca `basic`, `fast` e `ultra-fast`: 1 crédito; `advanced`: 2 créditos. Há planos mensais (por exemplo US$ 30 por 4000 créditos), com nomes que variam entre as páginas.
- **[resumo] Formato:** `POST` no endpoint de busca, chave por `Authorization: Bearer`; parâmetros `query`, `search_depth` (`basic` padrão, `advanced`, `fast`, `ultra-fast`), `country` (código ISO de 2 letras; "boost search results from a specific country", só com `topic` geral), `max_results`. `auto_parameters` pode subir sozinho para `advanced` (2 créditos).
- **[resumo] Latência:** a documentação só diz, qualitativamente, que `advanced` troca latência por relevância e que `ultra-fast` "minimizes latency above all else". Nenhum número oficial.

**Exa**

- **[resumo] Preço:** pague pelo uso, sem assinatura; busca comum **US$ 7 por 1000 pedidos** (até 10 resultados; cada resultado além de 10 custa US$ 1 por 1000). Crédito gratuito: as páginas oficiais divergem (**US$ 10** no cadastro e por mês, ou **US$ 20** no cadastro e US$ 10 por mês).
- **[resumo] Latência (números da própria Exa):** `instant` cerca de 250 ms, `fast` cerca de 450 ms (lançamento: p50 abaixo de 425 ms; depois, "lower than 350ms" medido a partir de `us-west-2`), `auto` cerca de 1 s; os modos `deep` levam de segundos a dezenas de segundos.
- **[resumo] Brasil:** `userLocation` com código de país de 2 letras ("BR") "to bias results toward a user's geographic region". Nenhum parâmetro de idioma foi visto.

**Kagi Search API**

- **[lido] Preço e acesso:** "The Kagi Search API is priced at **$12 per 1,000 queries** ($0.012 per search)." Passos: criar conta Kagi (o link é de teste, `plan_id=trial`), gerar o token em `kagi.com/api`, pôr saldo. (overview.md)
- **[lido] Formato:** `GET https://kagi.com/api/v1/search?q=...` com `Authorization: Bot <token>`; também aparece um exemplo `POST` com JSON `{"query": ...}` e `Authorization: Bearer`. "The Search API inherits settings from your account" (sites bloqueados ou promovidos, tamanho do trecho). Há uma API v0 legada. (overview.md, search.md)
- **[resumo]** Uma página antiga da ajuda dizia "closed beta", só para o plano Team, a US$ 0,025 por busca; a documentação atual (lida) não fala em beta nem em convite.
- Se é preciso **assinatura** Kagi paga além do saldo da API: **não verificado**.

**Mojeek Web Search API**

- **[resumo] Preço:** planos em libras por 1000 pedidos: **Startup £2/1000** (até 100 000 por dia, 5 por segundo) e **Business £3/1000** (até 400 000 por dia, 10 por segundo); Enterprise sob consulta. A página da Web Search API fala em "Flexible Terms" e num teste gratuito "with limited queries", sem cota publicada, pedido ao comercial.
- **[resumo] Termos do site:** fazer raspagem dos serviços "without Our prior consent is expressly prohibited"; os termos de anúncios proíbem acesso automatizado "unless you are an authorised Mojeek API user". Há termos próprios da API, **não lidos**.
- **[lido]** O módulo `mojeek.py` do SearXNG (`master`) lê a página HTML (`"use_official_api": False`), **resolve o captcha de prova de trabalho do Mojeek** (`solve_altcha`, rota `/captcha/challenge` e `/captcha/verify`, "Cache for storing the auth cookie after solving the CAPTCHA") e usa `curl_cffi`. O `settings.yml` o deixa `inactive: true` ("uses a Proof of Work CAPTCHA that requires much computer power to solve"). A documentação da API oficial apontada no módulo é `https://www.mojeek.com/support/api/search/request_parameters.html` (não aberta). Parâmetros de idioma e região usados pelo módulo: `lb` e `arc`.

**Revendedores tipo SerpApi (raspam o Google)**

- **[resumo]** O Google processou a SerpApi em 19/12/2025 (Google LLC v. SerpApi, LLC, 5:25-cv-10826, N.D. Califórnia), alegando que ela contorna a proteção do Google ("SearchGuard") com consultas falsas, com base nas regras anticircunvenção da DMCA, e viola os termos do Google, que proíbem raspagem automatizada e proxies para esconder a identidade. A SerpApi nega. O estado atual do processo **não foi verificado**.
- [lido na pesquisa anterior, 21/11/2026] O `robots.txt` do Google tem `Disallow: /search` para todos os robôs.

**Google Custom Search JSON API**

- **[resumo]** A página de visão geral diz que a API está **fechada para novos clientes** e será **descontinuada em 1/1/2027**. O substituto sugerido (Vertex AI Search, agora renomeado "Agent Search") cobre **até 50 domínios**, não a web inteira; para a web inteira o Google não oferece opção de autoatendimento, só um formulário de interesse.

**Bing Web Search API**

- **[resumo]** As Bing Search APIs (v7, incluindo Custom Search) foram **aposentadas em 11/08/2025**. O substituto indicado, "Grounding with Bing Search", só existe dentro dos agentes do Azure AI e **não entrega os resultados brutos** ao desenvolvedor, só a resposta gerada pelo modelo; a consulta sai da fronteira de conformidade do Azure.

### 3. Gratuitas ou sem chave

**Marginalia Search**

- **[resumo] Acesso:** há uma chave compartilhada **`public`** para experimentar, que "often hits a rate limit" (devolve HTTP 503 quando estoura) e não aceita filtros próprios. Uma **chave própria gratuita para uso não comercial** é pedida por e-mail ("to prevent mass signup abuse"); só o uso comercial é pago. Base atual `api2.marginalia-search.com`, chave no cabeçalho `API-Key`; os endereços antigos de `api.marginalia.nu` continuam, sem funções novas. A documentação da API é CC-BY-NC-SA 4.0; o software é AGPL.
- **[lido]** O módulo `marginalia.py` do SearXNG usa `https://api2.marginalia-search.com`, `"use_official_api": True`, `"require_api_key": True`, 20 resultados por página, paginação e `nsfw`, e manda o `User-Agent` do próprio SearXNG (`searxng_useragent()`), não um navegador. Categorias `general` e `blogs`. A resposta (`ApiSearchResults.java`) tem `license`, `query`, `page`, `pages` e `results` (cada um com `url`, `title`, `description`, `quality`, `format`, `details`).
- **[lido]** Marginalia é um buscador "independent open source ... operating out of Sweden" (docstring do módulo).

**Wiby**

- **[lido]** O `settings.yml` do SearXNG traz `wiby` como `json_engine` em `https://wiby.me/json/?q={query}&p={pageno}` (campos `URL`, `Title`, `Snippet`), desligado por padrão. Termos e documentação do Wiby: **não encontrados**.

**Mwmbl**

- **[lido]** O módulo `mwmbl.py` do SearXNG: API JSON sem chave (`"use_official_api": True`, `"require_api_key": False`), e o aviso: "At the moment it is little more than an idea together with a proof of concept implementation ... on a small index"; "does not support regions, languages, safe-search or time range".

**Qwant**

- **[lido]** O módulo `qwant.py` do SearXNG: "uses the Qwant API (https://api.qwant.com/v3) ... The API is undocumented but can be reverse engineered by reading the network log of https://www.qwant.com/ queries"; `"official_api_documentation": None`; usa `curl_cffi` com a ordem de cabeçalhos de um navegador ("drop impersonate default headers"). Desligado no `settings.yml`.
- **[resumo]** A política de privacidade da Qwant diz que trata as consultas para, entre outras coisas, detectar spam e "automated activity". As condições gerais de uso **não foram lidas**; nenhuma API pública documentada foi encontrada.

### 4. SearXNG com outros motores (os termos dos motores)

- **[lido]** Dos motores gerais do SearXNG olhados: **Mojeek** (raspagem, resolve captcha), **Qwant** (API não documentada, cabeçalhos de navegador) e **DuckDuckGo** no `master` (imitação de navegador) dependem exatamente do que a regra do Suup proíbe. **Marginalia**, **Brave API**, **Mwmbl** e **Wiby** usam API ou JSON oficial, os dois primeiros com chave.

## Inferências

Marcadas como inferência: concluídas dos fatos acima, não lidas em fonte.

- **I1. O captcha do DuckDuckGo é o comportamento esperado, não um defeito.** O módulo do SearXNG descreve um bloqueador de robôs que olha o `User-Agent`, cabeçalhos de navegador e o IP, e o `master` passou a imitar o Firefox para passar por ele. Um cliente que **se declara robô** é justamente o que esse bloqueador pega; o IP residencial não ajuda. Não há declaração oficial dizendo isso, mas não há caminho honesto para melhorar: tudo o que o SearXNG faz para passar é o que o Suup proíbe.
- **I2. Não existe busca geral gratuita, sem chave e com bons resultados em português.** As opções sem chave ou de chave gratuita com termos claros (Marginalia, Mwmbl, Wiby) têm índices pequenos e voltados à "web independente", majoritariamente em inglês; para "notícia de hoje no Brasil" ou "preço de X no Brasil" elas quase não ajudam. Servem como complemento honesto, não como substituto do Google.
- **I3. O "grátis" que existe exige cadastro e chave.** Tavily (1000 créditos por mês, sem cartão) e Brave (US$ 5 de crédito por mês, cerca de 1000 buscas, com atribuição e cadastro de pagamento) cobrem bem o uso de uma pessoa, desde que ela crie conta.
- **I4. Português e Brasil.** Brave (`country=BR`, `search_lang=pt-br` ou `pt`), Tavily (`country=br`, só realce), Exa (`userLocation: "BR"`, só viés) e Mojeek (`lb`, `arc`) têm alguma alavanca de região ou idioma; Kagi herda o que a conta configurou. A Brave tem índice próprio grande e parâmetro de idioma explícito, e deve ser a melhor em português entre as baratas; Mojeek tem índice próprio britânico e deve ser a mais fraca entre as pagas em português. **Nada disso foi medido.**
- **I5. SerpApi e parecidos estão fora pela regra do Suup**, não só por risco jurídico: pagar alguém para contornar a proteção do Google é terceirizar o que o Suup se recusa a fazer.
- **I6. Google e Bing não são opção**: um some em 1/1/2027 e já não aceita cliente novo; o outro já acabou e o substituto não devolve resultados.
- **I7. O cache do Suup e os termos da Brave.** O cache de 3 h no banco (`web_search_cache`) não parece "transient storage required for operation" e pode bater no texto dos termos da Brave. As outras (Tavily, Exa, Kagi) não tiveram os termos lidos sobre isso.
- **I8. Custo de 1000 buscas por mês** (preços acima, sem impostos, sem câmbio): Tavily **grátis** (basic) ou cerca de US$ 8 além da cota; Brave **cerca de zero** com o crédito de US$ 5, cerca de US$ 5 sem ele; Mojeek **cerca de £2**, se aceitarem conta pequena; Exa **cerca de US$ 7**, ou zero enquanto durar o crédito gratuito; Kagi **US$ 12**; Marginalia, Mwmbl, Wiby **zero**.

## O que não foi verificado

- Nenhuma página de preço, termo ou documentação de Brave, Tavily, Exa, Mojeek, Marginalia, Google, Microsoft, DuckDuckGo ou Qwant foi **aberta**: host bloqueado nesta máquina. Tudo marcado [resumo] precisa ser conferido na página antes de virar código ou promessa ao usuário.
- **Termos de uso para agente de IA pessoal**: os termos completos de Tavily, Exa, Kagi e da API do Mojeek **não foram lidos**; o da Brave só em trecho (cache), sem a regra de "AI inference" no plano comum.
- **Latência** de Brave, Tavily, Kagi, Mojeek e Marginalia: nenhum número oficial lido. A da Exa é a que a própria Exa publica, medida nos EUA; do Brasil deve ser maior.
- **Qualidade em português e no Brasil**: nada foi medido; tudo é inferência (I4).
- Endpoint exato e formato da API do Mojeek; se o teste gratuito existe para pessoa física.
- Se a Kagi exige assinatura paga além do saldo da API.
- Se a Brave exige cartão para o crédito mensal e como a atribuição tem de aparecer num app de desktop.
- Termos e `robots.txt` do Wiby e do Mwmbl; condições gerais de uso da Qwant; termos completos e política de uso aceitável do DuckDuckGo.
- Qualquer declaração oficial do DuckDuckGo sobre captcha para IP residencial: **não encontrada**.
- Estado atual do processo Google contra SerpApi.
- Nenhuma API foi chamada de verdade (nem a do DuckDuckGo): esta máquina não alcança os hosts.

## Tabela comparativa

Custo em dólar salvo indicação; "1000/mês" é o custo aproximado de 1000 buscas por mês (I8). PT-BR é inferência (I4), não medição.

| Opção | Grátis | 1000/mês | PT-BR | Termos para agente pessoal | Latência | API | Cabe no Suup |
|---|---|---|---|---|---|---|---|
| **Brave Search API** | US$ 5/mês de crédito (com atribuição) [resumo] | ~0 (ou US$ 5) | boa provável (`country`, `search_lang`) | permitido com chave; **cache limitado a transitório** [resumo] | não verificada | `GET api.search.brave.com/res/v1/web/search`, `X-Subscription-Token`, JSON | motor `direct`, host exato; precisa de chave e de **cache desligado ou curto** para ele |
| **Tavily** | 1000 créditos/mês, sem cartão [resumo] | 0 (basic) | razoável provável (`country` só realça) | feito para agentes; termos não lidos | não verificada | `POST`, `Authorization: Bearer`, JSON com trecho já limpo | motor `direct`; travar `search_depth=basic` e `auto_parameters` desligado para não gastar 2 créditos |
| **Exa** | US$ 10 ou 20 de crédito [resumo] | ~US$ 7 | incerta (`userLocation` só viés) | feito para agentes; termos não lidos | ~0,25 a 1 s (números da Exa) | `POST`, `x-api-key` ou `Bearer`, JSON | motor `direct`; índice "semântico", diferente de uma busca por palavras |
| **Kagi Search API** | não | US$ 12 [lido] | boa provável (herda a conta) | não lidos | não verificada | `GET kagi.com/api/v1/search`, `Authorization: Bot`, JSON [lido] | motor `direct`; mais cara; host `kagi.com` (o mesmo do site) |
| **Mojeek API** | teste a pedido [resumo] | ~£2 | fraca provável | **só pela API autorizada**; raspar é proibido [resumo] | não verificada | não verificado | motor `direct` depois de ler a doc; **nunca** pelo SearXNG (que resolve o captcha deles) |
| SerpApi e parecidos | varia | varia | boa (é o Google) | **fere a regra do Suup** (contorno de proteção, processo do Google) | n/a | n/a | **não** |
| Google CSE JSON | fechado a novos | n/a | n/a | acaba em 1/1/2027 [resumo] | n/a | n/a | **não** |
| Bing Web Search | aposentada | n/a | n/a | acabou em 11/08/2025 [resumo] | n/a | n/a | **não** |
| **Marginalia** | chave `public` ou chave grátis não comercial [resumo] | 0 | **fraca** (web pequena, inglês) | permitido, não comercial [resumo] | não verificada | `GET api2.marginalia-search.com`, `API-Key`, JSON [lido] | motor `direct`, host exato; bom complemento honesto |
| Mwmbl / Wiby | sem chave | 0 | muito fraca (índice mínimo) [lido] | termos não encontrados | não verificada | JSON simples | só se o dono quiser; pouco valor |
| Qwant | n/a | n/a | n/a | API não documentada, cabeçalhos de navegador [lido] | n/a | n/a | **não** |
| DuckDuckGo (atual) | sem chave | 0 | boa quando responde | sem API sancionada; bloqueador de robôs [lido] | n/a (captcha) | raspagem do HTML | **desligar** |

## Implicação para o Suup

### Como uma API paga cabe no desenho atual

- **Mesmo caminho dos motores diretos.** Cada uma vira uma entrada em `packages/web/src/engines.ts` com `via: "direct"`, `access: "api"`, `general: true`, `defaultOn: false` e os hosts exatos (`api.search.brave.com`, `kagi.com` e `api2.marginalia-search.com` vêm de fonte [lido]; os da Tavily, da Exa e do Mojeek **não foram lidos** e têm de ser confirmados na documentação), mais um módulo em `direct-engines.ts`. O `EgressProxy` em `127.0.0.1` continua deixando passar só esses hosts, com TLS até o serviço e sem seguir redirecionamento. O `User-Agent` honesto continua o mesmo.
- **Chave: mudança de desenho, precisa de decisão do dono.** Hoje o BUSCA.md diz que os motores diretos saem "sem credencial". Uma API paga leva a chave num **cabeçalho** (nunca na URL, como a pesquisa de 21/11 já pedia): `X-Subscription-Token` (Brave), `Authorization: Bearer` (Tavily), `x-api-key` (Exa), `Authorization: Bot` (Kagi), `API-Key` (Marginalia). A chave vem **só** de `apiKeyEnv` (o nome da variável, como os provedores em `packages/runtime/src/config.ts`) ou do cofre; nunca no `suup.config.json`, nunca no chat. Sem a variável, o motor aparece como "sem chave" em `suup doctor` e fica fora da busca (falha fechada).
- **Limites.** Os limites por minuto que já existem servem (a Brave antiga falava em 1 pedido por segundo). **Falta um teto mensal por motor** (orçamento), para o usuário nunca ser cobrado sem saber: por exemplo `perMonth`, contado no banco, que suspende o motor quando chega e diz até quando. HTTP 429 e 402/403 de cota entram na contabilidade de suspensão que já existe.
- **Cache.** O cache de 3 h economiza dinheiro, mas o termo da Brave limita a guarda a "transient storage". O motor precisa poder declarar a própria política de cache (desligado ou bem curto para a Brave) até os termos serem lidos inteiros.
- **SearXNG.** Nenhuma das opções recomendadas precisa do SearXNG. Se o DuckDuckGo sair, **o contêiner de busca deixa de ser necessário** no padrão (o desenho já não o cria sem motor `searxng` ligado). Os motores gerais do SearXNG que poderiam entrar (Mojeek, Qwant, Google, Bing) ferem a regra; o `braveapi` do SearXNG existe, mas o Suup chamaria a Brave direto, com o próprio nome, como já faz com os outros.
- **Regra da pesquisa antes do código.** Antes de escrever cada módulo: abrir a documentação e os termos do serviço escolhido numa máquina com rede (o que aqui ficou [resumo] ou "não verificado") e registrar num adendo desta pesquisa.

### Recomendação

1. **Padrão para quem não vai pagar:** os três motores atuais (Wikipédia, arXiv, Stack Overflow) **mais Marginalia** (chave `public` ou chave gratuita pedida por e-mail), todos honestos, abertos e sem custo. Dizer com clareza, na ferramenta e na tela, que **isso não é uma busca geral boa em português**. Para quem aceita **criar uma conta grátis**, o caminho recomendado é a **Tavily** (1000 buscas por mês sem cartão), ligada com a chave por `apiKeyEnv` ou no cofre.
2. **Melhor para pagar pouco:** **Brave Search API**. Índice próprio (não raspa ninguém), parâmetros de país e idioma (`country=BR`, `search_lang=pt-br`), resultados brutos no formato que o desenho já usa, e cerca de US$ 5 por 1000 buscas com US$ 5 de crédito por mês (na prática ~1000 buscas mensais sem pagar nada, com atribuição). Ponto a resolver antes: a regra de cache dos termos. Alternativas: Mojeek (mais barata, independente, fraca em português provável), Kagi (melhor qualidade provável, US$ 12 por 1000), Exa (boa para pesquisa "por significado", US$ 7 por 1000).
3. **DuckDuckGo: desligar por padrão** (`defaultOn: false`) e, de preferência, **tirar da lista**. Ele não tem API sancionada, o próprio SearXNG descreve um bloqueador de robôs e já precisa se disfarçar de navegador para passar, e um robô honesto recebe captcha (I1). Mantê-lo ligado só gera "busca indisponível" e uma hora de suspensão a cada tentativa. Se o dono quiser deixá-lo como opção avançada, que fique desligado e com o aviso de que vai falhar com o nome honesto. Sem ele, a busca padrão deixa de depender do Docker e do SearXNG.

Isto muda o plano (BUSCA.md: "duckduckgo ligado por decisão do dono" e "o Suup não traz adaptadores de Brave, Tavily nem Exa"). **O dono decide** antes de qualquer código: (a) tirar ou desligar o DuckDuckGo, (b) aceitar motores com chave no núcleo (opcionais, desligados por padrão), (c) quais entram primeiro.
