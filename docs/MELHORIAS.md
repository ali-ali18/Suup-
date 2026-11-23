# Pontos de melhoria

Lista viva do que os testes reais, as avaliações e o uso mostraram que dá para melhorar no Suup. Cada item diz **de onde veio** (a evidência), **o que fazer** e o **estado**. Pedido do dono (23/11/2026): "vai anotando os pontos de melhoria".

Estados: **aberto**, **em andamento**, **feito** (com o commit).

## Motor (loop, prompts, ferramentas)

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| M1 | Uma tarefa com critérios de pronto pode terminar com texto solto, sem `finish` e sem o revisor | Avaliação de 23/11 (conjunto principal): 2 execuções do Haiku (`implement-from-spec`, `prompt-injection-file`) terminaram assim; o resultado estava certo, mas os critérios não passaram pelo revisor | Sem plano, uma execução com critérios que responde só com texto volta com um pedido de `finish` (ou o texto vai ao revisor como um `finish` implícito) | aberto |
| M2 | O cache do prompt é reescrito a cada execução | Avaliação de 23/11: cerca de 4 mil tokens reescritos por execução, perto de US$ 0,13 dos US$ 0,30 do Sonnet; o nome do bot vem no começo do prompt do sistema | Deixar o começo do prompt igual para todos os bots (o que muda, como o nome e a personalidade, vai depois do trecho fixo) | aberto |
| M3 | `plan` quase não é usado | Avaliação de 23/11: em 13 tarefas de vários passos, o Haiku usou em 5 e o Sonnet em 2, apesar do prompt pedir | Rever a instrução no prompt e medir de novo; decidir se o plano vira obrigatório para tarefas com critérios | aberto |
| M4 | As definições das ferramentas pesam cerca de 9 mil tokens por pedido | Testes reais da fase 4 (TESTES-REAIS.md) | Enxugar descrições, adiar ferramentas raras para a busca de ferramentas | aberto |

## Avaliação

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| A1 | O conjunto principal não separa mais os modelos (14/14 nos dois) | Avaliação de 23/11 | Usar o conjunto difícil como referência e criar tarefas novas mais longas | aberto |
| A2 | O relatório marca ✓ uma execução que terminou sem `finish` | Avaliação de 23/11 | Mostrar no relatório se `plan` e `finish` foram usados | aberto |
| A3 | Uma repetição por célula: são pontos, não taxas | Avaliação de 23/11 | Rodar 3 repetições nas tarefas que importam, quando o orçamento deixar | aberto |

## Interface

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| I1 | O app catar sozinho o retorno do login e mandar para a VPS | Revisão "amigável" de 23/11 (CONECTORES.md) | Um ouvinte local no app; exige uma dependência nova no Tauri e pesquisa | aberto |
| I2 | Aviso falso de "sem isolamento" no formulário de conector | Testes da fase 3 | Corrigir a origem do aviso | aberto |

## Memória

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| Me1 | Memória duplicada quando a consolidação roda com um cartão pendente | Testes reais da fase 4 | Reproduzir num teste e corrigir | aberto |

## Busca

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| B1 | "Site fora da lista" quando o problema é endereço não encontrado | Junção da galeria | O motivo real da recusa do proxy | feito (`5adfda2`, veio com o visual novo) |
| B2 | Busca nunca testada com os buscadores de verdade e com o modelo | A rede deste ambiente bloqueia | Testar no PC do dono | aberto |
