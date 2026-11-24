# syntax=docker/dockerfile:1
#
# O serviço leitor de páginas e renderizador do Suup (docs/BUSCA.md): lê uma página pública e a
# devolve como Markdown; com `render`, abre a página num Chromium sem cabeça (Playwright). Roda num
# contêiner próprio, FORA da máquina dos bots, sem porta de entrada, sem segredo e sem perfil em
# disco; o worker fala com ele por `docker exec -i ... node /app/dist/serve.js`.
#
# Construir, a partir da raiz do repositório:
#   docker build -f docker/reader/Dockerfile -t suup-reader:dev .
#
# A imagem base do Playwright traz o Chromium e as bibliotecas dele; a TAG TEM DE SER a versão exata do
# `playwright-core` de packages/web/package.json (o navegador é daquela revisão). Atrás de um proxy que
# reassina o TLS, veja docs/IMPLANTACAO.md ("Construir atrás de um proxy").
# Sem navegador (só leitura de páginas, por exemplo onde o disco é pequeno): `--build-arg
# PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node`; `render` fica indisponível.
ARG NODE_VERSION=22
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.1-noble
ARG RUN_USER=pwuser

# --- 1. compilar o pacote e extrair só o que roda em produção -----------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY evals/package.json evals/
COPY packages/api/package.json packages/api/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/documents/package.json packages/documents/
COPY packages/providers/package.json packages/providers/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/server/package.json packages/server/
COPY packages/tools/package.json packages/tools/
COPY packages/web/package.json packages/web/
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && NODE_USE_ENV_PROXY=1 pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/sandbox packages/sandbox
COPY packages/web packages/web
# O Chromium vem da imagem base: nenhum navegador é baixado aqui.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm exec tsc -b packages/web
RUN pnpm --filter @suup/web deploy --legacy --prod /out

# --- 2. a imagem que roda -----------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS runtime
ARG RUN_USER
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=${RUN_USER}:${RUN_USER} /out /app
# Sem root: o usuário `pwuser` da imagem do Playwright (ou `node`, na variante sem navegador).
USER ${RUN_USER}
CMD ["sleep", "infinity"]
