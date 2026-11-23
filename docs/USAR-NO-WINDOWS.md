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
- **A saída dos bots passa por um proxy num contêiner próprio.** No Docker Desktop as redes do Docker ficam dentro da máquina virtual dele e o app, que roda no Windows, não escuta lá; por isso o proxy (`suup-egress`, uma imagem pequena que o app também constrói na primeira vez) roda dentro do Docker, e o app fala com ele por uma porta publicada **só em `127.0.0.1`**, com um token novo a cada início. A lista de sites e as suas aprovações continuam no app. Detalhes e desenho em [REDE.md](REDE.md). O app **prova esse caminho ao abrir** (sobe um contêiner descartável e fala com ele); se não der, ele tenta o modo em que o proxy roda no próprio app e, só se também não der, segue **sem isolamento**, dizendo o motivo. **Provado num Linux com Docker real, com o servidor como processo do computador (a mesma topologia do Windows); ainda não verificado no Windows com Docker Desktop em si.** Se o proxy não subir, os registros trazem o motivo.

## 4b. Busca e leitura de páginas

Os bots buscam na web e leem páginas com as mesmas ferramentas do servidor (`web_search` e `web_read`; [BUSCA.md](BUSCA.md)):

- **Sempre, mesmo sem Docker:** a busca na **Wikipédia, no arXiv e no Stack Overflow** (o Suup pergunta direto às APIs oficiais, saindo só para esses endereços) e a **leitura de páginas públicas** dentro do próprio app (sem rodar o JavaScript da página).
- **Com o Docker Desktop:** também a **busca geral (DuckDuckGo)**, pelo SearXNG num contêiner sem saída própria, e a leitura **com navegador** (para páginas que só aparecem com JavaScript), num contêiner próprio. A saída do SearXNG passa por um segundo proxy em contêiner (`suup-egress-search`), do mesmo jeito que a dos bots: só para os endereços dos motores, controlado pelo app por uma porta publicada só em `127.0.0.1`.
- **Sem o Docker,** o bot recebe o motivo quando a busca geral ou a leitura com navegador não estão disponíveis ("precisa do Docker"), e pode dizer isso a você.
- **Na primeira abertura com o Docker,** junto com as imagens dos bots, o app **constrói a imagem do leitor** (parte da imagem do Playwright, com o navegador: **alguns GB** de download) e **baixa a do SearXNG**. Se uma delas falhar, os bots continuam isolados normalmente; só aquela parte da web fica de fora (o motivo vai para os registros).

## 4c. Conectar serviços (galeria)

Em **Configurações > Conectores** fica a galeria: GitHub, Notion, Linear, Figma, Composio (opcional, de terceiros) e, a confirmar, Stack Overflow e Google Workspace ([CONECTORES.md](CONECTORES.md), "Galeria").

- **Login no navegador (Notion, Linear, Figma):** "Conectar" abre a página de login do serviço no seu navegador; o app mostra "Aguardando login…" e, quando você autoriza, o navegador volta para o próprio Suup (um endereço `http://127.0.0.1:<porta>/callback` que o servidor embutido abre só neste computador) e a linha vira "Conectado". Os tokens ficam no cofre, cifrados; você não copia nada.
- **Com token (GitHub, Composio):** "Conectar" mostra onde criar o token e o formulário seguro; o valor vai para o cofre e o bot nunca o vê.
- **Se o app está ligado a uma VPS**, o navegador não consegue voltar para o servidor (ele está em outra máquina): a página de retorno não abre, e você cola no app o endereço que ficou na barra do navegador.
- O Windows pode perguntar se o Suup pode receber conexões: o retorno é só em `127.0.0.1` (este computador), não precisa liberar na rede.

## 5. Onde ficam os dados e os registros

| O quê | Onde (Windows) |
|---|---|
| Banco, arquivos dos bots (sem Docker), configuração gerada | `%LOCALAPPDATA%\app.suup.desktop\local\` |
| Registros (um arquivo por dia, 14 dias) e o do banco | `%LOCALAPPDATA%\app.suup.desktop\local\logs\` (ou **Configurações > Geral > Servidor > Registros > Abrir pasta**) |
| Senhas e chaves (banco, token, cofre, Anthropic) | Gerenciador de Credenciais do Windows, entradas `app.suup.desktop` |
| Escolha de servidor e aparência | `%APPDATA%\app.suup.desktop\` |

Os registros **não** contêm chaves nem o token. **Avançado:** para trocar os modelos ou os limites, crie `config.override.json` na pasta de dados (cada chave de primeiro nível, como `models` ou `defaults`, substitui a gerada; o formato é o de [CONFIGURACAO.md](CONFIGURACAO.md)). O app começa com `claude-sonnet-5-5` (bot principal) e `claude-haiku-5-5` (revisão e memória).

## 6. Desinstalar e fazer backup

- **Desinstalar:** Configurações do Windows > Aplicativos > Suup > Desinstalar. Isso **não apaga** os dados nem as credenciais: apague à mão a pasta `%LOCALAPPDATA%\app.suup.desktop` e as entradas `app.suup.desktop` do Gerenciador de Credenciais se quiser tudo zerado. Se tinha Docker: `docker rm -f suup-machine suup-searxng suup-reader` e `docker volume rm suup-workspace`.
- **Backup:** feche o app (o banco para com calma ao fechar) e copie a pasta `%LOCALAPPDATA%\app.suup.desktop\local\`. **Guarde também as credenciais:** sem a chave do cofre e a senha do banco, uma cópia restaurada em outro computador não abre. Para um backup que abre em qualquer lugar, use o dump do banco ([IMPLANTACAO.md](IMPLANTACAO.md), "Passar do computador para a VPS").

## 7. Passar para a VPS

Em **Configurações > Geral > Servidor > Trocar** o app volta à primeira tela e você escolhe **Conectar à minha VPS** (endereço e token). Nada é apagado e **nada é copiado** entre os dois. Para levar os bots, as conversas e a memória, faça o dump e a restauração descritos em [IMPLANTACAO.md](IMPLANTACAO.md), "Passar do computador para a VPS". Depois disso, o computador deixa de valer: não deixe os dois com o mesmo bot ligados.

## O que foi e o que não foi verificado

- **Provado num Linux (esta entrega):** o banco PostgreSQL embutido sobe e aplica as migrações (27 nesta versão); o servidor e o worker respondem uma conversa; a parada deixa nenhum processo; um comando de bot roda dentro da máquina Docker, e a saída dele sai pelo proxy em contêiner, com o servidor como processo do computador falando com ele só pela porta publicada em `127.0.0.1` (a topologia do Docker Desktop); o app (no navegador, com o Tauri simulado) faz a primeira abertura, a troca e o aviso de isolamento. O Rust compila (`cargo check`).
- **Provado num Linux (app completo):** com Docker, uma busca do bot sobe o SearXNG e o proxy de motores em contêiner (`suup-egress-search`), com o servidor como processo do computador; o proxy aceita a credencial do SearXNG e só abre os endereços dos motores; o leitor construído pela receita do app (variante sem navegador, por falta de disco) lê e recusa endereços privados. Sem Docker, a busca pelas APIs diretas roda dentro do pacote do app.
- **Só no CI (primeira execução):** o instalador do Windows e o teste do servidor embutido no Windows (que inclui uma busca pelas APIs diretas, sem Docker); a imagem do leitor **com** navegador, construída pela receita do app (`ci.yml`).
- **Não verificado em nenhum lugar:** a instalação num Windows real, o aviso do SmartScreen, o Docker Desktop em si (a porta publicada em `127.0.0.1`, o firewall e os dois proxies em contêiner, o dos bots e o da busca; o desenho foi provado num Linux, não no Windows), o Credential Manager do Windows, o PostgreSQL rodando como administrador no Windows, o desempenho e o antivírus.
- **Linux:** o CI gera só o pacote `.deb`. O AppImage falhou no `linuxdeploy` do CI e fica como trabalho futuro.
