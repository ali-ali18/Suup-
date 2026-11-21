# Busca e leitura de páginas na web

Pesquisa que fundamenta este desenho: [pesquisas/fase-4-busca-na-web.md](pesquisas/fase-4-busca-na-web.md) (e o adendo "busca e leitura próprias"). Regra do dono, que manda em tudo aqui:

> "Não quero me prender a provedor." "Tem que ser 100% open, porque o projeto vai ser open."

Por isso a busca e a leitura são feitas por **peças de código aberto que o Suup mesmo roda**. Nenhuma API proprietária é exigida, nenhuma é o padrão, e a busca hospedada do provedor do modelo (a `web_search` da Anthropic, a da OpenAI) **não é usada**. O bot vê duas ferramentas embutidas, de nível `read` (sem cartão), concedidas por bot como as outras:

| Ferramenta | Faz | Como |
|---|---|---|
| `web_search` | devolve os melhores resultados (título, URL, trecho, motor) | contêiner **SearXNG** próprio, API JSON |
| `web_read` | lê uma página pública e devolve o conteúdo principal em **Markdown**, com título, URL final, autor e data quando a página dá | **serviço leitor**: baixa, extrai com Readability, converte com Turndown; `render: true` roda a página num Chromium sem cabeça |
| `web_fetch` (já existia) | uma chamada GET da máquina do bot, com cabeçalhos do cofre | continua para API e para URL interna; passa pela lista de hosts do bot |

## Arquitetura

```
 worker (tem o socket do Docker)
   |-- ferramenta web_search --docker exec--> [suup-searxng]  rede suup-search-net (INTERNA)
   |                                              |  só sai por ->  proxy de motores (no worker, IP da rede)
   |                                              |                  só os hosts EXATOS dos motores ligados
   |-- ferramenta web_read --docker exec -i--> [suup-reader]  ponte comum (rota pública), sem porta, sem segredo
   |                                              |- leitor: DNS uma vez, recusa faixa privada, robots, ritmo
   |                                              '- renderizador: Chromium atrás de um proxy local que só aceita nomes públicos
   '-- web_read com o leitor desligado --> máquina do bot (lista de hosts, com cartões)
```

- **Ninguém abre porta.** O worker fala com os dois contêineres por `docker exec` (o socket que ele já tem), sem rota de rede do worker até eles, então o caminho do pedido não depende de onde o worker roda (host ou contêiner). Já o proxy de motores (abaixo) precisa de um endereço do worker alcançável pela rede interna, como o proxy dos bots em [REDE.md](REDE.md): no Linux, o gateway da rede; em contêiner, o IP fixo; **no Docker Desktop (Windows e macOS) isso ainda não foi exercitado** (o app embutido resolve a rede dos bots com um contêiner de saída próprio, e a busca precisará do mesmo tratamento). O SearXNG é consultado por um `wget` **de dentro** dele, contra o próprio loopback; o leitor é um processo longo (`docker exec -i ... node /app/dist/serve.js`, uma linha JSON por pedido), que guarda o cache do `robots.txt` e o ritmo por host.
- **Nada sobe até uma ferramenta pedir.** O primeiro `web_search` ou `web_read` inicia o que falta (puxa a imagem do SearXNG se não houver, cria a rede, sobe os contêineres). `suup doctor` mostra a situação sem iniciar nada.
- **Sem Docker:** `web_search` responde que está indisponível (e por quê); `web_read` lê **no próprio processo** (o mesmo código do leitor, sem `render`). Sem a imagem do leitor construída, o mesmo.
- **Com o leitor desligado** (`web.reader.enabled: false`): `web_read` baixa pela **máquina do bot** (`curl` pela lista de hosts, com os cartões de `request_network_access`) e só converte o HTML em Markdown no worker (função pura, sem rede).
- **Custo:** nada por busca (sem provedor). Cada chamada fica no log da execução como `tool_call`/`tool_result` (nome, argumentos, duração, tamanho); a contagem por execução sai daí (`suup inspect`), não de um contador novo. O custo em tokens é o do texto que o bot lê.

## Os motores de busca

O SearXNG consulta vários motores e junta os resultados. **A lista padrão são só motores com uma API pública documentada, feita para programas**:

| Id | Motor | Acesso | Hosts (nomes exatos) | Padrão |
|---|---|---|---|---|
| `wikipedia` | Wikipédia (resumos) | API REST | `<idioma>.wikipedia.org` para cada idioma de `web.search.languages` (padrão `en`, `pt`) | ligado |
| `arxiv` | arXiv (artigos) | API | `export.arxiv.org` | ligado |
| `stackoverflow` | Stack Overflow (perguntas) | API Stack Exchange | `api.stackexchange.com` | ligado |
| `github` | GitHub (repositórios) | API de busca | `api.github.com` | ligado |
| `duckduckgo` | busca geral | lê a página HTML de resultados | `html.duckduckgo.com`, `duckduckgo.com` | **desligado** |
| `brave` | busca geral | lê a página HTML de resultados | `search.brave.com` | **desligado** |
| `startpage` | busca geral | lê a página HTML de resultados | `www.startpage.com` | **desligado** |

Os hosts foram lidos **no código-fonte de cada motor, na imagem fixada** (por exemplo `export.arxiv.org/api/query`, `api.stackexchange.com/2.3/search/advanced`, `api.github.com/search/repositories`, `{wiki_netloc}/api/rest_v1/page/summary/...`). Nesta máquina de desenvolvimento os motores não são alcançáveis, e mesmo assim o proxy de motores registrou os pedidos exatos a `en.wikipedia.org`, `export.arxiv.org` e `api.stackexchange.com` (a recusa foi só a falha de DNS do ambiente), e o `api.github.com` passou pela lista.

**Por que assim, e o que foi deixado de fora:**

- **Google e Bing não estão na lista, de propósito.** O `robots.txt` do Google (lido em 21/11/2026) tem `Disallow: /search` para todos os robôs: um metabuscador que raspa a página de resultados do Google vai contra a diretiva do próprio site, qualquer que seja o termo de uso (não lido). O Bing ficou fora pela mesma cautela (termos não lidos).
- **Os motores gerais (`duckduckgo`, `brave`, `startpage`) leem a página de resultados**, e **os termos de uso e o `robots.txt` deles não foram verificados** (hosts bloqueados na pesquisa e nesta máquina). Pela regra "na dúvida, conservador", ficam **desligados**. É uma decisão do dono: depois de ler os termos do motor, ligue-o na configuração (abaixo). Sem nenhum motor geral a busca cobre enciclopédia, artigos, perguntas técnicas e código, **não a web aberta**; o texto da ferramenta diz isso ao modelo.
- **Captcha e 429.** O SearXNG suspende sozinho o motor que devolve captcha ou 429 (3600 s para captcha, 180 s para 429/acesso negado; vale para a instância toda, porque todos saem pelo mesmo IP). A ferramenta **diz quais motores não responderam** (`suspended`) e devolve o que os outros deram. O limitador do SearXNG fica **desligado**: é uso de um só usuário, dentro de uma rede que ninguém de fora alcança (com o limitador ligado, o formato JSON teria teto de 4 pedidos por hora por IP, segundo a pesquisa).

### Trocar os motores

No `suup.config.json` (nenhuma tela por ora; um liga/desliga por motor, vindo do arquivo):

```json
"web": {
  "search": {
    "engines": ["wikipedia", "arxiv", "stackoverflow", "github", "duckduckgo"],
    "languages": ["en", "pt"]
  }
}
```

Id desconhecido é recusado ao carregar a configuração. Mudar a lista (ou os idiomas) muda os hosts que o proxy de motores deixa passar e o `settings.yml` do contêiner, que é **recriado** no próximo uso. Acrescentar um motor novo ao código é uma linha em `packages/web/src/engines.ts` (id do SearXNG, hosts exatos, se é API ou raspagem) mais a leitura do código do motor para os hosts.

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

## O que isto NÃO impede (honesto)

- **`web_read` sem cartão é um canal de saída.** Um bot pode ser induzido por uma página a ler `https://atacante.exemplo/?dado=...`: a URL é o canal. É consequência direta da decisão do dono (leitura pública sem cartão), e a mesma classe de risco que a Anthropic descreve para o fetch hospedado (ela só deixa buscar URLs que já apareceram na conversa). **Ainda não existe** essa restrição aqui; a mitigação natural (só URLs vistas na conversa, ou cartão para um domínio nunca visto) fica como decisão do dono. Quem não aceita desliga o leitor (`web.reader.enabled: false`) e volta ao caminho da máquina do bot, com cartões.
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
  "search": { "enabled": true, "engines": ["wikipedia", "arxiv", "stackoverflow", "github"], "languages": ["en", "pt"], "maxResults": 10 },
  "reader": { "enabled": true, "render": true, "image": "suup-reader:dev" }
}
```

Imagens: o SearXNG é puxado sozinho; a do leitor é construída por `docker build -f docker/reader/Dockerfile -t suup-reader:dev .` (produção: o serviço `reader-image` do Compose). Sem navegador (disco pequeno): `--build-arg PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node`, e `render` fica indisponível.

## O app embutido (sidecar)

O sidecar do app (`apps/sidecar`, ramo `feat/app-embutido`, ainda **não** unido a este ramo) deve chamar `startWebServices` de `@suup/web` junto da etapa "Preparando a máquina dos bots…" (sem Docker o app segue só com `web_read` no próprio processo). O worker do runtime já faz isso sozinho, sob demanda; falta ligar o sidecar quando os ramos se juntarem. **Não foi feito aqui por não existir `apps/sidecar` neste ramo.**

## Testes

- Unidade (rodam sempre): resultado e envelope, motores suspensos, `robots.txt` (permitir/negar, regra mais longa, 404, 5xx, sem resposta, validade do cache), recusa de endereço privado **depois do DNS** (resolvedor falso: `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `::1`, `fd00::1`, IPv4 embutido; resposta mista; redirecionamento para nome privado, IP e `file:`), Readability e Turndown sobre HTML de teste, limites de tamanho (depois de descomprimir) e de tempo, ritmo por host, `settings.yml` (igual ao arquivo versionado), o proxy nos modos `openWeb` e anônimo, a configuração, a ferramenta (nível `read`, saída como dado externo, caminho da máquina do bot) e a linha do prompt.
- Renderizador (`packages/web/test/renderer.test.ts`): Chromium **real** do ambiente (ou do `playwright install`) lendo uma página que só existe depois do JavaScript, sem vazar um pedido a `127.0.0.1`, recusando nome privado e IP, sem cookies entre páginas. É pulado, avisando, se não há Chromium.
- Docker real (`SUUP_DOCKER_TESTS=1`, imagem do leitor em `SUUP_READER_IMAGE`, padrão `suup-reader:dev`; `SUUP_WEB_NETWORK_TESTS=1` acrescenta a leitura de uma página pública): a imagem **oficial** do SearXNG sobe com o `settings.yml` gerado e responde JSON; o contêiner não tem rota nem DNS para fora; o proxy recusa host fora da lista e endereço privado; o leitor tem `cap_drop ALL`, raiz só leitura, nenhuma porta nem montagem e nenhuma variável secreta; o leitor recusa endereços privados, `localhost`, metadados, `file:` e URL com senha. Rodou nesta máquina com a imagem do leitor **sem navegador**; o teste dentro da imagem **com** Chromium (`mcr.microsoft.com/playwright`, vários GB) precisa de CI. Um teste de renderização positiva **dentro** do contêiner não existe, porque a página de teste teria de ser pública (o leitor recusa privados, que é a garantia).
