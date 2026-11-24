# Atualização automática do app

O app de desktop se atualiza sozinho, como o do Grok: **não é preciso reinstalar nada**. Ele usa o atualizador oficial do Tauri 2 (`tauri-plugin-updater` 2.14), e cada versão nova sai de uma Release do GitHub deste repositório. Pesquisa e fontes: [pesquisas/atualizador-do-app.md](pesquisas/atualizador-do-app.md). Como a tela fica: [DESIGN.md](DESIGN.md) §3e.

## Como funciona

1. **Procura.** Uns segundos depois de abrir, e a cada 4 horas com o app aberto, o app pede ao GitHub o arquivo `latest.json` da Release mais nova publicada (`https://github.com/ali-ali18/suup-/releases/latest/download/latest.json`, em `apps/desktop/src-tauri/tauri.conf.json`, `plugins.updater.endpoints`). Rascunhos e pré-lançamentos não contam. Sem Release, ou sem pacote para este sistema, é "nada novo". Uma procura que falha não mostra nada (o detalhe vai para o registro).
2. **Aviso.** Com versão nova, aparece no canto um aviso calmo: **"Nova versão do Suup disponível"**, com **Depois** e **Atualizar agora**. Em **Configurações > Geral**, no fim, a linha **"Versão x.y.z"** tem **Procurar atualização** (e acompanha o que está acontecendo).
3. **Download e conferência.** "Atualizar agora" baixa o instalador e confere a **assinatura** (minisign) com a chave pública do `tauri.conf.json`. Se não bater, não instala; isso não dá para desligar. A versão assinada também precisa ser a anunciada (`requireSignedVersion`), e uma versão menor que a atual nunca é instalada.
4. **Instalação.** "Reiniciar para concluir": o app **para o servidor embutido com calma** (o mesmo jeito de quando você fecha o app: as execuções em andamento voltam à fila, o banco para direito), e só então abre o instalador. No Windows o instalador roda no modo **passivo** (uma janelinha com barra de progresso, sem perguntas, sem senha de administrador) e abre o Suup de novo no fim. No macOS o app troca a si mesmo e reinicia.
5. **Depois.** Na primeira abertura da versão nova, o servidor embutido sobe e **aplica as migrações do banco** sozinho (provado em `apps/sidecar/test/embedded.test.ts`, "after an update").

Se algo der errado no download ou na instalação, o aviso diz só "Não foi possível atualizar agora" e oferece **Tentar de novo**; o servidor volta a rodar e o app continua na versão que estava. O detalhe técnico vai para o console e para o registro do app.

## Seus dados

- Nada é apagado: no Windows o instalador de atualização roda com `/UPDATE`, e o modelo de instalador do Tauri só apaga os dados do app numa **desinstalação** com a caixa marcada, nunca numa atualização. Os dados ficam em `%LOCALAPPDATA%\app.suup.desktop\local\`, fora da pasta do programa.
- As chaves (banco, token, cofre, Anthropic) continuam no Gerenciador de Credenciais do Windows.

## Privacidade

- O app só busca **o `latest.json` e o instalador**, no GitHub. Não envia nada seu: nem conversa, nem bot, nem chave. O GitHub vê o que todo download vê (o endereço IP e o nome do atualizador).
- Esse pedido sai do lado nativo do app (Rust), não da página: a página continua sem acesso à rede.
- Com o app no modo VPS, a procura é a mesma (o app é o mesmo); a VPS não é atualizada por aqui ([IMPLANTACAO.md](IMPLANTACAO.md)).

## O repositório precisa ser público

O app baixa o `latest.json` e o instalador **sem login**. Num repositório privado o GitHub responde "não encontrado" a quem não tem login, e a única saída seria embutir um token no app, o que qualquer um conseguiria extrair. Então: **mantenha o repositório público** (em 23/11/2026 ele é). Se um dia ele ficar privado, as Releases precisam ir para outro lugar público (um bucket ou CDN só com os instaladores e o `latest.json`) e o endereço em `plugins.updater.endpoints` muda.

## Desligado até o dono pôr a chave

Enquanto `plugins.updater.pubkey` for o marcador `SUBSTITUA-PELA-CHAVE-PUBLICA-DO-SUUP`, o atualizador fica **desligado**: o app não procura nada, não mostra aviso, e a linha de Configurações diz só "As atualizações automáticas ainda não estão ligadas.". Tudo o mais funciona normalmente.

## Passo a passo do dono (uma vez)

Faça no **seu** computador. A chave privada e a senha **nunca** vão para o chat, para um e-mail ou para o repositório. Se perder a chave privada (ou a senha), quem já tem o app instalado **não recebe mais atualizações** (teria de reinstalar uma vez): guarde as duas num lugar seguro (um gerenciador de senhas).

1. **Gerar as chaves.** Na pasta do repositório, no PowerShell:

   ```powershell
   pnpm --filter @suup/desktop exec tauri signer generate -w $env:USERPROFILE\.tauri\suup.key
   ```

   (no Prompt de Comando, `-w %USERPROFILE%\.tauri\suup.key`.) Ele pede uma senha: escolha uma e guarde. Saem dois arquivos: `suup.key` (a **privada**, secreta) e `suup.key.pub` (a **pública**).
2. **Guardar a privada no GitHub.** No repositório: **Settings > Secrets and variables > Actions > New repository secret**:
   - `TAURI_SIGNING_PRIVATE_KEY`: o **conteúdo** do arquivo `suup.key` (abra no Bloco de Notas e copie tudo).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: a senha que você escolheu.
3. **Colar a pública no app.** Abra `suup.key.pub`, copie o conteúdo (uma linha comprida) e cole no lugar de `SUBSTITUA-PELA-CHAVE-PUBLICA-DO-SUUP` em `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Ou mande a **pública** para o Claude colar: ela não é segredo. Faça commit.
4. **Conferir que o repositório é público** (Settings > General > Danger Zone > "Change repository visibility" mostra o estado).
5. **Lançar uma versão.** Escolha o número (maior que o atual) e rode:

   ```powershell
   pnpm release:version 0.1.0
   git commit -am "versão 0.1.0"
   git tag v0.1.0
   git push origin HEAD v0.1.0
   ```

   O workflow **"Release do app"** (aba Actions) compila o instalador assinado e cria uma Release **rascunho** `Suup v0.1.0` com o instalador e o `latest.json`.
6. **Publicar.** Na aba **Releases**, abra o rascunho, confira os arquivos (`Suup_0.1.0_x64-setup.exe`, a `.sig` e `latest.json`) e clique em **Publish release**. A partir daí, cada app instalado vê a versão nova na próxima procura.

A **primeira** versão com a chave precisa ser instalada à mão uma vez (o instalador da Release): os apps de antes não tinham a chave pública e não sabem conferir. Daí em diante, só o passo 5 e o 6.

## Como mudar a versão

`pnpm release:version x.y.z` (script `apps/desktop/scripts/release-version.mjs`) troca a versão em `apps/desktop/src-tauri/tauri.conf.json` (a que o atualizador compara), `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml` e `Cargo.lock`. Só aceita `x.y.z` com números e maior que a atual. A tag tem de ser `v` + essa versão: o workflow confere e para se não for.

## Onde está no código

| O quê | Onde |
|---|---|
| Configuração (endereço, chave pública, modo passivo, versão assinada) | `apps/desktop/src-tauri/tauri.conf.json`, `plugins.updater` |
| Pacotes de atualização só na Release | `apps/desktop/src-tauri/tauri.updater.conf.json` (`createUpdaterArtifacts`), passado por `--config` no `release.yml` |
| Procura, download, instalação, parada do servidor | `apps/desktop/src-tauri/src/update.rs` (comandos `update_info`, `update_check`, `update_download`, `update_install`) |
| Aviso e linha de Configurações | `apps/desktop/src/features/shell/UpdateNotice.tsx`, `features/settings/UpdateGroup.tsx`, `app/update-store.ts` |
| Release | `.github/workflows/release.yml` (tag `v*` ou à mão; rascunho) |
| O instalador comum, sem segredo | `.github/workflows/desktop-installer.yml` (não gera pacotes de atualização) |

## O que não foi verificado

Uma atualização assinada de verdade, de ponta a ponta, num Windows: isso só dá para provar depois que o dono gerar a chave, puser os segredos e publicar uma Release. O que foi provado está nos testes: o fluxo da tela (com o atualizador simulado), a chave de marcador desligando tudo, o Rust compilando, e o servidor embutido aplicando uma migração nova na partida seguinte sem perder os dados.
