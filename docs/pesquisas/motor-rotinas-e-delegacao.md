# Motor de rotinas e delegação: o que o bot vê e o que a ferramenta diz

Data: 24/11/2026. Base das correções M14 a M19 de [MELHORIAS.md](../MELHORIAS.md). Não depende de prática externa: tudo vem do código desta árvore (`packages/core/src/loop/prompts.ts`, `packages/runtime/src/{runtime,routines,supervisor}.ts`, `packages/db/src/routines.ts`) e dos relatos de uso do dono, escritos aqui como pedidos genéricos. Nenhuma fonte externa foi usada; onde houver uma prática de terceiros (por exemplo, documentação de prompts da Anthropic), ela entra numa pesquisa própria antes de virar regra (`docs/REGRAS.md` §2).

## Como o bot enxerga o mundo a cada execução

A execução de conversa recebe: o prompt do sistema (parte estável idêntica para todos os bots, depois a parte da execução), o histórico **só em texto** (sem as chamadas de ferramenta e seus resultados) e o lembrete de estado no fim do último turno do usuário. Tudo que o bot sabe sobre o estado atual vem do bloco da execução (`## Now`, `## Your team`, `## What you have`, `## Your routines`). O que não está ali e não está no texto do histórico não existe para ele.

## Causas, uma por uma

| Item | Causa na árvore | Correção |
|---|---|---|
| M14 | `deleteRoutine` apagava a linha e não deixava nada; `ownRoutinesFor` listava só o que existe. Uma rotina apagada pelo dono sumia do contexto, mas continuava no histórico em texto como "criei a rotina X": o bot via a frase sem prova e concluía que a criação falhara. | Tabela `routine_events` (migração 0033): lápide de cada apagar, mudar, pausar e retomar, com o autor (`owner`, `bot`, `system`). O contexto traz "Recent changes" (14 dias, até 10), lido junto com a lista e gravado em `context_loaded.ownRoutines`. |
| M15 | Um lembrete de uma vez é apagado depois de disparar; o histórico mantém a mensagem "vou te lembrar de X dia 29", e nada diz que já foi cumprido. | A lápide `fired` (autor `system`) entra em "Recent changes" com "ALREADY WENT OFF ... DONE, not pending"; o prompt diz que só o que está em "Your routines" é pendente e que o passado só se menciona quando serve ao pedido. |
| M16 | O relógio estava certo (`formatClock` usa `Intl` com o fuso do usuário; testado em torno da meia-noite). Mas o prompt dava **um** dia da semana, e qualquer outra data ("dia 29", "sexta") era calculada de cabeça pelo modelo; mensagens antigas do histórico não têm data e o "hoje" delas é de outro dia. | `formatCalendar`: ontem, hoje, amanhã e os 7 dias seguintes, cada um com o dia da semana calculado em código, no fuso do usuário; regra "nunca calcule o dia da semana, leia do calendário" e aviso sobre o "hoje" do histórico. Com o fuso desconhecido o relógio é UTC e o prompt já diz isso. |
| M17 | `ROUTINES_HOW` cobria "todo dia" e "toda segunda", não o pedido misto "faça agora e, a partir de amanhã, faça assim". O modelo respondia a parte de agora e "confirmava a regra" em texto. | Instrução: um pedido que implica "daqui para a frente" é um pedido de rotina; faça a parte de agora **e** crie a rotina no mesmo turno; diga o horário escolhido; confirmar em palavras sem criar é falha. A descrição de `create_routine` repete. Sem classificar o texto do dono: o modelo decide, e o cartão da rotina continua sendo o portão. |
| M18 | `SUPERVISOR_PROMPT` mandava delegar só "quando o usuário pede" ("diga ao Tutor para...") e terminava com "a maior parte do que o usuário pede é trabalho seu". E a execução delegada **não recebia as ferramentas de rotina** (só execuções `user`), então delegar a um bot de rotinas não adiantaria: ele não poderia criá-las. | O Principal delega também quando a descrição de um bot do time cobre o pedido (a lista com nomes e descrições já estava no contexto, até 200 caracteres por bot); rotina e lembrete são criados pelo bot que os executa. A execução `delegation` passa a receber as ferramentas de rotina e a lista "Your routines", com o mesmo portão de aprovação. Combinação por descrição, pelo modelo: nenhuma regra por nome. |
| M19 | Nada no prompt dizia de quem é o quê; um conector com terminal remoto parecia uma máquina. | Uma frase na linha dos conectores ("Connectors are only for reaching the user's apps ... Scheduling, routines, reminders and running code are Suup's own") e na instrução de rotinas; a descrição de `create_routine` diz que agendar é do Suup. A negação por padrão do terminal remoto do Composio é da frente de conectores (campo `deniedTools` do catálogo), fora deste trabalho. |

## Decisões

- **Lápide em tabela própria**, sem chave estrangeira para a rotina, com cascata só pelo bot. Escolhida em vez de "marcar a rotina como apagada": a lista da API e do painel, os limites de 30 e a duplicata continuam lendo só linhas vivas.
- **Quem apaga é o parâmetro `actor`**, obrigatório em `deleteRoutine` e `updateRoutine`: nenhum chamador novo esquece de dizer quem foi.
- **O contexto é um fato, não uma ordem**: "o usuário apagou X em tal dia; não recrie a menos que peça". A decisão continua do modelo.
- **Sem texto interpretado**: tudo acima é dado estruturado (tipo do evento, autor, nome, data) ou comparação exata. Os textos que o modelo lê são fixos do harness.
- **A parte estável do prompt segue igual para todos os bots**: as mudanças de `ROUTINES_HOW` valem para qualquer bot com ferramentas de rotina; calendário, equipe, "Recent changes" e a frase dos conectores estão na parte da execução.

## O que não está resolvido

- O histórico continua só em texto. A lápide cobre rotinas e lembretes; outras ações do dono sobre coisas do bot (apagar um arquivo, mudar uma configuração) seguem sem aviso.
- Um lembrete que falhou ao disparar não gera lápide `fired` (o resultado vai como mensagem do sistema).
- Uma tarefa delegada que cria rotina passa pelo revisor do Auto-review sem mensagem do usuário na execução. Na verificação real (uma repetição) o revisor deixou a criação passar sem cartão; o contrário (um cartão) seria seguro, mas não foi observado. Uma repetição não mostra a taxa.
