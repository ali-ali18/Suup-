# Pesquisa: implantar o Suup numa VPS compartilhada gerenciada pelo Dokploy

Data da pesquisa: 24/11/2026. Valida a entrega "Suup na VPS do dono com Dokploy" ([DEPLOY-DOKPLOY.md](../DEPLOY-DOKPLOY.md), `docker-compose.dokploy.yml`), que complementa [IMPLANTACAO.md](../IMPLANTACAO.md).

## Pergunta

Como o Dokploy implanta um app Docker Compose a partir do GitHub (arquivo, build, variáveis, volumes, domínios com Traefik, saúde, implantação automática, logs), e como rodar as máquinas dos bots, os conectores, o leitor e o SearXNG (contêineres que o próprio Suup cria) **sem** montar o socket do Docker do host, numa VPS que também roda outros projetos do dono; com o domínio atrás do proxy do Cloudflare.

## Fontes

Os sites `docs.dokploy.com`/`dokploy.com`, `developers.cloudflare.com`, `www.cloudflare.com` e `docs.docker.com` estão **bloqueados** neste ambiente (CONNECT 403 no curl, testado em 24/11/2026). As mesmas páginas foram lidas **nos repositórios oficiais de onde esses sites são gerados**, clonados com `git clone --depth 1` em 24/11/2026 (o commit lido vai entre parênteses). As URLs públicas das páginas vão ao lado para conferência.

Dokploy (repositório da documentação `Dokploy/website`, commit `b478448c`, de 23/11/2026; e o código `Dokploy/dokploy`, ramo `canary`, commit `b1b216e6`, de 23/11/2026):

- "Docker Compose": https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/docker-compose/index.mdx (página: https://docs.dokploy.com/docs/core/docker-compose)
- "Domains" (Docker Compose): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/docker-compose/domains.mdx
- "Utilities" (Isolated Deployments): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/docker-compose/utilities.mdx
- "Volumes & Mounts" (troubleshooting): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/troubleshooting/volumes-mounts.mdx
- "Cloudflare" (domínios): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/domains/cloudflare.mdx
- "Certificates": https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/certificates.mdx
- "Backups" de banco (inclui "Backing Up Databases in Docker Compose"): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/databases/backups.mdx
- "Volume Backups": https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/volume-backups.mdx
- "Auto Deploy" e "GitHub": https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/auto-deploy.mdx, https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/(Git-Sources)/github.mdx
- "Installation" (requisitos): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/installation.mdx
- Código: o comando de implantação, `packages/server/src/utils/builders/compose.ts` (https://github.com/Dokploy/dokploy/blob/canary/packages/server/src/utils/builders/compose.ts); os rótulos do Traefik e a rede, `packages/server/src/utils/docker/domain.ts`; a rede das implantações isoladas, `packages/server/src/utils/docker/collision/root-network.ts`; o resolvedor ACME do Traefik, `packages/server/src/setup/traefik-setup.ts`; o padrão de `isolatedDeployment`, `packages/server/src/db/schema/compose.ts`.

Docker (imagem oficial `docker`: repositório `docker-library/docker`, commit `5357ff52`, de 23/11/2026; texto do Docker Hub, `docker-library/docs`, commit `d42d7052`, de 23/11/2026; documentação do Docker, `docker/docs`, commit `81ece3a0`, de 23/11/2026):

- `dockerd-entrypoint.sh` (o que a imagem `dind` faz ao subir): https://github.com/docker-library/docker/blob/master/dockerd-entrypoint.sh
- `versions.json` (versão atual 29.10.0) e `29/dind/Dockerfile`: https://github.com/docker-library/docker/blob/master/versions.json
- Texto da imagem no Docker Hub (TLS, `--privileged`, armazenamento): https://github.com/docker-library/docs/blob/master/docker/content.md e https://github.com/docker-library/docs/blob/master/docker/variant-rootless.md (página: https://hub.docker.com/_/docker)
- "Docker Engine security": https://github.com/docker/docs/blob/main/content/manuals/engine/security/_index.md (página: https://docs.docker.com/engine/security/)
- "Rootless mode" e "Tips": https://github.com/docker/docs/blob/main/content/manuals/engine/security/rootless/tips.md (página: https://docs.docker.com/engine/security/rootless/tips/)

Sysbox (`nestybox/sysbox`, commit `f1c8b73c`, de 22/11/2026):

- README, LICENSE, CHANGELOG: https://github.com/nestybox/sysbox
- "Distro compatibility": https://github.com/nestybox/sysbox/blob/master/docs/distro-compat.md
- "Installation with the package": https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md
- "Security": https://github.com/nestybox/sysbox/blob/master/docs/user-guide/security.md

Cloudflare (repositório `cloudflare/cloudflare-docs`, ramo `production`, commit `da4c98c6`, de 23/11/2026):

- Modos de SSL/TLS: https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs/ssl/origin-configuration/ssl-modes (`flexible.mdx`, `full.mdx`, `full-strict.mdx`; página: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/)
- Origin CA: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/ssl/origin-configuration/origin-ca/index.mdx
- Configuration Rules (disponibilidade e a opção "SSL"): https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs/rules/configuration-rules (`index.mdx`, `settings.mdx`, `create-dashboard.mdx`)
- "Connection limits": https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/fundamentals/reference/connection-limits.mdx
- "Error 524": https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524.mdx
- "Proxy status": https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/dns/proxy-status/index.mdx
- Authenticated Origin Pulls: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/ssl/origin-configuration/authenticated-origin-pull/index.mdx

Medido neste ambiente (24/11/2026): tamanhos de imagens com `docker images` e `docker system df`, e a subida local do `docker-compose.dokploy.yml` (abaixo, "Verificação local").

## Fatos verificados

### 1. Como o Dokploy implanta um Compose

- **Comando.** Sem comando próprio, o Dokploy roda `docker compose -p <appName> [--project-directory <pasta>] [--env-file <dir do compose>/.env] -f <composePath> up -d --build --remove-orphans` (mais `--pull always` se pedido), dentro de `/etc/dokploy/compose/<appName>/code`, com `env -i` e as variáveis exportadas (`compose.ts`, `createCommand` e `getBuildComposeCommand`). Logo, **`build:` funciona** (modo "Docker Compose"; no modo "Stack" não: "some Docker Compose features, such as `build`, are not available in this mode", `docker-compose/index.mdx`).
- **Variáveis.** "By default, Dokploy saves these variables to a `.env` file in the same directory as your `docker-compose.yml`", e elas "are **not automatically injected into containers**": use `env_file` ou `${VAR}` no compose (`docker-compose/index.mdx`).
- **Arquivos do repositório.** "When using AutoDeploy, Dokploy performs a `git clone` on each deployment, which clears the repository directory. Mounting files directly from your repository using relative paths (e.g., `./` or `./config/file.conf`) will cause them to be lost or empty in subsequent deployments." A saída é o **File Mount** (Advanced > Mounts), referenciado como `../files/<nome>` (`docker-compose/index.mdx`, `troubleshooting/volumes-mounts.mdx`).
- **Volumes.** Dois jeitos: `../files` (bind) ou volumes nomeados; "Volume Backups only work with Docker named volumes" (`docker-compose/index.mdx`, `volume-backups.mdx`). Apagar o serviço com a caixa marcada roda `docker compose down --volumes` (`docker-compose/index.mdx`).
- **Domínios.** Pela aba Domains, o Dokploy acrescenta na implantação os rótulos `traefik.http.routers.<app>-<chave>-<entrypoint>.rule=Host(...)`, `...entrypoints=web|websecure`, `traefik.http.services....loadbalancer.server.port=<Container Port>`, `traefik.enable=true` e `traefik.docker.network=dokploy-network`, e **acrescenta `dokploy-network` (e `default`) só ao serviço escolhido** quando não há Isolated Deployments (`domain.ts`, `addDomainToCompose`, `addDokployNetworkToService`; `docker-compose/domains.mdx`: "Dokploy will add the `dokploy-network` to the service you selected"). Com HTTPS ligado e certificado `letsencrypt`, o roteador `websecure` recebe `tls.certresolver=letsencrypt`; com certificado `none` e HTTPS ligado, `tls=true` (o Traefik serve o certificado que tiver: "To use an uploaded certificate, set the domain's **Certificate Provider** to **None**. Traefik serves it for any domain whose name matches the certificate", `certificates.mdx`); o roteador `web` passa a redirecionar para HTTPS (`redirect-to-https@file`) (`domain.ts`, `createDomainLabels`). O resolvedor `letsencrypt` usa `httpChallenge` na entrada `web` (`traefik-setup.ts`).
- **Isolated Deployments** acrescenta a rede `<appName>` a **todo** serviço (`root-network.ts`, `addAppNameToServiceNetworks`, sem exceção para `network_mode`) e é desligado por padrão para um Compose criado à mão (`isolatedDeployment ... default(false)`, `schema/compose.ts`); os modelos prontos o trazem ligado (`utilities.mdx`). Já o caminho sem isolamento pula serviços com `network_mode` (`domain.ts`: `if (service && !service.network_mode && !compose.isolatedDeployment)`, no domínio desligado).
- **Implantação automática.** Com o GitHub ligado pelo app do Dokploy, "By default you will have Automatic deployments on each push", só no ramo escolhido (`github.mdx`); por webhook, liga-se "Auto Deploy" na aba General (`auto-deploy.mdx`).
- **Logs e monitoramento** por serviço; histórico das 10 últimas implantações; "Kill Build" (`docker-compose/index.mdx`).
- **Backup de Postgres de um Compose:** "Databases that run inside a Docker Compose service can be backed up from the `Backups` tab of the compose", com Database Type e Service Name, para um destino S3 (`databases/backups.mdx`). Volume Backups, com o contêiner parado ("Container OFF (Recommended)") ou não (`volume-backups.mdx`).
- **Requisitos do próprio Dokploy:** "at least 2GB of RAM and 30GB of disk space" (`installation.mdx`).

### 2. Docker dentro de Docker, Sysbox, rootless

- **`docker:dind` exige `--privileged`:** "`--privileged` is required for Docker-in-Docker to function properly, but it should be used with care as it provides full access to the host environment" (`docker/content.md`). O mesmo para a variante rootless: "just like the regular `dind` images, `--privileged` is required ... which is a security issue that needs to be treated appropriately" (`variant-rootless.md`); a documentação do Docker diz por quê: "`--privileged` is required for disabling seccomp, AppArmor, and mount masks" (`rootless/tips.md`).
- **TLS do dind:** com `DOCKER_TLS_CERTDIR`, o daemon sobe com `--host=tcp://0.0.0.0:2376 --tlsverify` (e gera CA, servidor e cliente; a chave do cliente fica `0644`); sem, com `tcp://0.0.0.0:2375` **sem autenticação** (`dockerd-entrypoint.sh`). O aviso: com rede compartilhada "or otherwise have network access to the container (including containers started within the `dind` instance via their gateway interface), this is a potential security issue (which can lead to access to the host system" (`docker/content.md`). **Os argumentos padrão só entram quando o comando não começa por `dockerd`**: com `command: dockerd ...` o entrypoint usa só o que se passou (e acrescenta o `docker-init`) (`dockerd-entrypoint.sh`).
- **Armazenamento:** o exemplo da imagem mostra `Storage Driver: overlay2` e aceita `--storage-driver overlay2`; `/var/lib/docker` é `VOLUME` (`docker/content.md`, `29/dind/Dockerfile`).
- **Quem controla o daemon controla o host:** "only trusted users should be allowed to control your Docker daemon ... you can start a container where the `/host` directory is the `/` directory on your host" (`engine/security/_index.md`).
- **Rootless e limites de recursos:** "Limiting resources with cgroup-related `docker run` flags such as `--cpus`, `--memory`, `--pids-limit` is supported only when running with cgroup v2 and systemd ... When these conditions are not satisfied, rootless mode ignores the cgroup-related `docker run` flags" (`rootless/tips.md`). O rootless roda o daemon dentro do `rootlesskit` com rede `slirp4netns` por padrão e `--disable-host-loopback` (`dockerd-entrypoint.sh`).
- **Sysbox:** licença Apache 2.0 (`LICENSE`); última versão 0.7.2 de 22/11/2026 (`CHANGELOG.md`); "originally developed by Nestybox (acquired by Docker" (README). Suporta pacote em Ubuntu 24.04 (kernel 6.8+) e 22.04 (5.15+) (`distro-compat.md`). A instalação recomenda "stopping and removing all Docker containers" porque "the Sysbox installer may need to configure and restart Docker" (há um caminho sem reiniciar, para produção) (`install-package.md`). O contêiner de sistema usa *user namespace*: "root in the container maps to an unprivileged user" no host, e dentro dele roda Docker e até contêiner `--privileged` interno (`security.md`).

### 3. Cloudflare na frente

- **Flexible:** "all connections between Cloudflare and your origin are made through HTTP"; "If your application contains sensitive information (personalized data, user login), use **Full** or **Full (Strict)** modes instead" (`flexible.mdx`).
- **Full:** Cloudflare "makes connections to the origin using the scheme requested by the visitor"; a origem precisa aceitar HTTPS na 443 e apresentar um certificado "self-signed, Cloudflare Origin CA, or purchased" (senão erro 525). **Não valida** o certificado (`full.mdx`).
- **Full (strict):** o certificado da origem precisa estar válido, ser de CA pública ou da **Cloudflare Origin CA**, e ter o nome do host (senão erro 526) (`full-strict.mdx`).
- **Origin CA:** grátis em todos os planos; criado em SSL/TLS > Origin Server > Create Certificate; "The zone apex and first level wildcard hostname are included by default"; "Cloudflare does not currently send expiration notifications" (`origin-ca/index.mdx`). O Dokploy documenta o mesmo caminho: copiar o "Origin Certificate" e a "Private Key" para Certificates > Add Certificate, e no domínio HTTPS ligado com Certificate "None" (`domains/cloudflare.mdx`).
- **Modo por host:** Configuration Rules existem no plano Free (10 regras) e têm a opção **SSL** com os valores Off, Flexible, Full, Strict, Origin Pull, aplicada só às requisições que casam com a expressão (`configuration-rules/index.mdx`, `settings.mdx`); criadas em Rules > Overview > Create rule > Configuration Rule (`create-dashboard.mdx`).
- **Tempos entre o Cloudflare e a origem:** Proxy Read Timeout **125 s** (erro 524; só Enterprise muda), Proxy Write Timeout 30 s, Proxy Idle 900 s; entre cliente e Cloudflare, 400 s de keep-alive/ociosidade (`connection-limits.mdx`, `error-524.mdx`). (O número "100 s" que circula é antigo; a página atual diz 125 s.)
- **Registro com proxy (nuvem laranja):** o DNS responde com IPs do Cloudflare, não o da origem (`proxy-status/index.mdx`).
- **Authenticated Origin Pulls** existe em todos os planos (`authenticated-origin-pull/index.mdx`).

### 4. Verificação local (este ambiente, 24/11/2026)

- `docker compose -f docker-compose.dokploy.yml config` com variáveis de mentira: válido; sem `POSTGRES_PASSWORD`, recusa com a mensagem. `SUUP_DOCKER_PRIVILEGED=false` + `SUUP_DOCKER_RUNTIME=sysbox-runc` gera o serviço sem `privileged` e com `runtime: sysbox-runc`.
- Subida local (Docker 29.10.0, cgroup v1, kernel 6.18), com uma cópia do repositório no papel de `code/` e um `files/suup.config.json` ao lado (o arranjo do Dokploy), e uma rede `dokploy-network` criada à mão: o `docker` (dind 29.10.0, `overlay2`) sobe saudável escutando **só** em `/var/run/dind/docker.sock` (dono `root:1000`, `0660`; nenhuma porta TCP: `netstat -ltn` só mostra o DNS interno do Docker); `migrate` aplica as 29 migrações; o `server` responde `{"status":"ok"}` em `http://server:8787/health` de um contêiner no `dokploy-network` (como o Traefik); o `worker` roda como `node` (uid 1000), não tem `/var/run/docker.sock`, e `docker ps` nele lista **só** os contêineres do Docker isolado.
- `node dist/bin.js doctor` no worker: Sandbox `docker`, contêiner `suup-machine` respondeu; "Rede dos bots: sem saída direta" ok (rede interna `suup-sandbox-net`, criada **dentro** do Docker isolado); "proxy e lista de hosts" ok (o proxy escutou no gateway da rede interna, `172.18.0.1`, dentro da rede do contêiner `docker`); só falhou o provedor (sem chave, de propósito). `docker ps -a --filter name=suup-machine` **no host**: nenhum.
- Reiniciar o `docker` (`docker compose restart docker`) reinicia o `worker` junto (`depends_on ... restart: true`), e a máquina dos bots volta.
- **O serviço `images` não terminou aqui:** o BuildKit do Docker isolado tentou resolver nomes por conta própria (`lookup auth.docker.io on 8.8.4.4:53: ... network is unreachable`), e este ambiente não tem DNS, só um proxy. O `docker pull` pelo mesmo daemon (que usa o proxy) funcionou. As imagens dos bots foram então copiadas do host com `docker save | docker load`. Na VPS, com DNS normal, o build não depende disso (não verificado lá).
- Tamanhos medidos (`docker images`, neste host): `suup` (servidor e worker) 482 MB; `docker:29.10.0-dind` 439 MB; `docker:29.10.0-cli` 224 MB; `pgvector/pgvector:0.8.1-pg18` 630 MB; `suup-sandbox` 290 MB; `suup-connector-runner` 444 MB; `searxng` 382 MB; `suup-reader` **sem** o Chromium 392 MB. A base do leitor completo, `mcr.microsoft.com/playwright:v1.65.1-noble` (amd64), tem **1,01 GB comprimidos** (soma das camadas no registro); descomprimida não foi medida. Memória em repouso (`docker stats`): server 44 MiB, worker 41 MiB, Postgres 74 MiB, dind 33 MiB.

## Inferências

- **Montar o socket do host está fora.** Pela documentação do Docker, quem fala com o daemon monta `/` do host num contêiner: com o socket, o Suup (e quem explorar o worker) controlaria os contêineres e os dados de todos os projetos da VPS.
- **Docker dentro de Docker privilegiado, com o daemon só num socket unix, é a opção que funciona hoje no Dokploy sem mexer no host.** Ele **não** é uma fronteira forte contra um atacante que já executa código no worker: com o socket do Docker isolado ele pode criar um contêiner `--privileged` lá dentro, e um contêiner privilegiado dentro de um dind privilegiado enxerga os dispositivos do host. O que ele resolve: (1) o Suup **não enxerga nem comanda** os contêineres, volumes e redes dos outros projetos pelo caminho normal; (2) imagens, redes internas e o workspace dos bots ficam num volume só do Suup (`dind-data`), sem colisão de nomes (`suup-machine`, `suup-sandbox-net`) com o Docker do host; (3) uma fuga do contêiner do bot cai no dind, não direto no host (ainda é preciso uma segunda fuga, que o `privileged` facilita). Sem TCP, o aviso da imagem sobre "network access to the container (including containers started within the dind instance via their gateway interface)" não se aplica: não há porta para alcançar.
- **dind rootless não serve para o Suup:** também exige `--privileged` (sem ganho no que mais importa), ignora `--memory`/`--cpus`/`--pids-limit` sem systemd e cgroup v2 (a máquina dos bots depende desses limites) e põe as redes do daemon atrás do `rootlesskit`/`slirp4netns`, fora da rede que o worker compartilha: o proxy de saída em modo `process` (escutar no gateway da rede interna, [REDE.md](../REDE.md)) deixaria de alcançar os bots. (Inferido da documentação e do entrypoint; não testado.)
- **Sysbox é a opção mais segura** (sem `privileged`; root do contêiner é um usuário sem privilégio no host) **mas exige mexer no host**: instalar um pacote e, em geral, reiniciar o Docker de todos os projetos. Fica como endurecimento opcional, já previsto no compose (`SUUP_DOCKER_PRIVILEGED=false`, `SUUP_DOCKER_RUNTIME=sysbox-runc`), não exercitado.
- **O worker usa a rede do contêiner `docker` (`network_mode: service:docker`).** Assim as redes internas que o Suup cria no Docker isolado existem na mesma pilha de rede do worker, e o proxy de saída escuta no gateway delas, exatamente como no "Linux com o Docker no próprio host" que já está provado; não precisa de IP fixo nem do modo `container`. Consequência no Dokploy: **Isolated Deployments tem de ficar desligado** (ele daria uma rede ao worker, o que o Compose recusa junto de `network_mode`), e o domínio vai para o `server`, que é um serviço comum.
- **O servidor fica separado do worker:** é o único no `dokploy-network` e não fala com Docker nenhum; o worker não está no `dokploy-network`. Os outros projetos, que estão no `dokploy-network`, alcançam só a porta 8787 do servidor (que exige o token).
- *Atualização de 24/11/2026:* a pedido do dono, as imagens passaram a ser construídas no GitHub e só baixadas na VPS ([imagens-no-github.md](imagens-no-github.md)); o item abaixo descreve o arranjo anterior.
- **As imagens dos bots precisam ser construídas no Docker isolado**, não pelo `build:` do Compose (que constrói no host). Como montar o repositório num contêiner é frágil no Dokploy (a pasta é apagada a cada implantação), as receitas vão **dentro** de uma imagem auxiliar (`docker/dokploy/images.Dockerfile`), que o Dokploy constrói no host normalmente, e um serviço de uma vez (`images`) roda `docker build` contra o socket do Docker isolado. O worker só sobe depois que ele termina bem.
- **A configuração vai por File Mount** (`../files/suup.config.json`), pelo mesmo motivo; é o caminho documentado do Dokploy.
- **Postgres no próprio compose**, não o serviço de banco do Dokploy: fica na rede interna `backend`, sem porta, e o Dokploy faz backup dele pela aba Backups do Compose (Service Name `postgres`). O `init.sql` do prod (`CREATE EXTENSION vector`) não é montado: nenhuma migração usa `vector` hoje, e uma migração futura pode criar a extensão (o usuário do banco é o dono).
- **Cloudflare no modo "Full" da zona (o do dono) exige a origem respondendo na 443 para `agent.kodea.com.br`.** No Dokploy isso é o domínio com **HTTPS ligado**; com HTTPS desligado só existe o roteador da porta 80, o Cloudflare chega na 443 e recebe 404. Com HTTPS ligado e Certificate **None**, o Traefik serve o certificado próprio dele, que o modo Full aceita; e o salto Cloudflare → VPS vai **cifrado**, mas sem validar o certificado. Para validar só neste host, sem mexer nos outros subdomínios: Origin CA + Configuration Rule "SSL = Strict" para `agent.kodea.com.br`. **Flexible** deixaria o token e as conversas em texto puro no salto até a VPS: não usar.
- **Tempo real (SSE) pelo Cloudflare:** o servidor manda um comentário `: ping` a cada **15 s** (`packages/server/src/stream/hub.ts`, `keepAliveMs` 15 000) e responde com `Cache-Control: no-cache, no-transform` e `X-Accel-Buffering: no` (`packages/server/src/server.ts`), bem abaixo dos 125 s do Proxy Read Timeout. Não é preciso mudar o intervalo. WebSocket não é usado.

## O que não foi verificado

- O build das imagens dos bots **dentro** do Docker isolado até o fim (o ambiente não tem DNS; veja acima). Na VPS, a primeira implantação é o teste.
- O leitor completo (com Chromium) e o SearXNG rodando dentro do Docker isolado (`web_search`/`web_read` precisam de uma execução com modelo; aqui não há chave). O mecanismo do proxy de motores é o mesmo do proxy dos bots, que o `doctor` provou.
- Uma execução de bot de ponta a ponta (sem chave de provedor aqui).
- Se o Cloudflare **bufferiza** respostas `text/event-stream` no plano Free: a documentação lida não fala de SSE no proxy. Teste no guia (`curl -N` pelo domínio).
- O kernel e a distribuição da VPS da Hostinger (para o Sysbox), e se o Traefik do Dokploy do dono tem alguma configuração diferente do padrão.
- Sysbox na prática, e o `network_mode: service:` com o Docker isolado sob Sysbox.
- O `Preview Compose` do Dokploy com este arquivo e o domínio configurado (lido no código, não executado).
- O tamanho descomprimido da imagem do leitor completo e o cache de build dentro do Docker isolado na VPS.

## Implicação para o Suup

- Novo `docker-compose.dokploy.yml`: `postgres`, `docker` (dind 29.10.0 privilegiado, só socket unix, volume próprio), `images` (constrói as imagens dos bots no Docker isolado), `migrate`, `server` (único no `dokploy-network`, porta 8787) e `worker` (`network_mode: service:docker`, `DOCKER_HOST` no socket isolado). Nenhum socket do host.
- `suup.config.dokploy.example.json`: o de produção **sem** os IPs fixos dos proxies (o gateway é descoberto sozinho), com `server.publicUrl` e o cofre.
- Guia do dono: [DEPLOY-DOKPLOY.md](../DEPLOY-DOKPLOY.md); [IMPLANTACAO.md](../IMPLANTACAO.md) aponta para ele. O `docker-compose.prod.yml` (VPS dedicada) não muda.
- Recomendação de recursos (inferência a partir das medidas e dos limites da configuração): **disco** livre de pelo menos **15 GB** para o Suup (imagens no host perto de 2 GB, imagens e cache no Docker isolado de 5 a 8 GB com o leitor completo, mais banco e workspace), **RAM** de pelo menos **4 GB livres** para o Suup (serviços em repouso perto de 200 MB; a máquina dos bots pode usar até `sandbox.memory`, 2 GB; cada conector até 512 MB; SearXNG até 512 MB; o Chromium do leitor, quando renderiza), numa VPS que já roda outros projetos. Com menos: `sandbox.memory` de `1g` e o leitor sem Chromium (`SUUP_READER_BROWSER=0`).
