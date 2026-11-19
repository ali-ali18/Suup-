# Bot machine: the Linux computer the bots work on. See docs/PLANO.md, section 4.7.
#
# Build:  docker build -t suup-sandbox:dev docker/sandbox
#
# Behind a TLS-intercepting proxy (see "Building behind a TLS-intercepting proxy" in docs/IMPLANTACAO.md):
# the proxy and its CA exist ONLY while this build runs (predefined proxy build args and a BuildKit
# secret mounted for one RUN); neither is written to a layer or to the final image.
#   docker build --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY --build-arg APT_HTTPS=1 \
#     --secret id=build_ca,src=/path/to/ca-bundle.crt -t suup-sandbox:dev docker/sandbox
# BASE_IMAGE only exists for networks that cannot reach the Debian mirrors; CI and normal builds
# keep the default.
ARG BASE_IMAGE=debian:12.15-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# APT_HTTPS=1 switches the package sources to https (an HTTP(S) proxy that only tunnels CONNECT
# refuses plain-http requests). The build CA (when given) is configured for apt only inside this RUN.
ARG APT_HTTPS=
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -n "$APT_HTTPS" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
        if [ -f "$f" ]; then sed -i 's|http://|https://|g' "$f"; fi; \
      done; \
    fi \
    && if [ -s /run/secrets/build_ca ]; then \
      echo 'Acquire::https::CaInfo "/run/secrets/build_ca";' > /etc/apt/apt.conf.d/99-build-ca; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        findutils \
        git \
        jq \
        procps \
        python3 \
        ripgrep \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-build-ca

# Non-root user. /workspace is where the named volume is mounted; creating it here, owned by
# the user, makes a fresh volume inherit that ownership.
# (Some base images already own uid 1000; free it first. A no-op on Debian.)
RUN if getent passwd 1000 >/dev/null; then userdel --remove "$(getent passwd 1000 | cut -d: -f1)"; fi \
    && useradd --create-home --shell /bin/bash --uid 1000 bot \
    && mkdir -p /workspace \
    && chown bot:bot /workspace

USER bot
WORKDIR /workspace

# The machine only has to stay alive; commands arrive through `docker exec`.
CMD ["sleep", "infinity"]
