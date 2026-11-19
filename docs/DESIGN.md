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
- [ ] Ícone pequeno (14 px) num quadrado arredondado de 24 px (`--size-icon-box`, `--radius-chip`, fundo `--color-raised`) e o rótulo curto da categoria em negrito: "Arquivo", "Terminal", "Web", "Memória", o nome do conector, "E-mail" (ferramenta de e-mail), "Segredos"; sem categoria, "Ferramenta" (`toolCategory`). **Um só vocabulário**: o mesmo rótulo e o mesmo ícone para uma ferramenta, seja cartão que espera você, aprovação decidida ou linha do que o bot fez; vem sempre de `toolCategory` (`data/approval-text.ts`) e do ícone dela (`ui/category-icon.tsx`). Nenhuma tela tem tabela própria ("Arquivo" num lugar e "Arquivos" noutro é erro).
- [ ] O nível de risco é texto apagado à direita, com prefixo "Risco:" só para leitor de tela. Nunca pílula colorida.

**Corpo**
- [ ] Título em negrito, uma frase humana do que vai acontecer, **em pt-BR** (`approvalTitle`; o resumo do servidor, que pode vir em inglês, só entra como reserva).
- [ ] **Um** parágrafo leve e apagado (quem pede e por quê). Mais de um parágrafo é erro.
- [ ] O conteúdo exato vem em linhas calmas separadas por fios de 1 px: rótulo à esquerda, valor depois; monoespaçado só para o que é código (comando, script, consulta, várias linhas); texto longo recolhido com "Mostrar tudo". O conteúdo exato é sempre inspecionável, porque é uma garantia de segurança; segredo aparece só como cadeado + NOME.

**Rodapé**
- [ ] À direita: ação secundária como **texto simples** ("Recusar", "Descartar", "Agora não") e a primária em **pílula** branca. Recusar é **um clique**, sem campo de motivo (a API ainda aceita um motivo; o cartão não o envia).
- [ ] Opções extras ficam no menu da seta do botão dividido (`ui/menu.tsx`, teclado: setas, Home/End, Esc devolve o foco; o foco nos itens usa `preventScroll`, porque rolar o chat fecha o menu). Cada item tem título e descrição apagada de uma linha. No cartão de aprovação: quatro "Sempre permitir" (este bot ou todos × exatamente isto ou qualquer uso da ferramenta), "Precisa de aprovação" (marcado; desmarcar faz "Aprovar" criar também a regra e o cartão diz qual) e "Gerenciar regras" (abre Configurações > Aprovações).
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

## 4. Balões e links

- [ ] Balão do bot: borda de 1 px, fundo de superfície. Balão do usuário: a cor do bot; se o bot é branco, cinza neutro.
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
