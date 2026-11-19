# Runner of the stdio connectors (MCP servers started as `npx ...` / `uvx ...` / `python -m ...`).
# See docs/CONECTORES.md and docs/REDE.md. One container per connector, started by the worker from
# this image; the connector's own code is fetched at start through the egress proxy (package
# registries on the allowlist), it is not baked in.
#
# Contents: Node 22 + npm + npx, Python 3.12 + pip, uv/uvx, a non-root user. No compilers, no git,
# no curl: a server that needs more is a reason to build a derived image (set `connectors.image`).
#
# Build:  docker build -t suup-connector-runner:dev docker/connector-runner
# Behind a TLS-intercepting proxy (docs/IMPLANTACAO.md): the proxy and CA exist only while this build runs.
#   docker build --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY \
#     --secret id=build_ca,src=/path/to/ca-bundle.crt -t suup-connector-runner:dev docker/connector-runner
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

FROM ${NODE_IMAGE} AS node

FROM ${PYTHON_IMAGE}
ENV LANG=C.UTF-8 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# `build_ca` (optional) is the CA of a build-time proxy; pip reads it only in this RUN.
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi \
    && pip install uv==0.5.14

RUN useradd --create-home --shell /bin/sh --uid 1000 runner
USER runner
WORKDIR /home/runner
# Caches and installs of npx/uvx go to the home directory (a tmpfs when the container runs).
ENV HOME=/home/runner
CMD ["sh"]
