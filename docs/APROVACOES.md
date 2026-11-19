# Aprovações

Princípio 5 do plano: **agir exige permissão proporcional ao risco**. Ler é livre; o que sai para o mundo ou não tem volta espera o usuário, com o conteúdo exato diante dos olhos. Este documento descreve como isso funciona hoje (fase 3, parte backend). A API está em [API.md](API.md), o cofre em [COFRE.md](COFRE.md), o que o app vai desenhar em [FRONTEND.md](FRONTEND.md).

## O que cada ferramenta declara

Uma ferramenta **só declara**; quem decide é o harness (a ferramenta nunca importa política, cofre nem banco).

| Declaração | Para quê |
|---|---|
| `risk` | O nível padrão de uma chamada: `read`, `write_reversible` ou `external_irreversible` |
| `classify(args, { executor })` (opcional) | O nível **desta** chamada, a partir dos argumentos (e da máquina onde roda). Se lançar erro, vale `external_irreversible` |
| `describe(args)` (opcional) | A linha do cartão. Padrão: o nome da ferramenta e os argumentos |
| `secretFields` | Os campos que podem receber `{{secret:NOME}}` (veja COFRE.md) |
| `externalOutput` | A saída vem de fora: chega ao modelo rotulada como dado não confiável |

Uma ferramenta que não declara nada, ou declara um nível que não existe, vale `external_irreversible`: o lado seguro é o que pergunta.

### Os níveis das ferramentas embutidas

| Ferramenta | Nível | Por quê |
|---|---|---|
| `read_file`, `list_files`, `search_files`, `recall`, `search_conversations` | `read` | Só observam |
| `web_fetch` | `read` | Sempre GET. Com um segredo nos argumentos (cabeçalho, URL) sobe para `external_irreversible` |
| `write_file`, `edit_file`, `remember`, `forget` | `write_reversible` | Mudam a pasta do próprio bot ou a memória, e dá para desfazer |
| `shell` | `write_reversible` **na máquina isolada** (Docker); `external_irreversible` na máquina `local` | Veja abaixo |

| `conn_<conector>__<ferramenta>` (conectores MCP) | `external_irreversible`, a não ser que **você** a marque como leitura (ou confie nas dicas do servidor) | O servidor é um programa externo e o que ele diz de si (`readOnlyHint`...) é só uma dica: ela pode apertar o nível, nunca afrouxar. Veja [CONECTORES.md](CONECTORES.md) |

**Por que o `shell` é assim.** Um comando de shell pode fazer qualquer coisa, e nenhuma análise do texto do comando serve de segurança (`curl -X POST`, `git push`, `rm -rf`, um script que faz tudo isso): por isso **não há heurística sobre o comando**. O que decide é *onde ele roda*. Na máquina dos bots (contêiner descartável, `sandbox.kind: "docker"`), um comando só muda uma máquina que pode ser jogada fora: `write_reversible`. Na máquina `local` (os comandos rodam direto no seu computador, sem isolamento) cada comando pergunta. Duas ressalvas honestas: a máquina Docker tem rede, então um comando pode, sim, enviar algo para fora sem pedir cartão; e um comando com um marcador de segredo (`{{secret:NOME}}`) é sempre `external_irreversible`, pois um segredo existe para provar quem você é a outra parte. Quem quer o rigor total muda o nível da ferramenta (`approvals.levels`, abaixo) ou cria uma regra que proíbe.

## Os três filtros, em ordem

A decisão é uma função pura (`decidePolicy`, em `core`), testada sozinha: dadas as regras e o veredito do revisor, devolve `allow`, `deny` ou `ask`.

1. **Regras do usuário** (tabela `approval_rules`). Valem para um bot ou para todos, para uma ferramenta (ou `*`) e, opcionalmente, com condições sobre os argumentos (`equals`, `starts_with`, `contains`, `glob` com `*` e `?`; todas precisam valer). **Quem proíbe vale mais que quem libera**; entre regras do mesmo efeito, a do bot vem antes da global. Uma regra pode liberar até uma ação irreversível ("pode fazer push neste repositório"). As condições olham os argumentos como o modelo os escreveu (um segredo aparece como `{{secret:NOME}}`, nunca como valor).
2. **Revisão automática.** Hoje é só a interface (`AutoReviewer`) e um padrão determinístico que apenas traduz o nível (`read` e `write_reversible` são seguros; `external_irreversible` é sensível). **Nenhuma chamada a modelo é feita.** O revisor só pode apertar, nunca afrouxar: um "seguro" dele não deixa passar uma ação irreversível; só uma regra sua faz isso. Um revisor que falha conta como "sensível".
3. **Cartão.** O que sobrou e é sensível espera você.

Sem regra nenhuma: leitura e escrita reversível executam (a escrita fica registrada num evento `policy_checked`); o resto vira cartão.

`approvals.levels` na configuração fixa o nível de uma ferramenta por cima do que ela declara (`{ "shell": "external_irreversible" }` faz todo comando perguntar, mesmo na máquina isolada).

## O ciclo de um cartão

```
modelo pede a chamada
  └─ portão: regras → revisor → cartão
       ├─ allow  → (policy_checked, se não for leitura simples) → executa
       ├─ deny   → policy_checked + resultado "negada" para o modelo (a execução continua)
       └─ ask    → approval_requested ──► status waiting_approval, o worker larga a execução
                                              │
                          você decide (API ou CLI) ─┤  (a decisão vai para a tabela, a execução volta à fila)
                                              ▼
                    o worker retoma: approval_decided entra no log
                       ├─ aprovada → executa EXATAMENTE os argumentos do cartão
                       └─ negada   → o modelo recebe o resultado "o usuário negou" (com o motivo)
```

- **O conteúdo exato.** `approval_requested.args` é o que vai rodar. Depois da aprovação o loop executa esses argumentos, nunca uma versão que o modelo diga de novo. Segredos aparecem como marcador.
- **Negar não derruba a execução.** O modelo recebe um resultado de erro dizendo que o usuário negou (com o motivo, se houver) e que não deve repetir nem contornar; a execução segue. A origem de falha `approval` continua existindo no esquema para um caso futuro, mas negar um cartão não a usa.
- **Aprovar e sempre permitir.** Cria, na mesma transação da decisão, uma regra `allow`: para este bot ou para todos, com as condições "todos os argumentos de texto iguais a estes" (padrão) ou "qualquer chamada desta ferramenta" (`matchers: []`).
- **Mensagens não aprovam nada.** Escrever "sim, pode" no chat não decide o cartão; só a decisão pelo cartão (API ou CLI) decide.
- **Sem prazo escondido.** Um cartão só expira se `approvals.expireAfterMinutes` estiver na configuração (aí ele vira `expired`, o bot é avisado e segue). Sem isso espera para sempre, e o worker não fica preso nele (a execução está em `waiting_approval`).
- **Cancelar a execução cancela os cartões pendentes** (`approval_decided` com `cancelled` no log).

### Várias chamadas no mesmo turno

O modelo pode pedir várias ferramentas numa resposta. A regra adotada:

- **Em ordem, um cartão de cada vez.** As chamadas são tratadas na ordem em que vieram; ao chegar numa que pede cartão, a execução pausa ali. As que vêm depois **não** são tocadas (nem as leituras) até a decisão.
- **Uma negação segura o resto do turno.** Se uma chamada é negada (por você, por uma regra ou pelo revisor), as que ainda não começaram recebem o resultado "não foi executada: uma chamada anterior deste mesmo turno foi negada" e o modelo decide de novo no turno seguinte.

Por quê: as chamadas de um turno saíram da mesma resposta, sem o modelo ter visto o resultado de nenhuma, e podem depender umas das outras (gravar o arquivo, depois enviá-lo). Executar a que vem depois de uma negada "às cegas" aplicaria um lote pela metade. O custo é um turno a mais depois de uma negação, e vários cartões em sequência em vez de todos de uma vez; a vantagem é um estado simples (no máximo um cartão pendente por execução, garantido pelo banco) e nenhum efeito fora de ordem. Mostrar todos os cartões de uma vez é uma melhoria possível, e exigiria decidir o que fazer com as chamadas dependentes.

## Sobrevivendo a quedas e reexecução

O log de eventos continua sendo a verdade:

- `approval_requested` grava o cartão no log e, **na mesma transação**, a linha de `approvals` (id calculado da execução e da chamada: regravar não duplica). Quem decide grava a decisão na tabela; o **loop** a lê, registra `approval_decided` no log e só então marca como entregue (o mesmo desenho da caixa de entrada). Uma queda em qualquer ponto é retomada do log: cada decisão é lida do log e **nunca refeita** (uma regra que mudou nesse meio-tempo não reescreve o que já aconteceu).
- A decisão que chega enquanto a execução ainda está a caminho de pausar não deixa a execução dormir (`requeueIfDecided`).
- O replay (`suup replay`) refaz o loop de verdade com o veredito e a decisão gravados: a mesma gravação dá o mesmo log. Há testes que derrubam o processo depois de cada evento de uma execução com aprovação e conferem que o log final é idêntico e que a ferramenta executa uma vez só.

## Na linha de comando

```
suup approvals [--all] [--bot X] [--show]    # os cartões que esperam você (--show: o conteúdo exato)
suup approve <id> [--always] [--global] [--any-args]
suup deny <id> [--reason "..."]
suup rules list|add|edit|rm
suup chat                                    # o cartão aparece no terminal e você responde na hora
```

No `suup chat` interativo o cartão aparece com `Aprovar? [s] sim · [n] não (n <motivo>) · [sempre] · [Enter] decidir depois`. Sem terminal (`--message`) o cartão é impresso com o comando para responder.

## O que ainda não existe

- O app de desktop não desenha cartões nem a tela de regras (o que ele precisa está em FRONTEND.md, seção 8).
- Revisão automática por modelo (só a interface).
- Rascunho de mensagens para outras pessoas ("tudo que vai para outra pessoa vira rascunho"): os conectores (MCP) já existem ([CONECTORES.md](CONECTORES.md)) e cada ferramenta deles pergunta por padrão, mas o rascunho como etapa própria ainda não.
- Mostrar todos os cartões de um turno de uma vez.
