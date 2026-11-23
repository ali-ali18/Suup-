# Busca e leitura de páginas na web

Pesquisa que fundamenta este desenho: [pesquisas/fase-4-busca-na-web.md](pesquisas/fase-4-busca-na-web.md) (e o adendo "busca e leitura próprias") e, para as APIs que o Suup chama ele mesmo, [pesquisas/fase-4-busca-apis-diretas.md](pesquisas/fase-4-busca-apis-diretas.md). Regra do dono, que manda em tudo aqui:

> "Não quero me prender a provedor." "Tem que ser 100% open, porque o projeto vai ser open."

## Regra do dono: o Suup não burla proteção de site

> "Sem resolver captcha e sem esconder que é um robô." (o dono, 21/11/2026)

Vale para tudo neste documento, e é checável no código:

- **Nenhum serviço de resolver captcha**, nenhum rodízio de IP ou de proxy para escapar de bloqueio, nenhum disfarce de navegador (impressão digital, `User-Agent` de navegador, cabeçalhos copiados de um). Um site que devolve captcha, `429` ou bloqueia o IP **disse não**: o Suup espera a janela passar, diz ao bot que a busca está indisponível e quando volta, e **não tenta de novo antes disso**.
- **O `robots.txt` é respeitado** (leitor, abaixo). O nome que o leitor usa é o honesto: `SuupBot/<versão> (+<repositório>)`.
- A busca e a leitura são **educadas** por desenho: limites por minuto, fila, cache, suspensão por motor (próxima seção, "Busca educada").
- O nome honesto vale para a Wikipédia, o arXiv e o Stack Overflow (que o Suup chama ele mesmo), para o DuckDuckGo e para o leitor. Não sobra lacuna: o único motor que passa pelo SearXNG é o DuckDuckGo, com o nome honesto ("O nome que o Suup usa").

Por isso a busca e a leitura são feitas por **peças de código aberto que o Suup mesmo roda**. Nenhuma API proprietária é exigida, nenhuma é o padrão, e a busca hospedada do provedor do modelo (a `web_search` da Anthropic, a da OpenAI) **não é usada**. O bot vê duas ferramentas embutidas, de nível `read` (sem cartão; `web_read` de um endereço que ainda não apareceu é a exceção, abaixo), concedidas por bot como as outras:

| Ferramenta | Faz | Como |
|---|---|---|
| `web_search` | devolve os melhores resultados (título, URL, trecho, motor) | **APIs oficiais** que o próprio Suup chama (Wikipédia, arXiv, Stack Overflow) e, para a web aberta, o contêiner **SearXNG** próprio (só o DuckDuckGo) |
| `web_read` | lê uma página pública e devolve o conteúdo principal em **Markdown**, com título, URL final, autor e data quando a página dá. **Sem cartão só para um endereço que já apareceu** (veja "A leitura só abre o que já apareceu"); outro endereço pede cartão | **serviço leitor**: baixa, extrai com Readability, converte com Turndown; `render: true` roda a página num Chromium sem cabeça |
| `web_fetch` (já existia) | uma chamada GET da máquina do bot, com cabeçalhos do cofre | continua para API e para URL interna; passa pela lista de hosts do bot |

## Arquitetura

```
 worker (tem o socket do Docker)
   |-- ferramenta web_search --HTTPS--> proxy de saída em 127.0.0.1 (só hosts exatos) --> Wikipédia, arXiv, Stack Overflow
   |     (o Suup mesmo pergunta, com o nome honesto; não precisa de Docker)
   |-- ferramenta web_search --docker exec--> [suup-searxng]  rede suup-search-net (INTERNA; só o DuckDuckGo)
   |                                              |  só sai por ->  proxy de motores (no worker, IP da rede)
   |                                              |                  só os hosts EXATOS dos motores ligados
   |-- ferramenta web_read --docker exec -i--> [suup-reader]  ponte comum (rota pública), sem porta, sem segredo
   |                                              |- leitor: DNS uma vez, recusa faixa privada, robots, ritmo
   |                                              '- renderizador: Chromium atrás de um proxy local que só aceita nomes públicos
   '-- web_read com o leitor desligado --> máquina do bot (lista de hosts, com cartões)
```

- **Ninguém abre porta.** O worker fala com os dois contêineres por `docker exec` (o socket que ele já tem), sem rota de rede do worker até eles, então o caminho do pedido não depende de onde o worker roda (host ou contêiner). Já o proxy de motores (abaixo) precisa de um endereço do worker alcançável pela rede interna, como o proxy dos bots em [REDE.md](REDE.md): no Linux, o gateway da rede; em contêiner, o IP fixo; **no Docker Desktop (Windows e macOS) isso ainda não foi exercitado** (o app embutido resolve a rede dos bots com um contêiner de saída próprio, e a busca precisará do mesmo tratamento). O SearXNG é consultado por um `wget` **de dentro** dele, contra o próprio loopback; o leitor é um processo longo (`docker exec -i ... node /app/dist/serve.js`, uma linha JSON por pedido), que guarda o cache do `robots.txt` e o ritmo por host.
- **Nada sobe até uma ferramenta pedir.** O primeiro `web_search` ou `web_read` inicia o que falta (o proxy de saída das APIs diretas e, só se há motor do SearXNG ligado, puxa a imagem do SearXNG se não houver, cria a rede, sobe os contêineres). Sem nenhum motor do SearXNG ligado, **o contêiner de busca nem é criado**. `suup doctor` mostra a situação sem iniciar nada.
- **Sem Docker:** `web_search` continua com as APIs diretas (Wikipédia, arXiv, Stack Overflow), que não usam Docker, e diz que o DuckDuckGo não respondeu (o contêiner não está no ar); se só motores do SearXNG estão ligados, responde que está indisponível (e por quê); `web_read` lê **no próprio processo** (o mesmo código do leitor, sem `render`). Sem a imagem do leitor construída, o mesmo.
- **Com o leitor desligado** (`web.reader.enabled: false`): `web_read` baixa pela **máquina do bot** (`curl` pela lista de hosts, com os cartões de `request_network_access`) e só converte o HTML em Markdown no worker (função pura, sem rede).
- **Custo:** nada por busca (sem provedor). Cada chamada fica no log da execução como `tool_call`/`tool_result` (nome, argumentos, duração, tamanho); a contagem por execução sai daí (`suup inspect`), não de um contador novo. O custo em tokens é o do texto que o bot lê.

## Os motores de busca

Há dois jeitos de o Suup perguntar a um motor, declarados em `EngineSpec.via` (`packages/web/src/engines.ts`):

- **`direct`: o Suup mesmo**, pela **API oficial** do serviço e com o **nome honesto** (`SuupBot/<versão> (+<repositório>)`), em `packages/web/src/direct-engines.ts`. A lista padrão tem os três.
- **`searxng`: o contêiner SearXNG**, só para quem não tem API (a web aberta, lida pela página de resultados): hoje só o DuckDuckGo (ligado).

**A lista padrão são só motores com uma API pública documentada, feita para programas, mais o DuckDuckGo**:

| Id | Motor | Quem pergunta | Acesso | Hosts (nomes exatos) | Padrão |
|---|---|---|---|---|---|
| `wikipedia` | Wikipédia | Suup | API de ações do MediaWiki (`list=search`, JSON) | `<idioma>.wikipedia.org` para cada idioma de `web.search.languages` (padrão `en`, `pt`) | ligado |
| `arxiv` | arXiv (artigos) | Suup | API do arXiv (`/api/query`, Atom), **um pedido a cada 3 s, uma conexão por vez** (termos de uso do arXiv) | `export.arxiv.org` | ligado |
| `stackoverflow` | Stack Overflow (perguntas) | Suup | API Stack Exchange 2.3 (`/search/advanced`, JSON), respeita `backoff` e a cota | `api.stackexchange.com` | ligado |
| `duckduckgo` | busca geral | SearXNG | lê a página HTML de resultados (POST) | `html.duckduckgo.com` | **ligado** (decisão do dono, 21/11/2026), no máximo **6 por minuto** |

**O GitHub não é motor de busca da web.** Regra do dono: *o que puder, vai para o MCP.* A busca no GitHub (repositórios, código, issues) é do **conector MCP do GitHub**, que o Suup já suporta ([CONECTORES.md](CONECTORES.md)); o mesmo vale para o Figma e para qualquer serviço que tenha conector. `github` não é um id válido em `web.search.engines` (a configuração é recusada com "motor desconhecido").

**As APIs diretas, em detalhe** (fatos e lacunas em [pesquisas/fase-4-busca-apis-diretas.md](pesquisas/fase-4-busca-apis-diretas.md)):

- **Como saem.** Por um **proxy de saída do worker** que escuta só em `127.0.0.1` (a mesma classe `EgressProxy`) e deixa passar **só os hosts exatos** dos motores diretos ligados; a conexão é um `CONNECT` ao host, porta 443, e o TLS vai até o serviço, conferindo o nome do certificado. Nenhum redirecionamento é seguido, sem cookie, sem credencial, tempo de 15 s e no máximo 2 MB por resposta. Não é preciso Docker.
- **Wikipédia.** `https://<idioma>.wikipedia.org/w/api.php?action=query&list=search&srsearch=...&srprop=snippet&format=json&formatversion=2`. O trecho vem com marcação HTML de destaque, que um analisador de HTML reduz a texto. Com `language` o Suup pergunta só àquela edição (se estiver nos idiomas configurados); sem, a cada idioma configurado, um depois do outro. HTTP 429 suspende por 3 min; 403, por 1 h; o erro `ratelimited` da API, por 3 min.
- **arXiv.** `https://export.arxiv.org/api/query?search_query=all:<termo> AND all:<termo>...`. Cada palavra da consulta vira um termo `all:`; os caracteres da sintaxe de consulta e as palavras `AND`, `OR`, `ANDNOT` escritas como termo são deixados de fora, para que uma palavra nunca mude o formato da consulta. A resposta é Atom, lida por um **analisador de XML de verdade** (o do jsdom, sem regex); o `<entry>` de erro documentado vira uma recusa com a explicação do arXiv. **Ritmo:** uma fila **só do arXiv**, um pedido por vez, com **3 s depois do fim do anterior** (os termos de uso do arXiv: "no more than one request every three seconds", uma conexão por vez), além do limite por minuto de todos os motores. Que `export.arxiv.org` responde em HTTPS não foi conferido (o manual só mostra `http://`).
- **Stack Overflow.** `https://api.stackexchange.com/2.3/search/advanced?q=...&site=stackoverflow&sort=relevance&order=desc&pagesize=N`. O título vem com entidades HTML (decodificadas); o trecho é montado dos campos (pontuação, respostas, etiquetas), sem o corpo da pergunta. **`backoff`** da resposta: os resultados são mantidos e o Suup deixa o motor em paz por aquele tempo (até 1 dia); **cota esgotada** (`quota_remaining` zero) e `throttle_violation` suspendem por 1 h. **Nenhuma documentação do Stack Exchange foi lida** (host bloqueado): o endereço, os nomes dos campos e o comportamento acima são suposição, e o motor **falha fechado** (mensagem clara, e suspenso quando a API manda parar) com qualquer resposta que não tenha essa forma. Conferir na primeira vez numa máquina com rede.
- **Janelas de suspensão** (3 min, 1 h) **são escolha do Suup**, não número dos serviços. **`time_range` é ignorado** pelos três.
- **Licença e atribuição.** Os metadados do arXiv são CC0 (termos de uso do arXiv); o texto da Wikipédia e as perguntas do Stack Overflow têm licenças próprias que **não foram lidas**: a ferramenta devolve só título, link e um trecho curto, e o bot é instruído a citar a URL.

Os hosts do DuckDuckGo foram lidos **no código-fonte do motor, na imagem fixada** (abaixo); os das APIs diretas são os endereços das próprias APIs (pesquisa). Nesta máquina de desenvolvimento os motores não são alcançáveis (DNS bloqueado), então **nenhum motor foi exercitado de verdade**: os testes usam um servidor de mentira para cada API e conferem o `User-Agent` exato, a consulta, a leitura da resposta, e o proxy de saída real recusando qualquer outro host.

**Por que assim, e o que foi deixado de fora:**

- **Google e Bing não estão na lista, de propósito.** O `robots.txt` do Google (lido em 21/11/2026) tem `Disallow: /search` para todos os robôs: um metabuscador que raspa a página de resultados do Google vai contra a diretiva do próprio site, qualquer que seja o termo de uso (não lido). O Bing ficou fora pela mesma cautela (termos não lidos).
- **`duckduckgo` está ligado por decisão do dono** (21/11/2026), com a troca dita aqui: ele **lê a página de resultados**, e **os termos de uso e o `robots.txt` dele não foram verificados** (host bloqueado na pesquisa e nesta máquina). Em troca, a busca ganha a web aberta. Para o risco ser pequeno: **taxa baixa (6 por minuto, e `web.search.limits.perEngine` pode baixar mais)**, **nome honesto** (próxima seção), **nenhuma tentativa de contornar** o captcha (ao primeiro, o Suup para de perguntar a ele por uma hora) e o IP do computador é o único que ele vê. O módulo do motor na imagem fixada diz que o DuckDuckGo **bloqueia o IP** de quem pergunta demais ou parece robô e que isso pode durar cerca de uma hora: é o que acontece se ele bloquear, e a ferramenta conta ao bot. Quem não quer isso tira `duckduckgo` de `web.search.engines`.
- **Brave e Startpage foram removidos** (o SearXNG mandaria o `User-Agent` de navegador sorteado dele; decisão do dono): uma configuração antiga que os cite é recusada com "motor desconhecido". **Google e Bing continuam fora.** Sem nenhum motor geral a busca cobre enciclopédia, artigos, perguntas técnicas e código, **não a web aberta**; o texto da ferramenta diz isso ao modelo.
- **Hosts do DuckDuckGo, lidos no módulo da imagem fixada** (`searx/engines/duckduckgo.py`, commit `541c6c3cb`, lido em 21/11/2026): a busca faz **POST só em `https://html.duckduckgo.com/html/`** (`ddg_url`); `duckduckgo.com` aparece ali apenas em `fetch_traits` (função de manutenção, offline, que nenhuma busca executa) e em outros motores do DuckDuckGo (imagens, notícias), que **não** estão ligados. Por isso a lista de saída tem **só `html.duckduckgo.com`** (a versão anterior desta lista trazia também `duckduckgo.com`, sem necessidade). **Não foi exercitado contra o DuckDuckGo de verdade** (esta máquina não alcança os motores); o teste de Docker real confere, com a imagem fixada, que o contêiner sobe com o motor ligado e que o SearXNG carrega o `duckduckgo` com o `User-Agent` do Suup e só os motores da lista.
- **Captcha e 429** (mais em "Busca educada"). O SearXNG suspende sozinho o motor que devolve captcha ou 429 (3600 s para captcha, 180 s para 429/acesso negado; vale para a instância toda, porque todos saem pelo mesmo IP). A ferramenta **diz quais motores não responderam, por quê e até quando**, e devolve o que os outros deram. O limitador do SearXNG fica **desligado**: é uso de um só usuário, dentro de uma rede que ninguém de fora alcança (com o limitador ligado, o formato JSON teria teto de 4 pedidos por hora por IP, segundo a pesquisa). Quem limita aqui é o próprio Suup.

## Busca educada

Código: `packages/web/src/search-governor.ts` (limites e suspensões), `search-cache.ts` (cache) e `search.ts` (o fluxo). Tudo configurável em `web.search.limits` e `web.search.cache` ([CONFIGURACAO.md](CONFIGURACAO.md)).

**Limites por minuto.** Janela deslizante de 60 s, no geral (padrão **20 buscas por minuto**) e por motor (padrão de cada motor, declarado em `engines.ts`: Wikipédia 30, arXiv 15, Stack Overflow 10, **DuckDuckGo 6**; `limits.perEngine` troca). Uma busca que passaria do limite **espera numa fila curta**, em ordem, até o primeiro instante em que cabe, **desde que a espera não passe de `limits.maxWaitSeconds`** (padrão 20 s). Passando disso o resultado é um erro claro, **"muitas buscas no último minuto... tente em cerca de X s"** (`rate_limited` com `retryInSeconds`), e o bot é instruído a **não repetir agora** e, se puder, usar `schedule_return`. Se só **um motor** está acima do seu limite e os outros estão livres, a busca vai **sem aquele motor** e diz qual ficou de fora e quando ele volta (`throttled`). A fila é de um processo só; o limite não é compartilhado entre o worker e outros processos.

**Cache.** Uma busca com a mesma **consulta em forma simples** (aparada, espaços reunidos dividindo e juntando o texto, minúscula; **sem expressão regular**), os mesmos **motores**, idioma e intervalo de tempo é respondida do cache, pelo prazo `cache.ttlMinutes` (padrão **180 min = 3 h**), **sem consultar motor nenhum**, e a resposta diz **que veio do cache e de quando foi feita**, e que motores não responderam naquela hora. Só se guarda busca que achou algo. O cache fica **no banco** (tabela `web_search_cache`, migração 0024), então sobrevive a reinício e vale para o worker e para o app; um cache que falha não derruba a busca. `cache.enabled: false` desliga. Os URLs de uma resposta do cache também contam como "já apareceram" para `web_read`.

**Motores suspensos.** O JSON do SearXNG traz, por motor que não respondeu, só um texto (`CAPTCHA`, `too many requests`, `access denied`, `timeout`...; com o prefixo `Suspended: ` quando ele nem chegou a perguntar). O Suup compara esse texto **por igualdade exata** com os que o SearXNG escreve (`searx/webutils.py`), sem padrão, e para os três de recusa aplica a janela do `settings.yml` do SearXNG: **captcha 3600 s; muitas requisições 180 s; acesso negado 180 s**. Os outros textos não têm janela conhecida e só são repassados. Enquanto a janela dura o Suup **não pergunta àquele motor** (a resposta diz "volta em cerca de 50 min"). Isto vale também para o DuckDuckGo, cujo módulo usa suspensão **zero** no captcha (para "não aumentar a reputação ruim do IP"): o Suup o suspende mesmo assim, por escolha, para nunca insistir. A janela é contada a partir do primeiro captcha que o Suup viu; se o processo reiniciou, conta a partir da próxima resposta (um limite superior). Quando **todo motor geral ligado** está fora (suspenso ou acima do limite), a resposta traz **"a busca geral está indisponível agora, volta em cerca de X min"** e instrui o bot a usar `schedule_return` em vez de tentar de novo; o que vier é só de enciclopédia, artigos, código e perguntas técnicas. Se **nenhum** motor pode ser perguntado, o serviço de busca nem é chamado.

Os motores que o **Suup mesmo pergunta** passam pela mesma contabilidade, com uma diferença: o motor diz o **porquê e por quanto tempo** (`windowSeconds`), em vez de o Suup ler um texto do SearXNG. HTTP 429 suspende por 180 s e 403 por 3600 s (escolhas do Suup); o `backoff` do Stack Exchange suspende pelo tempo que ele mandou (os resultados da própria resposta são mantidos); a cota esgotada e `throttle_violation`, por 3600 s. Falha sem janela (tempo esgotado, resposta fora do formato) só aparece como "não respondeu", sem suspender. O limite por minuto de cada motor e o cache valem igual. Quando os motores do SearXNG e os diretos respondem juntos, as listas são **intercaladas** (o primeiro de cada, depois o segundo de cada), sem URL repetida.

## O nome que o Suup usa (e a lacuna que sobra)

Decisão do dono (22/11/2026): **o Suup chama a Wikipédia, o arXiv e o Stack Overflow ele mesmo, pelas APIs oficiais, com o nome honesto**; o SearXNG fica só para o DuckDuckGo. O motivo: o SearXNG da imagem fixada escolhe um `User-Agent` de navegador sorteado a cada pedido a todo motor que não leia o nome de um atributo (`searx/search/processors/online.py`, `headers["User-Agent"] = gen_useragent()`, lido no commit `541c6c3cb`), e não há configuração que o troque (`outgoing.useragent_suffix` existe no `settings.yml`, mas nenhum código desta versão o lê). Trocar exigiria modificar o SearXNG (o dever de oferecer o código-fonte da AGPL, seção "Licenças") ou terminar o HTTPS num proxy nosso (o que o desenho recusa). Chamar as APIs direto evita as duas saídas.

- O **leitor** manda `SuupBot/<versão> (+<repositório>)` e lê o `robots.txt` (abaixo).
- A **Wikipédia, o arXiv e o Stack Overflow** recebem o mesmo nome, em todo pedido (`createDirectGet`, `packages/web/src/direct-http.ts`; o teste confere o cabeçalho **exato** de cada motor). O endereço do repositório pode ser trocado em `web.reader.repositoryUrl`.
- O **DuckDuckGo**: o módulo do motor lê o `User-Agent` de um atributo (`_HTTP_User_Agent`) que o SearXNG preenche a partir da configuração do motor; o Suup o aponta para o nome honesto, no `settings.yml` gerado (`EngineSpec.userAgentAttribute`). Sem isso o módulo mandaria um `User-Agent` de navegador sorteado. **O DuckDuckGo pode recusar um robô honesto**: é o preço da regra, e nesse caso o motor aparece como não respondendo (captcha ou bloqueio) e fica suspenso. O módulo avisa que alguns `User-Agent` são filtrados.
- **Sem lacuna de nome.** Brave e Startpage, os únicos que sairiam pelo SearXNG com o `User-Agent` de navegador sorteado dele, foram removidos; o DuckDuckGo leva o nome honesto.

### Trocar os motores

No `suup.config.json` (nenhuma tela por ora; um liga/desliga por motor, vindo do arquivo):

```json
"web": {
  "search": {
    "engines": ["wikipedia", "arxiv", "stackoverflow", "duckduckgo"],
    "languages": ["en", "pt"]
  }
}
```

Id desconhecido (`github`, por exemplo) é recusado ao carregar a configuração. Mudar a lista (ou os idiomas) muda os hosts que os proxies de saída deixam passar e o `settings.yml` do contêiner, que é **recriado** no próximo uso. Acrescentar um motor novo ao código é uma linha em `packages/web/src/engines.ts` (`via`, hosts exatos, se é API ou raspagem) mais, para um motor `direct`, um módulo em `direct-engines.ts` (com pesquisa antes, em `docs/pesquisas/`) e, para um `searxng`, a leitura do código do motor para os hosts.

## O que o contêiner de busca alcança, e por quê não guarda segredo

- Vive **sozinho** numa rede Docker **interna** (`suup-search-net`): sem rota para fora, sem DNS para fora (testado com Docker real: `wget` direto a um IP e a um nome falha). O único caminho é um **proxy de motores** (a mesma classe `EgressProxy` da rede dos bots, com uma lista fixa), que escuta no endereço do worker nessa rede e deixa passar **só os hosts exatos** dos motores ligados; IP literal, faixa privada e porta fora de 80/443 são recusados como em [REDE.md](REDE.md). Um host fora da lista recebe `403`, e a recusa vai para o log do worker.
- Não tem **nenhum segredo do Suup**: sem chaves de provedor, sem token, sem banco. O que ele recebe é uma `secret_key` aleatória do próprio SearXNG (assina cookies de uma instância que ninguém alcança), **gerada na criação do contêiner e passada por variável de ambiente (`SEARXNG_SECRET`), nunca num arquivo nem no git**.
- Endurecido: `cap_drop ALL` (só `CHOWN`, `SETGID`, `SETUID` que a entrada da imagem usa), `no-new-privileges`, 512 MB sem swap, 1 CPU, 256 processos.
- **Na produção por Compose** o worker entra na rede `search-net` com IP fixo (`172.29.78.2`) e o proxy escuta nele (`web.search.proxy` no `suup.config.prod.example.json`), como a rede dos bots. **No Compose de desenvolvimento** o serviço opcional `searxng` (perfil `web`) usa a saída do host, sem a lista: só para desenvolvimento.
- O que **sai** do computador numa busca: o texto da consulta, para os motores ligados, com o IP do computador. É isto que um metabuscador faz; um usuário que não quer isso desliga a busca (`web.search.enabled: false`) ou usa os motores de API só.

## O leitor: o que ele faz e o que recusa

Decisão do dono (opção (i) da pesquisa): **páginas públicas são lidas sem cartão pelo serviço leitor**, que **não é a máquina do bot nem usa a lista de hosts dela**. A máquina do bot continua com a lista fechada ([REDE.md](REDE.md)).

- **Só GET.** Sem cookies, sem credenciais, sem cabeçalhos do usuário e sem segredo (`web_read` não aceita cabeçalhos nem `{{secret:...}}`: quem precisa disso usa `web_fetch`). Só `http` e `https`, **portas 80 e 443**, URL com usuário e senha é recusada.
- **Só nome público.** IP literal, `localhost` e nomes de um só rótulo são recusados antes de qualquer rede. O nome é resolvido **uma vez**; se **qualquer** resposta cair em faixa privada, de loopback, link-local, de metadados ou reservada (as mesmas faixas de `isForbiddenAddress`, IPv4, IPv6 e IPv4 embutido) o nome é recusado, e a conexão vai para o endereço que foi validado (contra *DNS rebinding*). **Cada redirecionamento** (até 5) é conferido de novo, inclusive para onde aponta.
- **Limites:** 20 s de tempo, 5 MB depois de descomprimir (protege de *zip bomb*), texto cortado em 60 000 caracteres com aviso. Só texto: PDF, imagem e binário voltam como "não é texto" (use o shell).
- **robots.txt** (`robots-parser`, semântica da biblioteca, com o produto `SuupBot`), uma consulta por host por hora: `2xx` aplica as regras; `4xx` (sem arquivo) libera tudo; erro de servidor ou sem resposta **fecha o site por 5 minutos** (não adivinha). O texto da RFC 9309 não pôde ser lido na pesquisa; o comportamento segue a biblioteca e essa convenção. O robô se identifica de verdade: **`SuupBot/<versão> (+<repositório>)`** (nunca finge ser um navegador); o endereço pode ser trocado em `web.reader.repositoryUrl`.
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
- **O IP é um só.** Se um motor bloquear o IP do computador, a instância toda fica sem ele (suspensão do SearXNG).
- Injeção de instrução: tudo que vem é **dado** (envelope). Nada disso a detecta.

## Licenças (o projeto é MIT)

| Peça | Licença | Como entra |
|---|---|---|
| `@mozilla/readability` 0.6.0 | Apache-2.0 | biblioteca |
| `turndown` 7.2.5 | MIT | biblioteca |
| `jsdom` 31.0.1 | MIT | biblioteca |
| `robots-parser` 3.1.1 | MIT | biblioteca |
| `playwright-core` 1.65.1 | Apache-2.0 | biblioteca; o Chromium vem da imagem oficial `mcr.microsoft.com/playwright:v1.65.1-noble` (a tag **tem de ser** a versão do pacote) |
| **SearXNG** | **AGPL v3** | **serviço separado, sem modificação** |

**Por que o SearXNG (AGPL) não contamina o Suup.** O que a licença exige de quem oferece o programa por rede (seção 13, texto lido na pesquisa) começa com "*if you modify the Program*": a obrigação de oferecer o código-fonte aos usuários da interação remota nasce **ao modificar**. Aqui o SearXNG roda **sem nenhuma alteração**: a imagem oficial, com a versão **fixada** (`2026.3.25-541c6c3cb`, nunca `latest`), configurada **só por arquivo de configuração** (`settings.yml`) e por variável de ambiente, num **contêiner à parte**, e o Suup só o chama por HTTP/JSON (um programa separado, sem ligar código). Não copiamos código dele para o Suup. **Regra:** não alterar código, modelo (template) nem motor do SearXNG sem revisão jurídica antes; se isso um dia for preciso, a oferta de código-fonte da seção 13 passa a valer para a versão modificada. (Se usar a API HTTP de um serviço AGPL torna o código do cliente AGPL **não foi verificado** na pesquisa; a leitura comum é que não, por serem programas separados. Isto é uma leitura técnica, não parecer jurídico.) Também **não copiamos código do Firecrawl** (repositório principal AGPL v3).

## Usar um provedor pago ou uma API sua (opcional, por sua conta)

O Suup **não traz** adaptadores de Brave, Tavily nem Exa, e nada aqui os exige. Quem quiser, **pode** acrescentar um conector MCP de busca (o de Brave, Tavily, Exa, Firecrawl ou qualquer outro) pelo recurso de conectores que já existe: [CONECTORES.md](CONECTORES.md) (`suup connectors add ...`; a chave vai para o cofre e é enviada como cabeçalho, nunca na URL; o conector stdio roda num contêiner próprio e só sai pelos `egressHosts` que você der). As ferramentas dele entram no bot como qualquer ferramenta de conector, com a aprovação da concessão por ferramenta. Isso é escolha do usuário e fica fora do padrão.

Quem **já tem um SearXNG próprio** (inclusive o `docker compose --profile web up -d searxng` do repositório) aponta o Suup para ele: `"web": { "search": { "url": "http://127.0.0.1:8080" } }` (o formato `json` precisa estar ligado em `search.formats`). Nesse modo o Suup não sobe contêiner de busca.

## Configuração

Tudo opcional. Os campos estão em [CONFIGURACAO.md](CONFIGURACAO.md#web-opcional). Resumo:

```json
"web": {
  "search": {
    "enabled": true,
    "engines": ["wikipedia", "arxiv", "stackoverflow", "duckduckgo"],
    "languages": ["en", "pt"],
    "maxResults": 10,
    "limits": { "perMinute": 20, "perEngine": { "duckduckgo": 6 }, "maxWaitSeconds": 20 },
    "cache": { "enabled": true, "ttlMinutes": 180 }
  },
  "reader": { "enabled": true, "render": true, "image": "suup-reader:dev" }
}
```

Imagens: o SearXNG é puxado sozinho; a do leitor é construída por `docker build -f docker/reader/Dockerfile -t suup-reader:dev .` (produção: o serviço `reader-image` do Compose). Sem navegador (disco pequeno): `--build-arg PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node`, e `render` fica indisponível.

## O app embutido (sidecar)

O sidecar do app (`apps/sidecar`, ramo `feat/app-embutido`, ainda **não** unido a este ramo) deve chamar `startWebServices` de `@suup/web` junto da etapa "Preparando a máquina dos bots…" (sem Docker o app segue só com `web_read` no próprio processo). O worker do runtime já faz isso sozinho, sob demanda; falta ligar o sidecar quando os ramos se juntarem. **Não foi feito aqui por não existir `apps/sidecar` neste ramo.**

## Testes

- Unidade da busca educada (`packages/web/test/search-polite.test.ts`, com relógio falso): limite por minuto e fila (a terceira busca espera 50 s), recusa com "tente em X s" sem gastar a vaga, limite por motor deixando o motor de fora, ordem da fila; chave do cache (espaços, maiúsculas, motores, idioma, intervalo), acerto, erro, validade, reinício, cache que falha; motores suspensos (janelas de 3600 s e 180 s, contagem regressiva, não perguntar na janela, perguntar de novo depois dela, "busca geral indisponível"); no banco, `packages/db/test/web-search-cache.test.ts` e `packages/runtime/test/web-search-cache.test.ts` (sobrevive a reinício). Hosts do DuckDuckGo na lista de saída (igualdade exata) em `search.test.ts`.
- Unidade da leitura (`packages/core/src/web.test.ts`, `packages/tools/test/web-tools.test.ts`, `packages/tools/test/web-provenance.test.ts`, `packages/web/test/extract.test.ts`): normalização (barra final, fragmento, porta, caixa do host, codificação intacta), endereços de uma mensagem do usuário, de um resultado de busca e dos links de uma página lida, endereço novo vira cartão com a URL inteira, aprovar lê, recusar não lê, o log guarda a origem e o replay dá o mesmo log sem ler nada.
- Unidade (rodam sempre): resultado e envelope, motores suspensos, `robots.txt` (permitir/negar, regra mais longa, 404, 5xx, sem resposta, validade do cache), recusa de endereço privado **depois do DNS** (resolvedor falso: `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `::1`, `fd00::1`, IPv4 embutido; resposta mista; redirecionamento para nome privado, IP e `file:`), Readability e Turndown sobre HTML de teste, limites de tamanho (depois de descomprimir) e de tempo, ritmo por host, `settings.yml` (igual ao arquivo versionado), o proxy nos modos `openWeb` e anônimo, a configuração, a ferramenta (nível `read`, saída como dado externo, caminho da máquina do bot) e a linha do prompt.
- Renderizador (`packages/web/test/renderer.test.ts`): Chromium **real** do ambiente (ou do `playwright install`) lendo uma página que só existe depois do JavaScript, sem vazar um pedido a `127.0.0.1`, recusando nome privado e IP, sem cookies entre páginas. É pulado, avisando, se não há Chromium.
- Motores diretos (`packages/web/test/direct-engines.test.ts`, sem rede): para cada API um servidor de mentira confere o `User-Agent` **exato**, o host, o caminho e a consulta codificada, a leitura da resposta (inclusive gzip), `backoff`, cota, 429/403, o erro documentado do arXiv, XML malformado e respostas de outra forma (que falham fechadas), o ritmo de 3 s do arXiv com relógio falso e uma conexão por vez, TLS de verdade contra um servidor local (certificado conferido pelo nome do host), o proxy de saída **real** recusando `api.github.com`, `evil.example` e qualquer outro host fora da lista, e o fluxo da busca com o governador e o cache. **Nenhum motor foi chamado de verdade** (ver [TESTES-REAIS.md](TESTES-REAIS.md)).
- Docker real (`SUUP_DOCKER_TESTS=1`, imagem do leitor em `SUUP_READER_IMAGE`, padrão `suup-reader:dev`; `SUUP_WEB_NETWORK_TESTS=1` acrescenta a leitura de uma página pública): a imagem **oficial** do SearXNG sobe com o `settings.yml` gerado e responde JSON; o contêiner não tem rota nem DNS para fora; o proxy recusa host fora da lista e endereço privado; o leitor tem `cap_drop ALL`, raiz só leitura, nenhuma porta nem montagem e nenhuma variável secreta; o leitor recusa endereços privados, `localhost`, metadados, `file:` e URL com senha. Rodou nesta máquina com a imagem do leitor **sem navegador**; o teste dentro da imagem **com** Chromium (`mcr.microsoft.com/playwright`, vários GB) precisa de CI. Um teste de renderização positiva **dentro** do contêiner não existe, porque a página de teste teria de ser pública (o leitor recusa privados, que é a garantia).
