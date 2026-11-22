# Suup

Assistente pessoal de uso geral, formado por uma equipe de bots que conversam, lembram, agem em um computador próprio e terminam o que começam.

O plano de arquitetura e as fases de construção estão em [docs/PLANO.md](docs/PLANO.md). Já existem o núcleo (loop, worker, replay), o banco, os provedores, a máquina dos bots, as ferramentas, a montagem em tempo de execução (`@suup/runtime`), a CLI `suup`, conversas e memória, aprovações (cartões, regras, níveis de risco) o cofre de segredos e os conectores MCP ([docs/APROVACOES.md](docs/APROVACOES.md), [docs/COFRE.md](docs/COFRE.md), [docs/CONECTORES.md](docs/CONECTORES.md); só o backend: o app ainda não os desenha), e o **servidor** (`@suup/server`: API HTTP e tempo real, com o contrato e o cliente tipado em `@suup/api`) com o empacotamento para uma VPS; o app de desktop ainda não.

## Desenvolvimento

### Pré-requisitos

- Node.js 22 ou superior (`.nvmrc` incluído)
- pnpm 10 (versão fixada em `packageManager`; use `corepack enable` para habilitá-lo)
- Docker com Docker Compose, para o Postgres local

### Instalação

```sh
pnpm install
```

### Banco de dados (Postgres com pgvector)

```sh
cp .env.example .env          # opcional: os valores padrão já funcionam
docker compose up -d --wait   # sobe o Postgres e espera ficar saudável
docker compose down           # para o banco (acrescente -v para apagar os dados)
```

Com o banco no ar, aplique as migrações (lê `DATABASE_URL` do ambiente ou do `.env`):

```sh
pnpm db:migrate
```

As migrações ficam em `packages/db/migrations/` (arquivos SQL aplicados em ordem de nome, cada um em sua transação). Um arquivo já aplicado não pode ser editado: o checksum é conferido e a migração falha se ele mudou; crie um novo arquivo em vez disso.

O banco escuta apenas em `127.0.0.1` (porta `5432` por padrão). A extensão `vector` é criada automaticamente na primeira inicialização.

### Máquina dos bots (sandbox)

A máquina dos bots é um contêiner Linux persistente, descrito em `docker/sandbox/Dockerfile`. O servidor fala com ela por `DockerExecutor` (`packages/sandbox`), que usa `docker exec`.

```sh
docker build --tag suup-sandbox:dev docker/sandbox
```

Em código, `ensureMachine({ name, image, volume })` cria (ou reaproveita) o contêiner e o volume do workspace, e `removeMachine(name)` o remove. Para desenvolvimento e testes existe também `LocalExecutor`, que roda direto no seu computador, dentro de uma pasta, **sem nenhum isolamento**: não use com comandos de origem desconhecida.

Os testes do executor rodam sempre contra `LocalExecutor` e contra um `docker` falso. Para rodá-los também contra um contêiner de verdade (precisa do daemon do Docker):

```sh
docker build --tag suup-sandbox:dev docker/sandbox
SUUP_DOCKER_TESTS=1 SUUP_SANDBOX_IMAGE=suup-sandbox:dev pnpm vitest run packages/sandbox
```

Sem `SUUP_DOCKER_TESTS=1`, esses testes são pulados. O CI faz o build da imagem e roda com a variável ligada. Os testes de rede (proxy, rede interna, conectores em contêiner) também usam a imagem dos conectores:

```sh
docker build --tag suup-connector-runner:dev docker/connector-runner
node apps/sidecar/scripts/egress-image.mjs docker/egress && docker build --tag suup-egress:dev docker/egress   # o proxy em contêiner (precisa de pnpm exec tsc -b antes)
SUUP_DOCKER_TESTS=1 SUUP_SANDBOX_IMAGE=suup-sandbox:dev SUUP_CONNECTOR_IMAGE=suup-connector-runner:dev SUUP_EGRESS_IMAGE=suup-egress:dev pnpm test
```

Atrás de um proxy que reassina o TLS (corporativo): veja "Construir atrás de um proxy que reassina o TLS" em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

### Primeiro uso (CLI)

A CLI `suup` cria bots, roda execuções e ajuda a diagnosticá-las. Ela lê a configuração de `suup.config.json` (todos os campos em [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md)) e o banco de `DATABASE_URL`.

```sh
# 1. Configuração: copie o exemplo e ajuste (provedores, modelos, sandbox)
cp suup.config.example.json suup.config.json
export ANTHROPIC_API_KEY=...        # a chave nunca vai no arquivo, só o nome da variável (apiKeyEnv)

# 2. Banco no ar e migrado
docker compose up -d --wait
pnpm suup db migrate

# 3. Saúde de cada componente (use --live para testar os modelos de verdade)
pnpm suup doctor

# 4. Um bot
pnpm suup bot create --name ajudante --model model-x --all-tools --personality "Seja direto."

# 5. Uma execução, acompanhada ao vivo
pnpm suup run "Crie o arquivo ola.txt com a frase Olá, mundo!" --bot ajudante \
  --criterion "o arquivo ola.txt existe e contém a frase"
```

`pnpm suup` compila o que for preciso e roda a CLI (`pnpm suup <comando>`; a ajuda de cada um está em `pnpm suup <comando> --help`). Durante uma execução, o que você digitar vai ao bot como mensagem; Ctrl+C uma vez pausa no próximo ponto seguro (retome com `suup resume`), duas vezes aborta. Depois: `suup runs`, `suup show <id>` e, para entender uma falha, o roteiro de [docs/DIAGNOSTICO.md](docs/DIAGNOSTICO.md) (`inspect`, `replay`, `resend`). Para medir o harness e os modelos com tarefas verificadas automaticamente (matriz por modelo, qualificação, histórico, controle de custo), há o `suup eval`, descrito em [docs/AVALIACAO.md](docs/AVALIACAO.md).

**Sem chave de API:** `examples/demo/` tem uma configuração com um provedor roteirizado (`scripted`: um arquivo JSON responde no lugar do modelo) e sandbox local. Com o Postgres no ar e `DATABASE_URL` definida (o `.env` serve), a partir da raiz do repositório:

```sh
export SUUP_CONFIG=examples/demo/suup.config.json
pnpm suup db migrate
pnpm suup doctor
pnpm suup bot create --name ajudante --model model-x --all-tools
pnpm suup run "Crie o arquivo ola.txt com a frase Olá, mundo!" --bot ajudante \
  --criterion "o arquivo ola.txt existe e contém a frase"
```

Os arquivos do bot aparecem em `examples/demo/workspace/bots/<id>/`.

O sandbox `local` roda os comandos dos bots direto no seu computador, **sem isolamento**, e a CLI avisa sempre que ele está em uso.

### Servidor (API e tempo real)

O app de desktop fala com o `suup server`, uma API HTTP com tempo real por Server-Sent Events (todos os endpoints em [docs/API.md](docs/API.md)). Ele exige um token (mínimo 32 caracteres), que vem **só** de uma variável de ambiente, e por padrão escuta apenas em `127.0.0.1`.

```sh
# 1. Um token novo, e o servidor com um worker embutido (um processo só, bom para experimentar)
export SUUP_SERVER_TOKEN=$(pnpm --silent suup server --generate-token)
pnpm suup server --with-worker               # http://127.0.0.1:8787

# 2. Em outro terminal
curl -s localhost:8787/health                                     # {"status":"ok"}
curl -s -H "Authorization: Bearer $SUUP_SERVER_TOKEN" localhost:8787/v1/bots | jq
```

`suup server` (sem `--with-worker`) é só a API: as execuções precisam de `suup worker` em outro processo, e pausar, interromper e cancelar pela API funcionam entre os dois por meio do banco. Ao subir, o servidor acerta o que ficou pendente de execuções que terminaram sem aviso e cria o bot principal se não houver nenhum. As origens do app (Tauri) vão em `server.allowedOrigins` ([docs/CONFIGURACAO.md](docs/CONFIGURACAO.md)). **Fora do seu computador**, ponha um proxy com TLS na frente: o servidor fala HTTP puro.

### Produção numa VPS

`docker-compose.prod.yml` sobe Postgres, migrações, servidor, worker e a imagem da máquina dos bots, a partir de uma imagem só (`docker/server/Dockerfile`). O passo a passo (primeira implantação, token, TLS, o que o socket do Docker dá ao worker, backup, atualização, logs) está em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md).

```sh
cp .env.prod.example .env.prod && chmod 600 .env.prod            # preencha
cp suup.config.prod.example.json suup.config.json                # ajuste
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

### Qualidade

```sh
pnpm lint        # verifica lint e formatação (Biome)
pnpm format      # aplica a formatação
pnpm typecheck   # tsc -b em todos os pacotes, mais os arquivos de teste
pnpm test        # Vitest
```

Os testes que usam um Postgres real (`@suup/db`, `@suup/runtime`, `@suup/server`, a CLI e as avaliações) rodam quando `DATABASE_URL` está definida (o valor do `.env.example` serve para o banco do Compose), cada arquivo em um schema próprio que é removido ao final; sem ela, são pulados. Os testes de ponta a ponta do servidor sobem um servidor numa porta efêmera, um worker em outro objeto de runtime e usam o cliente real de `@suup/api`, com o provedor `scripted` e o sandbox `local`.

## Licença

MIT. Veja [LICENSE](LICENSE).
