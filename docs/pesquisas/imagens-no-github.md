# Pesquisa: construir as imagens no GitHub e só baixá-las na VPS

Data da pesquisa: 24/11/2026. Valida o pedido do dono de 24/11/2026, "O build da imagem deve ocorrer no github, para poupar a vps": o `.github/workflows/images.yml` e a mudança no `docker-compose.dokploy.yml` ([DEPLOY-DOKPLOY.md](../DEPLOY-DOKPLOY.md)). Complementa [deploy-vps-dokploy.md](deploy-vps-dokploy.md).

## Pergunta

Como publicar no GitHub Container Registry (GHCR), a partir do GitHub Actions, a imagem do servidor e as imagens dos bots (máquina, runner de conectores, leitor), com cache e tags que deixem fixar e voltar versões; quem pode baixá-las (o pacote nasce privado ou público?); e como o Dokploy passa a só baixar (sem `build`) e a reimplantar depois que as imagens estão prontas.

## Fontes

`docs.github.com`, `docs.docker.com` e `docs.dokploy.com` não abrem neste ambiente (o proxy recusa; testado em 24/11/2026). Cada página foi lida **no repositório oficial de onde o site é gerado**, com `git clone --depth 1` em 24/11/2026 (commit entre parênteses); a URL pública vai ao lado.

GitHub (repositório `github/docs`, commit `e0b0c90`, de 23/11/2026):

- "Working with the Container registry": https://github.com/github/docs/blob/main/content/packages/working-with-a-github-packages-registry/working-with-the-container-registry.md (página: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- "Configuring a package's access control and visibility": https://github.com/github/docs/blob/main/content/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility.md (página: https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
- "Publishing and installing a package with GitHub Actions": https://github.com/github/docs/blob/main/content/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions.md
- Trechos reutilizados: `data/reusables/package_registry/visibility-and-access-permissions.md` (puxar sem login), `container-registry-benefits.md`, `packages-billing.md`, `authenticate-to-container-registry-steps.md`, `packages-classic-pat-only.md`, `package-settings-from-user-level.md`, `package-settings-option.md` (https://github.com/github/docs/tree/main/data/reusables/package_registry)
- Permissões do `GITHUB_TOKEN`: `data/reusables/actions/github-token-permissions.md` e `github-token-scope-descriptions.md`
- Filtro de caminhos: `data/reusables/actions/workflows/triggering-a-workflow-paths1.md` a `paths5.md` (página: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
- Limites do cache: https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/dependency-caching.md ("Usage limits and eviction policy")

Docker (repositório `docker/docs`, commit `81ece3a`, de 23/11/2026):

- Cache `gha`: https://github.com/docker/docs/blob/main/content/manuals/build/cache/backends/gha.md (página: https://docs.docker.com/build/cache/backends/gha/)
- "Cache management with GitHub Actions": https://github.com/docker/docs/blob/main/content/manuals/build/ci/github-actions/cache.md
- "Copy image between registries" (`docker buildx imagetools create`): https://github.com/docker/docs/blob/main/content/manuals/build/ci/github-actions/copy-image-registries.md
- Compose, `pull_policy` e `dns`: https://github.com/docker/docs/blob/main/content/reference/compose-file/container-spec.md (página: https://docs.docker.com/reference/compose-file/services/)

Ações do Docker e do GitHub (repositórios clonados em 24/11/2026; versão mais recente por `git ls-remote --tags`):

- `docker/build-push-action` v7.4.0 (`c3c9e263c25d99ce0380d002d59b67737d91b0dc`, de 15/09/2026): https://github.com/docker/build-push-action (README e `action.yml`)
- `docker/login-action` v4.8.0 (`8aa5831fb8d48d8f76594c7ddde61ae58019f550`, de 05/11/2026): https://github.com/docker/login-action (README, "GitHub Container Registry")
- `docker/setup-buildx-action` v4.4.1 (`f87e5991a6d7451dcb8d9637bfbc97413f497069`, de 16/09/2026): https://github.com/docker/setup-buildx-action
- `docker/metadata-action` v6.2.0 (README, "Image name and tag sanitization"; lida, não usada): https://github.com/docker/metadata-action
- `actions/checkout` v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`): https://github.com/actions/checkout
- `rhysd/actionlint` v1.7.12 e `koalaman/shellcheck` v0.11.0 (só para conferir o workflow aqui): https://github.com/rhysd/actionlint/releases/tag/v1.7.12

Dokploy (documentação `Dokploy/website`, commit `b478448`, de 23/11/2026; código `Dokploy/dokploy`, ramo `canary`, commit `b1b216e`, de 23/11/2026):

- "Auto Deploy" (webhook e API): https://github.com/Dokploy/website/blob/main/apps/docs/content/docs/core/auto-deploy.mdx (página: https://docs.dokploy.com/docs/core/auto-deploy)
- "Registry" e "GHCR": https://github.com/Dokploy/website/tree/main/apps/docs/content/docs/core/registry
- O webhook do Compose: https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/api/deploy/compose/%5BrefreshToken%5D.ts e as funções `extractBranchName`/`extractHash` em `apps/dokploy/pages/api/deploy/[refreshToken].ts`
- O webhook do app do GitHub (push e tag): https://github.com/Dokploy/dokploy/blob/canary/apps/dokploy/pages/api/deploy/github.ts
- "Trigger Type" (On Push / On Tag) no formulário do provedor GitHub do Compose: `apps/dokploy/components/dashboard/compose/general/generic/save-github-provider-compose.tsx`; a URL do webhook na aba Deployments: `apps/dokploy/components/dashboard/application/deployments/show-deployments.tsx`
- O comando de implantação: `packages/server/src/utils/builders/compose.ts`; Watch Paths: `packages/server/src/utils/watch-paths/should-deploy.ts`

## Fatos verificados

### 1. Publicar no GHCR pelo Actions

- **Token.** O `GITHUB_TOKEN` basta; o job declara `contents: read` e `packages: write` ("`packages: write` permits an action to upload and publish packages", `github-token-scope-descriptions.md`; `github-token-permissions.md`). O login é `docker/login-action` com `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}` (README do `login-action`).
- **Ligação com o repositório.** "The easiest way to connect a repository to a container package is to publish the package from a workflow using `GITHUB_TOKEN`, as the repository that contains the workflow is linked automatically"; recomenda-se também o rótulo `org.opencontainers.image.source` (`working-with-the-container-registry.md`). Com o pacote ligado **antes** de publicar, ele herda as permissões de acesso do repositório, "but not the visibility" (`configuring-a-packages-access-control-and-visibility.md`).
- **Visibilidade (a documentação se contradiz).** "When you first publish a package that is scoped to your personal account, the default visibility is private and only you can see the package" (`configuring-...visibility.md`, "Configuring visibility of packages for your personal account"). Outra página diz que um pacote criado por workflow com o `GITHUB_TOKEN` "inherits the visibility and permissions model of the repository where the workflow is run" (`publishing-and-installing-a-package-with-github-actions.md`). Não há como saber aqui qual vale; o guia manda conferir na página do pacote.
- **Tornar público:** página do pacote > **Package settings** > "Danger Zone" > **Change visibility** > **Public** > digitar o nome > confirmar. "Once you make a package public, you cannot make it private again." Os pacotes da conta ficam em **Your profile > Packages** (`package-settings-option.md`, `package-settings-from-user-level.md`).
- **Público se baixa sem login:** "in the Container registry, public packages allow anonymous access and can be pulled without authentication" (`visibility-and-access-permissions.md`). Uso de pacotes públicos é gratuito (`packages-billing.md`).
- **Privado:** baixar exige um *personal access token (classic)* com `read:packages` ("GitHub Packages only supports authentication using a personal access token (classic)", `packages-classic-pat-only.md`; `authenticate-to-container-registry-steps.md`). O Dokploy guarda credenciais de registro na máquina (Registry > GHCR: usuário e token, `registry/ghcr.mdx`, `registry/index.mdx`).

### 2. Construir com cache

- `docker/build-push-action` constrói com Buildx/BuildKit; com `context` ele usa o caminho do checkout em vez do contexto Git (README, "Path context").
- **Cache `gha`:** `cache-from: type=gha` e `cache-to: type=gha,mode=max` (`cache.md`). "If you build multiple images, each build will overwrite the cache of the previous": use `scope` diferente por imagem (`gha.md`, "Scope"). Só a API v2 do cache funciona desde 15/04/2025; as ações atuais já a usam (`cache.md`).
- **Limite:** o cache do repositório tem 10 GB por padrão, entradas sem uso há mais de 7 dias são apagadas, e o excesso é cobrado ou despejado (`dependency-caching.md`). O cache é compartilhado com os outros workflows do repositório (pnpm, Rust).
- **Copiar uma tag sem reconstruir:** `docker buildx imagetools create --tag <nova> <origem>` (`copy-image-registries.md`).
- Tags de imagem: até 128 caracteres de letras, dígitos, `_`, `.` e `-`; barra não (README do `metadata-action`, "Image name and tag sanitization").

### 3. Quando o workflow roda

- `paths` em `on.push`: o workflow roda se ao menos um arquivo mudado casa com a lista; "Path filters are not evaluated for pushes of tags"; com `branches` e `paths`, os dois têm de valer; um workflow pulado por filtro deixa a verificação "Pending" (`triggering-a-workflow-paths1.md` a `paths5.md`).

### 4. O Dokploy só baixando

- O Dokploy roda `docker compose ... up -d --build --remove-orphans` (mais `--pull always` se ligado) (`compose.ts`). Sem `build:` no compose, o `--build` não constrói nada.
- `pull_policy: always`: "Compose always pulls the image from the registry"; o padrão sem build é `missing` (só baixa se não houver a imagem local), o que deixaria uma tag móvel (`main`) parada na versão antiga (`container-spec.md`).
- **Webhook do Compose:** `POST <painel>/api/deploy/compose/<refreshToken>`; a URL aparece na aba **Deployments** ("Webhook URL", com botão de copiar e de trocar o token) (`show-deployments.tsx`). O handler exige **Auto Deploy ligado** ("Automatic deployments are disabled for this compose", 400); para um Compose de origem GitHub lê o corpo como um push do GitHub: o ramo vem de `ref` (`refs/heads/<ramo>`) e tem de ser o ramo do Compose, senão 301 "Branch Not Match"; os caminhos vêm de `commits[].added/modified/removed` e são comparados às Watch Paths (lista vazia implanta); o hash vem de `head_commit.id`. Sucesso: 200 "Compose deployed successfully" ([refreshToken].ts, `should-deploy.ts`). O handler **não** olha o Trigger Type.
- **App do GitHub:** com Auto Deploy ligado, um push implanta os Compose com Trigger Type "push" daquele ramo; um push de tag implanta os com Trigger Type "tag" (`github.ts`). No formulário: **Trigger Type**, "On Push" ou "On Tag" (`save-github-provider-compose.tsx`).
- **API:** também existe (`x-api-key`, token gerado no perfil) (`auto-deploy.mdx`), mas o token é da conta inteira.

### 5. Docker dentro de Docker e DNS

- Na pesquisa anterior (deploy-vps-dokploy.md, "Verificação local"), o **build** dentro do dind falhou porque o BuildKit resolveu nomes por conta própria (8.8.4.4); o `docker pull` pelo mesmo daemon funcionou. `dns` no compose define os servidores de DNS de um contêiner (`container-spec.md`).

## Inferências

- **Um conjunto completo por commit.** Se cada imagem só fosse construída quando os arquivos dela mudam, o sha de um commit não teria todas as imagens, e `SUUP_IMAGE_TAG=<sha>` (fixar/voltar) quebraria. Por isso todo run constrói as quatro (as que não mudaram saem do cache), e o filtro `paths` fica no workflow inteiro (um push só de documentação não roda).
- **A tag móvel só anda depois que tudo subiu.** Os builds publicam só `:<sha>`; um job final copia as tags (`imagetools create`) para `:main` (ou `:v1.2.3`) e só então chama o Dokploy. Uma falha no meio não deixa `main` com metade nova e metade velha.
- **Ordem com o Dokploy.** Com Trigger Type "On Push", o Dokploy implantaria no push, **antes** de as imagens existirem (com o compose novo e as imagens velhas). Com "On Tag" e o webhook chamado pelo workflow, a implantação de um push ao `main` só acontece quando as imagens estão prontas. Uma tag `v*` ainda dispara o Dokploy na hora (o `release.yml` do app usa tags `v*`), mas com o padrão `SUUP_IMAGE_TAG=main` isso só baixa de novo o mesmo `main`: inofensivo.
- **Webhook em vez da API:** a URL do webhook só implanta aquele Compose (e o token dela se troca no painel); a chave da API manda na conta do Dokploy. O webhook fica como segredo do repositório (`DOKPLOY_WEBHOOK_URL`), opcional.
- **Público é o caminho.** O repositório é público (MIT) e as imagens não levam segredo (a CA de proxy de build só existe num `RUN` com `--mount=type=secret`; nenhum segredo entra nos Dockerfiles). Público: nenhuma credencial na VPS, nem no host nem no dind. Privado exigiria um token *classic* `read:packages` em dois lugares (Registry do Dokploy para o host baixar o servidor, e um `docker login` dentro do dind para as imagens dos bots), o que este compose não faz.
- **DNS do dind:** sem build dentro do dind, o problema do BuildKit some; o `docker pull` usa a resolução do próprio contêiner `docker`, que numa VPS com DNS normal resolve `ghcr.io`. Se não resolver, `dns:` no serviço `docker` resolve.
- **amd64 só:** a VPS da Hostinger é x86_64 (não verificado em fonte da Hostinger; o dono confere com `uname -m`). arm64 dobraria o tempo de build (emulação) sem uso.
- **Cache do leitor em `mode=min`:** a base do leitor tem ~1 GB comprimido; com `mode=max` o estágio de build (dependências do pnpm de todo o workspace) também iria ao cache. `min` guarda só as camadas da imagem final, para não estourar os 10 GB do repositório (estimativa; o tamanho real não foi medido).

## O que não foi verificado

- Se um pacote novo publicado pelo workflow nasce **privado** ou **público** neste repositório (a documentação diz as duas coisas). O guia manda olhar.
- O workflow rodando de verdade no GitHub (não há como disparar daqui); ele foi conferido com `actionlint` 1.7.12 + `shellcheck` 0.11.0.
- O webhook do Dokploy chamado pelo workflow (lido no código, não exercitado), e se o painel do Dokploy do dono é alcançável pela internet (o runner do GitHub precisa chegar nele).
- O `docker pull` de `ghcr.io` dentro do dind na VPS. Aqui o script do serviço `images` foi exercitado com um `docker` de mentira (ordem dos pulls, nomes locais, leitor sem navegador, imagem desconhecida recusada).
- O tamanho do cache `gha` das cinco construções.
- A arquitetura da VPS da Hostinger em fonte da Hostinger.

## Implicação para o Suup

- Novo `.github/workflows/images.yml`: push no `main` (com filtro de caminhos), tags `v*` e manual; publica `ghcr.io/ali-ali18/suup-server`, `suup-sandbox`, `suup-connector-runner` e `suup-reader` (mais as tags `-slim` do leitor sem navegador) com a tag do sha; depois move a tag do ramo ou da versão e, com o segredo `DOKPLOY_WEBHOOK_URL`, pede a reimplantação. Ações fixadas em versões exatas (os workflows atuais usam versões maiores, não shas).
- `docker-compose.dokploy.yml`: servidor, worker e migrate em `image: ${SUUP_IMAGE_REGISTRY:-ghcr.io/ali-ali18}/suup-server:${SUUP_IMAGE_TAG:-main}` com `pull_policy: always`, sem `build:`. O serviço `images` passa a ser a imagem oficial `docker:29.10.0-cli` com o script no próprio compose: baixa as imagens dos bots dentro do dind e as renomeia para `suup-sandbox:prod`, `suup-connector-runner:prod` e `suup-reader:prod` (os nomes da configuração); o SearXNG continua fixado.
- Saem `docker/dokploy/images.Dockerfile` e `docker/dokploy/build-images.sh`: um modo "construir na VPS" de reserva teria de manter o `build:` (e a cópia do repositório numa imagem) no compose, o contrário do pedido. Quem precisar construir à mão usa os comandos de [IMPLANTACAO.md](../IMPLANTACAO.md).
- O guia [DEPLOY-DOKPLOY.md](../DEPLOY-DOKPLOY.md) ganha: tornar os quatro pacotes públicos uma vez, Trigger Type "On Tag" com o webhook, `SUUP_IMAGE_TAG` e como voltar para um sha antigo.
