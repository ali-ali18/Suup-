# Pesquisa: o avatar vivo do bot no chat

Data da pesquisa: 24/11/2026. Apoia a entrega "avatar vivo no chat" (o rosto do bot no lugar dos três pontinhos enquanto ele trabalha) e o ajuste do dono do mesmo dia, "o chat mostra só resultados". Escrita antes do código, como pede `docs/REGRAS.md` §2.

## Pergunta

Como mostrar, no fim do chat, o bot trabalhando com uma expressão que acompanha o que a execução faz de verdade (pensando, terminal, arquivos, web, esperando você, erro, fim), respeitando o estilo de avatar do bot, o movimento reduzido e o leitor de tela, sem pulo de layout? O que o projeto anterior do dono (Atlas) faz, e o que o motor `@suup/avatar` já oferece?

## Fontes

Especificações e documentação, lidas em 24/11/2026 (o `www.w3.org` e o `developer.mozilla.org` não abriram na rede desta sessão; os mesmos textos foram lidos nos repositórios oficiais pelo `raw.githubusercontent.com`):

- WAI-ARIA, editor's draft (repositório oficial `w3c/aria`, ramo `main`): https://raw.githubusercontent.com/w3c/aria/main/index.html (publicado em https://w3c.github.io/aria/ ; seções `#status` e `#aria-live`). Acesso: 24/11/2026.
- MDN, "ARIA: status role": https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/accessibility/aria/reference/roles/status_role/index.md (publicado em https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role). Acesso: 24/11/2026.
- MDN, "aria-live": https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/accessibility/aria/reference/attributes/aria-live/index.md (publicado em https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live). Acesso: 24/11/2026.
- MDN, "prefers-reduced-motion": https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/at-rules/@media/prefers-reduced-motion/index.md (publicado em https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion). Acesso: 24/11/2026.

Código lido (o projeto anterior do dono, só leitura, `ali-ali18/atlas`):

- `apps/web/components/ui/templates/template-4/live-agent-avatar.tsx` e `live-agent-avatar.test.tsx`
- `apps/web/components/ui/templates/template-4/chat-thread/working-indicator.tsx`
- `apps/web/components/ui/templates/template-4/chat-thread/chat-thread.tsx` (onde o indicador entra)
- `apps/web/components/ui/templates/template-4/avatar-status.tsx`
- `packages/shared/src/avatar-activity.ts` (a classificação atividade → estado) e `apps/web/lib/working-status.ts` (a frase)

Código do Suup: `packages/avatar/src/states.ts`, `data/states.ts`, `model/brain.ts`, `model/behavior.ts`, `pixel/states.ts`, `runtime/avatar-runtime.ts`; `apps/desktop/src/ui/mascot.tsx`, `ui/pixel-mascot.tsx`, `ui/avatar.tsx`, `ui/chat-lines.tsx`, `lib/avatar-state.ts`, `data/derive.ts`, `features/chat/timeline.ts`, `features/chat/MessageList.tsx`.

## Fatos verificados

### Acessibilidade (fontes primárias)

1. **`role="status"`** é "um tipo de região viva cujo conteúdo é informação de aviso para o usuário, mas não importante o bastante para justificar um alerta"; "os autores DEVEM garantir que um elemento com `status` não receba o foco por causa de uma mudança de estado"; e "elementos com o papel `status` têm `aria-live` implícito `polite` e `aria-atomic` implícito `true`" (WAI-ARIA, `#status`; MDN "status role", que acrescenta: "não dê foco ao status quando o conteúdo dele muda").
2. **`aria-live="polite"`**: "as tecnologias assistivas avisam o usuário das mudanças, mas em geral não interrompem a tarefa atual, e as mudanças têm prioridade baixa"; devem ser anunciadas "na próxima oportunidade graciosa, como no fim da frase que está sendo falada ou quando o usuário para de digitar" (WAI-ARIA, `#aria-live`). A MDN recomenda não usar `assertive` a menos que a interrupção seja imprescindível (MDN "aria-live").
3. **`prefers-reduced-motion`** detecta se a pessoa ligou no aparelho o ajuste de "minimizar a quantidade de movimento não essencial"; serve para o navegador saber que ela prefere uma interface que "remove, reduz ou substitui animações baseadas em movimento"; o valor `reduce` é verdadeiro quando o ajuste está ligado. Animações como ampliar ou deslocar objetos grandes podem desencadear desconforto vestibular (MDN "prefers-reduced-motion").

### Atlas (o projeto anterior do dono)

4. `live-agent-avatar.tsx`: o avatar vivo lê o estado do bot de uma loja (`useBotAvatar(botId)`, publicada pelo `ChatThread`) e recebe "pulsos" dos eventos da execução (ferramenta começou, acabou, falhou) como gestos curtos. O movimento contínuo ("cérebro") liga só nos avatares do chat aberto (`brain ?? follow === "always"`).
5. `working-indicator.tsx`: no fim do chat, um contêiner `aria-live="polite"` de **altura zero** (`h-0 overflow-visible`) com, posicionado por cima, o avatar vivo de 36 px e uma linha apagada (`text-muted-foreground text-sm`) com a frase do que o bot faz. A frase vem de `workingStatusLabel` (por fase: escrevendo, ferramenta, na fila, esperando você, pausado).
6. `avatar-activity.ts`: a atividade vira o estado do motor. Esperar o **usuário** (aprovação, pergunta, pausa) vence e vira `waiting` (a órbita); pensando vira `thinking` (o corpo vira as reticências); escrevendo vira `streaming`; ferramenta vira família (`searching`, `reading`, `coding`, `running`, `controlling`, `working`). A família da ferramenta vem de `toolKind(tool)`.
7. `avatar-status.tsx`: o canto do avatar mostra um estado por precedência, trabalhando > não lida > estrela do principal (já adotado no Suup, `docs/DESIGN.md` §5).
8. `live-agent-avatar.test.tsx` confere: avatar parado com movimento reduzido, cor e forma vindas do bot, e que o cabeçalho e o indicador do chat usam o avatar vivo (não o parado).

### O motor `@suup/avatar` e o app

9. Estados públicos (`AVATAR_STATES`, `states.ts`): `idle`, `thinking`, `working`, `waiting`, `asking`, `done`, `failed`, `paused`, `sleeping`, `celebrating`. `thinking` e `waiting` transformam o corpo num indicador (`BODY_MORPH_STATES`: pontinhos, órbita), e o app nunca os pede (`docs/DESIGN.md` §6, "O rosto nunca vira indicador").
10. A tabela interna (`data/states.ts`) já tem estados de trabalho **com rosto** e sem morph: `reading` (olhos calmos), `coding` (olhos apertados), `controlling` (olhos de inspeção), `streaming`, `running`; e o cérebro (`model/brain.ts`) dá a cada família (`think`, `read`, `code`, `run`…) um perfil de movimento próprio. Esses estados não estavam no vocabulário público.
11. O pixel (`pixel/states.ts`) tem 10 poses desenhadas pelo dono, entre elas **"Pensando"**, "Trabalhando", "Com dúvida", "Concluiu", "Falhou", "Pausado".
12. No app, `Mascot` liga o cérebro só de 56 px para cima e a respiração de 64 px; com movimento reduzido (o ajuste do app ou o do sistema, `lib/reduced-motion.ts`) desenha a imagem parada do estado (`renderStill`, só o rosto). `PixelMascot` mostra a pose parada. `tokens.css` zera as durações com movimento reduzido.
13. O indicador do Suup (`ui/chat-lines.tsx`) eram três pontinhos e a frase (`role="status"`), no fim do chat, só com a execução em `queued`/`running`.

## Inferências

- **Uma tabela exata, não texto.** No Suup a categoria de uma ferramenta já é dada pelo nome **exato** (`toolCategory`, `data/approval-text.ts`); o equivalente ao `toolKind` do Atlas é essa tabela, sem padrão de texto (`docs/REGRAS.md` §1). A atividade é um conjunto fechado e a expressão sai de um `Record<Atividade, Estado>`.
- **Pensar sem virar indicador.** O Atlas usa os pontinhos do corpo para "pensando"; aqui a regra do dono proíbe. O motor ganha um estado público `pondering` (o rosto fica, os olhos procuram para cima como no `thinking`, a família de movimento é a de pensar; no pixel, a pose "Pensando") e passa a expor `reading` e `coding`, que já existiam por dentro. Nenhuma forma ou rosto novo é desenhado.
- **Pequeno e vivo.** Para a expressão aparecer num avatar de 36 px, o do chat liga o cérebro e a respiração (como o Atlas faz no chat aberto); o orçamento de 3 cérebros do app continua valendo.
- **Sem pulo.** O Atlas evita o pulo deixando o indicador com altura zero sobre um espaço reservado embaixo. No Suup o fim do chat não reserva espaço; a saída fecha a altura da linha com uma transição (`grid-template-rows` de `1fr` a `0fr`, mais a opacidade), e o mesmo elemento muda de expressão para "concluiu" enquanto sai.
- **Leitor de tela.** A linha é `role="status"` (educado, sem roubar o foco, fatos 1 e 2). Ao sair, ela vira `aria-hidden`, para não ser anunciada de novo; a mensagem do bot é anunciada pelo registro do chat (`role="log"`), que já existe.
- **Movimento reduzido.** Rosto parado na expressão do estado, nada em laço, e a saída imediata (fato 3; durações zeradas).
- **Esperando você.** Aprovação e pergunta também são o bot "parado esperando": o avatar fica, com a cara de quem pergunta, embaixo do cartão.

## O que não foi verificado

- O comportamento de cada leitor de tela (NVDA, VoiceOver, Orca) com um `status` dentro de um `log`: não verificado; a especificação só recomenda.
- As páginas publicadas em `www.w3.org` e `developer.mozilla.org` não abriram na rede desta sessão; foram lidas as fontes oficiais nos repositórios (`w3c/aria`, `mdn/content`).
- A aparência no app compilado (Tauri, WebKitGTK/WebView2) não foi conferida; só no Chromium do Playwright.

## Implicação para o Suup

- `lib/chat-activity.ts`: as atividades declaradas (`queued`, `thinking`, `terminal`, `files`, `web`, `memory`, `tool`, `approval`, `question`, `paused`, `done`, `failed`), a tabela `ACTIVITY_AVATAR` e uma frase fixa e amigável por atividade.
- `@suup/avatar`: `pondering`, `reading`, `coding` no vocabulário público (nenhum vira indicador; testes no motor e no app).
- O indicador do chat é o rosto do bot (estilo, 3D e cor dele, por `ui/avatar.tsx`) com a frase; sai com transição.
- Ajuste do dono do mesmo dia ("quero o resultado com excelência e nada mais"): o chat não mostra mais linhas de ferramenta nem passos; o avatar vivo é o único sinal de progresso, e o registro fica no Inspetor.
