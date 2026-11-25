# Pesquisa: entrada de apps reais (coreografia, mascote, campo)

Data de acesso: 24/11/2026, salvo quando indicado. Complementa [fluxo-de-entrada.md](fluxo-de-entrada.md). Não repete o que ela já tem (NN/g, Microsoft Win32, WCAG 2.2.2 e 2.3.3, MDN de `autocomplete`, `inputmode` e `enterkeyhint`, APG).

## Pergunta

1. Como as diretrizes oficiais (Material, Fluent, Apple) ordenam a entrada: o herói primeiro, o escalonamento, durações e curvas?
2. O que apps reais publicam sobre a primeira abertura e sobre o mascote?
3. Como o campo de nome deve ganhar foco e reagir ao Enter, sem prender o usuário?

## Fontes

- **Material 3, tokens de movimento (código oficial do Google, androidx Compose)**: https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/MotionTokens.kt. **[lido]**. A unidade não vem escrita no arquivo; os valores são os do Material (ms).
- **Material 3, páginas de motion** (`m3.material.io/styles/motion/overview`, `.../easing-and-duration`, `.../easing-and-duration/tokens-specs`, `.../transitions/transition-patterns`). **[não verificado]**: a ferramenta só recebeu o título (página feita em JavaScript). Nada citado delas.
- **Fluent 2, tokens de duração (código oficial da Microsoft)**: https://raw.githubusercontent.com/microsoft/fluentui/master/packages/tokens/src/global/durations.ts. **[lido]**. Ramo `master`, sem versão fixada.
- **Fluent 2, tokens de curva (código oficial)**: https://raw.githubusercontent.com/microsoft/fluentui/master/packages/tokens/src/global/curves.ts. **[lido]**.
- **Fluent 2, "Motion"**: https://fluent2.microsoft.design/motion. **[lido]** (texto extraído pela ferramenta; as citações são dela).
- **Apple, "Designing Fluid Interfaces" (WWDC18, sessão 803)**: https://developer.apple.com/videos/play/wwdc2018/803/. **[lido, parcial]**: texto da transcrição resumido pela ferramenta, não a transcrição inteira.
- **Apple HIG, Motion, Onboarding e Text fields**: developer.apple.com/design/human-interface-guidelines/motion, /onboarding e /text-fields. **[não verificado]**: só o título em cada uma. Não há citação delas aqui.
- **Linear, changelog de 9/5/2019**: https://linear.app/changelog/2019-05-09-first-time-user-experience. **[lido, resumo]**: "every team member now gets an introduction to the command menu"; animação discreta do logo no carregamento inicial.
- **Linear, changelog de 12/12/2019**: https://linear.app/changelog/2019-12-12-onboarding-join-teams. **[lido, parcial]**: "we added a dialog that lets new users only join the teams they want, or create a new team".
- **Raycast, changelog do macOS 0.59**: https://www.raycast.com/changelog/macos/0-59. **[lido]**: "Experience a brand new onboarding flow as a first time Raycast user". O texto não descreve o conteúdo dos passos.
- **Raycast, Manual (Windows, primeiros passos)**: https://manual.raycast.com/windows/getting-started. **[não verificado]**: a página é só um índice.
- **Duolingo, "Building character" (10/11/2020)**: https://blog.duolingo.com/building-character/. **[lido]**.
- **Duolingo, "Streak milestone design animation" (21/1/2022)**: https://blog.duolingo.com/streak-milestone-design-animation. **[lido]**.
- **Duolingo, "World character visemes"**: https://blog.duolingo.com/world-character-visemes. **[lido]**: o uso de Rive e a máquina de estados.
- **Rive (fornecedor da ferramenta), caso Lily da Duolingo**: https://rive.app/blog/duolingo-s-ai-powered-video-call-brings-lily-to-life. **[lido]**. Post do fornecedor, não da Duolingo: fonte secundária.
- **Rive, "Creative technologists" (caso Duolingo)**: https://rive.app/blog/creative-technologists-duolingo-s-solution-to-the-designer-to-developer-handoff. **[lido]**. Também do fornecedor.
- **Arc (The Browser Company)**: só entrevista na imprensa; **[não usado como fonte]**. Não há post oficial da empresa sobre a primeira abertura.
- **Claude Desktop, ajuda oficial** (https://support.claude.com/en/articles/10065433-install-claude-desktop). **[não verificado]**.
- **ChatGPT, Notion, Headspace**: sem fonte oficial sobre a primeira abertura. **[não verificado]**.
- **WCAG 2.2, Understanding 2.2.2 (Pause, Stop, Hide)**: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html. **[lido, parcial]**.
- **WCAG 2.2, Understanding 2.3.3**: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html. **[lido]**.
- **WCAG 2.2, Understanding 3.3.2 (Labels or Instructions)**: https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html. **[lido, parcial]**.
- **WHATWG HTML, atributo `autofocus`**: https://html.spec.whatwg.org/multipage/interaction.html (seção 6.6.7). **[lido, parcial]**.
- **MDN, `autofocus`**: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/autofocus. **[lido]**. Referência, não especificação.

## Fatos verificados

### 1. Coreografia

- **Material 3 (`MotionTokens.kt`)**: `EasingEmphasizedCubicBezier` = (0.2, 0, 0, 1); `EasingEmphasizedDecelerateCubicBezier` = (0.05, 0.7, 0.1, 1); `EasingEmphasizedAccelerateCubicBezier` = (0.3, 0, 0.8, 0.15). Durações: Short2 100, Short3 150, Short4 200, Medium1 250, Medium2 300, Medium3 350, Medium4 400, Long2 500.
- **Fluent 2, duração (`durations.ts`)**: ultraFast 50, faster 100, fast 150, normal 200, gentle 250, slow 300, slower 400, ultraSlow 500 (ms).
- **Fluent 2, curva (`curves.ts`)**: decelerateMid (0, 0, 0, 1); accelerateMid (1, 0, 1, 1); easyEase (0.33, 0, 0.67, 1).
- **Fluent 2, "Motion"**: "Give larger elements more time to animate than smaller elements." / "Keep durations short and the movement natural." / "Staggering is the process of delaying the start of one or more animations." / "For most scenarios, a staggered animation is preferred." / "Design for and include a 'no motion' setting for your app or website as recommended by the WCAG."
- **Apple WWDC18 803**: "the button should highlight immediately when I touch down on it." / "Be vigilant and mindful of all the latencies or timers that we could introduce into the interface so that it always feels responsive." A sessão não trata de onboarding.
- **WCAG 2.2.2**: vale para movimento que "lasts more than five seconds" e é "presented in parallel with other content". Uma entrada que termina em menos de 5 s não se encaixa; um olhar em laço sem fim, sim.
- **WCAG 2.3.3**: animação disparada por interação, não essencial, precisa poder ser desligada.

### 2. Primeira abertura em apps reais

- **Linear (2019)**: apresentação do menu de comandos na primeira vez; movimento discreto do logo no carregamento; um diálogo para escolher os times ao entrar.
- **Raycast (macOS 0.59)**: "a brand new onboarding flow as a first time Raycast user"; o conteúdo dos passos não é descrito.
- **Duolingo**: "Timing is everything in animation." O movimento do personagem é de evento ("a unique animation that would play anytime a learner answered an exercise correctly"), não de fundo. Durações não publicadas.

### 3. Mascote vivo

- **Duolingo (visemes, Rive)**: máquina de estados, "idle behavior like head nods, blinking, and eyebrows moving"; depois de um desafio, "the character can move to a final state, showing the reaction to your response".
- **Rive (Lily)**: "Subtle head bobs, facial expressions, and idle movements ensure Lily feels present and reactive rather than robotic."
- **Não encontrado**: nenhuma fonte oficial diz que o personagem olha para o campo quando a pessoa digita. **[não verificado]**.

### 4. Campo e foco

- **WHATWG `autofocus`**: "allowing the user to just start typing without having to manually focus the main element"; o foco não é tirado de quem já começou a digitar.
- **MDN `autofocus`**: "When autofocus is assigned, screen-readers 'teleport' their user to the form control without warning them beforehand." Logo, o foco automático vem depois de o texto estar na tela.
- **WCAG 3.3.2**: o rótulo precisa estar "persistently available"; o placeholder só complementa.

## Inferências

1. Ordem pelo princípio do Fluent ("larger elements more time"): o bot entra primeiro e mais devagar (400); o texto depois, 250 cada; o campo por último.
2. 300 ms entre linhas e 200 ms por olhar são escolhas de design a partir dos tokens (Fluent 200/250, Material Medium2 300), a ajustar a olho.
3. Foco automático no campo depois do texto.
4. O olhar ao digitar é movimento disparado pela pessoa: o movimento reduzido do app (`data-motion`) cobre o 2.3.3.
5. "Continuar" com o campo vazio: a regra "só liga com algo digitado" conflita com o nome opcional. Decisão do dono.
6. Enter envia o formulário (comportamento nativo de `form` com uma linha); `enterkeyhint="done"` rotula a tecla.

## Proposta de entrada

Tempos a partir do fim do carregamento da tela; termina em ~2,5 s, abaixo dos 5 s do WCAG 2.2.2.

| Momento | Ms | O que se mexe | Curva | Fonte |
|---|---|---|---|---|
| Bot entra no centro | 0 a 400 | opacidade 0 a 1, sobe 16 px | (0.05, 0.7, 0.1, 1) | M3 Emphasized Decelerate; Fluent "larger elements" |
| Olha à esquerda | 400 a 600 | só os olhos | (0, 0, 0, 1) | Fluent decelerateMid 200; ordem e pausas: inferência |
| Pausa | 600 a 850 | nada | | inferência |
| Olha à direita | 850 a 1050 | só os olhos | (0, 0, 0, 1) | idem |
| Pausa | 1050 a 1300 | nada | | inferência |
| Olha à frente e para | 1300 a 1500 | só os olhos; sem laço | (0, 0, 0, 1) | idem |
| Linha 1 | 1300 a 1550 | opacidade, sobe 8 px | (0, 0, 0, 1) | Fluent gentle 250 |
| Linha 2 | 1600 a 1850 | idem | idem | stagger "preferred" (Fluent); 300: inferência |
| Linha 3 | 1900 a 2150 | idem | idem | idem |
| Campo aparece e recebe o foco | 2150 a 2350 | opacidade (200) | | WHATWG / MDN |
| "Continuar" aparece | 2350 a 2550 | opacidade (200) | | inferência |
| Ao digitar | qualquer hora | os olhos vão ao campo (200) | (0, 0, 0, 1) | inferência |
| Continuar | clique ou Enter | bot em "done"; a tela sai por opacidade (150) | (1, 0, 1, 1) | Fluent accelerateMid 150 |
| Movimento reduzido | 0 | tudo de uma vez, sem deslocamento nem olhar | | DESIGN §7; MDN |

Sem confete, brilho ou laço (DESIGN §1). Placeholder como exemplo; o rótulo visível é a pergunta.

## Contradições e decisões

1. **"Pular"**: `fluxo-de-entrada.md` recomendava um "Pular" visível; o dono decidiu **sem "Pular"** (24/11/2026). Vale a decisão do dono.
2. **"Continuar" com o campo vazio**: ou o nome é obrigatório, ou "Continuar" fica sempre ligado. **Decisão do dono pendente.**
3. **Configurabilidade**: o `data-motion` do app já cobre o 2.3.3 e o "todo comportamento é configurável" do DESIGN §1.
4. **Durações**: os 167 ms (WinUI) da pesquisa anterior dão lugar aos tokens do Fluent 2 (150 e 200).
5. **Efeito decorativo (DESIGN §1)**: a coreografia da boas-vindas é decisão do dono; o DESIGN registra a exceção e que o movimento reduzido mostra tudo de uma vez.

## Recomendação

Seguir a tabela, com o campo opcional e "Continuar" sempre ligado (sem "Pular"), e atualizar o DESIGN §1 e §7 no mesmo commit da implementação. Os pontos mais bem apoiados pelas fontes são a ordem (bot, texto, campo) e o foco automático depois do texto.
