# Pesquisa: app Windows (Tauri 2) e servidor local com Docker Desktop

Data da pesquisa: 19/11/2026. Base para a entrega do app de desktop no Windows e para um modo local (servidor e worker no próprio PC, com Docker Desktop). Ver também [docs/IMPLANTACAO.md](../IMPLANTACAO.md) e [apps/desktop/README.md](../../apps/desktop/README.md).

## Pergunta

1. Como gerar o instalador do Windows pelo CI com Tauri 2 (`tauri-apps/tauri-action` em `windows-latest`): formatos (NSIS `.exe` ou MSI), modos de instalação do WebView2, o que Windows 10 e 11 já trazem, upload como artefato do workflow ou rascunho de Release, tempo de build e cache do Rust. Assinatura de código: o que acontece sem assinatura (aviso do SmartScreen), as opções, e se dá para distribuir sem assinatura para teste do dono. Atualizador (só os requisitos).
2. Vale incluir macOS e Linux na mesma matriz?
3. Rodar o servidor num PC com Windows: requisitos do Docker Desktop, se o uso do socket Docker pelo worker funciona com o backend WSL 2, notas de volumes e de desempenho, e ressalvas da rede interna (`internal: true`) que os bots usam.
4. Conexão entre o app e o servidor: CSP, `connect-src`, origem da webview no Windows (`http://tauri.localhost` ou `https://tauri.localhost`), CORS.
5. O que muda numa VPS (só listar; a implantação já está em `docs/IMPLANTACAO.md`).

## Fontes

Lidas em 19/11/2026, salvo quando indicado. Como `v2.tauri.app`, `docs.docker.com`, `learn.microsoft.com` e `crates.io` retornaram bloqueio de rede (CONNECT 403, ou falha de resolução), usei os fontes do GitHub de cada projeto, indicados abaixo.

Tauri (Tauri Apps):

- Documentação "Windows Installer" (ramo `v2` de `tauri-apps/tauri-docs`): https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/windows-installer.mdx (lida; a página pública em https://v2.tauri.app/distribute/windows-installer/ estava bloqueada).
- Documentação "HTTP Headers": https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/http-headers.mdx (lida).
- Documentação "Content Security Policy": https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/csp.mdx (lida).
- Documentação "Capabilities": https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/capabilities.mdx (lida).
- Documentação do atualizador (assinatura): https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx (lida).
- Código-fonte de configuração, `crates/tauri-utils/src/config.rs`, ramo `dev`: https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/src/config.rs (lido em 19/11/2026. Os campos `useHttpsScheme`, `webviewInstallMode`, `digestAlgorithm`, `certificateThumbprint`, `timestampUrl`, `signCommand`, `active` e `targets` foram conferidos aqui. A versão exata do pacote é a do lock local, ver abaixo.)
- `tauri-apps/tauri-action`, README do ramo `dev`: https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/README.md (lido; exemplo de matriz e lista de entradas).
- Versões: registro npm, `@tauri-apps/cli/latest` (2.12.6): https://registry.npmjs.org/@tauri-apps/cli/latest ; `@tauri-apps/api/latest` (2.12.5 no registro; o `package.json` do app pede `^2.12.5`): https://registry.npmjs.org/@tauri-apps/api/latest . O crate `tauri` do ramo `dev` declara `version = "2.12.7"`: https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri/Cargo.toml . Crates.io retornou 403: não verificado por ali.
- A documentação de assinatura de Windows do Tauri (`distribute/sign/windows`) não foi encontrada nos caminhos tentados (404 no GitHub) e o site está bloqueado. **Não verificado.**

Microsoft:

- "What is Artifact Signing?" (antigo Trusted Signing; `ms.date: 01/02/2026`): https://raw.githubusercontent.com/MicrosoftDocs/azure-docs/main/articles/artifact-signing/overview.md (lida via GitHub).
- SmartScreen e o aviso "aplicativo não reconhecido": **não verificado**. `learn.microsoft.com` retornou 403 e não há cópia legível no GitHub nos caminhos tentados.

GitHub:

- Eventos que disparam workflows: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows (lida).
- Runners hospedados pelo GitHub: https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners (lida).
- Artefatos de workflow: https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts (lida; o prazo de retenção padrão **não foi encontrado** no texto extraído).
- Imagem do runner Windows Server 2025 (`actions/runner-images`, `Image Version: 20261111.331.1`): https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md (lida).

Docker (lido pelo repositório `docker/docs`, porque `docs.docker.com` está bloqueado):

- Instalar no Windows (requisitos, modos de instalação): https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/setup/install/windows-install.md (lida).
- Permissões no Windows: https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/setup/install/windows-permission-requirements.md (lida).
- WSL 2: https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/features/wsl/_index.md (lida).
- Máquina virtual e VMM: https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/features/vmm.md (lida).
- Perguntas frequentes gerais (socket): https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/troubleshoot-and-support/faqs/general.md (lida).
- Notas de versão do Docker Desktop: https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/release-notes.md (lidas; versão 4.100.0, com data 2026-11-19).
- Protege o socket do daemon: https://raw.githubusercontent.com/docker/docs/main/content/manuals/engine/security/protect-access.md (lida).
- Compose, redes (`internal`): https://raw.githubusercontent.com/docker/docs/main/content/reference/compose-file/networks.md (lida).

Local (repositório, lido em 19/11/2026):

- `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock` (tauri 2.12.7, tauri-build 2.7.6), `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/src-tauri/src/lib.rs`.
- `.github/workflows/ci.yml` (job `tauri` em `ubuntu-latest`, `cargo check --locked`; sem empacotamento).
- `docker-compose.yml`, `docker-compose.prod.yml`, `docs/IMPLANTACAO.md`, `docs/REDE.md`, `docs/API.md`, `docs/CONFIGURACAO.md`, `apps/desktop/README.md`, `packages/server/src/cors.ts`, `.env.example`, `.env.prod.example`.

## Fatos verificados

### 1. App Windows: instalador, WebView2, assinatura, atualizador

**Formatos (Tauri, Windows Installer):**

- "Tauri applications for Windows are either distributed as Microsoft Installers (`.msi` files) using the WiX Toolset v3 or as setup executables (`-setup.exe` files) using NSIS." (https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/windows-installer.mdx)
- "`.msi` installers can **only be created on Windows** as WiX can only run on Windows systems." (mesma fonte)
- MSI exige o recurso VBSCRIPT: "requires the VBSCRIPT optional feature to be enabled on Windows" (mesma fonte).
- Alvo padrão: `targets` aceita "all" ou uma lista com "nsis" e "msi" (`config.rs`, `BundleTarget`).
- `bundle.active`: "Whether Tauri should bundle your application or just output the executable." Hoje o `tauri.conf.json` do app tem `"active": false` (https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/src/config.rs; arquivo local `apps/desktop/src-tauri/tauri.conf.json`). Ou seja: sem mudar isso, `tauri build` não gera instalador.

**WebView2 (Tauri, Windows Installer):**

- "On Windows 10 (April 2018 release or later) and Windows 11, the WebView2 runtime is distributed as part of the operating system." (mesma fonte)
- "The installers by default download the WebView2 bootstrapper and executes it if the runtime is not installed." (mesma fonte)
- Modos e tamanhos da tabela da fonte: `downloadBootstrapper` (internet: sim; +0 MB; "Default"); `embedBootstrapper` (~1.8 MB; melhor para Windows 7 em `.msi`); `offlineInstaller` (~127 MB; funciona sem internet); `fixedVersion` (~180 MB); `skip` ("Your application WILL NOT work if the user does not have the runtime installed").
- Configuração: `"webviewInstallMode": { "type": "downloadBootstrapper" }` dentro de `bundle.windows` (mesma fonte).
- `minimumWebview2Version` existe; a fonte diz que serve para exigir uma versão mínima e rodar o bootstrapper se a versão for menor (mesma fonte).

**Compilação cruzada:**

- "Cross compiling Windows apps on Linux and macOS hosts is possible with caveats when using NSIS." E: "it should only be used as a last resort if local VMs or CI solutions like GitHub Actions don't work for you." (mesma fonte). Ou seja, a fonte recomenda compilar no Windows ou no CI, e não no Linux.

**tauri-action (GitHub Action):**

- "This GitHub Action builds your Tauri application as a native binary for macOS, Linux and Windows and optionally upload it to a GitHub Release." (https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/README.md)
- Matriz do exemplo da fonte: `platform: 'windows-latest'` com `args: ''`; macOS com `args: '--target aarch64-apple-darwin'` e `'--target x86_64-apple-darwin'`; `ubuntu-22.04` com `args: ''` e dependências do WebKit (mesma fonte).
- Entradas relevantes (mesma fonte): `tagName`; `releaseName`; `releaseDraft` (exemplo com `releaseDraft: true`); `releaseId`; `uploadWorkflowArtifacts` ("Whether to upload the bundles and executables as \"workflow artifacts\"."); `workflowArtifactNamePattern`; `artifactPaths` (saída). Se "you only want to build the app without having the action upload any assets ... simply omit `tagName`, `releaseName` and `releaseId`." Se o rascunho já existe, "`releaseDraft` must match the status of that release".
- A versão da action usada nos exemplos é `tauri-apps/tauri-action@v1`. A versão atual da action não foi lida.

**Assinatura e atualizador:**

- Assinatura de Windows no Tauri: o `tauri.conf.json` aceita `digestAlgorithm`, `certificateThumbprint`, `timestampUrl`, `tsp` e `signCommand` (campos verificados em `config.rs`). O texto da documentação de assinatura **não foi lido** (ver "O que não foi verificado").
- Atualizador: "Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled." Há duas chaves: a pública vai no `tauri.conf.json`; a privada assina os instaladores, e "You should NEVER share this key with anyone." Ao gerar atualizações, a chave privada entra por variável de ambiente: `export TAURI_SIGNING_PRIVATE_KEY="Path or content of your private key"`, e "`.env` files do _not_ work!" (https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx)
- Ao perder a chave privada: "if you lose this key you will NOT be able to publish new updates to the users that" (mesma fonte, texto cortado na leitura).

**Assinatura pela Microsoft (Artifact Signing):**

- "Artifact Signing is a Microsoft fully managed, end-to-end signing solution that simplifies the certificate signing process and helps partner developers more easily build and distribute applications." (https://raw.githubusercontent.com/MicrosoftDocs/azure-docs/main/articles/artifact-signing/overview.md)
- "Provides zero-touch certificate lifecycle management inside FIPS 140-3 level 3 certified HSMs." (mesma fonte)
- A conta tem "two resources: Identity validation; Certificate profile", e há dois tipos: "Basic SKU" e "Premium SKU" (mesma fonte).

**Runner Windows (GitHub):**

- `windows-latest` é o rótulo usado na documentação do tauri-action (ver acima). O README de imagem do Windows Server 2025 traz `Image Version: 20261111.331.1`, Microsoft Edge 157.0.4341.46, Node 22.23.5 e Rust 1.99.1 (https://raw.githubusercontent.com/actions/runner-images/main/images/windows/Windows2025-Readme.md). O arquivo não menciona WebView2 como item à parte; o WebView2 faz parte do sistema (ver acima).
- "GitHub-hosted runners are available with Ubuntu Linux, Windows, or macOS operating systems." (https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners)

**Disparo do workflow:**

- "With the exception of `workflow_dispatch` and `repository_dispatch`, other GITHUB_TOKEN-triggered events do not create workflow runs at all." (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). Ou seja: `workflow_dispatch` (disparo manual) funciona mesmo quando o disparo vem de outro workflow com `GITHUB_TOKEN`.

**Estado atual do repositório (local):**

- O job `tauri` de `.github/workflows/ci.yml` roda em `ubuntu-latest`, instala as bibliotecas do WebKit, usa `dtolnay/rust-toolchain@stable` e `Swatinem/rust-cache@v2` com `workspaces: apps/desktop/src-tauri`, e roda só `cargo check --locked`. Não há job de Windows.
- `tauri.conf.json`: `identifier: app.suup.desktop`, `bundle.icon` inclui `icons/icon.ico` (arquivo presente em `apps/desktop/src-tauri/icons/`), `bundle.targets: "all"`.
- O `pnpm` está fixado em `packageManager: pnpm@10.28.0`; o Node vem de `.nvmrc`.

### 2. macOS e Linux na mesma matriz

- O exemplo do tauri-action inclui macOS (Apple Silicon e Intel) e Ubuntu 22.04 na mesma matriz, com a instalação de `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils` no Ubuntu (https://raw.githubusercontent.com/tauri-apps/tauri-action/dev/README.md). O nosso CI já instala as bibliotecas de WebKit para Linux (`.github/workflows/ci.yml`).
- A documentação de instalador lida só cobre Windows. Sobre notarização e aviso de Gatekeeper no macOS: **não verificado**.

### 3. Docker Desktop no Windows e o servidor local

**Requisitos (Docker, instalação no Windows):**

- "Docker Desktop is not supported on server versions of Windows, such as Windows Server 2019 or Windows Server 2022." (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/setup/install/windows-install.md)
- Backend WSL 2, lista da fonte:
  - "WSL version 2.1.5 or later."
  - "Windows 10 64-bit: Enterprise, Pro, or Education version 22H2 (build 19045)."
  - "Windows 11 64-bit: Enterprise, Pro, or Education version 23H2 (build 22631) or higher."
  - "The Windows Server service (LanmanServer) must be enabled and its start mode set to **Automatic**."
  - "8GB system RAM" e "Enable hardware virtualization in BIOS/UEFI."
  - A lista de edições não inclui Home (mesma fonte).
- Backends: "Docker Desktop for Windows supports three backends: WSL 2, Hyper-V, and Docker VMM (Beta)." WSL 2 é o padrão e "works for most users without administrator privileges" (mesma fonte).
- Instalação por usuário (padrão): "It does not require administrator privileges to install or update" (mesma fonte).
- Versão atual: Docker Desktop 4.100.0, com data 2026-11-19, e "Docker Engine v29.9.3" (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/release-notes.md).
- Termos: "Commercial use of Docker Desktop in larger enterprises (more than 250 employees OR more than $10 million USD in annual revenue) requires a paid subscription" (mesma fonte de instalação).

**Socket do Docker e o worker:**

- "Mac and Windows WSL 2 users can connect to the Docker Engine through a Unix socket: `unix:///var/run/docker.sock`." (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/troubleshoot-and-support/faqs/general.md). A fonte fala de quem se conecta ao Engine; **não diz** que o socket montado num contêiner Linux funciona da mesma forma. Isso não foi verificado nas fontes lidas.
- O grupo `docker-users`: "Membership in `docker-users` grants access to the Docker daemon socket, which is equivalent to granting administrative privileges on the host. ... For Linux containers using the WSL 2 backend, this group membership is not required." (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/setup/install/windows-install.md). Para o nosso caso (contêineres Linux com WSL 2), não precisa ser adicionado a esse grupo.
- Nota de segurança do próprio projeto: o worker é "o único serviço com o socket do Docker" (`docker-compose.prod.yml`, comentário; `docs/IMPLANTACAO.md`: "quem controla o socket controla o Docker do host").
- Versão corrigida: nas notas de versão há um item de correção de CVE-2025-9074, em que "a malicious container running on Docker Desktop could access the Docker Engine and launch additional containers without requiring the Docker socket to be mounted" (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/release-notes.md). Ele está corrigido nas versões atuais, mas não muda a regra de que o socket dá controle do Engine.
- Docker Desktop com "Enhanced Container Isolation" restringe montagens do socket (notas de versão). Não sabemos se o modo está ligado por padrão no caso do Suup: **não verificado**.

**Volumes e desempenho:**

- "To use bind mounts, keep your projects on a Windows drive." (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/features/wsl/_index.md). Com o backend VMM, "only files on Windows drives (for example under /mnt/c) can be bind-mounted from WSL" (mesma fonte). Com WSL 2, a mesma fonte diz que "You can still build images from a directory inside your distribution, but `docker.exe` reads the build context through WSL file sharing. This is slower".
- O `docker-compose.prod.yml` monta `./suup.config.json` e `/var/run/docker.sock` como bind mounts. Por isso o repositório precisa estar em um disco do Windows (ex.: `C:\...`), ou dentro do WSL com a restrição acima. A escolha exata do backend para o modo local é inferência (ver Inferências).
- VMM (Beta): "Docker VMM is a container-optimized hypervisor that reclaims idle memory and improves file I/O." (https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/setup/install/windows-install.md, dica da seção de backends). A página própria, https://raw.githubusercontent.com/docker/docs/main/content/manuals/desktop/features/vmm.md, diz que melhora a E/S de arquivos entre o contêiner e o host.

**Rede interna (`internal: true`):**

- "`internal`, when set to `true`, lets you create an externally isolated network." (https://raw.githubusercontent.com/docker/docs/main/content/reference/compose-file/networks.md)
- O nosso `docker-compose.prod.yml` define `sandbox-net` com `internal: true`, sub-rede `172.29.77.0/24` e o worker com `ipv4_address: 172.29.77.2`. O `docs/REDE.md` diz que "O contêiner roda numa rede Docker **interna** (`--internal`): sem rota para fora, sem DNS para fora."
- Ressalva específica do Docker Desktop para `internal`: **não encontrada** nas fontes lidas.

### 4. App ↔ servidor (Tauri 2)

**Origem da webview no Windows:**

- `useHttpsScheme`: "Sets whether the custom protocols should use `https://<scheme>.localhost` instead of the default `http://<scheme>.localhost` on Windows and Android. Defaults to `false`." (https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/src/config.rs). O padrão, portanto, é `http://tauri.localhost` no Windows.
- Na mesma nota: "Using a `https` scheme will NOT allow mixed content when trying to fetch `http` endpoints and therefore will not match the behavior of the `<scheme>://localhost` protocols used on macOS and Linux." (mesma fonte).
- Também: "Changing this value between releases will change the IndexedDB, cookies and localstorage location and your app will not be able to access the old data." (mesma fonte). Ou seja, trocar o esquema depois de publicar apaga o armazenamento local do app.
- Exemplo da documentação de cabeçalhos: `access-control-allow-origin:  http://tauri.localhost` (https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/http-headers.mdx).

**CSP:**

- "Tauri restricts the Content Security Policy (CSP) of your HTML pages." (https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/csp.mdx). A CSP do Suup: `connect-src ipc: http://ipc.localhost` (`tauri.conf.json`, na produção), e no modo de desenvolvimento acrescenta `ws://localhost:1420 http://localhost:1420`.

**Como o app fala com o servidor (código local):**

- Toda requisição sai pelo comando `http_fetch` em Rust, com `reqwest`, e "só aceita o endereço (esquema, host e porta) configurado" (`apps/desktop/README.md`; `apps/desktop/src-tauri/src/lib.rs`, linhas 46-64). Redirecionamentos são desligados (`Policy::none()`).
- O mesmo `http_fetch` **remove** os cabeçalhos `host`, `content-length` e `origin` antes de enviar (`lib.rs`, linhas 215-218).
- O token fica no chaveiro do sistema: `keyring` com `windows-native` (Credential Manager) em `Cargo.toml`, e a URL em arquivo de configuração (`apps/desktop/README.md`).
- `Cargo.toml` não tem `tauri-plugin-http`. A permissão da janela é só `core:default` e `notification:default` (`capabilities/default.json`), e a própria descrição diz: "A rede NÃO está aqui".

**CORS no servidor (código local):**

- O servidor aceita só origens de `server.allowedOrigins`. Uma requisição com `Origin` fora da lista leva `403 origin_not_allowed`. "Quem não manda `Origin` (curl, scripts) não é afetado." (`docs/API.md`, linha 22; `packages/server/src/cors.ts`).
- Os valores que a documentação do Suup manda acrescentar para o app são `tauri://localhost`, `http://tauri.localhost` e `https://tauri.localhost` (`docs/CONFIGURACAO.md`, linha 95; `packages/server/src/cors.ts`, `TAURI_ORIGINS`).

**Capabilities:**

- A documentação do Tauri diz: "Capabilities define which [permissions] are granted or denied for which windows or webviews." (https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/security/capabilities.mdx). O Suup não precisa de permissão de rede para o `http_fetch`, que é um comando próprio.

### 5. VPS (o que já está documentado)

- `docs/IMPLANTACAO.md`, seção "O que sobe": "proxy TLS" na frente (HTTPS 443), que fala com `http://127.0.0.1:8787` (só no próprio host). O servidor e o worker ficam no `docker-compose.prod.yml`. O `server` publica `"127.0.0.1:${SUUP_PORT:-8787}:8787"`.
- `docs/IMPLANTACAO.md`, "Requisitos": "Um nome de domínio apontando para a VPS, se for usar TLS com certificado público (recomendado; é o que torna o app seguro fora da sua casa)."
- O token: "O servidor **não sobe** sem token, nem com menos de 32 caracteres. `suup server --generate-token` imprime um novo (43 caracteres, 256 bits aleatórios)." (`docs/API.md`, linha 15).

## Inferências

Rotuladas. São conclusões minhas a partir das fontes acima, não afirmações delas.

1. **O instalador deve ser NSIS (`.exe`).** O MSI exige WiX v3 e o recurso VBSCRIPT (fato 1). Para o dono testar, o `.exe` é mais simples. Ainda não sabemos se o NSIS pode ser instalado sem administrador: **não verificado**.
2. **`bundle.active` precisa virar `true`** e `bundle.targets` precisa ser `["nsis"]` (ou `"nsis"`) no `tauri.conf.json`. Sem isso o build só gera o executável (fato 1, `config.rs`).
3. **WebView2: `downloadBootstrapper` (padrão).** Windows 10 (a partir de abril de 2018) e Windows 11 já trazem o runtime (fato 1). O bootstrapper só entra se faltar. O `offlineInstaller` (~127 MB) só vale para instalação sem internet.
4. **Sem assinatura agora.** O custo de assinar é uma conta de Artifact Signing (verificação de identidade) ou um certificado. Enquanto for só para o dono testar, o instalador pode ser não assinado. Isso precisa de um passo documentado para o aviso do Windows (fato 1 e "O que não foi verificado").
5. **Matriz do CI:** um job `desktop-windows` em `windows-latest` (ou um workflow `desktop.yml`), com `workflow_dispatch` e `push` de tag de versão. Não incluir o Windows nos pushes de PR de rotina por custo e tempo (o tempo de build não foi medido; ver "O que não foi verificado"). O `tauri-action` com `uploadWorkflowArtifacts: true` (artefato para baixar) e com `tagName` + `releaseDraft: true` (rascunho de Release, só no disparo por tag) cobrem os dois usos (fato 1).
6. **macOS e Linux depois do Windows.** A matriz já tem exemplo pronto na documentação (fato 2). Macs exigem notarização para uma distribuição sem alerta, o que não foi verificado aqui. Acrescentar as plataformas só depois de o instalador do Windows estar estável.
7. **O servidor local com Docker Desktop** deve usar um arquivo de composição próprio, como `docker-compose.local.yml`, reaproveitando os serviços do `docker-compose.prod.yml`. Ele sobe `db`, `migrate`, `server` e `worker`, com `SUUP_PORT` padrão `8787` publicado em `127.0.0.1` (como já está no prod). O token vai num `.env.local` gerado com `suup server --generate-token`. Isso segue a regra de `docs/API.md`.
8. **Ajustes no compose para o Windows.** `DOCKER_GID` (o `group_add` do worker) vem de `stat -c %g /var/run/docker.sock`, que só faz sentido num Linux. No Docker Desktop, o grupo do socket não foi verificado. Para o modo local, o `group_add` pode ser removido ou fixado por configuração, e o teste precisa ser feito numa máquina Windows real (ver "O que não foi verificado").
9. **O app nativo não precisa de CORS para falar com o servidor.** O `http_fetch` remove o `Origin` e a requisição sai pelo Rust (fato 4, código local). Logo, as origens `tauri://localhost`, `http://tauri.localhost` e `https://tauri.localhost` em `allowedOrigins` são necessárias só se a webview chamar o servidor diretamente. Isso é inferência a partir do código; não foi testado. Manter as origens na lista não atrapalha, mas a instrução de `docs/CONFIGURACAO.md` pode ser simplificada.
10. **CSP e `connect-src` não mudam** para o caso nativo, porque as requisições não partem da webview. Se um dia a webview chamar o servidor diretamente, seria preciso acrescentar o endereço do servidor no `connect-src`, e um servidor em `http://` só funciona com o esquema `http://tauri.localhost` (fato 4: o esquema `https` bloqueia conteúdo misto). Não usar `useHttpsScheme` a não ser que a VPS tenha TLS (inferência; a regra de conteúdo misto é o fato).
11. **Esquema do Windows fixado cedo.** Trocar `useHttpsScheme` depois de publicar apaga o armazenamento local (IndexedDB, cookies, localStorage) do app (fato 4). Decidir antes do primeiro instalador distribuído: o padrão `http://tauri.localhost`.
12. **Para a VPS**: o que muda é o endereço nas configurações do app (HTTPS, com o domínio), o TLS no proxy (já documentado), e a checagem de que `allowedOrigins` continua restrito. Nada no código do app muda. O token continua no chaveiro. O `docker-compose.prod.yml` já é o arquivo da VPS.

## O que não foi verificado

- **SmartScreen e o texto do aviso do Windows** ("aplicativo não reconhecido", "Mais informações", "Executar assim mesmo"): não li nenhuma fonte primária. Os passos para o dono precisam ser confirmados numa instalação de teste.
- **Documentação de assinatura do Tauri para Windows** (`distribute/sign/windows`): 404 no GitHub e bloqueada no site. Os campos de configuração foram lidos em `config.rs`, mas o procedimento não.
- **Artifact Signing**: elegibilidade (pessoa física ou empresa), países, preço, e se conta de pessoa física é aceita. A página lida só descreve o produto.
- **Certificados comerciais (OV/EV)**: não pesquisei fornecedores nem as regras atuais.
- **Tempo de build no `windows-latest`** e custo em minutos (o peso de minutos para Windows): não verificado.
- **Retenção padrão dos artefatos de workflow**: não encontrada no texto lido.
- **Rust cache**: a eficiência de `Swatinem/rust-cache` no Windows não foi medida. O repositório já usa a ação no job Linux.
- **Atualizador (plugin) e assinatura do conteúdo**: li só o requisito das chaves. A configuração do endpoint do plugin e o formato `latest.json` não foram lidos.
- **Versão atual da `tauri-action`**: lida só a documentação do ramo `dev` (exemplos com `@v1`).
- **Docker Desktop: socket montado num contêiner Linux** (`/var/run/docker.sock` dentro do worker) funciona no Windows com WSL 2: as fontes lidas não dizem. Também não sei qual é o grupo do socket visto pelo contêiner.
- **Docker Desktop: rede `internal: true`**: não encontrei ressalva específica do Docker Desktop. A ressalva é só a documentação geral do Compose.
- **Desempenho real** de bind mounts e de build no WSL 2 com o projeto no sistema de arquivos do Linux: a fonte fala de lentidão, sem números.
- **Docker Desktop com Enhanced Container Isolation** e o socket montado: não verificado se o modo está ligado nos planos do dono e se bloqueia o worker.
- **Comportamento de `https://localhost` e `http://localhost` (conteúdo misto) em WebView2** com `http://tauri.localhost`: não li fonte. Nosso fluxo não depende disso, porque o `http_fetch` sai pelo Rust.
- **macOS**: notarização e Gatekeeper. **Linux**: formatos de pacote além do que o tauri-action já mostra.
- **Pacote do Tauri**: a versão da própria `@tauri-apps/cli` em uso (2.12.6, no lock) é a do registro npm. A do crate (2.12.7, no lock) é a do ramo `dev`. Não confirmei se são a mesma série publicada.

## Implicação para o Suup

Tudo abaixo é inferência a partir das fontes; nada foi testado numa máquina Windows.

| Decisão | Base | Tipo |
|---|---|---|
| Instalador Windows em NSIS (`.exe`). Não usar MSI por enquanto | MSI precisa de WiX v3 e VBSCRIPT; NSIS é o outro formato suportado (fato 1) | Fato para o formato; a escolha é inferência |
| `bundle.active: true` e `bundle.targets: ["nsis"]` no `tauri.conf.json` | `active: false` não gera instalador (fato 1, `config.rs`) | Fato para o campo; a mudança é inferência |
| `webviewInstallMode: downloadBootstrapper` (padrão) | Windows 10 (abril de 2018 ou depois) e 11 já trazem o WebView2 (fato 1) | Fato para o padrão; a escolha é inferência |
| Job `desktop-windows` em `windows-latest` com `tauri-apps/tauri-action@v1`, `args: ''`, Node pelo `.nvmrc`, pnpm pelo `packageManager`, Rust `stable` e `Swatinem/rust-cache@v2` (já usado em `ci.yml`) | Exemplo do tauri-action (fato 2); `ci.yml` local | Fato para as peças; a montagem é inferência |
| Gatilhos: `workflow_dispatch` e tag de versão (ex.: `app-v*`). Sem build de Windows em todo PR | `workflow_dispatch` dispara mesmo com `GITHUB_TOKEN` (fato 1); custo e tempo não medidos | Inferência |
| Saídas: `uploadWorkflowArtifacts: true` (artefato `.exe` para baixar) em todo disparo; `tagName` + `releaseDraft: true` só no disparo por tag | Entradas do tauri-action (fato 1) | Fato para as entradas; o uso é inferência |
| Macintosh e Linux entram depois, em outra fase | Exemplo pronto (fato 2); notarização não verificada | Inferência |
| Sem assinatura agora. O instalador vai para o dono com um passo documentado para o aviso do Windows | Assinatura não é exigida pelo Tauri para gerar o instalador. O aviso do SmartScreen não foi verificado (ver lacuna) | Inferência; o passo precisa de confirmação |
| Assinatura futura por Artifact Signing (conta de identidade) ou certificado, via `signCommand` ou `certificateThumbprint` | Artifact Signing: produto gerenciado, HSM FIPS 140-3 nível 3 (fato 1); campos de `config.rs` | Fato para o produto; a escolha é inferência |
| Atualizador: gerar chaves com `tauri signer generate`, pública no `tauri.conf.json`, privada como segredo do GitHub em `TAURI_SIGNING_PRIVATE_KEY`. Não perder a chave privada | Requisito da documentação do atualizador (fato 1) | Fato para o requisito |
| Esquema `http://tauri.localhost` no Windows (padrão). Não mudar depois de publicar | `useHttpsScheme` padrão `false` e troca apaga o armazenamento local (fato 4) | Fato para o padrão; a decisão é inferência |
| `allowedOrigins` continua com `http://localhost:1420` (dev). Revisar a instrução das origens Tauri, que pode ser desnecessária para o app nativo | `http_fetch` remove `Origin` e sai pelo Rust (fato 4, código) | Inferência; não testado |
| CSP e `connect-src` do app ficam como estão | Requisições nativas não passam pela webview (fato 4); a CSP do Tauri restringe a página (fato 4) | Inferência |
| Modo local: `docker-compose.local.yml` com serviços do prod, `SUUP_PORT` 8787 em `127.0.0.1`, sem TLS, token em `.env.local` gerado por `suup server --generate-token` | `docs/API.md` (token de 43 caracteres, mínimo de 32); `docker-compose.prod.yml` (bind em `127.0.0.1`) | Inferência |
| Repositório num disco do Windows (ex.: `C:\`) para os bind mounts de `suup.config.json` e do socket | Docker, WSL 2: bind mounts só em disco do Windows com VMM; WSL 2 é mais lento para build (fato 3) | Fato para a restrição; a escolha do backend é inferência |
| Remover ou tornar configurável o `DOCKER_GID` no modo local, até testar o socket no Docker Desktop | `stat -c` é do Linux; o grupo do socket no Docker Desktop não foi verificado (lacuna) | Inferência |
| Worker com o socket (e só ele), como hoje. Não adicionar o dono ao grupo `docker-users` | O grupo dá acesso ao socket com privilégio de administrador do host; para contêiner Linux com WSL 2, não é necessário (fato 3) | Fato para o grupo; a regra é inferência |
| Rede `sandbox-net` `internal: true` mantida. Testar no Windows que os bots não saem para a internet e que o proxy alcança o worker | `internal` isola da rede externa (fato 3); a ressalva do Docker Desktop não foi achada (lacuna) | Fato para o `internal`; o teste no Windows é inferência |
| VPS: trocar o endereço do app por HTTPS com o domínio, manter TLS no proxy e o token; nada muda no código | `docs/IMPLANTACAO.md` (proxy TLS, token, `127.0.0.1:8787`) | Fato para o documento; a lista de mudanças é inferência |

**Passos para o dono no Windows (rascunho, a confirmar):**

1. Conferir a edição (Pro, Enterprise ou Education) e a versão (Windows 10 22H2 build 19045 ou Windows 11 23H2 build 22631 ou superior), com virtualização ligada na BIOS e 8 GB de RAM. Windows Server não é suportado (fato 3).
2. Instalar o Docker Desktop (instalação por usuário, sem administrador). Ativar o backend WSL 2 e instalar o WSL na versão 2.1.5 ou superior (fato 3).
3. Clonar o repositório num disco do Windows (ex.: `C:\suup`).
4. Gerar o token e criar `.env.local` (comando planejado: `suup server --generate-token`, dentro de um contêiner ou com o CLI).
5. Subir o servidor local (comando planejado: `docker compose -f docker-compose.local.yml --env-file .env.local up -d --build`).
6. Baixar o instalador `.exe` do artefato do workflow (ou do rascunho de Release, quando houver tag). Instalar e, se o Windows mostrar o aviso do SmartScreen, seguir o passo documentado (a confirmar).
7. No app, informar `http://127.0.0.1:8787` e o token. O token vai para o Gerenciador de Credenciais do Windows (fato 4, código local).
