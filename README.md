# Suup

Assistente pessoal de uso geral, formado por uma equipe de bots que conversam, lembram, agem em um computador próprio e terminam o que começam.

Ainda não há código de produto. O plano de arquitetura e as fases de construção estão em [docs/PLANO.md](docs/PLANO.md).

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

Sem `SUUP_DOCKER_TESTS=1`, esses testes são pulados. O CI faz o build da imagem e roda com a variável ligada.

### Qualidade

```sh
pnpm lint        # verifica lint e formatação (Biome)
pnpm format      # aplica a formatação
pnpm typecheck   # tsc -b em todos os pacotes, mais os arquivos de teste
pnpm test        # Vitest
```

Os testes do pacote `@suup/db` usam um Postgres real: defina `DATABASE_URL` (o valor do `.env.example` serve para o banco do Compose) e eles rodam, cada arquivo em um schema próprio que é removido ao final. Sem `DATABASE_URL`, esses testes são pulados.
