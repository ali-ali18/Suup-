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

### Qualidade

```sh
pnpm lint        # verifica lint e formatação (Biome)
pnpm format      # aplica a formatação
pnpm typecheck   # tsc -b em todos os pacotes, mais os arquivos de teste
pnpm test        # Vitest
```

Os testes do pacote `@suup/db` usam um Postgres real: defina `DATABASE_URL` (o valor do `.env.example` serve para o banco do Compose) e eles rodam, cada arquivo em um schema próprio que é removido ao final. Sem `DATABASE_URL`, esses testes são pulados.
