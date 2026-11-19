# Rede dos bots: saída por proxy, com lista de hosts

Responde à pesquisa [fase-3-aprovacoes-cofre-conectores.md](pesquisas/fase-3-aprovacoes-cofre-conectores.md): o item **High** "shell com rede sem cartão" (a perna de saída do *lethal trifecta*) e o **High** "stdio no host". Aplica-se ao sandbox `docker`. No sandbox `local` não há isolamento nem proxy (só desenvolvimento).

## O que mudou

- **A máquina do bot não tem rede própria.** O contêiner roda numa rede Docker **interna** (`--internal`): sem rota para fora, sem DNS para fora. A única coisa alcançável é o endereço do host nessa rede, onde escuta o proxy.
- **O proxy roda no worker, fora do contêiner.** Só ele fala com a internet. Cada comando do bot (`docker exec`) já nasce com `HTTP_PROXY`/`HTTPS_PROXY` apontando para ele, então `curl`, `npm`, `pip`, `git` por https e o `web_fetch` passam por ele sem o bot fazer nada.
- **O proxy só deixa passar nomes de host da lista.** Comparação por **igualdade exata** do nome normalizado (minúsculas, sem o ponto final). Não há curinga, sufixo nem padrão: `api.exemplo.com` não libera `exemplo.com`, nem `x.api.exemplo.com`.
- **Endereços IP, `localhost` e o endereço de metadados são recusados sempre**, mesmo que alguém os ponha na lista (a lista nem aceita IP). Depois de resolver o nome, o endereço é conferido **numericamente** contra as faixas privadas, de loopback, link-local, metadados, multicast e reservadas (IPv4 e IPv6, inclusive IPv4 embutido em IPv6); se **qualquer** resposta cair numa dessas faixas, o nome é recusado. O proxy resolve **uma vez** e conecta ao endereço que validou (contra *DNS rebinding*).
- **Portas:** só 80 e 443 (configurável).
- **Sem segredo no ambiente do contêiner.** O contêiner nasce sem variável nenhuma além das da imagem. Os comandos recebem só as variáveis de proxy (veja "O que o bot enxerga").

## A lista

| De onde | O que é | Quem muda |
|---|---|---|
| Padrões globais | `sandbox.network.defaultHosts` na configuração. Padrão visível: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | o dono, na configuração |
| Por bot | `suup network allow <bot> <host>` / `PUT /v1/bots/:id/network/hosts/:host` | o usuário (ato explícito) |
| Só esta execução | o que um cartão aprovado cria (abaixo); deixa de valer quando a execução termina | o usuário, no cartão |
| Por conector | `egressHosts` do conector (`suup connectors add --egress`, `connectors set-egress`), somado aos padrões | o usuário |

Ver e mexer: `suup network list <bot>`, `suup network allow <bot> <host>`, `suup network rm <bot> <host>` (o bot é um argumento **posicional**, o nome ou o início do id; não existe `--bot` nestes comandos); na API `GET /v1/bots/:id/network` (padrões, hosts do bot, últimas recusas), `PUT` e `DELETE` em `/v1/bots/:id/network/hosts/:host`.

## Host novo: recusa, aviso e cartão

1. O bot roda `curl https://api.novo.com`. O proxy recusa (`403`) e **registra** a recusa (tabela `network_events`, visível em `suup network list <bot>` e na API).
2. O resultado da ferramenta mostra, no fim do `stderr`: `suup: network: host api.novo.com is not allowed for this bot. If the user agrees, ask for it with the request_network_access tool (host api.novo.com).`
3. O bot chama `request_network_access { host, reason }`. É uma chamada comum de ferramenta, de nível `external_irreversible`: **sempre vira cartão** (a execução fica em `waiting_approval`), com o host exato e o motivo. O usuário aprova ou recusa como em qualquer cartão.
4. Aprovado: o host fica liberado **para esta execução** (linha em `network_hosts` com `run_id`, que só vale enquanto a execução não terminou). O bot repete o comando.

**Permitir para sempre (para este bot) não é decisão de cartão:** pela regra do dono (docs/REGRAS.md, seção 3), uma regra permanente só nasce de um ato explícito do usuário, não de um cartão comum. Quem quer o host fixo usa `suup network allow` (ou a tela de rede, quando existir). Se o dono quiser o botão dividido "Permitir para este bot" neste cartão (como o de destinatário), é uma exceção a decidir; o ponto de encaixe é o mesmo da decisão `allowRecipient`.

## Modelo de ameaça, honestamente

O que isto **impede**: um comando (ou um pacote instalado, ou uma página que injetou instruções) falar com um servidor qualquer na internet; falar com a rede interna, o host ou o serviço de metadados; usar a rede sem passar pela lista; ver variáveis do servidor (não existem no contêiner).

O que isto **não impede**:

- **Um host liberado é um canal.** Qualquer coisa que o host aceite pode servir para tirar dado de lá: `registry.npmjs.org` e `pypi.org` aceitam publicar pacotes (com uma conta); `github.com`, se for liberado, aceita gists e commits; um serviço de colar texto é uma saída por definição. A lista reduz a superfície, não a elimina. Por isso o padrão é só os registros de pacotes e todo host novo exige cartão.
- **O proxy não olha dentro do HTTPS.** Ele vê o nome do host do `CONNECT`, não o conteúdo. Um cliente pode, dentro do túnel, pedir outro `Host`/SNI a um CDN que atende vários domínios (*domain fronting*): se o host liberado for um CDN compartilhado, o túnel chega ao CDN, não necessariamente ao site que se imaginava.
- **DNS:** o contêiner não resolve nomes sozinho (testado: `getent hosts` falha), então não há canal de DNS a partir dele. O **proxy** resolve os nomes **liberados** (e só depois de decidir): um nome liberado cujo servidor de nomes seja de um atacante vê a consulta. Nomes não liberados são recusados antes de qualquer consulta.
- **Canais de tempo e volume:** o bot pode codificar dado no *quando* e no *quanto* conversa com um host liberado. Não há limite de volume nem de taxa por host nesta versão.
- **Credencial do proxy no ambiente dos comandos.** Para saber de qual bot é cada conexão, cada comando recebe `HTTP_PROXY=http://bot.<id>:<token>@<proxy>`: o token só abre o proxy, com a lista **daquele bot**, e só é alcançável de dentro da rede interna. Não é um segredo do cofre (o teste de "sem segredo no ambiente" confere isso por nome e por valor), mas aparece em `env`.
- **Os bots compartilham uma máquina.** Todos os bots rodam no mesmo contêiner (um diretório por bot, mesmo usuário). A lista por bot é uma política, **não** uma fronteira entre bots: um bot malicioso que consiga ler o ambiente de outro processo ativo no mesmo contêiner pode usar o token dele. Isolar bots entre si (um contêiner por bot) é trabalho futuro.
- **IPv6 e portas fora de 80/443** não passam; protocolos que não são HTTP(S) (ssh, git://, bancos) não funcionam, de propósito.

## Onde o proxy roda (e por quê)

Duas opções foram pesadas:

- **Dentro do worker (escolhida):** o worker já decide a política (lê o banco), já conhece o bot e já fala com o Docker. O proxy é um servidor `node:http` pequeno escutando no endereço do host na rede interna (o *gateway* da ponte). Vantagens: nenhum contêiner a mais para manter, a lista vem direto do banco, a recusa vira evento na hora. O custo: o proxy compartilha o processo do worker (uma falha no código do proxy é uma falha no worker); por isso o proxy é pequeno, não interpreta o conteúdo e não tem dependências.
- **Contêiner "sidecar" numa rede interna:** isola o proxy do worker, mas precisaria de um canal de controle para a lista e para as recusas (ou acesso ao banco), e de mais uma imagem. Fica como evolução se o proxy crescer.

Em desenvolvimento (worker no host): o proxy escuta no endereço do host na ponte interna (`172.x.0.1`), porta livre. Em produção com Compose (worker em contêiner): o worker entra na rede interna com IP fixo e escuta nele (veja `docs/IMPLANTACAO.md`, "Rede dos bots"). Cada processo (worker, CLI) abre o seu proxy numa porta livre e escreve o endereço certo nos comandos que lança.

## O que o bot enxerga

`env` dentro do contêiner mostra `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (e as minúsculas) com a credencial do proxy, `NO_PROXY` vazio, e as variáveis da imagem (`HOME`, `PATH`, `LANG`...). Nada do servidor: nem `DATABASE_URL`, nem a chave do cofre, nem o token do servidor.

## Conectores stdio

Veja [CONECTORES.md](CONECTORES.md). Com o sandbox `docker`, cada conector stdio roda **num contêiner próprio**, na mesma rede interna, e sai pelo mesmo proxy com a lista **dos padrões + `egressHosts` do conector**. Conector novo que precisa de um host: `suup connectors set-egress <nome> --host api.exemplo.com`. Não há cartão para conector (não há execução para pausar): a recusa fica registrada em `network_events` (sujeito `connector`) e o servidor costuma dizê-la no erro da chamada; ainda não há comando nem tela que liste as recusas de um conector (adiado). Quem libera é o usuário.

## `suup doctor`

Com o sandbox docker o `doctor` confere, **de dentro do contêiner**: (1) que um endereço público sem o proxy (`curl --noproxy '*' http://1.1.1.1/`) **não** responde; (2) que o proxy recusa um host que não está na lista. Falha no primeiro é "PERIGO": a máquina tem saída direta (por exemplo, um contêiner criado antes desta versão; o runtime o recria sozinho ao subir, mantendo o volume). Com o sandbox `local` ele diz que não há proxy. Para cada conector stdio diz **onde ele roda**: em contêiner (isolado) ou no host, sem isolamento.

## Configuração

```json
"sandbox": {
  "kind": "docker",
  "image": "suup-sandbox:dev", "name": "suup-machine", "volume": "suup-workspace",
  "network": {
    "name": "suup-sandbox-net",
    "defaultHosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
    "ports": [80, 443],
    "proxy": { "listenHost": "172.29.77.2", "advertiseHost": "172.29.77.2", "port": 3128 }
  },
  "connectors": { "image": "suup-connector-runner:dev", "memory": "512m", "cpus": 1 }
}
```

Tudo é opcional; sem `network` valem os padrões acima. `defaultHosts: []` não libera nada por padrão. `proxy` só se muda quando o worker não roda no host (veja IMPLANTACAO.md).

## Rede com interceptação de TLS (CA extra, opcional)

Alguns proxies (corporativos, ou o ambiente de um agente) **reassinam o HTTPS** com uma CA própria. O host está na lista e o túnel abre, mas dentro do contêiner o TLS falha ("self-signed certificate in certificate chain"), porque a CA do proxy não está na imagem. Isto **não** se resolve gravando uma CA na imagem (nenhuma CA entra em nenhuma imagem do projeto). Resolve-se por configuração, **desligada por padrão**:

```json
"sandbox": { "kind": "docker", "...": "...", "extraCaBundle": "/etc/ssl/certs/ca-da-empresa.pem" }
```

- `extraCaBundle` é o caminho **absoluto**, no computador do worker, de um arquivo PEM. Sem o campo, nada é montado e nenhuma variável é definida.
- Com ele, a máquina dos bots **e** cada contêiner de conector recebem o arquivo **somente leitura** em `/etc/suup/extra-ca.pem` (`--mount ...,readonly`: o bot não consegue alterá-lo) e as variáveis `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` e `GIT_SSL_CAINFO` apontando para ele. Uma variável que o próprio conector declara vale mais que estas.
- **Cuidado:** `NODE_EXTRA_CA_CERTS` **soma** à lista do sistema, mas as outras quatro **substituem** a lista daquele programa. Numa rede em que todo HTTPS é reassinado, a CA do proxy basta; para manter também as do sistema, coloque as duas no mesmo arquivo (a CA do proxy mais o conteúdo de `/etc/ssl/certs/ca-certificates.crt`).
- A CA só **confia**: não libera nenhum host. A lista de hosts continua sendo a única coisa que decide o que é alcançável, e a confiança numa CA de interceptação significa que o proxy dessa rede pode ler o tráfego dos bots. Use só onde isso já é assim.
- Mudar o valor (ou tirá-lo) **recria a máquina** dos bots na próxima execução (o volume do workspace é mantido; o rótulo `suup.extra-ca` do contêiner guarda o caminho usado). O arquivo é montado, não copiado: trocar o conteúdo vale na hora.
- Caminho que não existe, não é arquivo ou tem vírgula: o runtime recusa ao preparar a máquina, com a mensagem dizendo qual.
- Teste: `packages/sandbox/test/extra-ca.test.ts` (a parte de Docker roda com `SUUP_DOCKER_TESTS=1 SUUP_SANDBOX_IMAGE=... SUUP_CONNECTOR_IMAGE=...`).

## O que o app de desktop vai precisar

O app desenha (seção "Rede" na edição do bot, `runsIn` e hosts dos conectores, o cartão de acesso à rede): veja a seção "Rede dos bots" de [FRONTEND.md](FRONTEND.md) e [DESIGN.md](DESIGN.md) §3b. O servidor não declara se o sandbox é o local; o app deduz pela ferramenta `request_network_access` em `GET /v1/tools`.

## Não verificado / adiado

- O caminho de produção com o worker em contêiner (Compose, IP fixo na rede interna) foi escrito e validado só com `docker compose config`; a ponta a ponta com Docker dentro de Docker não foi exercida.
- Limite de volume/taxa por host, um contêiner por bot, e inspeção de SNI/Host dentro do túnel não existem.
- O botão "Permitir para este bot" no cartão (decisão do dono).
