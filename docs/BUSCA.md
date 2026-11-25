# Busca e leitura de páginas na web

Pesquisa que fundamenta este desenho: [pesquisas/fase-4-busca-na-web.md](pesquisas/fase-4-busca-na-web.md) (e o adendo "busca e leitura próprias"), [pesquisas/fase-4-busca-apis-diretas.md](pesquisas/fase-4-busca-apis-diretas.md) para as APIs especializadas que o Suup chama ele mesmo e [pesquisas/fase-4-busca-alternativas-ao-ddg.md](pesquisas/fase-4-busca-alternativas-ao-ddg.md) para a busca geral (a fila de Tavily e Brave, com as páginas oficiais lidas em 24/11/2026). Regra do dono, que manda em tudo aqui:

> "Não quero me prender a provedor." "Tem que ser 100% open, porque o projeto vai ser open."

**Decisão do dono, 24/11/2026: o DuckDuckGo e o SearXNG saíram por inteiro.** O DuckDuckGo pedia captcha em quase toda busca no computador do dono (um bloqueador de robôs que só se contorna imitando um navegador, o que o Suup não faz), e o SearXNG existia só para ele. No lugar, a **busca geral é uma fila de APIs oficiais com troca automática**: Tavily primeiro, depois a Brave Search API. A busca geral **não precisa mais de Docker**.

## Regra do dono: o Suup não burla proteção de site

> "Sem resolver captcha e sem esconder que é um robô." (o dono, 21/11/2026)

Vale para tudo neste documento, e é checável no código:

- **Nenhum serviço de resolver captcha**, nenhum rodízio de IP ou de proxy para escapar de bloqueio, nenhum disfarce de navegador (impressão digital, `User-Agent` de navegador, cabeçalhos copiados de um). Um serviço que devolve `429`, diz que a cota acabou ou bloqueia **disse não**: o Suup espera a janela passar, diz ao bot que aquele motor está indisponível e quando volta, e **não tenta de novo antes disso**.
- **O `robots.txt` é respeitado** (leitor, abaixo). O nome que o leitor usa é o honesto: `SuupBot/<versão> (+<repositório>)`.
- A busca e a leitura são **educadas** por desenho: limites por minuto, fila, cache, suspensão por motor (próxima seção, "Busca educada").
- O nome honesto vale para todo motor (Wikipédia, arXiv, Stack Overflow, Tavily, Brave) e para o leitor. Não sobra lacuna.
- **O Firecrawl não é motor da fila**: por padrão o proxy dele escala sozinho (`auto`) para um proxy que contorna bloqueios, e o Suup não chama a API dele por conta própria (pesquisa, seção "Firecrawl"). **Decisão do dono, 24/11/2026**: ele entra como **conector MCP da galeria**, na categoria "Pesquisa na web", porque aí quem busca e lê as páginas é o serviço do Firecrawl, com a conta e a chave de quem instala, e não o Suup ([CONECTORES.md](CONECTORES.md), "Galeria").

A busca e a leitura são feitas por **peças que o Suup mesmo roda ou chama pela API oficial**. A busca hospedada do provedor do modelo (a `web_search` da Anthropic, a da OpenAI) **não é usada**. O bot vê duas ferramentas embutidas, de nível `read` (sem cartão; `web_read` de um endereço que ainda não apareceu é a exceção, abaixo), concedidas por bot como as outras:

| Ferramenta | Faz | Como |
|---|---|---|
| `web_search` | devolve os melhores resultados (título, URL, trecho, motor) e **diz qual motor geral respondeu** | **APIs oficiais** que o próprio Suup chama: Wikipédia, arXiv e Stack Overflow (juntas) e, para a web aberta, a **fila** Tavily, depois Brave |
| `web_read` | lê uma página pública e devolve o conteúdo principal em **Markdown**, com título, URL final, autor e data quando a página dá. **Sem cartão só para um endereço que já apareceu** (veja "A leitura só abre o que já apareceu"); outro endereço pede cartão | **serviço leitor**: baixa, extrai com Readability, converte com Turndown; `render: true` roda a página num Chromium sem cabeça |
| `web_fetch` (já existia) | uma chamada GET da máquina do bot, com cabeçalhos do cofre | continua para API e para URL interna; passa pela lista de hosts do bot |

`web_fetch` recusa respostas acima de **5 MB depois de descomprimir**: o `--max-filesize` do curl só para o tamanho declarado (e o curl antigo, 7.81, nem o corpo em fluxo), então o arquivo que o curl escreve tem teto próprio (`ulimit -f` num subshell) e o tamanho é conferido depois do download; acima do limite, a mesma mensagem "larger than the 5 MB limit".

Com **cabeçalhos próprios** (que podem levar um segredo, `{{secret:NOME}}`), o `web_fetch` não deixa o curl seguir redirecionamentos: segue ele mesmo, um salto por vez, e só dentro da **mesma origem** (esquema, host e porta, comparados com a API `URL`). Um redirecionamento para outro site para e devolve o endereço novo ("a página redirecionou para outro site; abra o novo endereço sem os cabeçalhos"), sem que o outro site receba nada. Sem cabeçalhos, segue até 5 redirecionamentos como antes.

## Arquitetura

```
 worker (tem o socket do Docker só para o leitor)
   |-- ferramenta web_search --HTTPS--> proxy de saída em 127.0.0.1 (só hosts exatos)
   |       |                                 |-- Wikipédia, arXiv, Stack Overflow   (juntas)
   |       |                                 '-- api.tavily.com -> api.search.brave.com   (a fila, uma de cada vez)
   |       '-- a chave de cada motor da fila: variável de ambiente (apiKeyEnv) ou cofre
   |-- ferramenta web_read --docker exec -i--> [suup-reader]  ponte comum (rota pública), sem porta, sem segredo
   |                                              |- leitor: DNS uma vez, recusa faixa privada, robots, ritmo
   |                                              '- renderizador: Chromium atrás de um proxy local que só aceita nomes públicos
   '-- web_read com o leitor desligado --> máquina do bot (lista de hosts, com cartões)
```

- **A busca não usa Docker.** O worker (ou o sidecar do app) chama as APIs ele mesmo, por um **proxy de saída em `127.0.0.1`** (a classe `EgressProxy`) que deixa passar só os hosts exatos dos motores ligados. Não há contêiner de busca, rede interna de busca nem proxy de motores em contêiner.
- **O leitor** é um contêiner (`suup-reader`) que o worker fala por `docker exec -i ... node /app/dist/serve.js` (uma linha JSON por pedido), sem porta aberta; guarda o cache do `robots.txt` e o ritmo por host.
- **Nada sobe até uma ferramenta pedir.** O primeiro `web_search` ou `web_read` inicia o que falta (o proxy de saída das APIs e, para a leitura, o contêiner do leitor). `suup doctor` mostra a situação sem iniciar nada.
- **Sem Docker:** `web_search` funciona inteira (motores especializados e a fila geral); `web_read` lê **no próprio processo** (o mesmo código do leitor, sem `render`). Sem a imagem do leitor construída, o mesmo.
- **Com o leitor desligado** (`web.reader.enabled: false`): `web_read` baixa pela **máquina do bot** (`curl` pela lista de hosts, com os cartões de `request_network_access`) e só converte o HTML em Markdown no worker (função pura, sem rede).
- **Custo:** a Wikipédia, o arXiv e o Stack Overflow não custam nada. A fila geral usa **a conta do próprio usuário** em cada serviço: Tavily tem 1000 créditos por mês grátis (uma busca `basic` gasta 1), a Brave dá US$ 5 de crédito por mês (cerca de mil buscas; US$ 5 por mil depois). O Suup **conta** as buscas que cada motor respondeu por mês (a tela de Ajustes mostra); não guarda o texto. O custo em tokens é o do texto que o bot lê.

## Os motores de busca

Todo motor é chamado pelo próprio Suup, pela **API oficial**, com o **nome honesto** (`SuupBot/<versão> (+<repositório>)`), em `packages/web/src/direct-engines.ts` (os especializados) e `packages/web/src/general-engines.ts` (a fila). Declarados em `packages/web/src/engines.ts`.

| Id | Motor | Tipo | Acesso | Hosts (nomes exatos) | Chave | Padrão |
|---|---|---|---|---|---|---|
| `wikipedia` | Wikipédia | especializado | API de ações do MediaWiki (`list=search`, JSON) | `<idioma>.wikipedia.org` para cada idioma de `web.search.languages` (padrão `en`, `pt`) | não | ligado |
| `arxiv` | arXiv (artigos) | especializado | API do arXiv (`/api/query`, Atom), **um pedido a cada 3 s, uma conexão por vez** (termos de uso do arXiv) | `export.arxiv.org` | não | ligado |
| `stackoverflow` | Stack Overflow (perguntas) | especializado | API Stack Exchange 2.3 (`/search/advanced`, JSON), respeita `backoff` e a cota | `api.stackexchange.com` | não | ligado |
| `tavily` | Tavily | **geral (fila, 1º)** | `POST /search`, JSON, `Authorization: Bearer` | `api.tavily.com` | sim | ligado (sem chave, é pulado) |
| `brave` | Brave Search | **geral (fila, 2º)** | `GET /res/v1/web/search`, JSON, `X-Subscription-Token` | `api.search.brave.com` | sim | ligado (sem chave, é pulado) |

**O GitHub não é motor de busca da web.** Regra do dono: *o que puder, vai para o MCP.* A busca no GitHub (repositórios, código, issues) é do **conector MCP do GitHub** ([CONECTORES.md](CONECTORES.md)); o mesmo vale para o Figma e para qualquer serviço que tenha conector. `github` não é um id válido em `web.search.engines`. **Google, Bing, DuckDuckGo, SearXNG e Firecrawl também não são ids válidos** (a configuração é recusada com "motor desconhecido").

### A fila da busca geral

Os motores **especializados** (Wikipédia, arXiv, Stack Overflow) são perguntados **juntos**; a lista de cada um é intercalada com as outras, sem URL repetida. Os motores **gerais** formam uma **fila**: um de cada vez, na ordem configurada (`web.search.general.order`, padrão `["tavily", "brave"]`).

1. O primeiro motor da fila que **tem chave** é perguntado. Um motor **sem chave é simplesmente pulado**, sem custo e sem ocupar vaga nos limites do Suup.
2. Se responde (mesmo sem resultado), a fila **para**: o resultado diz **qual motor geral respondeu** ("General web search answered by: tavily") e o motor ganha **+1 na contagem do mês**.
3. Se **não há cota** (créditos do mês acabaram), está **indisponível**, **não aceitou a chave**, **limitou o ritmo** ou **falhou**, o Suup passa **sozinho** para o próximo, na mesma busca, e deixa uma linha no registro: `web_search: failover tavily (quota) -> brave`. Só o motor e o tipo de falha vão para a linha, **nunca o texto da busca**.
4. O motor que falhou fica **de lado** (suspenso) pelo tempo da tabela abaixo, e as buscas seguintes nem o perguntam, até a janela acabar.
5. Se **a fila toda** está fora, a busca devolve o que os outros motores deram e diz: **"A busca geral está sem cota agora."** (ou, conforme o motivo, que nenhuma chave foi adicionada, que o limite por minuto do Suup foi atingido ou que a busca geral não respondeu). O bot então usa a Wikipédia, o arXiv e o Stack Exchange, não repete a busca em laço e, se puder, volta mais tarde (`schedule_return`).

| Falha | Tavily | Brave Search | O Suup deixa o motor de lado por |
|---|---|---|---|
| Sem cota (créditos do mês) | HTTP `432` (limite da chave ou do plano) ou `433` (limite do pague-quanto-usar) | código `QUOTA_LIMITED`, `CREDIT_EXHAUSTED` ou `USAGE_LIMIT_EXCEEDED` (e, numa resposta que gasta a última busca do mês, `X-RateLimit-Remaining` zerado no mês) | **1 hora** (escolha do Suup: uma conta recarregada volta a ser usada em até uma hora; uma tentativa que falha não é cobrada) |
| Ritmo (muitos pedidos) | HTTP `429` com `Retry-After` | código `RATE_LIMITED` (ou `429` sem código) | o `Retry-After` (Brave: `X-RateLimit-Reset`, até 60 s), no máximo 1 hora; sem o valor, 60 s |
| Chave não aceita | HTTP `401` | `SUBSCRIPTION_TOKEN_INVALID`, `SUBSCRIPTION_NOT_FOUND`, `RESOURCE_NOT_ALLOWED`, `OPTION_NOT_IN_PLAN`, ou HTTP `401`/`403` | 1 hora |
| Fora do ar | HTTP `5xx`, tempo esgotado, falha de conexão | `INTERNAL`, `5xx`, tempo esgotado | 60 s |
| Pedido que o Suup fez errado | `400`, `422`, resposta de outra forma | `422` sem código conhecido, resposta de outra forma | não suspende (falha só esta busca) |

O estado da suspensão fica na **memória do processo**: depois de um reinício o Suup descobre de novo, com uma tentativa que não é cobrada. **A contagem do mês fica no banco** (tabela `web_search_usage`, migração 0031): só motor, mês (UTC) e um número; o texto de uma busca nunca é guardado.

**A chave** de cada motor da fila vem, nesta ordem, da **variável de ambiente** que a configuração nomeia (`web.search.general.<id>.apiKeyEnv`; por padrão `TAVILY_API_KEY` e `BRAVE_SEARCH_API_KEY`) e do **segredo da chave** (`web.search.general.<id>.secret`; por padrão o mesmo nome), o que o app escreve pela página do plugin. **A chave fica com o motor** (decisão do dono, 25/11/2026), não no Cofre do usuário: o app grava por `PUT /v1/web-search/providers/{id}/key`, que a guarda **marcada** `search:<id do motor>` (`search:tavily`), fora de `GET /v1/secrets`, nunca concedida a um bot; as que já estavam no Cofre passam para o motor na partida (docs/COFRE.md, "Credencial de plugin"). Um `request_secret` com o nome da chave também a grava assim, sem conceder ao bot. É lida **a cada busca**, então uma chave adicionada com o Suup rodando vale na hora. **Nunca no `suup.config.json`** (uma chave ali é recusada), nunca num log, nunca na URL: vai num cabeçalho (`Authorization: Bearer` para a Tavily, `X-Subscription-Token` para a Brave).

**País e idioma.** Com `web.search.locale` (`pt-BR`; o app embutido manda o idioma do computador) os motores gerais pedem resultados do Brasil e em português, com os valores exatos das documentações:

| | país | idioma |
|---|---|---|
| Tavily | `country: "brazil"` (nome em inglês, minúsculas; a lista oficial tem `brazil` e `portugal`) | `language: "pt"` (ISO 639-1; só **realça** na ordenação) |
| Brave | `country=BR` (código de 2 letras) | `search_lang=pt-br` (a lista oficial tem `pt-br` e `pt-pt`; região `PT` dá `pt-pt`) |

O `language` que o bot pede (`web_search` com `language: "en"`) vale sobre o do locale. Um idioma que a Brave não lista não é mandado. `time_range` do bot (`day`, `month`, `year`) vira `time_range` na Tavily e `freshness=pd|pm|py` na Brave.

### Os termos de cada serviço, e o que o Suup faz por causa deles

- **Brave** ([termos da API](https://api-dashboard.search.brave.com/terms-of-service), lidos em 24/11/2026): não se pode "store, cache, or create a database of Search Results... other than transient storage required for operation". Por isso **os resultados da Brave nunca vão para o cache de buscas** (nem uma resposta que misture hits da Brave com outros), e **nenhum resultado da Brave entra em avaliação de IA** ("use the Search Results to create, evaluate, train... or benchmark" AI): o harness de avaliação (`runEval`, em `evals/`) tira a Brave da lista de motores antes de rodar qualquer coisa (`Runtime.restrictWebForEvaluation`), qualquer que seja a configuração. A atribuição ("Powered by Brave") é opcional. Não se pode burlar o limite criando várias contas: o Suup usa **uma chave por motor**.
- **Tavily** ([termos da plataforma](https://www.tavily.com/terms), lidos em 24/11/2026): sem cláusula de cache ou de atribuição nos textos lidos; uso por agente é previsto (chave de agente); o serviço é para "uso interno" do cliente, e **a política de uso aceitável (§3.8) não foi lida**: o dono decide se um agente pessoal cabe. O Suup trava `search_depth=basic` (1 crédito) e `auto_parameters=false` (que poderia subir para 2 créditos).

### Os especializados, em detalhe

(fatos e lacunas em [pesquisas/fase-4-busca-apis-diretas.md](pesquisas/fase-4-busca-apis-diretas.md))

- **Como saem.** Pelo **proxy de saída do worker** que escuta só em `127.0.0.1` e deixa passar **só os hosts exatos** dos motores ligados; a conexão é um `CONNECT` ao host, porta 443, e o TLS vai até o serviço, conferindo o nome do certificado. Nenhum redirecionamento é seguido, sem cookie, tempo de 15 s e no máximo 2 MB por resposta. A única credencial que viaja é a chave de um motor geral, num cabeçalho.
- **Wikipédia.** `https://<idioma>.wikipedia.org/w/api.php?action=query&list=search&srsearch=...&srprop=snippet&format=json&formatversion=2`. O trecho vem com marcação HTML de destaque, que um analisador de HTML reduz a texto. Com `language` o Suup pergunta só àquela edição (se estiver nos idiomas configurados); sem, a cada idioma configurado, um depois do outro. HTTP 429 suspende por 3 min; 403, por 1 h; o erro `ratelimited` da API, por 3 min.
- **arXiv.** `https://export.arxiv.org/api/query?search_query=all:<termo> AND all:<termo>...`. Cada palavra da consulta vira um termo `all:`; os caracteres da sintaxe de consulta e as palavras `AND`, `OR`, `ANDNOT` escritas como termo são deixados de fora. A resposta é Atom, lida por um **analisador de XML de verdade** (o do jsdom, sem regex); o `<entry>` de erro documentado vira uma recusa com a explicação do arXiv. **Ritmo:** uma fila **só do arXiv**, um pedido por vez, com **3 s depois do fim do anterior**, além do limite por minuto. Que `export.arxiv.org` responde em HTTPS não foi conferido (o manual só mostra `http://`).
- **Stack Overflow.** `https://api.stackexchange.com/2.3/search/advanced?q=...&site=stackoverflow&sort=relevance&order=desc&pagesize=N`. O título vem com entidades HTML (decodificadas); o trecho é montado dos campos (pontuação, respostas, etiquetas). **`backoff`** da resposta: os resultados são mantidos e o Suup deixa o motor em paz por aquele tempo (até 1 dia); **cota esgotada** (`quota_remaining` zero) e `throttle_violation` suspendem por 1 h. **Nenhuma documentação do Stack Exchange foi lida** (host bloqueado): o endereço, os campos e o comportamento são suposição, e o motor **falha fechado** com qualquer resposta que não tenha essa forma. Conferir na primeira vez numa máquina com rede.
- **Janelas de suspensão** dos especializados (3 min, 1 h) **são escolha do Suup**, não número dos serviços. **`time_range` é ignorado** pelos três.
- **Licença e atribuição.** Os metadados do arXiv são CC0; o texto da Wikipédia e as perguntas do Stack Overflow têm licenças próprias que **não foram lidas**: a ferramenta devolve só título, link e um trecho curto, e o bot é instruído a citar a URL.

Nesta máquina de desenvolvimento os motores não são alcançáveis, então **nenhum motor foi exercitado de verdade**: os testes usam um servidor de mentira para cada API, com respostas no formato que a documentação oficial descreve, e conferem o `User-Agent` exato, a chave no cabeçalho certo (e fora da URL), a consulta, a leitura da resposta, e o proxy de saída real recusando qualquer outro host.

## Busca educada

Código: `packages/web/src/search-governor.ts` (limites e suspensões), `search-cache.ts` (cache), `search-usage.ts` (contagem do mês) e `search.ts` (o fluxo e a fila). Tudo configurável em `web.search.limits` e `web.search.cache` ([CONFIGURACAO.md](CONFIGURACAO.md)).

**Limites por minuto.** Janela deslizante de 60 s, no geral (padrão **20 buscas por minuto**) e por motor (padrão de cada motor, declarado em `engines.ts`: Wikipédia 30, arXiv 15, Stack Overflow 10, Tavily 30, Brave 30; `limits.perEngine` troca; a Tavily dá 100 pedidos por minuto no plano grátis, a Brave 50 por segundo). Uma busca que passaria do limite **espera numa fila curta**, em ordem, até o primeiro instante em que cabe, **desde que a espera não passe de `limits.maxWaitSeconds`** (padrão 20 s). Passando disso o resultado é um erro claro, **"muitas buscas no último minuto... tente em cerca de X s"** (`rate_limited` com `retryInSeconds`), e o bot é instruído a **não repetir agora** e, se puder, usar `schedule_return`. Se só **um motor** está acima do seu limite e os outros estão livres, a busca vai **sem aquele motor** e diz qual ficou de fora e quando ele volta (`throttled`); um motor da fila acima do seu limite **passa para o próximo**. A fila é de um processo só; o limite não é compartilhado entre o worker e outros processos.

**Cache.** Uma busca com a mesma **consulta em forma simples** (aparada, espaços reunidos dividindo e juntando o texto, minúscula; **sem expressão regular**), os mesmos **motores**, idioma e intervalo de tempo é respondida do cache, pelo prazo `cache.ttlMinutes` (padrão **180 min = 3 h**), **sem consultar motor nenhum**, e a resposta diz **que veio do cache e de quando foi feita**. Só se guarda busca que achou algo, **e nunca uma resposta com resultado da Brave** (termos dela, acima). O cache fica **no banco** (tabela `web_search_cache`, migração 0024), então sobrevive a reinício e vale para o worker e para o app; um cache que falha não derruba a busca. `cache.enabled: false` desliga. Os URLs de uma resposta do cache também contam como "já apareceram" para `web_read`. Uma busca respondida do cache **não é cobrada** em nenhum serviço e não entra na contagem do mês.

**Motores suspensos.** Cada motor diz o **porquê e por quanto tempo** (`windowSeconds`, a tabela acima): o Suup deixa de perguntar a ele até a janela passar (a resposta diz "volta em cerca de 50 min"), sem comparar texto de erro. Falha sem janela (tempo esgotado, resposta fora do formato) só aparece como "não respondeu", sem suspender. Quando **todo motor geral ligado** está fora (suspenso, sem chave ou acima do limite), a resposta traz o `generalUnavailable` com o motivo e o tempo, e a ferramenta diz o que fazer (acima). Se **nenhum** motor pode ser perguntado, nenhuma API é chamada.

### Trocar os motores

No `suup.config.json` (e a ordem e o país em `general` e `locale`):

```json
"web": {
  "search": {
    "engines": ["wikipedia", "arxiv", "stackoverflow", "tavily", "brave"],
    "languages": ["en", "pt"],
    "locale": "pt-BR",
    "general": {
      "order": ["tavily", "brave"],
      "tavily": { "apiKeyEnv": "TAVILY_API_KEY" },
      "brave": { "apiKeyEnv": "BRAVE_SEARCH_API_KEY" }
    }
  }
}
```

Id desconhecido (`github`, `duckduckgo`...) é recusado ao carregar a configuração, e a ordem só aceita motores gerais. Mudar a lista (ou os idiomas) muda os hosts que o proxy de saída deixa passar. Acrescentar um motor novo ao código é uma linha em `packages/web/src/engines.ts` (hosts exatos, chave, `cacheable`, `forbiddenInEvals`) mais um módulo em `direct-engines.ts` ou `general-engines.ts` (com pesquisa antes, em `docs/pesquisas/`, e os termos do serviço lidos).

## Configurações > Busca (o app)

**Decisão do dono, 24/11/2026: Tavily e Brave são plugins** (categoria "Pesquisa na web", [DESIGN.md](DESIGN.md) §5e). A **página de cada um** mostra o estado em palavras (**"Pronto"**, **"Sem chave"**, **"Cota do mês usada"**, "Chave não aceita", "Não respondeu agora", "Desligado"), as buscas do mês, a posição na fila e o botão **"Adicionar chave"** (o diálogo seguro, que grava a chave com o motor, com os passos que o catálogo declara). Com chave, o motor aparece em "Instalado" (Configurações > Conectores). **Configurações > Busca virou um ponteiro curto** (a opção mais amigável, sem controle repetido): só a **fila na ordem em que é tentada**, cada motor com o estado e a contagem e um "Abrir" para a página dele. Nunca mostra a chave, o nome do segredo nem o texto de uma busca (`GET /v1/web-search`, [API.md](API.md)). A ordem é da configuração do servidor: não há controle para ela na tela. Quando falta a chave, o `web_search` diz ao bot para pedi-la com `request_secret` (o formulário abre no chat) e não mandar o dono procurar nos Ajustes. Os motores continuam embutidos, **não** são conectores MCP. O Firecrawl aparece na mesma categoria, mas como **conector MCP** da galeria (fora da fila).

## O leitor: o que ele faz e o que recusa

Decisão do dono (opção (i) da pesquisa): **páginas públicas são lidas sem cartão pelo serviço leitor**, que **não é a máquina do bot nem usa a lista de hosts dela**. A máquina do bot continua com a lista fechada ([REDE.md](REDE.md)).

- **Só GET.** Sem cookies, sem credenciais, sem cabeçalhos do usuário e sem segredo (`web_read` não aceita cabeçalhos nem `{{secret:...}}`: quem precisa disso usa `web_fetch`). Só `http` e `https`, **portas 80 e 443**, URL com usuário e senha é recusada.
- **Só nome público.** IP literal, `localhost` e nomes de um só rótulo são recusados antes de qualquer rede. O nome é resolvido **uma vez**; se **qualquer** resposta cair em faixa privada, de loopback, link-local, de metadados ou reservada (as mesmas faixas de `isForbiddenAddress`, IPv4, IPv6 e IPv4 embutido) o nome é recusado, e a conexão vai para o endereço que foi validado (contra *DNS rebinding*). **Cada redirecionamento** (até 5) é conferido de novo, inclusive para onde aponta.
- **Limites:** 20 s de tempo, 5 MB depois de descomprimir (protege de *zip bomb*), texto cortado em 60 000 caracteres com aviso. Só texto: PDF, imagem e binário voltam como "não é texto" (use o shell).
- **robots.txt** (`robots-parser`, semântica da biblioteca, com o produto `SuupBot`), uma consulta por host por hora: `2xx` aplica as regras; `4xx` (sem arquivo) libera tudo; erro de servidor (`5xx`) **fecha o site por 5 minutos** (não adivinha) e o bot recebe "HTTP 503" do site. Um `robots.txt` que **não pôde ser buscado** (DNS, rota, TLS, tempo) também deixa o site sem ler, mas por **1 minuto** e dito como é: `unreachable`, "não consegui acessar o site agora, não foi o site que recusou" (nunca "o site pediu para não ler"). O que falhou (etapa, código do sistema, endereços tentados) vai **só para os registros** (`web_read: could not reach ...`; [USAR-NO-WINDOWS.md](USAR-NO-WINDOWS.md), 4b). O leitor tenta **cada endereço** do nome, em ordem (todos já conferidos como públicos), quando a conexão nem chega ao servidor (`ENETUNREACH`, `ECONNREFUSED`...): um IPv6 sem rota não derruba a leitura. O texto da RFC 9309 não pôde ser lido na pesquisa; o comportamento segue a biblioteca e essa convenção. O robô se identifica de verdade: **`SuupBot/<versão> (+<repositório>)`** (nunca finge ser um navegador); o endereço pode ser trocado em `web.reader.repositoryUrl`.
- **Ritmo:** no máximo um pedido por segundo ao mesmo host (fila por host; hosts diferentes não esperam um ao outro).
- **Conteúdo:** HTML vira um DOM do **jsdom que nunca roda scripts nem carrega nada** (os padrões do jsdom); o **Readability** escolhe o conteúdo principal e o **Turndown** escreve o Markdown. Links só se forem http(s) (resolvidos para endereço absoluto; `javascript:`, `data:` e `mailto:` caem, ficando o texto), imagens viram `[image: descrição]`. Sem artigo, cai para o texto do corpo e a saída diz isso. Nada disso decide "o que a página é" por padrão de texto: o Readability trabalha na estrutura do documento e o tipo de conteúdo é comparado por igualdade.
- O resultado entra no contexto no envelope `<<<EXTERNAL_DATA` (dado, nunca instrução), como o `web_fetch`.

### `render: true`

Para páginas que montam o conteúdo com JavaScript. Roda num **Chromium sem cabeça (Playwright) dentro do contêiner leitor**, nunca na máquina do bot:

- **O navegador não tem rede própria.** Todo pedido dele passa por um proxy local (o `EgressProxy` em modo `openWeb`: qualquer **nome** público, mas nunca IP, só 80/443, DNS uma vez e recusa de faixa privada, e conecta ao endereço validado). `loopback` não é exceção (`<-loopback>`), WebRTC fora do proxy está desligado e WebSocket é fechado.
- **Sem perfil e sem estado:** um contexto novo por página (sem cookies, armazenamento, *service workers* nem *downloads*); o contêiner é `--read-only` (só `/tmp` em memória). Imagens, mídia e fontes não são baixadas.
- **Limites:** 30 s no total, HTML cortado em 5 MB. O `robots.txt` e o ritmo valem antes de abrir a página.
- O Chromium roda com `--no-sandbox` **dentro** do contêiner (o contêiner, sem capacidades, sem raiz e sem rede interna, é a caixa), uma troca conhecida e documentada pela Playwright para contêineres sem perfil de seccomp próprio.

## A leitura só abre o que já apareceu

Decisão do dono (21/11/2026), pelo mesmo motivo da busca hospedada da Anthropic: **a URL é um canal de saída**. Um bot induzido por uma página poderia ler `https://atacante.exemplo/?dado=...` e entregar o dado no próprio endereço. Por isso:

> `web_read` abre **sem cartão** só um endereço que, depois de normalizado, é **exatamente igual** a um que **já apareceu nesta execução**: (a) numa **mensagem do usuário** (as da conversa, a do pedido, as que ele mandou durante a execução e as respostas às perguntas do bot), (b) num **resultado de `web_search`** (inclusive vindo do cache), ou (c) nos **links de uma página lida antes com `web_read`** nesta execução (mais o endereço final dela, depois dos redirecionamentos). **Qualquer outro endereço é um cartão**: "**Ler uma página nova: `<url>`**", com o endereço **inteiro** (a consulta também, sem cortar), nível `external_irreversible`. Recusar é uma recusa normal: nada é lido e o bot é avisado.

- **Normalização** (`normalizeWebUrl`, em `packages/core/src/web.ts`): a API `URL` do WHATWG. Esquema e host em minúsculas, porta padrão tirada, **fragmento (`#...`) descartado**; caminho e consulta **exatamente como estão**. Consequências, todas cobertas por teste: `https://a.com/x` e `https://a.com/x/` são **endereços diferentes** (cartão); `?a=1&b=2` e `?b=2&a=1` são diferentes; `%2F` e `%2f` e `/` são diferentes (a codificação não é tocada); `https://a.com` e `https://a.com/` são o mesmo (o padrão do WHATWG escreve o caminho vazio como `/`); outro host (`www.`), outra porta ou outro esquema são outro endereço. Só `http` e `https`.
- **De onde vêm os endereços, sem padrão de texto.** (a) A mensagem do usuário é partida em espaços e nos caracteres que cercam um endereço (`<`, `>`, aspas simples e duplas, crase, `|` e a barra invertida), cada lugar onde aparece **`http://` ou `https://`** (até no meio de um parêntese ou de um Markdown) é lido pela API `URL`, e, como uma frase pode terminar com `.`, `)` ou `,`, o trecho vale **com e sem** a pontuação final (até 6 caracteres tirados um a um): ambas as formas contam como escritas pelo usuário, e nenhuma outra. (b) Os resultados da busca e (c) os links da página são **declarados pela ferramenta** (`ToolOutput.webUrls`), não achados no texto: o leitor coleta os `<a href>` **da estrutura do documento** (antes de o Readability tirar o menu), resolve contra a URL da página, normaliza, tira repetidos e guarda até 500 por página. Um link que está num menu e não no texto lido também vale: ele é um endereço que a página mostrou, e o atacante não consegue montar um endereço novo com um dado do usuário.
- **Registro (para o replay ser determinístico).** O evento `tool_result` guarda `webUrls` (o que a chamada pôs à vista, já normalizado) e, no `web_read`, `urlProvenance`: `user_message`, `search_result` ou `page_link` (de onde veio o endereço) ou `approved` (era novo e o usuário aprovou o cartão). E o `web_read` declara a página que leu (`source: { url, title? }`: o endereço final, depois dos redirecionamentos, e o título), que o log guarda e o histórico de uma rotina mostra como fonte, com o ícone do site ([ROTINAS.md](ROTINAS.md)). O estado da execução (`RunState.webSeen`, mais as mensagens do usuário) sai **só do log**, então retomar e reproduzir (`suup replay`, que serve o resultado gravado e nunca lê nada) liberam os mesmos endereços. O cartão e a decisão têm os eventos de sempre (`approval_requested` com `tool: "web_read"`, `args.url`, `summary: "Read a new page: <url>"`).
- **Limites honestos:** (1) o endereço novo **dentro** de um domínio já visto continua sendo novo (caminho diferente = cartão), e é por isso que o cartão existe; (2) a igualdade é por endereço, não por domínio: um link de uma página que o atacante controla pode levar a `atacante.exemplo/?x`, **mas o atacante escreveu esse endereço na página, antes**, sem o dado do usuário; o que ele não consegue é fazer o bot **inventar** `?dado=<segredo>`; (3) a restrição vale para `web_read`, não para `web_fetch` (que já passa pela lista de hosts do bot) nem para os motores de busca (que recebem a consulta). Não há opção para desligar a restrição.

## O que isto NÃO impede (honesto)

- **`web_read` é um canal de saída, agora estreito.** Só um endereço que já apareceu abre sem cartão, e o resto passa pelo usuário, com a URL inteira à vista. Resta o caso de um endereço **que apareceu** e carrega informação por si (um link de rastreamento numa página), e o de o usuário aprovar um cartão sem ler. Quem não aceita desliga o leitor (`web.reader.enabled: false`) e volta ao caminho da máquina do bot, com cartões de host.
- **Um host é um canal** (como em REDE.md): os hosts dos motores recebem a consulta.
- **O leitor não olha dentro do HTTPS e confia nos servidores de nomes do computador** para resolver (validando o que voltou).
- **O IP é um só.** Se um serviço bloquear o IP do computador, ele fica sem aquele motor até a janela passar; o Suup não troca de IP.
- **A chave é do usuário.** Quem tem a chave de um motor gasta a cota dele; uma chave vazada em outro lugar é problema de quem a guardou (por isso: cofre ou variável, nunca arquivo de configuração).
- Injeção de instrução: tudo que vem é **dado** (envelope). Nada disso a detecta.

## Licenças (o projeto é MIT)

| Peça | Licença | Como entra |
|---|---|---|
| `@mozilla/readability` 0.6.0 | Apache-2.0 | biblioteca |
| `turndown` 7.2.5 | MIT | biblioteca |
| `jsdom` 31.0.1 | MIT | biblioteca |
| `robots-parser` 3.1.1 | MIT | biblioteca |
| `playwright-core` 1.65.1 | Apache-2.0 | biblioteca; o Chromium vem da imagem oficial `mcr.microsoft.com/playwright:v1.65.1-noble` (a tag **tem de ser** a versão do pacote) |

Tavily e Brave são **serviços de terceiros chamados pela API**, sob os termos de cada um (acima); nenhum código deles entra no Suup. O Suup **não** copia código do Firecrawl (repositório principal AGPL v3), e o SearXNG (AGPL v3) **não faz mais parte do projeto**.

## Usar um provedor pago ou uma API sua (opcional, por sua conta)

As duas contas da fila são do usuário: **Tavily** (1000 créditos por mês grátis, sem cartão) e **Brave Search API** (US$ 5 de crédito por mês; o plano de busca precisa ser ativado no painel dela). Quem quiser outro serviço de busca **pode** acrescentar um conector MCP pelo recurso de conectores que já existe: [CONECTORES.md](CONECTORES.md) (a chave vai para o cofre e é enviada como cabeçalho, nunca na URL). Isso é escolha do usuário e fica fora do padrão.

## Configuração

Tudo opcional. Os campos estão em [CONFIGURACAO.md](CONFIGURACAO.md#web-opcional). Resumo:

```json
"web": {
  "search": {
    "enabled": true,
    "engines": ["wikipedia", "arxiv", "stackoverflow", "tavily", "brave"],
    "languages": ["en", "pt"],
    "locale": "pt-BR",
    "general": { "order": ["tavily", "brave"] },
    "maxResults": 10,
    "limits": { "perMinute": 20, "perEngine": { "brave": 10 }, "maxWaitSeconds": 20 },
    "cache": { "enabled": true, "ttlMinutes": 180 }
  },
  "reader": { "enabled": true, "render": true, "image": "suup-reader:dev" }
}
```

A imagem do leitor é construída por `docker build -f docker/reader/Dockerfile -t suup-reader:dev .` (produção: o serviço `reader-image` do Compose). Sem navegador (disco pequeno): `--build-arg PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node`, e `render` fica indisponível. **A busca não tem imagem nem contêiner.** As chaves: `export TAVILY_API_KEY=...` e `export BRAVE_SEARCH_API_KEY=...` no ambiente do servidor, ou, melhor, pelo app (página do plugin), que as guarda com o motor.

## O app embutido (sidecar)

O app de desktop (`apps/sidecar`) liga a web **do mesmo jeito que o servidor**: o worker embutido é o mesmo runtime, e a configuração que o sidecar gera (`web`, em `apps/sidecar/src/config.ts`) diz só o que muda no computador do usuário: o **locale** do computador (um brasileiro recebe o Brasil e o português) e a imagem do leitor. Nada sobe até uma ferramenta pedir, como no servidor.

| Neste computador | `web_search` | `web_read` |
|---|---|---|
| **Sem Docker** (ou o Docker não responde) | tudo: a Wikipédia, o arXiv, o Stack Overflow e a fila geral, pelo proxy de saída em `127.0.0.1` do próprio sidecar (só os hosts exatos). Sem chave, a busca geral diz que nenhuma chave foi adicionada | lê **no próprio processo** (o mesmo código do leitor), sem `render`; pedir `render` responde que a renderização precisa do contêiner do leitor, com o motivo |
| **Com Docker** (qualquer proxy dos bots) | o mesmo (a busca não usa Docker) | pelo contêiner do leitor (`suup-reader:app-<versão>`), com `render` |

**As imagens**, como as da máquina dos bots: na etapa "Preparando a máquina dos bots…" da primeira abertura com Docker, o sidecar **constrói** a imagem do leitor a partir da receita que o app leva (`docker/reader/app.Dockerfile` com o programa já empacotado por `apps/sidecar/scripts/reader-image.mjs`; não precisa do repositório). Ela parte da imagem do Playwright (com o Chromium), de alguns GB: a primeira abertura demora mais. Se falhar, a máquina dos bots não é afetada: a leitura com navegador fica de fora e a ferramenta diz por quê (o log do app, `<dados do app>/logs`, diz o motivo).

**O que não foi verificado no Windows de verdade.** O Docker Desktop em si não existe no CI; como a busca já não usa Docker, o que sobra do arranjo é a imagem do leitor.

## Testes

- Cada motor da fila (`packages/web/test/general-engines.test.ts`, sem rede, com um servidor de mentira que responde o que a documentação diz e chaves inventadas): o endereço, o método, o `User-Agent` exato, **a chave no cabeçalho certo e fora da URL**, o corpo da Tavily (`basic`, `auto_parameters` falso, `country: "brazil"`, `language: "pt"`), os parâmetros da Brave (`country=BR`, `search_lang=pt-br`, `pt-pt` para Portugal, idioma que a lista não tem não é mandado, `freshness`), a leitura da resposta, e **cada erro**: `401`, `432`, `433`, `429` com e sem `Retry-After`, `5xx`, os códigos `QUOTA_LIMITED`/`CREDIT_EXHAUSTED`/`USAGE_LIMIT_EXCEEDED`/`RATE_LIMITED`/`SUBSCRIPTION_TOKEN_INVALID`/`INTERNAL` da Brave (decide o código, não o status), a última busca do mês gastando a cota, e o motor sem chave que nem conecta.
- A fila (`packages/web/test/search-queue.test.ts`, motores reais num servidor de mentira, relógio falso): Tavily responde e a Brave nem é perguntada; **sem cota na Tavily, a Brave responde** sozinha (com a linha de troca no registro); a janela de 1 hora e a volta; ritmo com `Retry-After`; fora do ar e chave recusada; **a fila toda sem cota** (mensagem, hits dos outros motores mantidos, ninguém perguntado de novo); sem chave numa e na outra; ordem configurável; limite do próprio Suup passando para o próximo; **a Brave nunca no cache** (sozinha, misturada, depois de uma falha da Tavily); a Tavily no cache; **nenhum texto de busca nem chave nos registros**; a contagem por motor e por mês (UTC).
- Unidade da busca educada (`packages/web/test/search-polite.test.ts`, com relógio falso): limite por minuto e fila (a terceira busca espera 50 s), recusa com "tente em X s" sem gastar a vaga, limite por motor deixando o motor de fora, ordem da fila; chave do cache (espaços, maiúsculas, motores, idioma, intervalo), acerto, erro, validade, reinício, cache que falha; motores que pediram para ser deixados em paz (janela, contagem regressiva, não perguntar na janela, perguntar de novo depois dela). No banco, `packages/db/test/web-search-cache.test.ts`, `packages/db/test/web-search-usage.test.ts` e `packages/runtime/test/web-search-cache.test.ts` (sobrevive a reinício).
- De onde vêm as chaves (`packages/runtime/test/search-keys.test.ts`): ambiente primeiro, depois o cofre, nomes trocados pela configuração, sem chave em lugar nenhum, cofre que falha. A configuração (`packages/runtime/test/config.test.ts`): a ordem, uma chave escrita no arquivo é recusada sem repeti-la, os campos do SearXNG que saíram. A fiação (`packages/runtime/test/web-wiring.test.ts`): estados dos motores para a tela, e a Brave fora de uma avaliação (`evals/test/runner.test.ts`). A API e o servidor (`packages/server/test/e2e-web-search.test.ts`) e a tela (`apps/desktop/src/features/settings/search-settings.test.tsx`).
- Unidade da leitura (`packages/core/src/web.test.ts`, `packages/tools/test/web-tools.test.ts`, `packages/tools/test/web-provenance.test.ts`, `packages/web/test/extract.test.ts`): normalização (barra final, fragmento, porta, caixa do host, codificação intacta), endereços de uma mensagem do usuário, de um resultado de busca e dos links de uma página lida, endereço novo vira cartão com a URL inteira, aprovar lê, recusar não lê, o log guarda a origem e o replay dá o mesmo log sem ler nada; a mensagem **"A busca geral está sem cota agora"** e o motor que respondeu aparecem no resultado da ferramenta.
- Unidade (rodam sempre): `robots.txt` (permitir/negar, regra mais longa, 404, 5xx, sem resposta, validade do cache), recusa de endereço privado **depois do DNS** (resolvedor falso: `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `::1`, `fd00::1`, IPv4 embutido; resposta mista; redirecionamento para nome privado, IP e `file:`), Readability e Turndown sobre HTML de teste, limites de tamanho (depois de descomprimir) e de tempo, ritmo por host, o proxy nos modos `openWeb` e anônimo, a configuração, a ferramenta (nível `read`, saída como dado externo, caminho da máquina do bot) e a linha do prompt.
- Renderizador (`packages/web/test/renderer.test.ts`): Chromium **real** do ambiente (ou do `playwright install`) lendo uma página que só existe depois do JavaScript, sem vazar um pedido a `127.0.0.1`, recusando nome privado e IP, sem cookies entre páginas. É pulado, avisando, se não há Chromium.
- Motores especializados (`packages/web/test/direct-engines.test.ts`, sem rede): para cada API um servidor de mentira confere o `User-Agent` **exato**, o host, o caminho e a consulta codificada, a leitura da resposta (inclusive gzip), `backoff`, cota, 429/403, o erro documentado do arXiv, XML malformado e respostas de outra forma (que falham fechadas), o ritmo de 3 s do arXiv com relógio falso e uma conexão por vez, TLS de verdade contra um servidor local (certificado conferido pelo nome do host), o proxy de saída **real** recusando `api.github.com`, `evil.example`, `html.duckduckgo.com` e `api.firecrawl.dev`, e o fluxo da busca com o governador e o cache. **Nenhum motor foi chamado de verdade** (ver [TESTES-REAIS.md](TESTES-REAIS.md)).
- Docker real (`SUUP_DOCKER_TESTS=1`, imagem do leitor em `SUUP_READER_IMAGE`, padrão `suup-reader:dev`; `SUUP_WEB_NETWORK_TESTS=1` acrescenta a leitura de uma página pública): o leitor tem `cap_drop ALL`, raiz só leitura, nenhuma porta nem montagem e nenhuma variável secreta; o leitor recusa endereços privados, `localhost`, metadados, `file:` e URL com senha; e **nenhum contêiner de busca** existe. O teste dentro da imagem **com** Chromium (`mcr.microsoft.com/playwright`, vários GB) precisa de CI. Um teste de renderização positiva **dentro** do contêiner não existe, porque a página de teste teria de ser pública (o leitor recusa privados, que é a garantia).
