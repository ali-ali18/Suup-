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
| `outbound` (opcional) | `{ kind: "message", recipientFields: ["to", ...] }`: a chamada **envia uma mensagem a outra pessoa** (e-mail e afins) e os destinatários estão nesses campos dos argumentos. Veja "Mensagens a outras pessoas" |

Uma ferramenta que não declara nada, ou declara um nível que não existe, vale `external_irreversible`: o lado seguro é o que pergunta.

### Os níveis das ferramentas embutidas

| Ferramenta | Nível | Por quê |
|---|---|---|
| `read_file`, `list_files`, `search_files`, `recall`, `search_conversations` | `read` | Só observam |
| `web_fetch` | `read` | Sempre GET. Com um segredo nos argumentos (cabeçalho, URL) sobe para `external_irreversible` |
| `write_file`, `edit_file`, `remember`, `forget` | `write_reversible` | Mudam a pasta do próprio bot ou a memória, e dá para desfazer |
| `shell` | `write_reversible` **na máquina isolada** (Docker); `external_irreversible` na máquina `local` | Veja abaixo |
| `request_network_access` | `external_irreversible` (fixo) | Pede ao usuário que a máquina alcance **um host** (nome exato). Sempre é cartão, com o host e o motivo; aprovar libera o host só para a execução. Veja [REDE.md](REDE.md) |

| `conn_<conector>__<ferramenta>` (conectores MCP) | `external_irreversible`, a não ser que **você** a marque como leitura (ou confie nas dicas do servidor) | O servidor é um programa externo e o que ele diz de si (`readOnlyHint`...) é só uma dica: ela pode apertar o nível, nunca afrouxar. Veja [CONECTORES.md](CONECTORES.md) |

**Por que o `shell` é assim.** Um comando de shell pode fazer qualquer coisa, e nenhuma análise do texto do comando serve de segurança (`curl -X POST`, `git push`, `rm -rf`, um script que faz tudo isso): por isso **não há heurística sobre o comando**. O que decide é *onde ele roda*. Na máquina dos bots (contêiner descartável, `sandbox.kind: "docker"`), um comando só muda uma máquina que pode ser jogada fora: `write_reversible`. Na máquina `local` (os comandos rodam direto no seu computador, sem isolamento) cada comando pergunta. Duas ressalvas honestas: a máquina Docker **não tem rede própria**: tudo sai por um proxy do harness, só para hosts de uma lista de nomes exatos ([REDE.md](REDE.md)), então um comando não pode falar com um servidor qualquer; um host **novo** é recusado e o bot pede a liberação pela ferramenta `request_network_access`, que **sempre vira cartão** com o host exato (aprovar libera aquele host só para a execução). Um host que já está na lista continua sendo um canal de saída (REDE.md, "Modelo de ameaça"). E um comando com um marcador de segredo (`{{secret:NOME}}`) é sempre `external_irreversible`, pois um segredo existe para provar quem você é a outra parte. Quem quer o rigor total muda o nível da ferramenta (`approvals.levels`, abaixo) ou cria uma regra que proíbe.

## Os três filtros, em ordem

**Precedência (dita por inteiro).** Uma regra de **negar** vence **sempre**, mesmo contra uma de permitir mais específica; depois vem o revisor; uma regra de **permitir** só existe por um **ato explícito do usuário** (Configurações > Permissões, `suup rules add`, ou "Permitir destinatário" no cartão de uma mensagem a outra pessoa). Uma regra de permitir só libera o que ela descreve por inteiro (ferramenta, bot e igualdade exata dos campos nomeados). Nada que o modelo, uma ferramenta, um conector ou uma mensagem digam cria ou amplia uma regra. A decisão é gravada uma vez no log e nunca refeita.

A decisão é uma função pura (`decidePolicy`, em `core`), testada sozinha: dadas as regras e o veredito do revisor, devolve `allow`, `deny` ou `ask`.

1. **Regras do usuário** (tabela `approval_rules`). Valem para um bot ou para todos, para uma ferramenta (ou `*`) e, opcionalmente, com condições sobre os argumentos: cada uma diz que um campo nomeado é **exatamente igual** a um valor (todas precisam valer). **Não existe outra comparação**: nada de "começa com", "contém", glob ou regex; o que roda sem perguntar é só o que o usuário escreveu por inteiro. **Uma regra sem condições vale para QUALQUER uso da ferramenta** (escolha explícita do usuário, e as telas dizem isso com todas as letras). **Quem proíbe vale mais que quem libera**; entre regras do mesmo efeito, a do bot vem antes da global. Uma regra pode liberar até uma ação irreversível ("pode fazer push neste repositório"). As condições olham os argumentos como o modelo os escreveu (um segredo aparece como `{{secret:NOME}}`, nunca como valor).
2. **Revisão automática.** Hoje é só a interface (`AutoReviewer`) e um padrão determinístico que apenas traduz o nível (`read` e `write_reversible` são seguros; `external_irreversible` é sensível). **Nenhuma chamada a modelo é feita.** O revisor só pode apertar, nunca afrouxar: um "seguro" dele não deixa passar uma ação irreversível; só uma regra sua faz isso. Um revisor que falha, ou que não dá um veredito válido, conta como "sensível" (pergunta ao usuário, nunca permite). Veja a regra do revisor por modelo logo abaixo.
3. **Cartão.** O que sobrou e é sensível espera você.

Sem regra nenhuma: leitura e escrita reversível executam (a escrita fica registrada num evento `policy_checked`); o resto vira cartão.

`approvals.levels` na configuração fixa o nível de uma ferramenta por cima do que ela declara (`{ "shell": "external_irreversible" }` faz todo comando perguntar, mesmo na máquina isolada).

### Revisor automático por modelo: o contrato (a regra, antes de existir)

Pesquisa: [aprovações, cofre e conectores](pesquisas/fase-3-aprovacoes-cofre-conectores.md) (o modo automático do Claude Code e o guardrail paralelo do Agents SDK). Quando um revisor que **usa um modelo** for implementado, atrás da mesma interface `AutoReviewer`, ele deve:

1. **Nunca receber o RESULTADO de uma ferramenta**: só o pedido do usuário e a chamada proposta (`ReviewCall`, que não tem campo para resultado e não pode ganhar um). É nos resultados que a injeção chega; um revisor que os lê pode ser convencido a aprovar.
2. Ser **síncrono e bloqueante**: o veredito é esperado **antes** de qualquer execução. Um revisor em paralelo com a ação (que pode disparar depois que a ferramenta já rodou) não é permitido.
3. Tratar **erro, tempo esgotado ou veredito ausente/desconhecido como "perguntar ao usuário"**, nunca como permitir. O portão já faz isso hoje (`packages/core/src/approvals/gate.ts`).
4. Só **apertar** o nível, nunca afrouxar.

Há testes do contrato no portão (`reviewer-contract.test.ts`). Que o revisor `finish` (conferência da conclusão) lê resultados é outra coisa: é uma conferência de evidências, não uma decisão de permissão.

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
- **Nada de "sempre permitir" num cartão comum.** Um cartão de ação comum só se aprova ou se recusa. Regras permanentes nascem de um **ato explícito do usuário**: Configurações > Permissões, ou `suup rules add`. A única exceção é o cartão de **mensagem a outra pessoa** (abaixo), cujo menu tem "Permitir destinatário".
- **Mensagens a outras pessoas.** Uma chamada é uma mensagem a outra pessoa **só por declaração**, nunca por palpite sobre o nome ou o texto da ferramenta: (1) a ferramenta declara `outbound` (nenhuma embutida declara hoje); (2) para uma ferramenta de **conector**, o **usuário** marca a ferramenta como "envia mensagem para outra pessoa" e diz em qual campo dos argumentos está o destinatário (`suup connectors set-outbound <conector> <ferramenta> --to campo`, ou a tela do conector); nenhuma dica do servidor faz isso. A declaração entra no evento `approval_requested`, na linha de `approvals` (`outbound`) e na API (`Approval.outbound`). Uma ferramenta assim **nunca é `read`**: sempre pergunta, a não ser por uma regra. O cartão dela tem "Descartar" e o botão dividido "Enviar", cujo menu é "Permitir destinatário", "Precisa de aprovação" e "Gerenciar regras". "Permitir destinatário" (`allowRecipient: true` na decisão) cria, na mesma transação, uma regra `allow` **para este bot**, com **exatamente os campos de destinatário iguais aos desta chamada** (os outros campos, assunto e corpo, ficam livres). Se o envio não tem um único destinatário em texto (uma lista, um campo ausente), não dá para fixar o destinatário e a opção é recusada (`409`); aprovar só este envio continua valendo.
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
suup approve <id> [--allow-recipient]        # só para mensagem a outra pessoa
suup deny <id> [--reason "..."]
suup rules list|add|edit|rm                  # a regra: igualdade exata, `--match campo=valor`
suup chat                                    # o cartão aparece no terminal e você responde na hora
```

No `suup chat` interativo o cartão aparece com `Aprovar? [s] sim · [n] não (n <motivo>) · [sempre] · [Enter] decidir depois`. Sem terminal (`--message`) o cartão é impresso com o comando para responder.

## Regras antigas com padrões

A migração 0013 **desativou** (nunca apagou nem ampliou) as regras guardadas com `starts_with`, `contains` ou `glob`: elas deixam de valer, continuam na lista com o motivo (as condições antigas ficam registradas) e `suup doctor` as aponta. Para voltar a usá-las, o usuário troca as condições por valores exatos e reativa (`suup rules edit <id> --match campo=valor --enable`, ou a tela de regras: "Salvar e ativar"); ativar uma regra com condições antigas, ou sem nenhuma condição restante, não é aceito.

## O que ainda não existe

- No app de desktop, o cartão, o formulário seguro e as telas de regras, cofre e conectores **existem** (README do app, seção "Aprovações, cofre e conectores").
- Revisão automática por modelo (só a interface e o contrato acima).
- Rascunho de mensagens para outras pessoas ("tudo que vai para outra pessoa vira rascunho"): os conectores (MCP) já existem ([CONECTORES.md](CONECTORES.md)) e cada ferramenta deles pergunta por padrão, mas o rascunho como etapa própria ainda não.
- Mostrar todos os cartões de um turno de uma vez.
