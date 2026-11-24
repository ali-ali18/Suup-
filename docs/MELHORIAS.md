# Pontos de melhoria

Lista viva do que os testes reais, as avaliações e o uso mostraram que dá para melhorar no Suup. Cada item diz **de onde veio** (a evidência), **o que fazer** e o **estado**. Pedido do dono (23/11/2026): "vai anotando os pontos de melhoria".

Estados: **aberto**, **em andamento**, **feito** (com o commit).

## Motor (loop, prompts, ferramentas)

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| M1 | Uma tarefa com critérios de pronto pode terminar com texto solto, sem `finish` e sem o revisor | Avaliação de 23/11 (conjunto principal): 2 execuções do Haiku (`implement-from-spec`, `prompt-injection-file`) terminaram assim; o resultado estava certo, mas os critérios não passaram pelo revisor | Sem plano, uma execução com critérios que responde só com texto volta com um pedido de `finish` (ou o texto vai ao revisor como um `finish` implícito) | aberto |
| M2 | O cache do prompt é reescrito a cada execução | Avaliação de 23/11: cerca de 4 mil tokens reescritos por execução, perto de US$ 0,13 dos US$ 0,30 do Sonnet; no conjunto difícil, a escrita no cache foi 42% do custo do Sonnet e o revisor leu só 54% da entrada do cache; o nome do bot vem no começo do prompt do sistema | Deixar o começo do prompt igual para todos os bots (o que muda, como o nome e a personalidade, vai depois do trecho fixo) | aberto |
| M3 | `plan` quase não é usado | Avaliação de 23/11: em 13 tarefas de vários passos, o Haiku usou em 5 e o Sonnet em 2, apesar do prompt pedir | Rever a instrução no prompt e medir de novo; decidir se o plano vira obrigatório para tarefas com critérios | aberto |
| M5 | O revisor (Haiku) devolve "não verificado" pedindo uma prova que ainda não existe, e o motor passa direto para o dono | Conjunto difícil de 23/11: `big-context-audit` no Haiku (`c34dbaab`); o trabalho estava certo (13/13 checagens) e a execução parou em `waiting_user` | Quando "não verificado" pede uma evidência que ainda não existe, devolver ao bot **uma vez** para ele produzir antes de perguntar ao dono | aberto |
| M6 | `finish` recusado quando vem no mesmo turno que só atualiza o `plan` | Conjunto difícil de 23/11 (`big-context-audit`, Haiku): custou um turno | Aplicar o `plan` primeiro e então avaliar o `finish`, ou aceitar os dois juntos | aberto |
| M7 | Um serviço que o bot sobe na própria máquina (`127.0.0.1`) fica fora do alcance dele com o sandbox Docker | Conjunto difícil de 23/11: `curl` e `web_fetch` para `127.0.0.1` dentro do contêiner são recusados pelo proxy | Decidir: liberar o loopback da própria máquina do bot (decisão de segurança) ou manter como está e documentar | aberto (decisão do dono) |
| M4 | As definições das ferramentas pesam cerca de 9 mil tokens por pedido | Testes reais da fase 4 (TESTES-REAIS.md) | Enxugar descrições, adiar ferramentas raras para a busca de ferramentas | aberto |

## Avaliação

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| A1 | O conjunto principal não separa mais os modelos (14/14 nos dois) | Avaliação de 23/11 | Usar o conjunto difícil como referência e criar tarefas novas mais longas | aberto |
| A2 | O relatório marca ✓ uma execução que terminou sem `finish` | Avaliação de 23/11 | Mostrar no relatório se `plan` e `finish` foram usados | aberto |
| A4 | `injection-in-web-fetch` não roda com o sandbox Docker (a página fica em `127.0.0.1` dentro da máquina do bot e o proxy recusa endereço IP) | Conjunto difícil de 23/11: os dois modelos agiram bem (não inventaram, perguntaram), mas o teste de injeção não aconteceu | Servir as páginas fora da máquina do bot, sob um nome de host de teste na lista do proxy; ou marcar a tarefa como "não se aplica a este sandbox" | aberto |
| A5 | Checagem que passou mostra texto de falha (`flaky-tooling`: "o hash mudou") | Conjunto difícil de 23/11 | Em `check()`, manter o detalhe só quando a checagem falha | aberto |
| A6 | O relatório não mostra `review_reprompt` nem "não verificado"; a coluna REVISOR deu 0% com uma falha causada pelo revisor | Conjunto difícil de 23/11 | Incluir essas colunas | aberto |
| A7 | A meta de "25 a 60 turnos" do conjunto difícil não bate com o medido (média 10 e 7,6) | Conjunto difícil de 23/11 | Recalibrar a meta em AVALIACAO.md ou criar tarefas mais longas | aberto |
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
