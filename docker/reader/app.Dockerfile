# syntax=docker/dockerfile:1
#
# O leitor de páginas (docs/BUSCA.md) como o app de desktop o constrói, SEM o repositório: o app leva
# esta receita e o programa já empacotado (`dist/serve.js`, gerado por
# apps/sidecar/scripts/reader-image.mjs), e a imagem é construída no computador do usuário na
# primeira vez, como a da máquina dos bots e a do proxy de saída. O resultado é o mesmo contêiner da
# imagem `docker/reader/Dockerfile` (sem porta, sem segredo, `docker exec -i ... node /app/dist/serve.js`).
#
# Gerar a pasta e construir à mão (a partir da raiz do repositório):
#   pnpm exec tsc -b && node apps/sidecar/scripts/reader-image.mjs /tmp/reader
#   docker build -t suup-reader:app-dev /tmp/reader
#
# A TAG da imagem base TEM DE SER a versão exata do `playwright-core` de packages/web/package.json
# (o navegador é daquela revisão); o script confere. O `playwright-core` é o único pacote instalado
# aqui, na versão exata que o `package.json` gerado fixa (não tem dependências). Sem navegador:
# `--build-arg PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node`.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.1-noble
FROM ${PLAYWRIGHT_IMAGE}
ARG RUN_USER=pwuser
ENV NODE_ENV=production
WORKDIR /app
COPY package.json /app/package.json
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY dist /app/dist
# Sem root: o usuário `pwuser` da imagem do Playwright (ou `node`, na variante sem navegador).
USER ${RUN_USER}
CMD ["sleep", "infinity"]
