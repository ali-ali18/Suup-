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

O banco escuta apenas em `127.0.0.1` (porta `5432` por padrão). A extensão `vector` é criada automaticamente na primeira inicialização.

### Qualidade

```sh
pnpm lint        # verifica lint e formatação (Biome)
pnpm format      # aplica a formatação
pnpm typecheck   # tsc -b em todos os pacotes
pnpm test        # Vitest
```
