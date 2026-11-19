# Usar o Suup no Windows (instalar e usar)

O app de desktop leva **tudo dentro dele**: o servidor, o worker que roda os bots e o banco de dados. Não há nada para instalar à parte, nem servidor para configurar. Se um dia você preferir uma VPS, o mesmo app conecta a ela (veja o fim deste guia). Um servidor de cada vez: **os dois não se sincronizam**.

> Estado desta entrega: o instalador é construído pelo CI (GitHub Actions) e **ainda não foi testado num Windows de verdade**. O que foi provado, e o que não foi, está em "O que foi e o que não foi verificado", no fim.

## 1. Baixar o instalador

1. No GitHub, abra o repositório, aba **Actions**, workflow **"Instalador do app"**.
2. Abra a execução mais recente (verde) da sua branch, ou clique em **Run workflow** para gerar uma nova.
3. No fim da página da execução, em **Artifacts**, baixe o do **Windows** (um `.zip`). Dentro dele está o instalador `Suup_..._x64-setup.exe`.

## 2. Instalar (o aviso do Windows)

O instalador **não é assinado** (assinatura de código é paga e fica para depois). Por isso o Windows mostra um aviso na primeira vez:

- Aparece uma tela azul do SmartScreen dizendo que o aplicativo não é reconhecido. Clique em **Mais informações** e depois em **Executar assim mesmo**.
- Esses textos são os que o Windows costuma usar, mas **não pude confirmar as palavras exatas** (a documentação da Microsoft estava inacessível durante a pesquisa). Se o seu Windows disser outra coisa, o caminho é o mesmo: procurar o "mais informações" e escolher executar mesmo assim.
- O antivírus pode reclamar de um programa novo e sem assinatura. Se o seu o bloquear, é um falso positivo conhecido para esse tipo de programa; confira que o arquivo veio da **sua** execução do Actions.
- A instalação é só para o seu usuário, sem pedir senha de administrador. Se o WebView2 (a janela do app) faltar, o instalador o baixa sozinho; Windows 10 recente e Windows 11 já o têm.

## 3. Primeira abertura

1. O app pergunta onde o Suup deve rodar. Escolha **Usar neste computador**.
2. Ele pede a **chave da Anthropic**. Cole **no campo do app** (é um campo de senha) e clique em **Guardar e continuar**. **Nunca** cole a chave numa conversa, num e-mail ou num arquivo. Ela é guardada no **Gerenciador de Credenciais do Windows** e nunca é mostrada de novo. Dá para "Fazer depois" e colocar em **Configurações > Geral > Servidor > Chave da Anthropic**.
3. Aparece "Iniciando o Suup…" enquanto o banco e o servidor sobem (e, com o Docker, a máquina dos bots: veja abaixo). Na primeira vez leva alguns segundos; depois, menos.
4. O app abre com o bot **Principal**. Pronto.

Se algo falhar ao iniciar, a tela diz o **motivo**, mostra onde estão os registros e oferece **Tentar de novo** e **Abrir a pasta de registros**.

## 4. A máquina dos bots: Docker Desktop (recomendado)

Os bots rodam comandos (terminal, arquivos). Com o **Docker Desktop**, esses comandos rodam **dentro de um contêiner isolado**, sem rede própria (só saem por uma lista de sites), sem acesso aos seus arquivos. Sem ele, no Windows **os bots ficam sem terminal** (o modo "neste computador, sem isolamento" depende de um shell que o Windows não traz) e, mesmo onde roda, os comandos usariam os seus arquivos e acessos.

**Requisitos do Docker Desktop** (segundo a documentação da Docker, lida na pesquisa de 19/11/2026): Windows 10 64 bits **22H2** (build 19045) ou Windows 11 **23H2** (build 22631) ou superior, nas edições **Pro, Enterprise ou Education** (a lista não inclui Home), **WSL 2** versão 2.1.5 ou mais nova, virtualização ligada na BIOS, 8 GB de RAM. Deixe o Docker Desktop **aberto** quando abrir o Suup.

Como o app cuida disso:

- Detecta o Docker rodando `docker info` (só olha se deu certo, não lê o texto). Veja o resultado em **Configurações > Geral > Servidor > Máquina dos bots**: **"Isolada (Docker)"**, ou **"Sem isolamento: …"** com o motivo.
- Na primeira vez **constrói as imagens** (`suup-sandbox` e `suup-connector-runner`) a partir dos Dockerfiles que vêm dentro do app. A tela mostra "Preparando a máquina dos bots…". Precisa de **internet** e leva alguns minutos; se o build falhar, o app diz o motivo (nos registros) e segue **sem isolamento**, dizendo isso. (Escolhi construir em vez de baixar porque ainda não publicamos as imagens em nenhum registro; construir não exige conta nem segredo.)
- **Limitação conhecida, não verificada no Windows:** a saída dos bots passa por um proxy que o servidor abre no endereço da rede interna do Docker. No **Docker Desktop** esse endereço fica dentro da máquina virtual do Docker, e o app, que roda no Windows, pode não conseguir escutar nele. O app **testa isso** (tenta escutar) e, se não der, diz "este computador não alcança a rede interna dos bots" e cai em **sem isolamento**. Se for o seu caso, a saída é usar uma **VPS** (o desenho de produção, onde o worker roda dentro do Docker). Isso precisa ser confirmado num Windows com Docker Desktop.

## 5. Onde ficam os dados e os registros

| O quê | Onde (Windows) |
|---|---|
| Banco, arquivos dos bots (sem Docker), configuração gerada | `%LOCALAPPDATA%\app.suup.desktop\local\` |
| Registros (um arquivo por dia, 14 dias) e o do banco | `%LOCALAPPDATA%\app.suup.desktop\local\logs\` (ou **Configurações > Geral > Servidor > Registros > Abrir pasta**) |
| Senhas e chaves (banco, token, cofre, Anthropic) | Gerenciador de Credenciais do Windows, entradas `app.suup.desktop` |
| Escolha de servidor e aparência | `%APPDATA%\app.suup.desktop\` |

Os registros **não** contêm chaves nem o token. **Avançado:** para trocar os modelos ou os limites, crie `config.override.json` na pasta de dados (cada chave de primeiro nível, como `models` ou `defaults`, substitui a gerada; o formato é o de [CONFIGURACAO.md](CONFIGURACAO.md)). O app começa com `claude-sonnet-5-5` (bot principal) e `claude-haiku-5-5` (revisão e memória).

## 6. Desinstalar e fazer backup

- **Desinstalar:** Configurações do Windows > Aplicativos > Suup > Desinstalar. Isso **não apaga** os dados nem as credenciais: apague à mão a pasta `%LOCALAPPDATA%\app.suup.desktop` e as entradas `app.suup.desktop` do Gerenciador de Credenciais se quiser tudo zerado. Se tinha Docker: `docker rm -f suup-machine` e `docker volume rm suup-workspace`.
- **Backup:** feche o app (o banco para com calma ao fechar) e copie a pasta `%LOCALAPPDATA%\app.suup.desktop\local\`. **Guarde também as credenciais:** sem a chave do cofre e a senha do banco, uma cópia restaurada em outro computador não abre. Para um backup que abre em qualquer lugar, use o dump do banco ([IMPLANTACAO.md](IMPLANTACAO.md), "Passar do computador para a VPS").

## 7. Passar para a VPS

Em **Configurações > Geral > Servidor > Trocar** o app volta à primeira tela e você escolhe **Conectar à minha VPS** (endereço e token). Nada é apagado e **nada é copiado** entre os dois. Para levar os bots, as conversas e a memória, faça o dump e a restauração descritos em [IMPLANTACAO.md](IMPLANTACAO.md), "Passar do computador para a VPS". Depois disso, o computador deixa de valer: não deixe os dois com o mesmo bot ligados.

## O que foi e o que não foi verificado

- **Provado num Linux (esta entrega):** o banco PostgreSQL embutido sobe e aplica as 21 migrações; o servidor e o worker respondem uma conversa; a parada deixa nenhum processo; um comando de bot roda dentro da máquina Docker; o app (no navegador, com o Tauri simulado) faz a primeira abertura, a troca e o aviso de isolamento. O Rust compila (`cargo check`).
- **Só no CI (primeira execução):** o instalador do Windows e o teste do servidor embutido no Windows.
- **Não verificado em nenhum lugar:** a instalação num Windows real, o aviso do SmartScreen, o Docker Desktop (a limitação da seção 4), o Credential Manager do Windows, o PostgreSQL rodando como administrador no Windows, o desempenho e o antivírus.
