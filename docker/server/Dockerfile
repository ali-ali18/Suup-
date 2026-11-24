# syntax=docker/dockerfile:1
#
# Imagem de produção do Suup: servidor da API e worker na MESMA imagem; o comando escolhe o papel
# (`server`, `worker`, `db migrate`...). Veja docs/IMPLANTACAO.md.
#
# Construir, a partir da raiz do repositório:
#   docker build -f docker/server/Dockerfile -t suup:prod .
#
# Atrás de um proxy que reassina o TLS (docs/IMPLANTACAO.md, "Construir atrás de um proxy"): o proxy
# e a CA existem SÓ durante o build (build args predefinidos de proxy e um segredo do BuildKit
# montado em um RUN); nenhum dos dois entra numa camada nem na imagem final.
#   docker build --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY --secret id=build_ca,src=ca.crt \
#     -f docker/server/Dockerfile -t suup:prod .

ARG NODE_VERSION=22

# --- 1. compilar o workspace e extrair só o que roda em produção --------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Os manifestos primeiro: a camada das dependências só é refeita quando um package.json ou o
# lockfile muda, não a cada alteração de código.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY evals/package.json evals/
COPY packages/api/package.json packages/api/
COPY packages/connectors/package.json packages/connectors/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/server/package.json packages/server/
COPY packages/tools/package.json packages/tools/
COPY packages/web/package.json packages/web/
# `build_ca` (opcional) é a CA do proxy de build; o Node só a lê neste RUN. NODE_USE_ENV_PROXY faz o
# `fetch` do Node (corepack) respeitar HTTPS_PROXY quando ele é passado como build arg.
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && NODE_USE_ENV_PROXY=1 pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY apps apps
COPY evals evals
COPY packages packages
# A CLI depende (por referência de projeto) de todos os pacotes: compilar ela compila o resto.
RUN pnpm exec tsc -b apps/cli
# Só o `dist`, as migrações e as dependências de produção da CLI, sem código-fonte nem devDependencies.
RUN pnpm --filter @suup/cli deploy --legacy --prod /out

# --- 2. a imagem que roda -----------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SUUP_CONFIG=/app/suup.config.json
# A CLI do docker (binário estático): é como o worker conversa com a máquina dos bots, pelo socket
# do host. Só o contêiner do worker recebe o socket (docker-compose.prod.yml); o do servidor, não.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# Sem root: o usuário `node` da imagem oficial (uid 1000).
USER node
EXPOSE 8787
# O servidor responde "ok" em /health sem token. (O worker não tem HTTP: o docker-compose.prod.yml
# desliga este teste nele.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SUUP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["server"]
