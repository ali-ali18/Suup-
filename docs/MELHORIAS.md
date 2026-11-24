# Pontos de melhoria

Lista viva do que os testes reais, as avaliações e o uso mostraram que dá para melhorar no Suup. Cada item diz **de onde veio** (a evidência), **o que fazer** e o **estado**. Pedido do dono (23/11/2026): "vai anotando os pontos de melhoria".

Estados: **aberto**, **em andamento**, **feito** (com o commit).

## Motor (loop, prompts, ferramentas)

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| M1 | Uma tarefa com critérios de pronto pode terminar com texto solto, sem `finish` e sem o revisor | Avaliação de 23/11 (conjunto principal): 2 execuções do Haiku (`implement-from-spec`, `prompt-injection-file`) terminaram assim; o resultado estava certo, mas os critérios não passaram pelo revisor | Sem plano, uma execução com critérios que responde só com texto volta com um pedido de `finish` (ou o texto vai ao revisor como um `finish` implícito) | feito (`5dc9726`) |
| M2 | O cache do prompt é reescrito a cada execução | Avaliação de 23/11: cerca de 4 mil tokens reescritos por execução, perto de US$ 0,13 dos US$ 0,30 do Sonnet; no conjunto difícil, a escrita no cache foi 42% do custo do Sonnet e o revisor leu só 54% da entrada do cache; o nome do bot vem no começo do prompt do sistema | Deixar o começo do prompt igual para todos os bots (o que muda, como o nome e a personalidade, vai depois do trecho fixo) | feito (`a2a8b73`) |
| M3 | `plan` quase não é usado | Avaliação de 23/11: em 13 tarefas de vários passos, o Haiku usou em 5 e o Sonnet em 2, apesar do prompt pedir | Rever a instrução no prompt e medir de novo; decidir se o plano vira obrigatório para tarefas com critérios | aberto |
| M5 | O revisor (Haiku) devolve "não verificado" pedindo uma prova que ainda não existe, e o motor passa direto para o dono | Conjunto difícil de 23/11: `big-context-audit` no Haiku (`c34dbaab`); o trabalho estava certo (13/13 checagens) e a execução parou em `waiting_user` | Quando "não verificado" pede uma evidência que ainda não existe, devolver ao bot **uma vez** para ele produzir antes de perguntar ao dono | feito (`bd67f7e`) |
| M6 | `finish` recusado quando vem no mesmo turno que só atualiza o `plan` | Conjunto difícil de 23/11 (`big-context-audit`, Haiku): custou um turno | Aplicar o `plan` primeiro e então avaliar o `finish`, ou aceitar os dois juntos | feito (`af27ff3`) |
| M7 | Um serviço que o bot sobe na própria máquina (`127.0.0.1`) fica fora do alcance dele com o sandbox Docker | Conjunto difícil de 23/11: `curl` e `web_fetch` para `127.0.0.1` dentro do contêiner são recusados pelo proxy | Decidir: liberar o loopback da própria máquina do bot (decisão de segurança) ou manter como está e documentar | aberto (decisão do dono) |
| M8 | Um byte NUL na saída de um comando derruba a execução: "unsupported Unicode escape sequence" (origem `harness`) | Comparação de documentos de 24/11 (`TESTES-REAIS.md`): o bot imprimiu no terminal o fluxo descomprimido de um PDF para conferi-lo e o Postgres recusou gravar o evento `tool_result` (JSONB não aceita `\u0000`) | Trocar o NUL por um caractere de substituição ao gravar o resultado de uma ferramenta (e qualquer texto que vá para o log), sem regex (`split`/`join`); teste com uma saída com NUL | feito (24/11/2026: `withoutNul` no `appendRunEvent`, `packages/db/src/events.ts`, com teste; a segunda rodada de documentos não teve mais o erro) |
| M9 | O arquivo que `create_document` monta fica no servidor: o bot e o revisor não conseguem medi-lo e a execução vira `waiting_user` | Mesma comparação: na ABNT, 2 de 3 execuções com a ferramenta terminaram perguntando ao dono ("não medi margens, fonte e espaçamento"), com o arquivo certo (14/14 checagens) | A ferramenta já abre o arquivo para conferi-lo: devolver ao bot **o que mediu** (páginas, tamanho, margens, corpo da fonte, espaçamento, justificação, fontes embutidas, imagens e legendas) no resultado da chamada, para ele citar como evidência no `finish`; ou gravar uma cópia no workspace para ele abrir | feito (24/11/2026: `send_file` e `create_document` devolvem o que mediram; segunda rodada em `TESTES-REAIS.md`) |
| M10 | A legenda da figura sai "Figura 1: título. Fonte: …"; a ABNT usa "Figura 1 – título" e a fonte numa linha própria | Mesma comparação: o pedido trazia a legenda com travessão e o PDF da ferramenta traz dois-pontos | Trocar o separador por travessão e pôr "Fonte:" em linha própria (pesquisa `ferramenta-de-documento.md`, "ABNT") | feito (24/11/2026: "Figura N – título" e "Fonte: …" na linha seguinte, em PDF e Word; o traço é o "–", como a ABNT e a tarefa de avaliação escrevem) |
| M11 | O bot repete o nome do arquivo no texto mesmo com `send_file` e `create_document` pedindo para não repetir | Mesma comparação: 9 das 11 mensagens finais citam o nome, nos dois modos e nos dois modelos | Decisão do dono: reforçar no prompt, ou deixar o app tratar a duplicata (sem regex: o nome vem da linha da tabela `files`, comparação exata) | aberto (decisão do dono) |
| M12 | Com a conferência na entrega, um bot barato que erra a fonte várias vezes gasta os turnos e o revisor fica sem os dele ("turn limit reached: 30 of 30 model calls used"), e o `finish` vira pergunta ao dono | Segunda rodada de documentos de 24/11 (CHEAP, relatório por código: 3 recusas seguidas, 30 turnos) | A mensagem de recusa agora traz o nome da fonte e uma receita curta (feito, não retestado); decidir se os turnos do revisor saem de uma conta à parte | em andamento |
| M13 | Chegar ao limite de passos (50), repetir a mesma chamada 5 vezes ou ficar 3 turnos sem ferramenta derrubava a execução como `failed` e o trabalho útil se perdia | Pesquisa [vigia-de-progresso.md](pesquisas/vigia-de-progresso.md) (24/11/2026); M12 é um caso | **Feito (24/11/2026):** o vigia de progresso ([VIGIA.md](VIGIA.md)). Decisões do dono: (1) **perguntar em vez de falhar**: cartão "Continuar (+25 passos)" / "Parar por aqui", com a frase amigável e o resumo do que foi feito e falta; "Continuar" dá +25 e reabre a janela; "Parar" termina limpo; (2) **rotina (ninguém olhando)**: para com mensagem amigável no chat, sem perguntar e sem gastar; (3) **sem teto de custo ou tempo por padrão** (`maxCostUsd` e `maxDurationMs` seguem desligados e configuráveis). Sinais estruturais por igualdade exata, juiz barato com esquema (`avanca`/`circulo`/`incerto`), até 2 extensões automáticas, `defaults.watchdog`. **Não verificado:** calibração dos limiares com execuções reais ([TESTES-REAIS.md](TESTES-REAIS.md)) | feito |
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
| A8 | O conjunto de documentos (`doc-*`) tem uma repetição por célula e só PDF e xlsx | Comparação de 24/11 (`TESTES-REAIS.md`): 12 execuções, a mesma tarefa deu `waiting_user` numa passada e `done` na outra | Rodar 3 repetições, acrescentar Word (`docx`) e um caso de imagem; reaproveitar `inspectPdf`/`inspectXlsx` | aberto |
| A9 | Em modo SCRIPT, 3 de 4 PDFs saíram sem fonte embutida (reportlab com a fonte padrão) | Mesma comparação | Decidir se o prompt da máquina ou a imagem do sandbox deve levar uma fonte TTF e a instrução de embuti-la, ou se a ferramenta `create_document` é o caminho único para PDF | feito (24/11/2026, decisão do dono: código livre por padrão; fontes livres e `suup_docs` na imagem, guia curto no prompt e conferência de fonte embutida no `send_file`; 0 de 6 PDFs entregues sem fonte na segunda rodada) |
| A3 | Uma repetição por célula: são pontos, não taxas | Avaliação de 23/11 | Rodar 3 repetições nas tarefas que importam, quando o orçamento deixar | aberto |

## Interface

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| I1 | O app catar sozinho o retorno do login e mandar para a VPS | Revisão "amigável" de 23/11 (CONECTORES.md) | Um ouvinte local no app; exige uma dependência nova no Tauri e pesquisa | aberto |
| I2 | Aviso falso de "sem isolamento" no formulário de conector | Testes da fase 3 | Corrigir a origem do aviso | aberto |

## Interface (pedidos do dono de 24/11)

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| I3 | Menus no estilo do shadcn, nome curto do modelo, separadores do shadcn | Dono, 24/11 | PR #13 | feito (`c1ca95b`, `c028b63`) |
| I4 | Arquivo aparece duas vezes; pergunta sem título no cartão | Dono, 24/11 | O bot sabe o que as ferramentas desenham; cartão sempre com título | feito (`ed1cc1d`, `13ca1e7`) |
| I5 | O X do cartão de pergunta trava as opções e mostra "Não respondido" | Dono, 24/11 | Em `feat/arquivos-no-chat` | em andamento |
| I6 | Chat só com resultados (sem linhas de passos) e avatar vivo no lugar das bolinhas | Dono, 24/11 | Em `feat/avatar-vivo`; pesquisa `avatar-vivo-no-chat.md` | em andamento |
| I7 | Documento (PDF, Word, Excel) sem Python: ferramenta própria que monta e confere | Dono, 24/11 | Em `feat/ferramenta-documento`; pesquisa `ferramenta-de-documento.md` | em andamento |
| I8 | Imagens montadas no GitHub, a VPS só baixa | Dono, 24/11 | PR #15 | feito (`d4be66a`) |

## Memória

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| Me1 | Memória duplicada quando a consolidação roda com um cartão pendente | Testes reais da fase 4 | Reproduzir num teste e corrigir | aberto |

## Busca

| # | Ponto | De onde veio | O que fazer | Estado |
|---|---|---|---|---|
| B1 | "Site fora da lista" quando o problema é endereço não encontrado | Junção da galeria | O motivo real da recusa do proxy | feito (`5adfda2`, veio com o visual novo) |
| B2 | Busca nunca testada com os buscadores de verdade e com o modelo | A rede deste ambiente bloqueia | Testar no PC do dono | aberto |
| B3 | O DuckDuckGo pede captcha em quase toda busca no PC do dono; a busca geral fica fora | Uso do dono, 24/11/2026; pesquisa `docs/pesquisas/fase-4-busca-alternativas-ao-ddg.md` | **Decisões do dono (24/11): tirar o DuckDuckGo e o SearXNG de vez; busca geral numa fila de APIs oficiais, Tavily e depois Brave, trocando sozinha quando a cota de uma acaba (o Firecrawl não entra: o proxy dele contorna bloqueios).** Feito: motores diretos com chave (cofre ou `apiKeyEnv`), ordem configurável, contagem por mês, Configurações > Busca, Brave fora do cache e das avaliações. Falta (dono): criar as contas e pôr as chaves; testar de verdade (B2) | feito (`3709433`) |
| B4 | Uma busca que falha não deixava motivo nos registros | Registro do dono, 24/11/2026 | Linha `web_search:` com o motivo, sem a consulta | feito (`5bb7423`) |
| B5 | Motor de pesquisa profunda (deep research): brief, subtemas, conjunto de fontes, orçamento, citações conferidas | Relatório do dono, 24/11/2026 (`docs/pesquisas/motor-de-pesquisa-deep-research.md`) | Ler as fontes (regra §2), planejar a fase depois da busca plugável (B3) | aberto |
| B6 | WebMCP: sites que oferecem ferramentas para agentes no navegador | Pergunta do dono, 24/11/2026 (`docs/pesquisas/webmcp.md`) | Não é busca. Item futuro: só com suporte no Chromium do Playwright, a API fora do rascunho e um caso concreto; o mínimo seguro é ler as ferramentas declaradas sem executar | aberto (futuro) |
| B7 | O Cofre listava `SUUP_OAUTH_NOTION_ACCESS` e `_REFRESH`, tokens internos do conector | Queixa do dono, 24/11/2026 | Coluna `secrets.managed_by` (migração 0032, nome exato do conector): fora da lista, da pesquisa e das concessões; concedê-los é recusado pela API; desconectar ou remover o conector os apaga. Docs: COFRE, CONECTORES, API, DESIGN | feito |
| B8 | Configurações > Conectores listava o conector cru (interruptor, "Abrir", "Servidor HTTP · 69 ferramentas", nome em minúsculas); Tavily e Brave só existiam em Busca | Uso do dono, 24/11/2026 (referência de inspiração) | **Decisão do dono: Conectores vira "Instalado" (grade de duas colunas, só instalados, ícone e nome do catálogo, estado à direita); tudo de um plugin vai para a página dele; Tavily e Brave são plugins em "Pesquisa na web"; Busca vira ponteiro.** Feito, com testes e capturas (`apps/desktop/screenshots/plugins-antes-depois/`) | feito |
| B9 | Composio ligado à mão ficava "ainda não listado" e "nenhum bot"; o bot mandava o dono procurar nas Configurações e colava o link de conectar numa mensagem | Uso do dono, 24/11/2026 | Ligar lista as ferramentas na hora; a página diz os dois estados e age; o aprovado de um bot é concedido a ele; `propose_connector` não repete o já instalado; `show_connect_card` entrega o link só como cartão, com o host conferido; `deniedTools` do Composio; regra `HAND_OVER_RULE`. Falta: listar os apps ligados dentro do Composio (não há endpoint) e conferir a pesquisa `composio-mcp.md` | feito (exceto o que falta) |
