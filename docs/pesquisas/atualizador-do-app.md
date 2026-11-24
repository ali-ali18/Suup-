# Pesquisa: atualização automática do app de desktop (Tauri 2)

Data da pesquisa: 23/11/2026. Valida a entrega "o app se atualiza sozinho" (aprovada pelo dono em 23/11/2026: "não preciso reinstalar nada, ele só atualiza", como o Grok). Ver [ATUALIZACAO.md](../ATUALIZACAO.md).

## Pergunta

Como o atualizador oficial do Tauri 2 (`tauri-plugin-updater`) procura, baixa, confere e instala uma versão nova; o que o `tauri-action` publica numa Release do GitHub para ele; o que acontece com os dados do app numa atualização do instalador NSIS do Windows; e o que um repositório privado muda?

## Fontes

Todas lidas diretamente em 23/11/2026 (via `curl` de raw.githubusercontent.com, crates.io, registry.npmjs.org e api.github.com; tauri.app não foi usado: a documentação foi lida no repositório dela).

Tauri (plugin e documentação):

- Documentação do plugin, `tauri-apps/tauri-docs`, ramo `v2`, `src/content/docs/plugin/updater.mdx`: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx
- Documentação do instalador do Windows, mesmo repositório, `src/content/docs/distribute/windows-installer.mdx`: https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/distribute/windows-installer.mdx
- Código do plugin, `tauri-apps/plugins-workspace`, ramo `v2`, `plugins/updater/` (`Cargo.toml`, `package.json`, `README.md`, `src/config.rs`, `src/updater.rs`, `src/error.rs`, `permissions/default.toml`): https://raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/updater/src/updater.rs (e os vizinhos)
- crates.io, `tauri-plugin-updater` (versões, licença, `rust_version`): https://crates.io/api/v1/crates/tauri-plugin-updater
- npm, `@tauri-apps/plugin-updater`: https://registry.npmjs.org/@tauri-apps/plugin-updater
- Código da CLI do Tauri, `tauri-apps/tauri`, ramo `dev`: `crates/tauri-cli/src/bundle.rs` (assinatura dos pacotes), `crates/tauri-cli/src/helpers/updater_signature.rs`, `crates/tauri-cli/src/signer/generate.rs`, `crates/tauri-cli/CHANGELOG.md`: https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/src/bundle.rs (e os vizinhos)
- Modelo do instalador NSIS, `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`: https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- `crates/tauri-bundler/src/bundle/updater_bundle.rs`: https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/updater_bundle.rs

tauri-action:

- `README.md`, `action.yml`, `CHANGELOG.md` e `src/upload-version-json.ts`, `src/inputs.ts`, `src/create-release.ts` do repositório `tauri-apps/tauri-action` (ramo `dev`, commit `4092d6e`, de 12/11/2026; clonado com `git clone --depth 1`): https://github.com/tauri-apps/tauri-action
- Tags do repositório (`git ls-remote --tags`): existem `v1`, `v1.0` e `v1.0.0`.

GitHub:

- "Linking to releases": https://raw.githubusercontent.com/github/docs/main/content/repositories/releasing-projects-on-github/linking-to-releases.md
- "About releases": https://raw.githubusercontent.com/github/docs/main/content/repositories/releasing-projects-on-github/about-releases.md
- Descrição oficial da API REST (`github/rest-api-description`, `api.github.com.json`), operações `GET /repos/{owner}/{repo}/releases/latest` e `GET /repos/{owner}/{repo}/releases/assets/{asset_id}`: https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
- "Troubleshooting the REST API": https://raw.githubusercontent.com/github/docs/main/content/rest/using-the-rest-api/troubleshooting-the-rest-api.md
- "Rate limits for the REST API" e o trecho reutilizado `data/reusables/rest-api/primary-rate-limit-unauthenticated-users.md`: https://raw.githubusercontent.com/github/docs/main/data/reusables/rest-api/primary-rate-limit-unauthenticated-users.md
- O próprio repositório, `GET https://api.github.com/repos/ali-ali18/suup-` (campo `visibility`) e `.../releases`.

## Fatos verificados

### 1. O plugin: versões, licença, como entra no app

- crates.io: a versão estável mais nova de `tauri-plugin-updater` é **2.14.1** (publicada em 28/10/2026), licença **"Apache-2.0 OR MIT"**, `rust_version` **1.90**. Há uma `3.0.0-alpha.3` (14/10/2026), que não é estável. O README: "This plugin requires a Rust version of at least **1.90**".
- npm: `@tauri-apps/plugin-updater` tem `latest` = **2.14.1** (28/10/2026), licença "MIT OR Apache-2.0", depende de `@tauri-apps/api ^2.12.0`.
- A documentação instala o plugin em Rust (`cargo add tauri-plugin-updater --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'`) e o inicia com `app.handle().plugin(tauri_plugin_updater::Builder::new().build())`; o pacote de JavaScript é opcional ("You can install the JavaScript Guest bindings").
- A documentação mostra também o caminho só em Rust: "To notify the frontend of the download progress consider using a command with a [channel]", com comandos próprios `fetch_update` e `install_update` que guardam o `Update` pendente no estado do app.
- Permissões: "By default all potentially dangerous plugin commands and scopes are blocked"; `updater:default` libera `allow-check`, `allow-download`, `allow-install` e `allow-download-and-install` para a página (`permissions/default.toml`). Comandos próprios em Rust não precisam dessas permissões.

### 2. Como procura: endpoints e `latest.json`

- `endpoints`: "This must be an array of endpoint URLs as strings. TLS is enforced in production mode. Tauri will only continue to the next url if a non-2XX status code is returned!" O exemplo inclui "a static github json file": `https://github.com/user/repo/releases/latest/download/latest.json`.
- O JSON estático tem `version` (SemVer, "with or without a leading `v`"), `notes`, `pub_date` (RFC 3339) e `platforms`, cada chave no formato `OS-ARCH` (`windows-x86_64`, `darwin-aarch64`...), com `url` e `signature`. "The required keys are `"version"`, `"platforms.[target].url"` and `"platforms.[target].signature"`". `signature` é "The content of the generated `.sig` file ... A path or URL does not work!"
- "Tauri will validate the whole file before checking the version field".
- Sem resposta válida de nenhum endpoint, `check` falha com `Error::ReleaseNotFound` ("Could not fetch a valid release JSON from the remote", `src/error.rs`). Uma versão nova sem a chave da plataforma atual falha com `TargetNotFound` / `TargetsNotFound` (`src/updater.rs`, `get_urls`).
- Comparação: `None => release.version > self.current_version` (`update_from_release`); e "a release that is not an update is not an error, even if it has no entry for this target".
- O pedido sai do processo nativo (o `reqwest` do próprio plugin, com `user_agent(UPDATER_USER_AGENT)`), não da página. O download manda `Accept: application/octet-stream` quando não há outro (`download`).

### 3. Assinatura (minisign)

- "Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled."
- Duas chaves: a pública vai em `tauri.conf.json` ("can be uploaded and shared safely as long as your private key is secure"); a privada "You should NEVER share this key with anyone. Also, if you lose this key you will NOT be able to publish new updates to the users that have the app already installed."
- Gerar: `tauri signer generate -w ~/.tauri/myapp.key`.
- Na compilação: `TAURI_SIGNING_PRIVATE_KEY` ("Path or content of your private key") e, opcional, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. "`.env` files do _not_ work!"
- `pubkey`: "This has to be the public key generated from the Tauri CLI ... It **cannot** be a file path!"
- A CLI (`bundle.rs`, `sign_updaters`): sem `createUpdaterArtifacts` ligado, nada é assinado ("Updater not enabled"); ligado e sem a chave privada, a compilação **falha**: "A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable." Com chave que não bate com a `pubkey`, só avisa: "won't be accepted at runtime".
- Na CLI, os ajustes do atualizador só são lidos com `createUpdaterArtifacts` ligado: `let updater_enabled = config.bundle.create_updater_artifacts != Updater::Bool(false);` (`crates/tauri-cli/src/interface/rust.rs`, https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/src/interface/rust.rs, lido em 23/11/2026). Com ele desligado (o padrão), `plugins.updater` no `tauri.conf.json` não muda a compilação.
- A conferência (`verify_signature`): decodifica a chave pública e a assinatura de base64 e chama `public_key.verify(data, &signature, true)`; um pacote que não confere nunca é instalado ("a package that does not match this update's signature is never installed", `install`).
- Versão assinada: a CLI 2.12.0 passou a gravar a versão no comentário confiável da assinatura (CHANGELOG: "Record the app version in the trusted comment of updater signatures ... Enable `requireSignedVersion` in the updater plugin configuration to enforce this."). O plugin compara a versão assinada com a anunciada (`SignedVersionMismatch`); sem versão na assinatura, só falha se `requireSignedVersion` estiver ligado (`MissingSignedVersion`).

### 4. `createUpdaterArtifacts` e o que sai no Windows

- `"bundle": { "createUpdaterArtifacts": true }`. No Windows: "`myapp-setup.exe` - The standard app bundle. It will be re-used by the updater." e "`myapp-setup.exe.sig` - The signature of the update bundle." (o mesmo para `.msi`). No Linux, o AppImage e o `.sig`; no macOS, `myapp.app.tar.gz` e `.sig`.
- `updater_bundle.rs`: o pacote de atualização do Linux vem do **AppImage** (`PackageType::AppImage`); o do macOS, do `.app` (`PackageType::MacOsBundle`).

### 5. Instalação no Windows (NSIS), dados do app, saída

- `installMode` do atualizador: `"passive"`: "There will be a small window with a progress bar. The update will be installed without requiring any user interaction. Generally recommended and the default mode."; `"basicUi"` pede interação; `"quiet"`: "There will be no progress feedback to the user ... Generally not recommended."
- O plugin chama o instalador NSIS com `/P` (passivo), **`/UPDATE`** e, para reabrir o app, `/R` (`nsis_args`, `updater_parameters`).
- No modelo `installer.nsi`, a seção de desinstalação só apaga os dados do app com a caixa marcada **e fora de atualização**: "Delete app data if the checkbox is selected / and if not updating" (`${If} $DeleteAppDataCheckboxState = 1` / `${AndIf} $UpdateMode <> 1`, então `RmDir /r "$APPDATA\${BUNDLEID}"` e `RmDir /r "$LOCALAPPDATA\${BUNDLEID}"`). A instalação por usuário vai para `$LOCALAPPDATA\${PRODUCTNAME}`.
- "Due to a limitation of Windows installers, Tauri will automatically quit your application before installing updates on Windows." No código: depois de lançar o instalador (`ShellExecuteW`), `std::process::exit(0)`. Há um gancho síncrono, `on_before_exit`, que roda antes disso.
- A seção de instalação confere se o app está aberto: `!insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"` (o executável principal).
- "currentUser" (o padrão do NSIS do Tauri): "the installer does not require Administrator privileges to run, but the app is installed in the `%LOCALAPPDATA%` folder".
- macOS / Linux: "You need to relaunch the app to run the newly install version". No macOS e no AppImage o plugin guarda uma cópia do app atual e a **restaura** se a troca falhar (`replace_bundle`, "if something went wrong during the extraction, we should restore previous app"; erro `PreviousAppNotRestored` só se a restauração também falhar).

### 6. Versão menor que a atual

- "By default Tauri checks if the update version is greater than the current app version". Para aceitar versão menor é preciso `version_comparator` (Rust) ou `allowDowngrades` na configuração (`config.rs`, `allow_downgrades`, padrão falso).

### 7. tauri-action

- O exemplo principal cria a Release: `permissions: contents: write`, `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `tagName: app-v__VERSION__` ("the action automatically replaces \_\_VERSION\_\_ with the app version"), `releaseName`, `releaseBody`, `releaseDraft: true`, `prerelease: false`, `uses: tauri-apps/tauri-action@v1`.
- v1.0.0 (CHANGELOG): "**Breaking Change**: Renamed `includeUpdaterJson` to `uploadUpdaterJson`"; "The action will now fail if `draft: true` is set but the relevant release is not a draft"; "The download urls in `latest.json` will now use the github url instead of the browser download url."
- `uploadUpdaterJson` (padrão `true`): "Whether to upload a JSON file for the updater or not (only relevant if the updater is configured). This file assume you're using the GitHub Release as your updater endpoint." `updaterJsonPreferNsis` (padrão `false`, "for legacy reasons"): escolhe NSIS ou MSI quando os dois existem.
- `src/upload-version-json.ts`: o arquivo se chama `latest.json`; a `url` de cada plataforma é `${githubBaseUrl}/repos/${owner}/${repo}/releases/assets/${data.id}`, e `githubBaseUrl` é `GITHUB_API_URL` ou `https://api.github.com` (`src/inputs.ts`). Sem `.sig` encontrada: "Signature not found for the updater JSON. Skipping upload...".
- "If you only want to build the app without having the action upload any assets ... simply omit `tagName`, `releaseName` and `releaseId`." (é o que o `desktop-installer.yml` faz hoje).
- "relative paths provided via the `--config` flag will be resolved relative to the `projectPath`".

### 8. GitHub: "latest", rascunhos, repositório privado

- `/releases/latest/download/asset-name.zip` leva ao arquivo da Release mais nova ("Linking to releases").
- API: "The latest release is the most recent non-prerelease, non-draft release". Logo, um **rascunho não é visto** pelo app até ser publicado.
- O arquivo de uma Release pela API: "set the `Accept` header of the request to `application/octet-stream`. The API will either redirect the client to the location, or stream it directly if possible."
- "If you make a request to access a private resource and your request isn't properly authenticated, you will receive a `404 Not Found` response."
- "You can make unauthenticated requests if you are only fetching public data ... The primary rate limit for unauthenticated requests is 60 requests per hour." (por endereço IP).
- "Anyone with read access to a repository can view and compare releases".
- Hoje (23/11/2026, 23h) `GET https://api.github.com/repos/ali-ali18/suup-` responde `"visibility": "public"`, e a lista de Releases está vazia.

## Inferências

- **Repositório público é requisito** deste desenho: num repositório privado o `latest.json` e os instaladores respondem 404 sem autenticação, e o app só poderia baixá-los com um token embutido, o que é inaceitável (qualquer um extrairia o token do app). Com o repositório privado, a saída seria outro servidor (um bucket ou CDN público só com os instaladores e o `latest.json`). Inferência a partir dos fatos 8.
- Enquanto não houver nenhuma Release publicada, `check` falha com `ReleaseNotFound`; isso é "nada novo", não um erro para a pessoa.
- Uma plataforma sem pacote assinado na Release (o `.deb` do Linux, que não é atualizável por este caminho: o pacote de atualização do Linux é o AppImage) também é "nada novo".
- O caminho só em Rust (comandos próprios com canal de progresso) encaixa no app: a página do Suup não fala com a rede (CSP só `ipc:`), e **parar o servidor embutido** antes do instalador exige Rust de qualquer jeito: no Windows o plugin chama `std::process::exit(0)` logo depois de lançar o instalador, o que pula o `RunEvent::ExitRequested` onde o app para o servidor com calma. Por isso o pacote JS e `updater:default` não são necessários (menos superfície).
- O instalador confere só o executável principal aberto (`CheckIfAppIsRunning`); o Node do servidor embutido e o PostgreSQL ficam em `$INSTDIR` também. Se ainda estivessem rodando, a troca desses arquivos poderia falhar. Parar o servidor antes de instalar evita isso. (Inferência; o comportamento exato do NSIS com arquivo em uso não foi testado.)
- Os dados do servidor embutido ficam em `%LOCALAPPDATA%\app.suup.desktop\local` (`app_local_data_dir`), que é `$LOCALAPPDATA\${BUNDLEID}`: o instalador em modo `/UPDATE` não os apaga, e a pasta de instalação (`$LOCALAPPDATA\Suup`) é outra.
- Como o servidor embutido aplica as migrações a cada partida (`apps/sidecar/src/run.ts`, etapa "migrations"), a versão nova atualiza o banco na primeira abertura, sem passo extra.
- `requireSignedVersion: true` é seguro aqui: a CLI do projeto é 2.12.6 (grava a versão desde a 2.12.0), e ainda não há Release antiga assinada sem versão.
- Ligar `createUpdaterArtifacts` no `tauri.conf.json` quebraria o `desktop-installer.yml` (sem o segredo a CLI falha, fato 3). Ele deve ser ligado só no fluxo de Release, por `--config` com um arquivo à parte.
- Publicar a Release como **rascunho** dá ao dono o último passo: o app não vê o rascunho (fato 8) até ele publicar.

## O que não foi verificado

- Uma atualização assinada de ponta a ponta no Windows (baixar, conferir, NSIS `/P /UPDATE /R`, reabrir): só depois que o dono gerar a chave, colocar os segredos e publicar uma Release.
- Se a URL da API (`api.github.com/.../releases/assets/<id>`) que o tauri-action v1 grava no `latest.json` conta no limite de 60 pedidos por hora por IP em cada download; e se o redirecionamento é seguido pelo `reqwest` do plugin sem problema (o código do plugin não foi lido nesse ponto).
- O texto completo da macro `CheckIfAppIsRunning` (o arquivo `process.nsh`/`utils.nsh` não foi achado pelo caminho tentado; 404).
- O comportamento do atualizador com o `.deb` (o plugin tem `install_deb` no ramo `v2`, mas o fluxo de Release não publica pacote assinado do Linux).
- tauri.app não foi aberto (bloqueado); a documentação foi lida no repositório `tauri-docs`.

## Implicação para o Suup

| Decisão | Base | Tipo |
|---|---|---|
| Atualizador oficial `tauri-plugin-updater` 2.x (2.14.1), só em Rust, com comandos próprios (`update_info`, `update_check`, `update_download`, `update_install`) e canal de progresso; sem o pacote JS e sem `updater:default` | Fatos 1 e 5; inferência sobre a CSP e o `exit(0)` | Fato + inferência |
| `plugins.updater.endpoints` = `https://github.com/ali-ali18/suup-/releases/latest/download/latest.json` | Fatos 2 e 8 | Fato |
| `pubkey` = um marcador que o dono troca; com o marcador, o atualizador fica **desligado** sem erro (comparação exata com o marcador) | Fato 3 ("cannot be disabled": sem chave real não há atualização possível) | Inferência |
| `requireSignedVersion: true`, sem `allowDowngrades` | Fatos 3 e 6 | Fato + inferência |
| Windows `installMode: "passive"` (barra pequena, sem perguntas, reabre sozinho) | Fato 5 ("Generally recommended and the default mode") | Fato |
| Antes de instalar: parar o servidor embutido com calma (o mesmo `stop` da saída do app); se a instalação falhar, religá-lo e continuar na versão atual | Fato 5 (`exit(0)` depois do instalador); inferência sobre arquivos em uso | Inferência |
| Banco: nada a fazer na atualização; as migrações rodam na próxima partida (teste no `embedded.test.ts`) | `run.ts`; fato 5 (dados preservados em `/UPDATE`) | Fato + inferência |
| `ReleaseNotFound`, `TargetNotFound`, `TargetsNotFound` = "nada novo" | Fatos 2 e 4 | Inferência |
| `createUpdaterArtifacts` só no `release.yml`, por `--config src-tauri/tauri.updater.conf.json` | Fato 3 (falha sem a chave), fato 7 (`--config` relativo ao `projectPath`) | Fato |
| `release.yml`: tag `v*` (e disparo manual), `tauri-apps/tauri-action@v1`, `contents: write`, `releaseDraft: true`, `uploadUpdaterJson: true`, `updaterJsonPreferNsis: true`, segredos `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Fato 7 | Fato |
| O plano dizia `includeUpdaterJson`: na v1 o nome é `uploadUpdaterJson` (não muda o desenho) | Fato 7 | Fato |
| O repositório precisa continuar **público** (hoje é); se ficar privado, trocar o endereço por um servidor público só com as Releases | Fato 8 | Inferência |
| Privacidade: o app só busca o `latest.json` e o instalador no GitHub, sem enviar dados da pessoa (o GitHub vê o IP e o agente do atualizador) | Fatos 2 e 8 | Inferência |
