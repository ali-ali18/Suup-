# O proxy de saída dos bots, na sua própria máquina (docs/REDE.md, "Proxy em contêiner").
# Só leva um arquivo JavaScript (o proxy e o canal de controle, sem dependências). Ele NÃO tem
# banco, lista nem segredo do cofre: a lista de hosts vem do worker pelo canal de controle.
#
# O arquivo `egress.mjs` é gerado (não fica no repositório):
#   pnpm exec tsc -b && node apps/sidecar/scripts/egress-image.mjs docker/egress
#   docker build -t suup-egress:dev docker/egress
# O app de desktop já leva os dois (Dockerfile e egress.mjs) e constrói a imagem na primeira vez.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

COPY egress.mjs /opt/suup-egress/egress.mjs
# O usuário `node` (uid 1000) da imagem; sem shell interativo nem nada a mais.
USER node
EXPOSE 3128 3129
CMD ["node", "/opt/suup-egress/egress.mjs"]
