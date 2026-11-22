# Pesquisa: Wikipédia, arXiv e Stack Overflow chamados direto pelas APIs oficiais, com o nome honesto do Suup

Data da pesquisa: 22/11/2026. Valida a troca decidida pelo dono (opção A) na busca da fase 4 (ver [pesquisas/README.md](README.md), [BUSCA.md](../BUSCA.md) e [fase-4-busca-na-web.md](fase-4-busca-na-web.md)).

## Pergunta

Como o Suup pode consultar a Wikipédia, o arXiv e o Stack Overflow **sem passar pelo SearXNG** (que manda um `User-Agent` de navegador sorteado a esses motores), usando a API oficial de cada um e o nome honesto `SuupBot/<versão> (+https://github.com/ali-ali18/suup-)`? Qual endpoint serve a busca, o que cada serviço pede de `User-Agent` e de ritmo, em que formato respondem e com que licença/atribuição o conteúdo vem?

## Fontes

Lidas em 22/11/2026, salvo quando indicado. Nesta máquina quase todos os hosts são bloqueados (CONNECT 403 ou falha de DNS); só `raw.githubusercontent.com` respondeu. Por isso as fontes abaixo são o **código-fonte e os textos de documentação versionados em repositórios oficiais**.

arXiv:

- arXiv, "Terms of Use for arXiv APIs" (fonte do site `info.arxiv.org/help/api/tou.html`, lida no repositório oficial `arXiv/arxiv-docs`, ramo `develop`, arquivo `source/help/api/tou.md`): https://raw.githubusercontent.com/arXiv/arxiv-docs/develop/source/help/api/tou.md
- arXiv, "arXiv API User's Manual" (fonte de `info.arxiv.org/help/api/user-manual.html`, mesmo repositório, `source/help/api/user-manual.md`): https://raw.githubusercontent.com/arXiv/arxiv-docs/develop/source/help/api/user-manual.md
- Os dois endereços do site (`info.arxiv.org/...`) e `export.arxiv.org` em si: **não verificado (host bloqueado)**.

Wikipédia / MediaWiki:

- MediaWiki core, textos de ajuda da API (`includes/api/i18n/en.json`, ramo `REL1_43`, os mesmos textos que `Special:ApiHelp` mostra): https://raw.githubusercontent.com/wikimedia/mediawiki/REL1_43/includes/api/i18n/en.json
- MediaWiki core, código do módulo `list=search` (`includes/api/ApiQuerySearch.php`, ramo `REL1_43`): https://raw.githubusercontent.com/wikimedia/mediawiki/REL1_43/includes/api/ApiQuerySearch.php
- Política de `User-Agent` da Wikimedia Foundation (`foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy`), `meta.wikimedia.org`, `mediawiki.org/wiki/API:Etiquette` e `API:Search`: **não verificado (host bloqueado)**. Os ramos `master` do MediaWiki no raw também devolveram 404 para os arquivos acima (usado `REL1_43`, uma versão de lançamento).

Stack Exchange:

- `api.stackexchange.com/docs` (páginas `throttle`, `search`, `errors`, `compression`), e as páginas de termos e de atribuição: **não verificado (host bloqueado)**. Não há repositório oficial com esses textos que o raw alcance; nenhuma fonte primária foi lida.

Só como pista, **não como fonte**: uma busca na web (22/11/2026) devolveu resumos de páginas de terceiros (`apis.io`, `dev.to`, espelhos de perguntas do Meta Stack Exchange) sobre o `backoff` e as cotas do Stack Exchange, e resumos de páginas do `mediawiki.org` sobre `User-Agent`. Nenhuma dessas páginas foi aberta (hosts bloqueados), então nada delas entra em "Fatos verificados".

## Fatos verificados

### 1. arXiv

- **Termos de uso, ritmo:** "When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API), make no more than one request every three seconds, and limit requests to a single connection at a time." Os limites valem "to all of the machines under your control as a whole" e não se deve tentar passar deles aumentando máquinas. (tou.md)
- **Termos de uso, o que é proibido e o que é permitido:** "Attempt to circumvent rate limits" está na lista do que não se deve fazer; "If we think that you are attempting to circumvent those limitations ... we may further limit or block your access." É permitido "Retrieve, store, transform, and share **descriptive metadata** about arXiv e-prints", e "Direct users to arXiv.org to retrieve e-print content ... We encourage you to link to the abstract page." Não se deve "Store and serve arXiv e-prints (PDFs, source files, or other content) from your servers" sem permissão do detentor. (tou.md)
- **Licença dos metadados:** "You are free to use descriptive metadata about arXiv e-prints under the terms of the Creative Commons Universal (CC0 1.0) Public Domain Declaration." Título, resumo, autores, identificadores e classificação contam como metadados descritivos. Os próprios artigos têm direitos autorais dos autores. (tou.md)
- **User-Agent:** os termos e o manual **não mencionam** `User-Agent` (busca por "user-agent" nos dois arquivos: nenhuma ocorrência). O que se pede é o ritmo e o respeito aos limites.
- **Endpoint:** `http://export.arxiv.org/api/query` com os parâmetros `search_query` (texto), `id_list`, `start` (padrão 0) e `max_results` (padrão 10). Exemplo do manual: `http://export.arxiv.org/api/query?search_query=all:electron`; para dois termos, `all:electron+AND+all:proton`. `sortBy` aceita `relevance`, `lastUpdatedDate`, `submittedDate`. (user-manual.md)
- **Teto por chamada:** `max_results` é limitado a 30000 em fatias de no máximo 2000; acima disso, HTTP 400 com explicação. (user-manual.md)
- **Ritmo, no manual:** "we encourage you to play nice and incorporate a 3 second delay in your code". (user-manual.md)
- **Formato da resposta:** Atom 1.0 (XML) com extensões OpenSearch (`opensearch:totalResults`, `startIndex`, `itemsPerPage`) e `arxiv:`. Cada artigo é um `<entry>` com `<title>`, `<id>` (a URL da página do resumo, por exemplo `http://arxiv.org/abs/hep-ex/0307015`), `<summary>`, `<published>`, `<updated>`, `<author><name>`, `<category>`, e até três `<link>`: `rel="alternate"` (página do resumo, sempre), `rel="related" title="pdf"` (sempre) e `title="doi"` (às vezes). (user-manual.md)
- **Erros:** com erro, o `<feed>` traz **um único** `<entry>` cujo `<id>` é `http://arxiv.org/api/errors#...`, `<title>` é `Error` e `<summary>` é a mensagem. Exemplo: `id_list=1234.12345` dá `incorrect id format for 1234.12345`. (user-manual.md)
- **HTTPS em `export.arxiv.org`:** o manual só usa `http://`. O SearXNG da imagem fixada usa `https://export.arxiv.org/api/query` (lido na pesquisa anterior, [fase-4-busca-na-web.md](fase-4-busca-na-web.md) e BUSCA.md). Que o host responde em HTTPS **não foi verificado** aqui (host bloqueado).

### 2. Wikipédia (MediaWiki Action API)

- **Endpoint de busca:** módulo `list=search` da Action API: `action=query&list=search&srsearch=<texto>` (exemplo do próprio código: `action=query&list=search&srsearch=meaning`). Descrição: "Perform a full text search." (ApiQuerySearch.php, en.json)
- **Parâmetros usados:** `srsearch` ("Search for page titles or content matching this value"), `srlimit` (a ajuda diz "How many total pages to return"), `srprop` (inclui `snippet`: "Adds a snippet of the page, with query term highlighting markup"), `srnamespace` ("Search only within these namespaces"), `srwhat`, `srinfo`, `srenablerewrites` ("Enable internal query rewriting ... correcting spelling errors"). (en.json)
- **Campos da resposta:** o código acrescenta a cada resultado `title`, `pageid` e, com `srprop=snippet`, `snippet` (`getTextSnippet()`, texto com marcação HTML de destaque); metadados da busca em `query.searchinfo` (`totalhits`). (ApiQuerySearch.php)
- **Formato:** `format=json` com `formatversion=2` ("Modern format", en.json). Erros: "When erroneous requests are sent to the API, an HTTP header will be sent with the key "MediaWiki-API-Error"" e o mesmo código vai no corpo; para limite de ritmo a mensagem do MediaWiki é "You've exceeded your rate limit. Please wait some time and try again." (`apierror-ratelimited`). (en.json)
- **Etiqueta:** a ajuda principal da API aponta para "API:Etiquette & usage guidelines" (en.json); o texto dessa página **não foi lido**.
- **User-Agent:** a política da Wikimedia **não foi lida** (host bloqueado). Pelo resumo de uma busca na web (não aberto, ver Fontes) ela pede um `User-Agent` descritivo com forma de contato (URL ou e-mail) e diz que requisições sem ele, ou com o padrão de uma biblioteca genérica, podem ser bloqueadas sem aviso. Isso é só pista.

### 3. Stack Overflow (Stack Exchange API 2.3)

Nenhum fato foi **lido em fonte primária** (host bloqueado, sem repositório oficial alcançável). Do que o Suup precisa saber, e que **não está verificado**: o endpoint `/2.3/search/advanced` (com `q`, `site=stackoverflow`, `pagesize`, `sort`, `order`), o campo `backoff` do envelope, o campo `quota_remaining`, a compressão sempre ligada, o formato de erro (`error_id`, `error_name`, `error_message`) e a política de atribuição. O desenho trata essas partes de forma defensiva (abaixo), e o código marca em cada ponto o que é suposição.

## Inferências

- **arXiv é o motor com regra explícita e checável:** um pedido a cada 3 s e uma conexão por vez. Isso pede, no código, uma fila **por motor** com intervalo mínimo de 3 s entre o fim de um pedido e o início do seguinte, além do limite por minuto do governador (que, sozinho, deixaria 15 pedidos em 1 s).
- **Os três aceitam um nome honesto sem protesto da documentação lida:** arXiv não pede `User-Agent`; a Wikimedia pede um descritivo (pista, não lida); o Stack Exchange não foi lido. `SuupBot/<versão> (+https://github.com/ali-ali18/suup-)` tem produto, versão e URL, a forma que a pista descreve.
- **A busca do arXiv por `all:`:** como `search_query` aceita operadores (`AND`, `OR`, `ANDNOT`, aspas, parênteses, `:`), uma consulta em linguagem natural vira `all:t1 AND all:t2 ...`, com cada termo sem os caracteres de sintaxe e sem os três operadores escritos como termo. Isto é **montar** uma consulta (escapar), não classificar texto.
- **Wikipédia sem filtro de tempo:** a Action API de busca não tem, nos parâmetros lidos, um filtro por data de edição equivalente ao `time_range` da ferramenta; o `time_range` é ignorado para esses motores (o SearXNG também não o usava neles, até onde se sabe da leitura anterior, mas isso não foi reconferido aqui).
- **Janelas de suspensão** (3 min para "muitos pedidos", 1 h para recusa de acesso ou cota) **são escolha do Suup**, não número de nenhuma fonte; servem para nunca insistir.
- **Segurança:** o corpo das três respostas é dado externo (título e resumo escritos por terceiros); entra na ferramenta como as outras buscas, no envelope de dado externo, e o `snippet` da Wikipédia tem marcação HTML que é reduzida a texto por um analisador de HTML, nunca por padrão de texto.

## O que não foi verificado

- Política de `User-Agent` da Wikimedia (texto), `API:Etiquette`, limites de ritmo da Wikimedia para a API anônima: não lidos.
- Qualquer documentação do Stack Exchange (endpoint, `backoff`, cota sem chave, erros, compressão, licença e atribuição das perguntas): não lida.
- Que `export.arxiv.org` responde em HTTPS, e o comportamento real das três APIs com o nome do Suup: nada foi chamado (esta máquina não alcança os hosts).
- Licença do texto da Wikipédia e a atribuição que ela pede: não lida.
- Termos de uso do arXiv sobre o `User-Agent`: o texto lido não diz nada; não se sabe se há regra fora dele.

## Implicação para o Suup

- **Nada contradiz a troca decidida pelo dono.** O arXiv confirma o ritmo (1 pedido a cada 3 s, uma conexão) e libera os metadados (CC0); isso entra como limite do motor.
- **Wikipédia:** Action API `list=search`, JSON `formatversion=2`, `srprop=snippet`; o link do resultado é `https://<idioma>.wikipedia.org/wiki/<título>`. Recusa de acesso (403) suspende por 1 h, 429 por 3 min.
- **arXiv:** `export.arxiv.org/api/query`, Atom lido por um analisador de XML de verdade (o do jsdom, que o pacote já usa), um pedido por vez com 3 s de intervalo; o `<entry>` de erro vira falha com a mensagem do arXiv.
- **Stack Overflow:** `api.stackexchange.com/2.3/search/advanced`, JSON; o campo `backoff` e a cota esgotada suspendem o motor; qualquer coisa fora do formato esperado falha fechado com mensagem clara. **Como nada disso foi lido na fonte, o BUSCA.md e o TESTES-REAIS.md dizem que esse motor não foi conferido contra a documentação nem contra a API real**, e o primeiro uso numa máquina com rede deve conferir.
- **GitHub sai da busca na web:** a regra do dono é "o que puder, vai para o MCP"; a busca no GitHub é do conector MCP do GitHub (já suportado). O mesmo vale para Figma e outros serviços com conector.
- **SearXNG só para o DuckDuckGo** (e os motores de raspagem que o dono ligar, que continuam com o `User-Agent` sorteado do SearXNG, o que o BUSCA.md diz com todas as letras).
