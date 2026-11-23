# Implantação numa VPS

Como pôr o Suup para rodar de verdade: Postgres, servidor da API, worker e a máquina dos bots numa VPS com Docker, e o app de desktop falando com ele. A API está em [API.md](API.md); a configuração, em [CONFIGURACAO.md](CONFIGURACAO.md).

## O que sobe

```
                 internet
                    │  HTTPS (443)
              ┌─────┴──────┐
              │ proxy TLS  │   o que VOCÊ escolhe (exemplo com Caddy abaixo)
              └─────┬──────┘
                    │  http://127.0.0.1:8787  (só no próprio host)
┌───────────────────┴─────────────────────────────────────────────┐
│  docker compose (docker-compose.prod.yml)                       │
│                                                                 │
│   server ── API + tempo real       sem socket do Docker         │
│   worker ── roda as execuções      COM o socket do Docker ──────┼──► suup-machine
│   migrate ─ aplica migrações e sai                              │    (a máquina dos bots,
│   db ────── Postgres (pgvector)    sem porta publicada          │     criada pelo worker)
│   sandbox-image ─ constrói a imagem da máquina e sai            │
└─────────────────────────────────────────────────────────────────┘
```

Uma imagem só (`suup:prod`, `docker/server/Dockerfile`) serve de servidor, worker e migração; o comando escolhe o papel. Roda sem root (usuário `node`), com sistema de arquivos só de leitura, sem capacidades extras e só com o que é de produção.

Em uma VPS bem pequena dá para juntar servidor e worker num processo só (`suup server --with-worker`: troque o `command` do `server` e remova o serviço `worker`; o contêiner único precisa então do socket, e o servidor deixa de ser isolado dele).

## Requisitos

- Uma VPS Linux (x86_64 ou arm64) com **Docker Engine** e **Docker Compose v2**. 2 GB de RAM é o mínimo razoável (a máquina dos bots tem limite próprio, 2 GB por padrão: `sandbox.memory`).
- Um nome de domínio apontando para a VPS, se for usar TLS com certificado público (recomendado; é o que torna o app seguro fora da sua casa).
- A chave de API de pelo menos um provedor de modelos.

## Primeira implantação

```sh
git clone <este repositório> suup && cd suup

# 1. Variáveis (segredos): copie, preencha e proteja
cp .env.prod.example .env.prod
chmod 600 .env.prod
#    POSTGRES_PASSWORD  -> openssl rand -hex 24
#    DOCKER_GID         -> stat -c %g /var/run/docker.sock
#    ANTHROPIC_API_KEY  -> a chave (ou a variável que o seu suup.config.json citar)
#    SUUP_SERVER_TOKEN  -> veja "O token", logo abaixo
#    SUUP_VAULT_KEY     -> (opcional) a chave do cofre de segredos: veja docs/COFRE.md

# 2. Configuração: modelos, limites, sandbox, servidor
cp suup.config.prod.example.json suup.config.json
$EDITOR suup.config.json        # ajuste "models", "defaults", "server.allowedOrigins"

# 3. Subir (constrói as imagens na primeira vez; leva alguns minutos)
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# 4. Conferir
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
curl -s http://127.0.0.1:8787/health                                    # {"status":"ok"}
docker compose -f docker-compose.prod.yml --env-file .env.prod exec worker node dist/bin.js doctor
```

O `doctor` no worker é o teste de ponta a ponta: banco, migrações, busca sem acento, fila, **a máquina dos bots** (ele a cria na primeira vez) e os provedores. `doctor --live` faz uma chamada minúscula a cada modelo (gasta alguns tokens). Se alguma linha falha, o `detail` diz o que fazer.

Na primeira subida o servidor cria o **bot principal** ("Principal", com o primeiro modelo da configuração) se ainda não houver nenhum bot.

### O token

O app e o `curl` se autenticam com um único token (`Authorization: Bearer`). Gere um de 256 bits e ponha em `SUUP_SERVER_TOKEN` no `.env.prod`:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps -e SUUP_SERVER_TOKEN=x server server --generate-token
# ou, sem Docker:
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Cole o mesmo token no app. O servidor **não sobe sem token**, nem com menos de 32 caracteres. O token nunca fica no `suup.config.json` (a configuração só guarda o **nome** da variável, `server.tokenEnv`; um campo `token` é recusado). Para trocá-lo, mude o `.env.prod` e rode `docker compose ... up -d` de novo; o app precisa do novo.

### Migrações

O serviço `migrate` roda `suup db migrate` antes de o servidor e o worker subirem, e eles só sobem se ele terminar bem. Cada migração roda em uma transação; um arquivo já aplicado não pode mudar (o checksum é conferido). Para rodar à mão: `docker compose ... run --rm migrate`. O estado: `docker compose ... exec worker node dist/bin.js doctor` (linha "Banco de dados").

## TLS na frente

O servidor fala **HTTP puro** e só escuta em `127.0.0.1` do host (o `docker-compose.prod.yml` publica `127.0.0.1:8787`). Sem TLS, o token e as conversas viajam sem criptografia: **nunca** exponha a porta 8787 à internet. O proxy reverso é escolha sua (Caddy, nginx, Traefik, o balanceador do seu provedor...); o que ele precisa fazer:

1. terminar o TLS e repassar para `http://127.0.0.1:8787`;
2. **não guardar em buffer** as respostas, para o tempo real (SSE) funcionar;
3. deixar as conexões do stream abertas por bastante tempo (o servidor manda um pulso a cada 15 s).

Exemplo com **Caddy** (`/etc/caddy/Caddyfile`; o Caddy obtém e renova o certificado sozinho, com o domínio apontando para a VPS e as portas 80 e 443 abertas):

```
suup.exemplo.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1        # sem buffer: necessário para o stream SSE
    }
}
```

No nginx, o equivalente é `proxy_pass http://127.0.0.1:8787; proxy_buffering off; proxy_read_timeout 1h;`.

Depois: `curl -s https://suup.exemplo.com/health`, e no app o endereço `https://suup.exemplo.com` com o token. Acrescente em `server.allowedOrigins` as origens do app (Tauri: `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`, já presentes no exemplo de configuração). Feche o resto do firewall (`ufw allow 22,80,443/tcp`): o Postgres não tem porta publicada, e a 8787 só existe no loopback.

## O socket do Docker: o que ele dá ao worker

O worker comanda a máquina dos bots com `docker exec`, o que exige falar com o daemon do Docker do host. Há duas formas de dar isso a ele, e as duas passam pelo socket:

| Opção | O que é | Por que (não) |
|---|---|---|
| **A. Socket montado no worker, que cria a máquina** (a escolhida) | O worker monta `/var/run/docker.sock` e o próprio código (`ensureMachine`) cria o contêiner `suup-machine` na primeira execução, com o volume do workspace | **Uma definição só** da máquina: limites de memória, CPU e processos, sem swap, sem capacidades, `no-new-privileges`, usuário sem root, tudo no código, testado. Nada para ficar fora de sincronia com o `suup.config.json` |
| B. A máquina como serviço do compose | O compose declara o contêiner e o worker só faz `docker exec` nele | O worker **continua** precisando do socket para o `exec`, então nada se ganha em segurança; e a máquina passaria a ter duas definições (compose e código) e dois volumes possíveis: se o contêiner sumir, o worker recria outro, com outro volume, e os arquivos dos bots "desaparecem" sem erro |

**Aviso de segurança, sem rodeios:** montar o socket do Docker dá ao worker **controle equivalente a root sobre o Docker do host**. Quem executa código dentro do contêiner do worker pode subir um contêiner privilegiado com o disco do host montado. O que isso significa na prática:

- O worker é o código do Suup, não o código dos bots: os comandos dos bots rodam **dentro** da máquina dos bots, que **não** recebe o socket e é um contêiner endurecido. O risco real é uma falha no worker, ou nas bibliotecas dele, ser explorada.
- O **servidor da API não recebe o socket** (é o que fica na frente da rede). É por isso que o `doctor` do servidor não confere a máquina dos bots: peça ao worker.
- Mantenha a VPS dedicada ao Suup (nada mais de valor nela), com o sistema e o Docker atualizados e as portas fechadas (item acima).
- Para reduzir ainda mais: Docker em modo *rootless* no host, ou um *proxy de socket* com permissões restritas (só `exec`, `inspect`, `start`, `volume create`, `run`) entre o worker e o daemon. Nenhum dos dois vem pronto aqui.

## Rede dos bots

A máquina dos bots (e cada conector stdio) fica numa rede Docker **interna** e só sai pelo proxy do worker, com uma lista de hosts de nome exato: [REDE.md](REDE.md). No Compose de produção o worker é um contêiner, então ele entra na rede interna com IP fixo e o proxy escuta nesse IP: o `docker-compose.prod.yml` já declara a rede `suup-sandbox-net` (interna, `172.29.77.0/24`, worker em `172.29.77.2`) e o `suup.config.prod.example.json` aponta `sandbox.network.proxy` para esse endereço. Se mudar a sub-rede, mude os dois. A imagem do runner dos conectores (`suup-connector-runner:prod`) é construída pelo serviço `connector-runner-image`.

**Produção usa o proxy dentro do worker** (`sandbox.network.proxy.mode` omitido = `process`): é o caminho provado e o mais simples com o worker na rede interna; o contêiner `suup-egress` (modo `container`, [REDE.md](REDE.md)) existe para quem roda o worker como processo num computador com Docker Desktop (o app no Windows) e não muda o `docker-compose.prod.yml`. Para construir a imagem à mão (desenvolvimento e testes): `pnpm exec tsc -b && node apps/sidecar/scripts/egress-image.mjs docker/egress && docker build -t suup-egress:dev docker/egress`; os testes com Docker real a usam em `SUUP_EGRESS_IMAGE=suup-egress:dev` (o CI constrói `suup-egress:ci`).

Contêineres criados antes desta versão (na rede padrão, com saída direta) são **recriados sozinhos** na primeira execução (o volume do workspace é mantido); `suup doctor` confere que a máquina não tem saída direta.

## Busca e leitura de páginas (`web_search`, `web_read`)

[BUSCA.md](BUSCA.md). No Compose de produção:

- `reader-image` constrói a imagem do leitor e renderizador (`docker/reader/Dockerfile`, base `mcr.microsoft.com/playwright:v1.65.1-noble`, vários GB; a tag é a versão exata do `playwright-core`) e `searxng-image` puxa a imagem do SearXNG **fixada** (`docker.io/searxng/searxng:2026.3.25-541c6c3cb`, nunca `latest`; AGPL v3, usado sem modificação).
- O **worker** sobe os dois contêineres no primeiro uso (`suup-searxng` e `suup-reader`), pelo socket do Docker. Nada novo escuta em porta alguma.
- A rede `suup-search-net` (`172.29.78.0/24`, **interna**) é a do SearXNG; o worker entra nela em `172.29.78.2` e o proxy de motores escuta aí (`web.search.proxy` no `suup.config.prod.example.json`). Se mudar a sub-rede, mude os dois, como na rede dos bots.
- O cache da busca fica no banco (tabela `web_search_cache`, migração 0024, aplicada sozinha pelo `migrate`): sobrevive a reinício. `duckduckgo` está ligado por padrão e sai só por `html.duckduckgo.com` (BUSCA.md).
- **Nenhum segredo novo no `.env.prod`:** a `secret_key` do SearXNG é gerada na criação do contêiner.
- Construir a imagem do leitor atrás de um proxy que reassina o TLS: os mesmos argumentos da seção seguinte, com `-f docker/reader/Dockerfile`.
- Sem o leitor ou sem a busca: `"web": { "reader": { "enabled": false } }` e/ou `"search": { "enabled": false }`.
- Desenvolvimento: `docker compose --profile web up -d searxng` (com `SEARXNG_SECRET`) sobe só o SearXNG na porta `127.0.0.1:8080`, **com a saída do host** (sem a lista): só para desenvolvimento.
- **Produção (VPS) não muda:** o proxy de motores fica no worker (`web.search.proxy.mode` omitido = `process`). O modo `container` (`suup-egress-search`, a imagem de `docker/egress`) é o do app de desktop no Windows, onde o worker é um processo do computador e não escuta numa rede do Docker ([BUSCA.md](BUSCA.md), "O app embutido").
- **A imagem do leitor como o app a constrói** (sem o repositório): `pnpm exec tsc -b && node apps/sidecar/scripts/reader-image.mjs /tmp/reader && docker build -t suup-reader:app-dev /tmp/reader` (receita `docker/reader/app.Dockerfile`; o CI a constrói e confere que o navegador sobe). Atrás de um proxy que reassina o TLS, os mesmos argumentos da seção seguinte (`--network host`, `--build-arg HTTPS_PROXY`, `--secret id=build_ca,...`).

## Construir atrás de um proxy que reassina o TLS

Numa rede com um proxy que intercepta HTTPS (corporativo, ou o ambiente de um agente), `docker build` falha no `apt-get update`/`npm`/`pip`: o build não tem o proxy nem a CA dele. Passe os dois **só durante o build**, sem gravá-los na imagem:

```sh
# o proxy como build arg predefinido (não entra no histórico nem nas camadas) e a CA como segredo do BuildKit
docker build --network host \
  --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg APT_HTTPS=1 \
  --secret id=build_ca,src=/caminho/ca-bundle.crt \
  --tag suup-sandbox:dev docker/sandbox

docker build --network host --build-arg HTTPS_PROXY="$HTTPS_PROXY" --secret id=build_ca,src=/caminho/ca-bundle.crt \
  --tag suup-connector-runner:dev docker/connector-runner
docker build --network host --build-arg HTTPS_PROXY="$HTTPS_PROXY" --secret id=build_ca,src=/caminho/ca-bundle.crt \
  -f docker/server/Dockerfile --tag suup:prod .
```

- `APT_HTTPS=1` troca as fontes do `apt` para https (um proxy que só faz túnel `CONNECT` recusa `http://` puro). Sem a variável o build é o de sempre.
- `--network host` deixa o build alcançar um proxy em `127.0.0.1`; com um proxy em outro endereço, use esse endereço e tire a opção.
- A CA só existe dentro do `RUN` que a monta (`--mount=type=secret`, opcional): sem `--secret` nada muda. Verifique: `docker history --no-trunc <imagem>` e `docker run --rm <imagem> env` não mostram o proxy.
- Se o proxy bloqueia os espelhos do Debian, use `--build-arg BASE_IMAGE=ubuntu:24.04` na imagem da máquina (o `Dockerfile` libera o uid 1000 da base sozinho). Só para ambientes assim: o CI e a produção usam o padrão Debian.

Se o proxy da rede **reassina o TLS**, o build acima resolve só a construção da imagem; **dentro** do contêiner em execução a CA do proxy continua desconhecida e o HTTPS para hosts liberados falha. Para isso há `sandbox.extraCaBundle`, opcional e desligado por padrão (um arquivo do host montado somente leitura na máquina dos bots e nos conectores): veja [REDE.md](REDE.md), "Rede com interceptação de TLS". Com o worker em contêiner (Compose de produção) atenção: quem monta o arquivo nos outros contêineres é o Docker **do host** (pelo socket), então o caminho precisa existir **igual no host e no contêiner do worker** (o worker o confere antes de pedir a montagem). Monte o arquivo no serviço do worker no mesmo caminho do host (por exemplo `/opt/suup/ca-da-empresa.pem:/opt/suup/ca-da-empresa.pem:ro`) e use esse caminho em `extraCaBundle`. Esse caso (Docker dentro de Docker) não foi exercitado.

## Conectores MCP

Com o sandbox `docker`, um conector de processo local ([CONECTORES.md](CONECTORES.md)) roda **num contêiner próprio** criado pelo worker, na rede interna, sem os arquivos nem o ambiente do worker. O contêiner do worker segue com acesso ao socket do Docker (veja acima), então o risco do **worker** não muda; o conector, sim, fica fora dele. Prefira fixar a versão do programa e liberar só os hosts de que o servidor precisa (`--egress`). O contêiner do servidor da API não roda conectores: `suup doctor`, nele, diz que não verificou; rode `docker compose ... exec worker suup connectors test <nome>`.

## Backups

Dois lugares guardam o que importa: o **Postgres** (bots, conversas, memória, o log de todas as execuções) e o **volume do workspace** (os arquivos que os bots criam).

```sh
# Postgres: um arquivo de dump (formato custom, restaura com pg_restore)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db \
  pg_dump -U suup -Fc suup > backup-$(date +%F).dump

# Restaurar num banco vazio (com o servidor e o worker parados)
docker compose -f docker-compose.prod.yml --env-file .env.prod stop server worker
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T db \
  pg_restore -U suup -d suup --clean --if-exists < backup-2026-11-18.dump
docker compose -f docker-compose.prod.yml --env-file .env.prod start server worker

# O volume de dados do Postgres, inteiro (com tudo parado: o dump acima é o que se recomenda;
# isto é para quem quer copiar o diretório)
docker run --rm -v suup-prod_pgdata:/data -v "$PWD":/backup debian:12-slim \
  tar czf /backup/pgdata-$(date +%F).tgz -C /data .

# O workspace dos bots (o volume é criado pelo worker, com o nome de sandbox.volume)
docker run --rm -v suup-workspace:/data -v "$PWD":/backup debian:12-slim \
  tar czf /backup/workspace-$(date +%F).tgz -C /data .
```

Use o usuário e o banco do seu `.env.prod` no lugar de `suup`, e agende (cron) o `pg_dump`, copiando o arquivo para **fora** da VPS. O dump traz, com a busca por palavras, as colunas que o banco calcula; a função e a extensão da busca sem acento são recriadas pelas migrações no banco novo.

## Passar do computador para a VPS

O app de desktop pode rodar o servidor **dentro dele** ("Usar neste computador", [USAR-NO-WINDOWS.md](USAR-NO-WINDOWS.md)) ou falar com esta VPS. **Um cérebro por vez, sem sincronização**: o que está no computador não aparece na VPS até você levar. Levar é um dump e uma restauração (o mesmo `pg_dump`/`pg_restore` de "Backups"):

1. **Suba a VPS** como acima (banco vazio, migrações aplicadas, servidor e worker parados no passo 3).
2. **No computador, com o app aberto** (o banco só roda enquanto o app está aberto): Configurações > Geral > Servidor > **Banco de dados > Copiar endereço**. O endereço tem a forma `postgres://suup:SENHA@127.0.0.1:PORTA/suup` e leva a senha: não cole em chat nem em arquivo versionado.
3. **Faça o dump.** O banco embutido não traz `pg_dump`; use o do Docker (o Docker Desktop já está lá se você usa a máquina isolada). Troque `127.0.0.1` por `host.docker.internal` e grave com `-f` (o `>` do PowerShell estraga arquivo binário):

   ```powershell
   docker run --rm -v "${PWD}:/out" postgres:18 pg_dump -Fc -f /out/suup.dump "postgres://suup:SENHA@host.docker.internal:PORTA/suup"
   ```

4. **Copie** `suup.dump` para a VPS (`scp`) e **restaure** com o servidor e o worker parados, como em "Backups" (`pg_restore -U suup -d suup --clean --if-exists < suup.dump`), e suba-os de novo.
5. **No app:** Configurações > Geral > Servidor > **Trocar** > **Conectar à minha VPS** (endereço e token da VPS).

O que **não** vai junto: os **segredos do cofre** (estão cifrados com uma chave que fica no chaveiro do computador e não sai de lá: cadastre-os de novo na VPS), os **arquivos que os bots criaram** na máquina deles (o volume do workspace; copie à parte, se importar) e a **chave da Anthropic** (coloque em `.env.prod`). Depois de passar, **não deixe o computador e a VPS ligados com o mesmo bot**: cada um teria a sua conversa e a sua execução. Para voltar da VPS para o computador, o caminho é o contrário (dump na VPS, restauração no banco do app, que precisa estar parado: peça para eu documentar quando for preciso, ainda não foi exercitado).

## Atualizar

```sh
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

O Compose reconstrói a imagem, refaz o `migrate` (aplica o que for novo) e recria o servidor e o worker. O worker recebe o aviso de parada, leva as execuções em andamento até o próximo ponto seguro e as devolve à fila (espera até 30 s; o `stop_grace_period` é de 40 s), e o novo worker as retoma de onde o log parou. O servidor encerra os streams, e o app reconecta e retoma pelo `Last-Event-ID`.

Faça um backup antes: **as migrações não têm volta**. Para voltar a uma versão anterior do código depois de uma migração nova, restaure o dump.

## Logs

Tudo vai para a saída padrão dos contêineres, com rodízio (5 arquivos de 10 MB):

```sh
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f server worker
docker compose -f docker-compose.prod.yml --env-file .env.prod logs --since 1h worker
```

- **server**: uma linha por requisição (`2026-11-18T20:13:08.123Z GET /v1/runs/… 200 12ms 9f3a1c2b4d5e`: método, caminho **sem a consulta**, estado, tempo e o `X-Request-Id`, que também volta ao cliente) e os erros internos com o detalhe. Nunca registra o token, o corpo das requisições ou o texto das mensagens.
- **worker**: o fim de cada execução (`worker: execução 3f2a9c1d: concluída em 12.3 s`, ou o motivo de ter sido devolvida), as falhas de infraestrutura e as pendências acertadas na partida.
- **db**: o log do Postgres.

Para entender **por que uma execução se comportou de certo jeito**, o log do contêiner não é o lugar: use o Inspetor (`/v1/runs/{id}/events`, `/requests/{seq}`, `/replay`, `/resend`) ou `docker compose … exec worker node dist/bin.js inspect <execução>`, que lê o log de eventos gravado no banco ([DIAGNOSTICO.md](DIAGNOSTICO.md)).

## Busca sem acento

As migrações criam a busca sem diferenciar acentos ("avaliacao" acha "avaliação") **se** o PostgreSQL tem a extensão `unaccent`, que a imagem `pgvector/pgvector` tem. Num PostgreSQL puro, sem os pacotes *contrib*, a **mesma migração** roda e deixa a busca como era (por radicais, com acentos); a linha "Busca" do `doctor` diz qual caso vale. Se você instalar o contrib depois, a busca continua sem acento até uma migração nova a ativar: peça que ela seja escrita; o dado não se perde.

## Desligar e limpar

```sh
docker compose -f docker-compose.prod.yml --env-file .env.prod down        # para; os dados ficam
docker rm -f suup-machine                                                 # a máquina dos bots (não é do compose)
docker compose -f docker-compose.prod.yml --env-file .env.prod down -v    # APAGA o banco (volume pgdata)
docker volume rm suup-workspace                                           # APAGA os arquivos dos bots
```

## O que esta implantação ainda não resolve

- Sem alta disponibilidade: um Postgres, um servidor, um worker (mais workers funcionam: `docker compose … up -d --scale worker=2`, e mais servidores atrás do proxy também, com o tempo real consistente).
- Sem renovação automática de token nem vários usuários: o desenho é de um dono só.
- O socket do Docker no worker (acima).
