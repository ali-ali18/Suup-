#!/bin/sh
# Constrói (ou atualiza) as imagens dos bots dentro do Docker isolado do Suup e sai.
# Roda como o serviço `images` do docker-compose.dokploy.yml, a cada implantação; com o cache do BuildKit
# guardado no volume do Docker isolado, uma implantação sem mudança nas receitas leva segundos.
#
#   DOCKER_HOST         o socket do Docker isolado (o compose define; nunca o do host)
#   SUUP_IMAGES         quais construir, separadas por espaço (padrão: todas)
#   SUUP_READER_BROWSER 0 = leitor sem o Chromium (imagem pequena; `render` fica indisponível)
#   SUUP_BUILD_PROXY / SUUP_BUILD_CA  só numa rede que intercepta o HTTPS (docs/IMPLANTACAO.md,
#                       "Construir atrás de um proxy"): o proxy e a CA valem SÓ durante o build.
set -eu

: "${DOCKER_HOST:?defina DOCKER_HOST (o socket do Docker isolado)}"
SRC=/src
IMAGES="${SUUP_IMAGES:-sandbox connector-runner reader searxng}"
SEARXNG_IMAGE=docker.io/searxng/searxng:2026.3.25-541c6c3cb

echo "suup-images: esperando o Docker isolado ($DOCKER_HOST)..."
tries=0
until docker version >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 90 ]; then
    echo "suup-images: o Docker isolado não respondeu em 3 minutos" >&2
    exit 1
  fi
  sleep 2
done
docker version --format 'suup-images: Docker isolado {{.Server.Version}}'

build() {
  # $1 = tag, $2 = contexto, o resto = argumentos extras de `docker build`
  tag="$1"; ctx="$2"; shift 2
  if [ -n "${SUUP_BUILD_PROXY:-}" ]; then
    set -- "$@" --build-arg "HTTPS_PROXY=$SUUP_BUILD_PROXY" --build-arg APT_HTTPS=1
  fi
  if [ -n "${SUUP_BUILD_CA:-}" ]; then
    set -- "$@" --secret "id=build_ca,src=$SUUP_BUILD_CA"
  fi
  echo "suup-images: construindo $tag"
  docker build --progress=plain --tag "$tag" "$@" "$ctx"
}

for image in $IMAGES; do
  case "$image" in
    sandbox)
      build suup-sandbox:prod "$SRC/docker/sandbox" ;;
    connector-runner)
      build suup-connector-runner:prod "$SRC/docker/connector-runner" ;;
    reader)
      if [ "${SUUP_READER_BROWSER:-1}" = "0" ]; then
        build suup-reader:prod "$SRC" -f "$SRC/docker/reader/Dockerfile" \
          --build-arg PLAYWRIGHT_IMAGE=node:22-bookworm-slim --build-arg RUN_USER=node
      else
        build suup-reader:prod "$SRC" -f "$SRC/docker/reader/Dockerfile"
      fi ;;
    searxng)
      echo "suup-images: baixando $SEARXNG_IMAGE"
      docker pull --quiet "$SEARXNG_IMAGE" ;;
    *)
      echo "suup-images: imagem desconhecida em SUUP_IMAGES: $image (use sandbox, connector-runner, reader, searxng)" >&2
      exit 1 ;;
  esac
done

echo "suup-images: pronto"
docker image ls --format 'suup-images:   {{.Repository}}:{{.Tag}}  {{.Size}}'
