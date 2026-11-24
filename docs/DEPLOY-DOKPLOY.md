# Suup na VPS com o Dokploy (e o Cloudflare na frente)

Passo a passo para pôr o Suup na sua VPS da Hostinger, que o **Dokploy** gerencia e onde já rodam outros projetos seus, no endereço **`https://agent.kodea.com.br`** (DNS no Cloudflare, com o proxy laranja). O arquivo usado é o [`docker-compose.dokploy.yml`](../docker-compose.dokploy.yml); a pesquisa por trás de cada escolha está em [pesquisas/deploy-vps-dokploy.md](pesquisas/deploy-vps-dokploy.md). Para uma VPS **só do Suup**, sem Dokploy, o caminho é o de [IMPLANTACAO.md](IMPLANTACAO.md).

## O que sobe

```
 app (Windows) ──HTTPS──► Cloudflare ──HTTPS (443)──► Traefik do Dokploy ──► server :8787
                                                                               │ rede interna "backend"
                                                                    postgres ◄─┤
                                                                               │
   worker ── usa a rede do contêiner "docker" ──► docker  (o Docker PRÓPRIO do Suup, dind)
                                                    └─ suup-machine (bots), conectores, leitor
```

| Serviço | O que faz | Rede |
|---|---|---|
| `server` | API e tempo real. Não fala com Docker nenhum | `backend` e `dokploy-network` (o único que o Traefik enxerga) |
| `worker` | Roda as execuções; comanda o Docker do Suup | a do contêiner `docker` |
| `docker` | Docker dentro de Docker: onde vivem as máquinas dos bots | `backend` e `outbound` (saída para a internet) |
| `images` | Constrói as imagens dos bots **dentro** do `docker` e sai | nenhuma |
| `migrate` | Aplica as migrações do banco e sai | `backend` |
| `postgres` | O banco (pgvector), sem porta publicada | `backend` (interna) |

Nada aqui monta o `/var/run/docker.sock` da VPS: veja "Riscos e isolamento", no fim.

## Do que você precisa

- O painel do Dokploy, com o GitHub já ligado (Settings > Git > GitHub; é o que você já usa nos outros projetos).
- O registro `agent.kodea.com.br` no Cloudflare. **Já existe e foi conferido em 24/11/2026:** registro `A` para o IP da sua VPS, com o proxy ligado (nuvem laranja), e a zona `kodea.com.br` no modo de SSL/TLS **Full**. Não precisa mexer.
- Folga na VPS para o Suup: **15 GB de disco livre** e **4 GB de RAM livres** (detalhes em "Recursos").
- No seu computador, um lugar para gerar e guardar os segredos (um gerenciador de senhas). **Nunca** cole segredo em chat, e-mail ou arquivo do repositório.

## 1. Gerar os segredos (no seu computador)

Gere cada um no **PowerShell** do Windows (aleatório de verdade, do gerador criptográfico do sistema). Troque `32` pelo número de bytes indicado:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

| Variável | Bytes | Para quê |
|---|---|---|
| `POSTGRES_PASSWORD` | 24 | a senha do banco |
| `SUUP_SERVER_TOKEN` | 32 | o token do app (o servidor recusa menos de 32 caracteres; 32 bytes dão 64) |
| `SUUP_VAULT_KEY` | 32 | a chave do cofre de segredos dos conectores ([COFRE.md](COFRE.md)) |

Com Git Bash ou WSL, o mesmo é `openssl rand -hex 24` / `openssl rand -hex 32`. Quem tem a CLI do Suup pode usar `suup server --generate-token` e `suup vault key generate`. Guarde os três no gerenciador de senhas: o token você vai colar no app; a chave do cofre, se perdida, faz os segredos guardados virarem lixo.

A chave da Anthropic (`ANTHROPIC_API_KEY`) é a sua, do console da Anthropic.

## 2. Criar o serviço no Dokploy

1. **Projects** > o projeto onde quer o Suup (ou **Create Project**, por exemplo "Suup").
2. **Create Service** > **Compose**. Nome: `suup`. Tipo: **Docker Compose** (não "Stack": o Stack não constrói imagens).
3. Na aba **General**, em **Provider**: **GitHub**; repositório **`ali-ali18/Suup-`**; **Branch**: o ramo que você quer em produção (por exemplo `main`); **Compose Path**: `./docker-compose.dokploy.yml`. **Save**.
4. Confira que **Isolated Deployments** está **desligado** (é o padrão de um Compose novo; fica nas opções do Compose, na aba Advanced). Ligado, o Dokploy dá uma rede a cada serviço e o `worker` (que usa a rede do `docker`) não sobe.

## 3. A configuração (File Mount)

O Dokploy apaga e clona de novo a pasta do código a cada implantação, então a configuração **não** pode vir de um arquivo do repositório: ela vai num **File Mount**.

1. Aba **Advanced** > **Mounts** > **Add Mount** > **File Mount**.
2. **File Path**: `suup.config.json` (o compose o procura em `../files/suup.config.json`).
3. **Content**: copie [`suup.config.dokploy.example.json`](../suup.config.dokploy.example.json) e ajuste:
   - `models`: troque `model-x` pelo id real de cada modelo que você usa (o mesmo do app) e ajuste `contextWindow`, `maxOutputTokens` e `pricing`; troque também `reviewer.model` e `memory.consolidation.model`.
   - `server.publicUrl` já vem `https://agent.kodea.com.br` (é o que faz os logins OAuth de conectores voltarem para a VPS: [CONECTORES.md](CONECTORES.md)).
   - `server.allowedOrigins` já traz as origens do app de desktop (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`).
   - **Não** acrescente `listenHost`/`advertiseHost` aos proxies: neste arranjo o Suup descobre o endereço sozinho (diferente do `docker-compose.prod.yml`).
4. **Save**. Para mudar depois: edite aqui e faça **Redeploy**.

Nenhum segredo entra neste arquivo: ele só guarda os **nomes** das variáveis (`apiKeyEnv`, `tokenEnv`, `keyEnv`).

## 4. As variáveis (aba Environment)

Cole, trocando os marcadores pelos valores do passo 1 (o Dokploy grava um `.env` ao lado do compose, só na VPS):

```
POSTGRES_PASSWORD=<a senha do passo 1>
SUUP_SERVER_TOKEN=<o token do passo 1>
SUUP_VAULT_KEY=<a chave do cofre do passo 1>
ANTHROPIC_API_KEY=<a sua chave da Anthropic>
```

Opcionais:

| Variável | Padrão | Quando mexer |
|---|---|---|
| `SUUP_READER_BROWSER` | `1` | `0` constrói o leitor de páginas **sem** o Chromium (economiza alguns GB; `web_read` com `render` fica indisponível) |
| `SUUP_IMAGES` | `sandbox connector-runner reader` | quais imagens dos bots o serviço `images` prepara |
| `SUUP_DOCKER_PRIVILEGED` / `SUUP_DOCKER_RUNTIME` | `true` / `runc` | só com o Sysbox instalado na VPS: `false` / `sysbox-runc` (veja "Riscos e isolamento") |

Outro provedor de modelo: acrescente a variável aqui **e** uma linha em `environment` no `docker-compose.dokploy.yml` (é como o Compose passa variáveis para dentro do contêiner).

## 5. O domínio (aba Domains)

O Cloudflare da zona está em **Full**: ele chega na VPS pela porta **443**. Então o domínio precisa estar com **HTTPS ligado** no Dokploy (com HTTPS desligado só existe a porta 80, e o Cloudflare recebe "404 page not found").

1. Aba **Domains** > **Add Domain**.
2. **Service Name**: `server`.
3. **Host**: `agent.kodea.com.br`. **Path**: `/`. **Container Port**: `8787`.
4. **HTTPS**: ligado. **Certificate**: **None** (o Traefik serve o certificado próprio dele; o modo Full do Cloudflare aceita e cifra o caminho até a VPS).
5. **Create**.

Dica: abra o domínio de um dos seus outros projetos (n8n, por exemplo) e confira que ele usa o mesmo HTTPS e Certificate; se usa **Let's Encrypt** e funciona, também serve aqui (a validação passa pela porta 80, que o Cloudflare repassa). O que não pode é HTTPS desligado.

Não use **Flexible** no Cloudflare para este endereço: nesse modo o trecho Cloudflare → VPS vai em **HTTP puro**, e o token do app e as conversas atravessam a internet sem criptografia.

### Opcional: validar o certificado só neste endereço (Full strict)

No modo **Full**, o caminho até a VPS é cifrado, mas o Cloudflare não confere **quem** responde. Para conferir, sem mudar a zona inteira (os seus outros subdomínios continuam como estão):

1. **Cloudflare** > `kodea.com.br` > **SSL/TLS** > **Origin Server** > **Create Certificate** > "Generate private key and CSR with Cloudflare" > hostnames: `agent.kodea.com.br` > validade (até 15 anos) > **Create**. Copie o **Origin Certificate** e a **Private Key** (formato PEM). A chave só aparece agora: não a guarde em lugar público.
2. **Dokploy** > **Certificates** > **Add Certificate**: um nome (`agent-kodea-origin`), cole o certificado e a chave, **Save**. O domínio do passo 5 continua com Certificate **None**: o Traefik escolhe sozinho o certificado cujo nome casa.
3. **Cloudflare** > **Rules** > **Overview** > **Create rule** > **Configuration Rule**. Nome: "agent strict". **Custom filter expression**: Field `Hostname`, Operator `equals`, Value `agent.kodea.com.br`. Em **Then the settings are**: **SSL** > **Strict**. **Deploy**.
4. Teste `https://agent.kodea.com.br/health`. Erro **526**: o certificado não casou (confira o host); desfaça a regra enquanto acerta.

O certificado da Origin CA só vale para o Cloudflare: o registro precisa continuar **laranja**. O Cloudflare não avisa quando ele vence: anote a data.

Ainda mais (não obrigatório): **Authenticated Origin Pulls** (a VPS só aceita conexões que provem ser do Cloudflare) ou um firewall que só deixe entrar nas portas 80 e 443 os endereços do Cloudflare. As duas coisas afetam **todos** os projetos atrás do mesmo Traefik: só faça se todos estiverem atrás do Cloudflare.

## 6. Implantar

1. Aba **General** > **Deploy**. Acompanhe em **Deployments** (o registro ao vivo).
2. A **primeira** implantação demora (dezenas de minutos numa VPS pequena): o Dokploy constrói a imagem do Suup e o serviço `images` constrói, **dentro** do Docker do Suup, a máquina dos bots, o runner dos conectores e o leitor (que parte de uma imagem de ~1 GB comprimido). As seguintes reaproveitam o cache e levam poucos minutos.
3. Na aba **Logs**: `migrate` termina com a lista das migrações; `server` diz "Servidor no ar em http://0.0.0.0:8787" (o aviso de "HTTP puro" é esperado: o TLS está no Traefik e no Cloudflare; a porta 8787 não está aberta para a internet); `worker` diz "Worker ... pronto"; `images` termina com "suup-images: pronto".

Se o `images` falhar, o `worker` não sobe (de propósito): o log do `images` diz qual imagem e por quê. Corrija e faça **Redeploy**.

## 7. Conferir

No navegador ou no terminal do seu computador:

```sh
curl -s https://agent.kodea.com.br/health          # {"status":"ok"}
```

O teste completo é o `doctor` **no worker**. Pelo SSH da VPS (o nome do contêiner começa com o nome do app no Dokploy; `docker ps --format '{{.Names}}' | grep worker` mostra):

```sh
docker exec -it <nome-do-contêiner-do-worker> node dist/bin.js doctor
```

Tudo `[ok]`, em especial "Sandbox ... `suup-machine` respondeu", "Rede dos bots: sem saída direta" e "proxy e lista de hosts". Para ver que a máquina dos bots vive no Docker do Suup e **não** no da VPS:

```sh
docker exec <nome-do-contêiner-docker> docker -H unix:///var/run/dind/docker.sock ps   # mostra suup-machine
docker ps -a --filter name=suup-machine                                                # na VPS: vazio
```

O tempo real pelo Cloudflare (deve aparecer `: ping` a cada 15 s; Ctrl+C para parar). Ponha o token numa variável sem que ele vá para o histórico do terminal:

```sh
read -rs T && curl -sN -H "Authorization: Bearer $T" https://agent.kodea.com.br/v1/stream
```

Se nada aparecer por mais de 30 s, ou a conexão cair perto de 2 minutos (erro 524), o Cloudflare está segurando a resposta: diga-me o que viu.

## 8. Ligar o app

No app de desktop: **Configurações > Geral > Servidor > Trocar > Conectar à minha VPS**, endereço `https://agent.kodea.com.br` e o token (`SUUP_SERVER_TOKEN`). Na primeira subida o servidor cria o bot "Principal" se não houver nenhum.

Conectores por login (Notion, Linear, Figma) já funcionam com a VPS porque `server.publicUrl` está na configuração (o navegador volta para `https://agent.kodea.com.br/oauth/callback`).

## 9. Levar os dados do computador para a VPS

Se você já usa o Suup "neste computador", leve os bots, as conversas e a memória com um dump e uma restauração ([IMPLANTACAO.md](IMPLANTACAO.md), "Passar do computador para a VPS"):

1. **No computador** (app aberto): Configurações > Geral > Servidor > **Banco de dados > Copiar endereço**. Faça o dump com o Docker Desktop (troque `SENHA` e `PORTA` pelos do endereço copiado):

   ```powershell
   docker run --rm -v "${PWD}:/out" postgres:18 pg_dump -Fc -f /out/suup.dump "postgres://suup:SENHA@host.docker.internal:PORTA/suup"
   ```

2. **Copie** `suup.dump` para a VPS (`scp suup.dump <usuário>@<IP da sua VPS>:/tmp/`).
3. **Na VPS**, pare o servidor e o worker (Dokploy > o serviço > **Stop**, ou `docker stop` nos dois contêineres) e restaure no contêiner do Postgres:

   ```sh
   docker exec -i <nome-do-contêiner-postgres> pg_restore -U suup -d suup --clean --if-exists < /tmp/suup.dump
   rm /tmp/suup.dump
   ```

4. **Deploy** de novo (ou **Start**) e conecte o app à VPS (passo 8).

Não vão juntos: os **segredos do cofre** (cifrados com a chave do computador: cadastre de novo na VPS), os **arquivos que os bots criaram** no computador e a chave da Anthropic (já está no passo 4). Depois de passar, não deixe o computador e a VPS ligados com o mesmo bot.

## 10. Backups

O que importa está em dois volumes: o banco (`postgres`) e o workspace dos bots, que fica **dentro** do Docker do Suup (no volume `dind-data`).

- **Banco, automático (recomendado):** cadastre um destino S3 (Settings > S3 Destinations; o R2 do Cloudflare serve) e, na aba **Backups** do Compose, **Add Backup**: Database Type **PostgreSQL**, Service Name **`postgres`**, Database **`suup`**, um horário (cron, por exemplo `30 4 * * *`), "Keep the latest" 14. Use **Run Manual Backup** uma vez para conferir que o arquivo chega ao bucket.
- **Banco, à mão:** `docker exec <nome-do-contêiner-postgres> pg_dump -U suup -Fc suup > suup-$(date +%F).dump`, e copie o arquivo para fora da VPS.
- **Arquivos dos bots:**

  ```sh
  docker exec <nome-do-contêiner-docker> sh -c 'tar czf - -C /var/lib/docker/volumes/suup-workspace/_data .' > workspace-$(date +%F).tgz
  ```

- **Volume Backups** do Dokploy (aba Volume Backups) também copiam volumes nomeados para o S3; para o `dind-data` use "Container OFF" (ele guarda imagens e cache, é grande e se reconstrói sozinho: o que vale salvar dele é só o workspace, acima).

**Restaurar** o banco é o passo 3 da seção 9. **As migrações não têm volta:** faça um backup antes de atualizar.

## 11. Atualizar

- **Automático:** com o GitHub ligado pelo app do Dokploy, cada `push` no ramo escolhido implanta sozinho. O Dokploy reconstrói o Suup, o `images` refaz o que mudou nas receitas, o `migrate` aplica o que for novo e o servidor e o worker são recriados. O worker devolve as execuções em andamento à fila (espera até 30 s) e o novo as retoma.
- **Manual:** desligue **Auto Deploy** na aba General e use **Deploy** quando quiser. É o mais seguro para um banco com migrações sem volta: backup, depois Deploy.
- Mudou só a configuração (File Mount) ou uma variável: **Redeploy**.

## Recursos

Medido em 24/11/2026 (pesquisa, "Verificação local"): em repouso, servidor, worker, Postgres e o Docker do Suup somam perto de **200 MB** de RAM. Com uso, cresce até os limites da configuração: a máquina dos bots até `sandbox.memory` (**2 GB** no exemplo), cada conector até 512 MB e o Chromium do leitor quando renderiza uma página. Disco: perto de 2 GB de imagens na VPS (Suup, dind, Postgres, o auxiliar das imagens) mais, **dentro** do Docker do Suup, as imagens dos bots e o cache de build (de 5 a 8 GB com o leitor completo; estimativa), o banco e o workspace.

Recomendação para o Suup numa VPS que já roda outros projetos: **4 GB de RAM livres** e **15 GB de disco livres**. Com menos, ponha `"memory": "1g"` em `sandbox` na configuração e `SUUP_READER_BROWSER=0`. Para ver o uso: aba **Monitoring** do Dokploy, ou `docker system df` dentro do contêiner `docker` (`docker exec <nome-do-contêiner-docker> docker -H unix:///var/run/dind/docker.sock system df`).

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Deploy falha com "mutually exclusive" ou "network_mode" | Isolated Deployments ligado (passo 2.4) |
| `migrate`/`server` param com "Arquivo de configuração não encontrado" ou "EISDIR" | Falta o File Mount `suup.config.json` (passo 3): sem ele o Docker cria uma **pasta** com esse nome |
| "defina POSTGRES_PASSWORD..." no deploy | Variável faltando na aba Environment (passo 4) |
| `https://agent.kodea.com.br` dá 404 do Traefik | Domínio com HTTPS desligado (passo 5) ou Service Name diferente de `server` |
| Erro 525/526 do Cloudflare | 525: nada respondeu em TLS na 443 (HTTPS desligado). 526: modo Strict sem o certificado da Origin CA (passo 5, opcional) |
| `worker` não sobe | O `images` falhou (veja o log dele) |
| Depois de reiniciar a VPS o `worker` parou | Ele vive na rede do contêiner `docker`; um **Redeploy** (ou `docker start` no worker) resolve |

## Riscos e isolamento

**Por que não o socket do Docker da VPS.** O jeito mais curto de o Suup criar as máquinas dos bots seria montar o `/var/run/docker.sock` da VPS no worker (é o que o [`docker-compose.prod.yml`](../docker-compose.prod.yml) faz numa VPS **só do Suup**). Quem fala com esse socket manda no Docker inteiro: pode parar, ler ou apagar os contêineres e volumes do n8n e dos seus outros projetos, e até montar o disco da VPS num contêiner. Uma falha no worker, ou num caminho que um bot consiga explorar, viraria controle da VPS inteira. Por isso aqui **ninguém** recebe esse socket.

**O que fica no lugar.** O Suup tem o próprio Docker (o serviço `docker`, imagem oficial `docker:dind`), com imagens, redes e volumes num volume só dele (`dind-data`). O worker fala com ele por um socket num volume próprio (`dind-sock`), sem nenhuma porta de rede (nem no loopback). O servidor, que é o que fica exposto, não fala com Docker nenhum, e é o único serviço no `dokploy-network`. O banco fica numa rede interna, sem porta. As máquinas dos bots continuam como sempre: rede interna sem saída, só pelo proxy com a lista de hosts ([REDE.md](REDE.md)).

**O que isto não resolve, sem rodeios.** Docker dentro de Docker exige o contêiner `docker` **privilegiado**. Isso separa bem o Suup dos outros projetos **no uso normal** e contra erros, mas **não** é uma parede contra um atacante que já consiga rodar código no worker: com o Docker do Suup na mão, ele pode criar um contêiner privilegiado lá dentro e, a partir dele, alcançar o núcleo e os discos da VPS. Na prática, isso pede duas falhas encadeadas (sair da máquina do bot, que é um contêiner endurecido sem capacidades, e explorar o privilégio do dind), em vez de uma só com o socket do host. Mantenha o sistema e o Docker da VPS atualizados.

**O próximo degrau (opcional): Sysbox.** O [Sysbox](https://github.com/nestybox/sysbox) (Apache 2.0, hoje do Docker) roda Docker dentro de Docker **sem** `privileged`: o root lá dentro é um usuário sem poder na VPS. Custa mexer no host: instalar o pacote (Ubuntu 22.04 ou 24.04) e, em geral, **reiniciar o Docker da VPS**, o que derruba por alguns instantes todos os seus projetos (o guia do Sysbox recomenda parar os contêineres antes). Feito isso, ponha `SUUP_DOCKER_PRIVILEGED=false` e `SUUP_DOCKER_RUNTIME=sysbox-runc` na aba Environment e faça Redeploy. Não foi exercitado.

**O que foi descartado:** o dind *rootless* (também precisa de `privileged`, ignora os limites de memória e CPU da máquina dos bots sem systemd e esconde as redes internas atrás do `rootlesskit`, o que quebra o proxy de saída) e o Docker rootless na própria VPS (mudaria o Docker de todos os projetos).

**Outros riscos que continuam:** o contêiner do leitor de páginas (dentro do Docker do Suup) tem saída para a internet e, pela rede do `docker`, chegaria ao endereço do Postgres; o próprio leitor recusa endereços privados, e o banco exige a senha. Os outros projetos no `dokploy-network` alcançam a porta 8787 do servidor, que exige o token.
