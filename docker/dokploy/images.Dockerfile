# syntax=docker/dockerfile:1
#
# Imagem de um uso só, para o docker-compose.dokploy.yml: leva a CLI do docker e as receitas das imagens dos
# bots (as pastas de docker/ e o código que o leitor compila) e, ao rodar, constrói essas imagens DENTRO do
# Docker isolado do Suup (o serviço `docker`), nunca no Docker do host. Veja docs/DEPLOY-DOKPLOY.md.
#
# As receitas vão DENTRO da imagem (COPY) em vez de montadas do repositório: o Dokploy apaga e clona de novo
# a pasta do código a cada implantação, e uma montagem do repositório ficaria vazia (pesquisa
# docs/pesquisas/deploy-vps-dokploy.md, "Arquivos do repositório").
FROM docker:29.10.0-cli
COPY . /src
COPY docker/dokploy/build-images.sh /usr/local/bin/suup-build-images
ENTRYPOINT ["/bin/sh", "/usr/local/bin/suup-build-images"]
