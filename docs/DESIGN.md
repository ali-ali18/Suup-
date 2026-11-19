# Padrão de design do app de desktop

Este é o padrão **obrigatório** da interface (`apps/desktop`). Quem desenha ou muda tela, cartão ou componente lê isto antes e segue. Quando o dono decidir algo novo, **este arquivo é atualizado no mesmo commit**. Tudo aqui é regra checável; o que um teste consegue conferir está em `apps/desktop/src/design-rules.test.ts`.

Os valores vêm do código (`src/styles/tokens.css`, `src/ui/ui.css`, `src/lib/pane-size.ts`). Onde um número dito pelo dono difere do código, **vale o código alinhado com as referências** e o texto diz isso.

## 1. Princípios

- [ ] Só se desenha o que o backend tem (`docs/FRONTEND.md`). Nada inventado, nenhum botão que não faz nada, nada de "Compartilhar".
- [ ] As referências do dono valem pela **estrutura e proporção**. Nunca copiar marca, arte ou texto distintivo; os textos são nossos, em pt-BR.
- [ ] Escuro neutro "v2", arredondado. O claro é derivado dele (`tokens.css`).
- [ ] Todo comportamento é configurável em Configurações (`src/lib/settings.ts`); a tela lê a configuração, nunca fixa a escolha.
- [ ] Nada de efeito decorativo: sem sombra pesada, sem preenchimento forte, sem pílula vermelha.

## 2. Tokens

- [ ] Nenhuma cor literal fora de `tokens.css` (teste). Raio e tamanho de fonte também vêm de token (o teste só deixa o número de exceções antigas cair).
- [ ] Token novo entra em `tokens.css`, com comentário. Exemplos recentes: `--radius-chip` (8 px), `--size-icon-box` (24 px).
- [ ] Raios: cartão e balão `--radius-card` (24 px), linha `--radius-row` (16 px), interno `--radius-inner` (14 px), pílula `--radius-pill`.
- [ ] Largura de leitura `--width-reading` (700 px): cartões e balões do bot nunca passam disto.

## 3. Cartões no chat

Todo cartão do chat (aprovação, segredo, ação do bot, pergunta, "precisa de você") usa a mesma moldura e a mesma linha recolhida. Componentes: `ui/decision-card.tsx` (cartão que espera você), `ui/action-card.tsx` (linha recolhida e a variante "precisa de você"). Cartão novo **não** inventa moldura: usa um dos dois (teste).

**Moldura**
- [ ] Borda de 1 px `--color-border`, fundo `--color-surface` liso, raio 24 px, largura até a de leitura. Padding de 20 px.
- [ ] Sem preenchimento forte e sem cor de alerta no cartão.

**Cabeçalho**
- [ ] Ícone pequeno (14 px) num quadrado arredondado de 24 px (`--size-icon-box`, `--radius-chip`, fundo `--color-raised`) e o rótulo curto da categoria em negrito: "Arquivo", "Terminal", "Web", "Memória", o nome do conector, "Mensagem" (uma chamada que **declara** ser mensagem a outra pessoa; nunca deduzido do nome da ferramenta), "Segredos"; sem categoria, "Ferramenta" (`toolCategory`). **Um só vocabulário**: o mesmo rótulo e o mesmo ícone para uma ferramenta, seja cartão que espera você, aprovação decidida ou linha do que o bot fez; vem sempre de `toolCategory` (`data/approval-text.ts`) e do ícone dela (`ui/category-icon.tsx`). Nenhuma tela tem tabela própria ("Arquivo" num lugar e "Arquivos" noutro é erro).
- [ ] O nível de risco é texto apagado à direita, com prefixo "Risco:" só para leitor de tela. Nunca pílula colorida.

**Corpo**
- [ ] Título em negrito, uma frase humana do que vai acontecer, **em pt-BR** (`approvalTitle`; o resumo do servidor, que pode vir em inglês, só entra como reserva).
- [ ] **Um** parágrafo leve e apagado (quem pede e por quê). Mais de um parágrafo é erro.
- [ ] O conteúdo exato vem em linhas calmas separadas por fios de 1 px: rótulo à esquerda, valor depois; monoespaçado só para o que é código (comando, script, consulta, várias linhas); texto longo recolhido com "Mostrar tudo". O conteúdo exato é sempre inspecionável, porque é uma garantia de segurança; segredo aparece só como cadeado + NOME.

**Rodapé**
- [ ] À direita: ação secundária como **texto simples** ("Recusar", "Descartar", "Agora não") e a primária em **pílula** branca. Recusar é **um clique**, sem campo de motivo (a API ainda aceita um motivo; o cartão não o envia).
- [ ] **Regra do dono: ação comum = aprovar ou recusar.** O cartão de uma ação normal (arquivos, terminal, memória, web, ferramentas de conector: tudo o que não é mensagem a outra pessoa) tem **só** o texto "Recusar" e a pílula "Aprovar". **Sem botão dividido, sem seta, sem menu, sem "sempre permitir"**. Regra permanente nunca sai do cartão comum: só de um ato explícito do usuário (Configurações > Aprovações, ou `suup rules`). Nada de configuração "escopo do sempre permitir".
- [ ] **O botão dividido existe só para mensagem a outra pessoa** (e-mail e afins): o cartão cujo `approval.outbound` (a declaração da ferramenta, ou a marca que o **usuário** pôs na ferramenta do conector) existe. Os botões leem "Descartar" e "Enviar"; o menu da seta é sobre o destinatário: "Permitir destinatário" (cria uma regra liberando exatamente este destinatário, neste bot; indisponível se o envio não tem um único destinatário em texto), "Precisa de aprovação" (marcado; desmarcar faz "Enviar" também permitir o destinatário, e o cartão diz qual regra) e "Gerenciar regras". O app **nunca adivinha** que algo é mensagem pelo nome ou pelo texto da ferramenta. `design-rules.test.ts` confere que o botão dividido só é desenhado pelo rodapé de mensagem.
- [ ] O menu da seta do botão dividido (só no cartão de mensagem) é `ui/menu.tsx` (teclado: setas, Home/End, Esc devolve o foco; o foco nos itens usa `preventScroll`, porque rolar o chat fecha o menu). Cada item tem título e descrição apagada de uma linha: "Permitir destinatário", "Precisa de aprovação" e "Gerenciar regras" (abre Configurações > Aprovações).
- [ ] À esquerda, quando houver, uma linha discreta: garantia (segredo: "Guardado no cofre; o bot nunca vê o valor."), prazo, erro, ou a regra que será criada.
- [ ] Durante o envio os botões ficam desligados com um pequeno giro e o rótulo ("Aprovando…"); a largura não muda. Nada é otimista: o cartão só muda quando o servidor responde.

**Segredo** (`secret-request-card.tsx`): cabeçalho "Segredos"; título e um parágrafo com o motivo dado **pelo bot** ("Motivo dado pelo bot: …"); o NOME como rótulo do campo; o campo seguro (sem estado, sem autocompletar, olho desligado, limpo antes de enviar); "Enviar" só liga com algo digitado (o cartão guarda só um booleano de "vazio", nunca o texto).

**Estado resolvido (todo cartão)**
- [ ] Cai para **uma linha**: ícone em quadrado + rótulo em negrito + resultado apagado ("Aprovado e concluído · Escrever a.txt", "Recusado · Escrever a.txt", "Expirou", "Cancelado", "Segredo NOME disponível"). No chat, a aprovação decidida **não** é uma linha à parte: é a linha da chamada (ver acima); a linha só da aprovação existe no histórico de Configurações > Aprovações. Sem botões.
- [ ] O affordance de expandir é o par de **setas empilhadas** (`ChevronsUpDown`, recolhido; `ChevronsDownUp`, aberto), nunca uma seta simples; vale para toda linha recolhida de cartão (`ui/action-card.tsx`, inclusive "Mais N ações").
- [ ] A seta de expandir só aparece em hover ou foco do teclado (e continua anunciada por `aria-expanded`). Clicar expande, no lugar, o que foi executado; clicar de novo recolhe. A linha sem detalhes não é botão.

**Uma linha por chamada de ferramenta**
- [ ] Cada chamada de ferramenta aparece **uma única vez** no chat. Quando ela teve aprovação, a aprovação **entra na linha da chamada** (`mergeApprovals`, `data/actions.ts`); nunca há uma linha para o pedido e outra para a ação.
- [ ] O vínculo vem dos dados: o `callId` (e a execução) que a aprovação carrega e os eventos trazem, nunca comparação de texto.
- [ ] Enquanto espera, só o cartão de decisão aparece (a chamada ainda não é linha). Decidida, vira a linha da chamada, com o texto apagado dizendo a decisão e a execução juntas: "Aprovado, rodando", "Aprovado e concluído", "Aprovado, mas falhou", e, sem execução, "Recusado", "Expirou", "Cancelado"; depois o resumo ("Escrever a.txt"). Ex.: "Arquivo · Aprovado e concluído · Escrever aprovado.txt".
- [ ] Aberta, a linha mostra o que foi aprovado (o conteúdo exato) e o resultado da execução (ou o erro). Recusada, expirada ou cancelada não tem resultado, só o motivo quando há. Chamada liberada por regra, sem cartão, é só a ação, com uma linha discreta "Permitido por uma regra sua" quando aberta.
- [ ] "Mais N ações" conta **chamadas**, não linhas. Linha que não rodou (recusada, expirada, cancelada) ou falhou não se esconde na dobra.

**Cartão "precisa de você"** (ação no computador do bot, fase 5): a mesma moldura; prévia do que está na tela e os botões embaixo, no rodapé.

**Regra geral:** um cartão não repete em linhas o que o título e o parágrafo já dizem por inteiro; o que sai das linhas continua a um clique ("Ver o conteúdo exato"). Hoje só o cartão de rede faz isso.

**Acesso à rede** (`request_network_access`, `data/approval-text.ts`): cartão comum de decisão, **sem botão dividido**. Cabeçalho "Rede" (ícone `network`); título "Acessar <host>"; **um** parágrafo, "Motivo dado pelo bot: “…”" (o motivo é fala do bot, atribuída a ele); **sem linhas para `host` e `reason`**, que só repetiriam o título e o parágrafo (qualquer outro argumento ganha linha), e o conteúdo exato inteiro numa divulgação "Ver o conteúdo exato" (`<details>`, fechada); à esquerda do rodapé a nota apagada "Aprovar vale só para esta execução."; "Recusar" e "Aprovar". Resolvido, é a linha única da chamada ("Rede · Aprovado… · Acessar api.exemplo.com"), como qualquer outra. O app **não** adivinha que algo é pedido de rede pelo texto: é a ferramenta pelo nome exato.

**Uma chamada por `use_tool`** (modo de pesquisa por índice) aparece como a linha da **ferramenta real**, nunca como `use_tool` (`resolveToolCall`, `data/derive.ts`; o servidor já grava o nome real, e uma chamada recusada traz o real em `args.tool`). A busca (`search_tools`) é uma linha calma "Procurar ferramentas…".

## 3b. Configurações: conectores, rede e revisão

Padrões criados para as telas de Configurações > Conectores e para a "Rede" do bot. Reaproveite-os; não invente outros.

- [ ] **Acesso por bot e por ferramenta = linha recolhida com contagem**, nunca um interruptor. É o `ActionCard` (as setas empilhadas aparecem só em hover/foco): ícone, nome do bot em negrito, contagem apagada "3 de 14" ("17 de 17 (todas)" quando o usuário escolheu "Selecionar todas"). Aberta, mostra os atalhos em texto ("Selecionar todas", "Só as de leitura", "Nenhuma"), **uma caixa por ferramenta** com o nome em negrito, o risco em texto apagado à direita e, embaixo, de onde veio o risco (a mesma frase da lista de ferramentas), e o rodapé à direita: "Descartar" (texto, só com mudança) e "Salvar" (pílula, desligada sem mudança). Nada vem marcado numa concessão nova. O corpo enviado é a lista exata das marcadas; `all` só nasce de "Selecionar todas" (`lib/tool-grants.ts`, função pura testada).
- [ ] **Ferramenta `new` ou `changed` não se marca**: a caixa fica desligada e a linha diz por quê ("A definição mudou: desligada até você revisar.") com o atalho "Revisar". Nunca finja que "quase" funciona.
- [ ] **Aviso calmo** (`ui-notice`, `role="status"`): uma frase no próprio conector ("2 ferramentas mudaram e estão desligadas até você revisar") e um botão "Revisar". Sem cor de alerta, sem pílula vermelha.
- [ ] **Comparação "antes / agora"** (revisão de definição; `ToolReview.tsx`, `lib/tool-review.ts`): uma janela (`Dialog`), um bloco por ferramenta, e dentro dele a nota fixa **"Texto escrito pelo servidor"** (descrição e esquema nunca são texto do app). Seções "Descrição", "Esquema de entrada" e "Dicas do servidor", cada uma com "sem mudança" ou "N linhas diferem"; duas colunas, **Antes (o que você aprovou)** à esquerda e **Agora (o que o servidor mostra)** à direita, linha a linha. A diferença **não depende de cor**: sinal "−"/"+" na frente da linha, texto falado para leitor de tela ("Linha removida:", "Linha nova:") e, nas linhas que mudaram no lugar, as palavras diferentes em **negrito e sublinhadas**. A cor (`--color-danger-subtle`/`--color-success-subtle`) só reforça. Ferramenta nova: lado esquerdo vazio e a frase "nada foi aprovado antes". Botões por ferramenta, à direita: "Manter desligada" (texto; não envia nada ao servidor e se desfaz com "Rever") e "Aprovar esta definição" (pílula; manda a impressão digital da definição **que está na tela**; um `409` recarrega e mostra a nova com "mudou de novo"). **Não existe "aprovar tudo".**
- [ ] **Histórico das ferramentas** é uma linha recolhida (`ActionCard`) que carrega os eventos só quando aberta.
- [ ] **Rede do bot** (`features/new-bot/BotNetwork.tsx`, na edição do bot): "Liberados para todos os bots" (só leitura, vêm da configuração), "Liberados só para este bot" (lista com remover), campo "Liberar um host" (o app só recusa campo vazio; **o resto é a mensagem do servidor, mostrada como veio**), a frase de que o nome é **exato** e de que host liberado é canal de saída, e "Recusas recentes" (host, porta, motivo em palavras, quando) com "Liberar" em cada uma. As mudanças valem na hora e não esperam o "Salvar" do bot (a tela diz isso). Quando o servidor usa o sandbox local (não tem a ferramenta `request_network_access` em `GET /v1/tools`), um aviso diz, em texto, que **não há isolamento de rede**.
- [ ] **Onde o programa de um conector roda** (`ConnectorNetwork.tsx`): `runsIn` vira "em contêiner isolado" ou "no servidor, sem isolamento" (esta última num aviso visível); a lista de hosts do conector é editável (um por linha) e mostra os padrões liberados para todos.
- [ ] **Medida das definições** no Inspetor, só leitura: o modo do catálogo ("direto", "pesquisa nativa", "pesquisa por índice") e, por pedido, definições, adiadas e tokens estimados/carregados (`toolStats`, sempre com `~` e "(estimado)" no cabeçalho), a estimativa do pedido inteiro e a **entrada real** que o provedor contou (`model_response.measure` e `usage`). Pedido com busca de ferramentas do provedor leva a marca "(soma de passagens da busca do provedor)": a entrada real soma passagens internas. São estimativas, e a tela diz isso.

## 3c. Configurações: o diálogo

Configurações **não é uma tela**: é um diálogo modal (`features/settings/SettingsDialog.tsx`) sobre a tela aberta, na linguagem das referências do dono. Tokens: `--width-settings`, `--height-settings`, `--width-settings-nav`, `--text-settings-title-size`. Peças: `features/settings/parts.tsx` (`SettingsGroup`, `SettingsRow`, `SettingsSelect`, `PaneHead`).

- [ ] **Moldura.** Modal centrado (`aria-modal="true"`, portal no `body`), navegação estreita à esquerda (ícone + rótulo; o selecionado tem um preenchimento suave arredondado), um fio, e à direita o título da seção e o X de fechar. Esc e o X fecham e devolvem o foco; o foco fica preso dentro (regra do foco modal, §7). Em janela estreita a navegação vira uma faixa no topo e nada passa da largura.
- [ ] **Só o que o backend tem.** Seções: Geral, Permissões, Cofre, Conectores. Não existe "Uso e cobrança", "Atualizações", "Computador" nem "Conta" enquanto o backend não servir dados reais para elas.
- [ ] **Grupo = rótulo pequeno e apagado + cartão arredondado de linhas** (`SettingsGroup`). Cada linha (`SettingsRow`): o rótulo à esquerda, **um** controle à direita (um menu discreto "Valor ⌄", um interruptor, um botão em pílula), e, quando precisa, **uma** linha apagada de descrição. Uma decisão por linha. Nada de painel gigante: formulário comprido, parágrafo explicativo longo e lista de comandos ficam fora da primeira vista (atrás de uma linha, de "Mais opções" ou de uma janela pequena).
- [ ] **Escolha de duas opções = interruptor; de mais = menu discreto** (`SettingsSelect`, um `<select>` sem caixa até o hover). Nunca um grupo de pílulas.
- [ ] **Permissões é a página mais simples**: um cartão "Aprovações" (o modo, **só como o backend o tem**: hoje o valor é só leitura, "Por nível de risco", porque a API não troca de modo), duas linhas sem cartão ("Nunca permitir", "Permitir sem perguntar") cada uma com a descrição de uma linha e a pílula "Adicionar regra", as regras existentes como linhas curtas embaixo do título (a frase da regra e "Editar"/"Remover" discretos), e um cartão "Permissões dos conectores" com o botão "Abrir conectores". Fora da primeira vista: cartões pendentes (estão em Pendências e no chat), o comportamento dos cartões (está em Geral > Conversa) e explicações longas.
- [ ] **"Adicionar regra" é uma janelinha**: pede só a ferramenta (um menu); bot, condições e anotação ficam atrás de "Mais opções"; a frase do que a regra fará aparece embaixo. A condição é sempre "campo é exatamente valor" (igualdade exata); nada de lista de comandos nem de padrão.
- [ ] **Cofre**: título, pílula "Novo item" no cabeçalho, campo de pesquisa (substring exata sobre os nomes já carregados), linhas calmas com "Gerenciar" e, vazio, uma frase centrada. O valor de um segredo nunca é mostrado.
- [ ] **Conectores**: primeiro a lista (uma linha por conector: nome, uma linha de estado, o interruptor e "Abrir"); os detalhes (acesso por bot e ferramenta, ajustes, rede, histórico, ferramentas, revisão) abrem ao selecionar o conector, com "‹ Conectores" para voltar. Uma ferramenta é uma linha; os detalhes dela abrem em "Detalhes".
- [ ] Um diálogo aberto de dentro de outro (regra, segredo, revisão) é uma superfície modal própria, a mais de cima: leva o foco, prende o Tab e devolve o foco ao fechar.

## 4. Balões e links

- [ ] Balão do bot: borda de 1 px, fundo de superfície. Balão do usuário: a cor do bot; se o bot é branco, cinza neutro.
### Balões: grupos, cantos, espaçamento, "cartões não contam"

- [ ] **Grupo**: balões de **texto** seguidos do mesmo remetente. Num grupo, os cantos que tocam um vizinho do mesmo grupo usam o raio pequeno `--radius-bubble-link` (6 px, cerca de um quarto do raio cheio, medido na referência do dono); os demais cantos ficam com o raio cheio `--radius-bubble` (= `--radius-card`, 24 px). O balão sozinho é todo arredondado.
- [ ] **Lado da ligação**: o do remetente. Bot, à esquerda: o primeiro tem o canto inferior esquerdo pequeno; o do meio, os dois cantos da esquerda; o último, o superior esquerdo. O lado de fora e as pontas do grupo ficam cheios. O usuário é o espelho, à direita.
- [ ] **Espaçamento**: dentro do grupo `--bubble-gap-group` (4 px); entre grupos e entre balão e cartão, o espaço normal do chat (`--chat-gap`, que continua valendo no modo compacto).
- [ ] **Quebram o grupo**: outro remetente, qualquer cartão ou linha (ação, aprovação, segredo, pergunta com opções, fim de execução, aviso, indicador de trabalho), separador de dia ou de pausa longa (30 min, o mesmo limiar dos separadores). O balão antes do cartão termina o grupo; o depois começa outro. Pergunta aberta (sem opções) é balão.
- [ ] **Cartões não contam**: mantêm a moldura e o raio padrão (24 px) e não entram em grupo nem têm `data-bubble`; só os dois balões de texto de `ui/message.tsx` o carregam. Mensagem do usuário ainda sendo enviada agrupa como as outras; listas e código dentro do balão não mudam nada.
- [ ] **Cálculo**: função pura `bubblePositions` (`features/chat/timeline.ts`: `single | first | middle | last` por item); o componente só aplica `data-bubble`. Quando chega um balão novo, o antigo "último" vira "do meio": muda **só o raio**, sem transição e sem deslocar nada (o espaçamento depende de ser ou não o primeiro, não da posição exata).

- [ ] Link: texto na cor normal, sublinhado, com glifo; favicon **desligado** por padrão (`favicons: "off"`, a busca sai do computador).

## 5. Barra lateral

- [ ] Sem destaque fixo do bot selecionado; o cartão do bot só aparece no hover, com raio 24 px.
- [ ] Colunas 1 e 3 arrastáveis (`lib/pane-size.ts`): barra lateral 240–420 px (padrão 316; abaixo de 200 vira trilho de 110), painel do bot 340–640 px (padrão 450; abaixo de 280 fecha).
- [ ] Avatares (token / caixa): linha 36 px, trilho 56 px, painel 72 px, pequeno 28 px. O dono falou em corpo visível ~42 / ~64 / ~74 / ~27 px; a caixa do código é a que vale até haver medida do corpo. O avatar nunca é recortado por um círculo.

## 6. Mascotes

- [ ] Só pelo motor `@suup/avatar` e pelas formas dele. Nenhuma forma ou rosto desenhado à mão.

## 7. Acessibilidade mínima

- [ ] Tudo se opera pelo teclado; foco visível (`--focus-ring`); menus com setas, Esc e retorno do foco.
- [ ] Pedido novo (aprovação, segredo) é anunciado em região `aria-live`; o cartão recebe o foco, não um botão, e não rouba o foco de quem digita.
- [ ] **Superfície modal manda no foco** (paleta, diálogos: `aria-modal="true"`): nada do chat toma o foco por conta própria enquanto uma está aberta (compositor, cartão de decisão, formulário de segredo, pergunta usam `focusOnAppearance`, `lib/focus.ts`; teste em `ui/modal-focus.test.tsx`), e a paleta devolve o foco ao campo se algo o levar.
- [ ] Controle só com ícone tem nome (`aria-label`); estado vai em `aria-expanded` / `aria-checked` / `aria-busy`.
- [ ] Movimento reduzido (`prefers-reduced-motion`) zera as durações (`tokens.css`).

## 8. Antes de entregar uma tela

1. Rodar `pnpm lint`, `pnpm typecheck`, `pnpm vitest run apps/desktop` e o Playwright; ler a saída.
2. Gerar as capturas 1920x1080 e **compará-las, lado a lado, com as referências do dono** (peso, espaços, borda, posição dos botões).
3. Conferir: moldura de 1 px e raio 24 px; um parágrafo só; conteúdo exato visível; rodapé à direita; estado resolvido numa linha.
4. Nenhuma cor, raio ou tamanho literal fora de `tokens.css`.
5. Teclado: percorrer a tela só com Tab, setas, Enter e Esc; o foco aparece.
6. O que é novo e configurável está em Configurações; nada foi inventado que o backend não tem.
7. Textos em pt-BR, nossos, sem copiar marca ou frase distintiva de referência.
8. Este arquivo foi atualizado se o dono decidiu algo novo.
