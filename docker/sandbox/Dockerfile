# Bot machine: the Linux computer the bots work on. See docs/PLANO.md, section 4.7.
#
# Build:  docker build -t suup-sandbox:dev docker/sandbox
FROM debian:12.15-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
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
    && rm -rf /var/lib/apt/lists/*

# Non-root user. /workspace is where the named volume is mounted; creating it here, owned by
# the user, makes a fresh volume inherit that ownership.
RUN useradd --create-home --shell /bin/bash --uid 1000 bot \
    && mkdir -p /workspace \
    && chown bot:bot /workspace

USER bot
WORKDIR /workspace

# The machine only has to stay alive; commands arrive through `docker exec`.
CMD ["sleep", "infinity"]
