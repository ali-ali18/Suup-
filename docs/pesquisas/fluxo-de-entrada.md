# Pesquisa: fluxo de entrada (boas-vindas, primeiro bot, supervisor opcional)

Data da pesquisa: 24/11/2026. Todas as fontes web foram acessadas em 24/11/2026, salvo quando indicado. Valida o novo fluxo de entrada do app de desktop, decidido pelo dono em 24/11/2026: (1) boas-vindas na primeira abertura, com o bot no centro, texto que sobe linha a linha e campo para o nome; (2) o servidor deixa de criar o bot "Principal" sozinho e a interface abre em "Crie seu bot"; (3) supervisor é opcional, com um diálogo que sugere ligar; (4) o nome da pessoa é guardado no servidor como campo estruturado. Ver [README](README.md).

Marcação: **[lido]** = a página oficial foi aberta e o trecho foi conferido; **[lido, parcial]** = abriu, mas faltou parte do texto (dito no lugar); **[não verificado]** = a página não deu o corpo do texto (só o título), deu 404 ou não foi aberta.

## Pergunta

1. O que as diretrizes oficiais de plataforma e a pesquisa de UX dizem sobre a primeira abertura: pedir o nome logo de cara, quantos passos, pular, não bloquear?
2. Como animar um texto que entra em sequência e um bot que olha para os lados sem prejudicar quem tem movimento reduzido? Quais durações e curvas as diretrizes dão?
3. Como montar o campo de nome: atributos `autocomplete`, `inputmode`, `enterkeyhint`, rótulo e descrição acessíveis, sem validar o formato do nome?
4. Como um diálogo que sugere uma opção não obrigatória (supervisor) deve se comportar: foco inicial, Esc, texto dos botões, papel ARIA?
5. O que o repositório já decidiu sobre isto, e a pesquisa contradiz algo?

## Fontes

### Plataformas (Apple, Microsoft, Google)

- **Apple HIG, Onboarding**: https://developer.apple.com/design/human-interface-guidelines/onboarding (e variante com barra final). **[não verificado]**: a página só devolveu o título "Onboarding | Apple Developer Documentation". Não deu para citar nada dela.
- **Apple HIG, Alerts**: https://developer.apple.com/design/human-interface-guidelines/alerts. **[não verificado]**: só o título.
- **Apple HIG, Motion**: https://developer.apple.com/design/human-interface-guidelines/motion. **[não verificado]**: só o título.
- **Apple HIG (índice)**: https://developer.apple.com/design/human-interface-guidelines/. **[não verificado]**: só o título.
- **Microsoft Learn, "First Experience" (Win32, guia de Windows 7)**: https://learn.microsoft.com/en-us/windows/win32/uxguide/exper-first-exper (ms.date 20/10/2020). **[lido]**. A própria página avisa: "This design guide was created for Windows 7 and has not been updated for newer versions of Windows."
- **Microsoft Learn, "Dialogs and flyouts"**: https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/dialogs-and-flyouts/ (ms.date 13/10/2026). **[lido]**.
- **Microsoft Learn, "Dialog controls"**: https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/dialogs-and-flyouts/dialogs (ms.date 15/07/2026). **[lido]**.
- **Microsoft Learn, "Writing style"**: https://learn.microsoft.com/en-us/windows/apps/design/style/writing-style (atualizado em 27/06/2026). **[lido]**.
- **Microsoft Learn, "Timing and easing"**: https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing (ms.date 18/09/2024). **[lido]**.
- **Fluent 2, "Motion"**: https://fluent2.microsoft.design/motion. **[lido]**. Não traz valores em milissegundos.
- **Microsoft Learn, candidato a "first run" (Windows apps)**: https://learn.microsoft.com/en-us/windows/apps/design/style/first-run-experience. **404**; não citado. Não existe, por essa URL, guia atual de onboarding de app Windows (a busca só achou o guia Win32 acima e um texto de FRE do Windows App, que é outro produto; não usado).
- **Material Design (onboarding, m2)**: https://m2.material.io/design/communication/onboarding.html. **[não verificado]**: só o título.
- **Material Design 3, "Motion"**: https://m3.material.io/styles/motion/overview. **[não verificado]**: só o título.
- **Material Design 3, "Easing and duration" (tokens)**: https://m3.material.io/styles/motion/easing-and-duration/tokens-specs. **[não verificado]**: só o título. Os valores de duração do Material não foram conferidos.

### Pesquisa de UX (Nielsen Norman Group)

- **NN/g, "Mobile-App Onboarding: An Analysis of Components and Techniques"**: https://www.nngroup.com/articles/mobile-app-onboarding/ (publicado em 21/06/2020, segundo a própria página). **[lido]**.
- **NN/g, "7 Tips for Successful Customization"**: https://www.nngroup.com/articles/customization/ (publicado em 14/08/2016). **[lido]**.
- **NN/g, "6 Tips for Successful Personalization"**: https://www.nngroup.com/articles/personalization/ (publicado em 02/10/2016). **[lido]**.
- **NN/g, "'Get Started' Stops Users"**: https://www.nngroup.com/articles/get-started/ (publicado em 20/08/2017). **[lido]**.

### Acessibilidade e movimento (W3C, MDN)

- **WCAG 2.2 (texto normativo)**: https://www.w3.org/TR/WCAG22/. **[lido, parcial]**: li os critérios 2.2.2 e 2.3.3 pelo trecho; o restante do critério 2.2.2 não foi lido.
- **WCAG 2.2, Understanding 2.3.3 (Animation from Interactions)**: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html. **[lido]**.
- **MDN, `prefers-reduced-motion`**: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion. **[lido]**. A página tem mais de 100 mil caracteres; li o trecho de descrição e o exemplo.
- **MDN, `autocomplete`**: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete. **[lido]**.
- **MDN, `inputmode`**: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode. **[lido]**.
- **MDN, `enterkeyhint`**: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/enterkeyhint. **[lido]**.
- **W3C, "Personal names around the world"**: https://www.w3.org/International/questions/qa-personal-names. **[lido]**.

### Componentes e padrões de diálogo

- **WAI-ARIA APG, "Modal Dialog Pattern"**: https://www.w3.org/WAI/ARIA/apg/patterns/dialogmodal/. **[lido]**.
- **WAI-ARIA APG, "Alert Dialog" (página de alert)**: https://www.w3.org/WAI/ARIA/apg/patterns/alert/. **[lido, parcial]**: a página não descreve o padrão alertdialog em detalhe; o que citei está dito na página.
- **Base UI, "Field"**: https://base-ui.com/react/components/field. **[lido, parcial]**: a página não diz como a descrição e o erro ligam ao controle.
- **Base UI, código de `FieldDescription.tsx`**: https://github.com/mui/base-ui/blob/master/packages/react/src/field/description/FieldDescription.tsx. **[lido]**.
- **Base UI, código de `FieldControl.tsx`**: https://raw.githubusercontent.com/mui/base-ui/master/packages/react/src/field/control/FieldControl.tsx. **[lido, parcial]**: o arquivo não mostra a montagem do `aria-describedby`; ela fica no hook de validação, que não foi lido.

### Repositório (lido em 24/11/2026)

- `docs/REGRAS.md` (§1 regex; §2 pesquisa antes de implementar); `docs/pesquisas/README.md`; `docs/RECEPCAO.md`; `docs/pesquisas/fase-4-recepcao-inicial.md`; `docs/DESIGN.md` (§1, §3d linhas 191 a 202, §6 linha 324, §7 linhas 326 a 332); `docs/PLANO.md` (§4.5, §4.8, §4.12a, §4.14).
- `docs/SUPERVISOR.md`: "A estrela no avatar do Principal vem de `bot.isDefault`." (linha 47, seção "O Principal como supervisor"). **[lido]**.
- `packages/runtime/src/conversations.ts`, linhas 158 (`DEFAULT_BOT_NAME = "Principal"`) e 177 a 181 (`ensureDefaultBot`: "if there are no active bots, creates "Principal" with every registered tool and marks it default. Idempotent."). **[lido]**.

## Fatos verificados

### 1. Primeira abertura e onboarding

**Microsoft (Win32, "First Experience"; guia antigo, ver a ressalva da própria página).** [lido, `exper-first-exper`, 24/11/2026]
- "Questions aren't choices. Questions require responses they must be answered before users can proceed." E: "Choices are optional."
- "Limit first experiences to tasks and settings required to use a program or feature, and only include these when there is no better alternative."
- Exceção para o nome: "Add personalization or program customization settings to the first experience if their customization is part of the core experience or crucial to the user's personal identification with the program." O exemplo da própria página é o nome do computador e o fundo de tela, pedidos "because these settings help form an emotional connection to the product".
- "Prefer optional tasks and settings to required tasks and settings. Avoid forcing users to configure your program."
- "Start simple. Begin with simple, personalization settings and progress towards more complex, technical tasks and settings."
- "Don't present everything all at once."
- "Present first experiences full screen only if users can't productively perform other tasks. [...] Most first experiences shouldn't be full screen."
- "Reconsider presenting tutorials during the first experience."
- "Require users to opt in for: [...] Features that reveal personally identifiable information (PII) or system information."
- "If the need for personal information isn't obvious, explain why your program needs the information and how it will be used."

**NN/g, mobile-app onboarding (21/06/2020).** [lido]
- "Skip Onboarding Whenever Possible."
- "Even if users decide to skip your onboarding, they still have to click or tap to do so." E: "ensure there's a highly visible Skip option" (para tutoriais em cartas).
- "Instructional onboarding should be brief, optional, and should only highlight the minimum that users need to know."
- Sobre pedir dados: "Consider whether you truly need this information for a user to get started and be successful in the app." E: "Explain why you want that data and how it will be used." E: "This information should be gathered later, once the user can better understand why it's necessary."

**NN/g, "Customization" (14/08/2016).** [lido]
- Perguntas cedo: "it's best not to interrupt their early interactions by asking questions or requesting information."
- A exceção: "One exception is when a small set of questions will streamline the experience significantly for users." Com um motivo curto para cada uma.

**NN/g, "'Get Started' Stops Users" (20/08/2017).** [lido]
- "Don't ask for too much too soon."
- "Give people the information they need before asking them to answer multiple screens of questions."

**NN/g, "Personalization" (02/10/2016).** [lido]
- "Personalization is your best guess at what would be helpful to users based on user characteristics or past behaviors."
- "we need to make sure that users can override these personalized settings if they go against their needs."

### 2. Movimento, durações e movimento reduzido

**WCAG 2.2, SC 2.3.3 (AAA).** [lido]
- Texto: "Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed."
- Definição de animação de movimento: "addition of steps between conditions to create the illusion of movement or to give a sense of a smooth transition." A própria definição do Understanding diz que mudança de cor, desfoque ou opacidade **não** é animação de movimento.
- Understanding: "Take advantage of the reduce motion feature in the user agent or operating system." E: "a control for users to turn off non-essential animations from user interaction."

**WCAG 2.2, SC 2.2.2 (A).** [lido, parcial] Começa com: "For any moving, blinking or scrolling information that (1) starts automatically, (2) lasts more than five seconds, [...]". O restante do critério (pausar, parar ou ocultar) não foi lido.

**MDN, `prefers-reduced-motion`.** [lido]
- "The setting is used to convey to the browser on the device that the user prefers an interface that removes, reduces, or replaces motion-based animations."
- O exemplo do MDN troca a animação de escala por uma de dissolver ("a more muted animation that is not a vestibular motion trigger").

**Microsoft Learn, "Timing and easing" (18/09/2024).** [lido]
- Durações padrão do WinUI 3: `ControlNormalAnimationDuration` 250 ms; `ControlFastAnimationDuration` 167 ms; `ControlFasterAnimationDuration` 83 ms.
- Entrada: "Fast Out, Slow In", `cubic-bezier(0, 0, 0, 1)`: "Use for objects or UI entering the scene, either navigating or spawning."
- Saída: "Slow Out, Fast In", `cubic-bezier(1 , 0 , 1 , 1)`: "Use for UI or objects that are exiting the scene."

**Fluent 2, "Motion" (página de conceito).** [lido]
- "Give larger elements more time to animate than smaller elements." E: "Keep durations short and the movement natural."
- "Design for and include a 'no motion' setting for your app or website as recommended by the WCAG."
- Os nomes de easing (linear, ease-in, ease-out, ease-in-out) estão lá; os milissegundos, não.

**Não verificado:** as durações do Fluent 2 em milissegundos (tokens ultra-fast, fast, normal, slow). A busca não achou a tabela oficial; o único número oficial que achei é o do WinUI 3, acima. As durações do Material também não foram conferidas (ver Fontes).

### 3. Campo de nome

**MDN, `autocomplete`.** [lido]
- `name`: "The field expects the value to be a person's full name."
- `given-name`: "The given (or "first") name."
- `nickname`: "A nickname or handle."
- `off`: "In most modern browsers, setting autocomplete to "off" will not prevent a password manager from asking [...]." Não é o caso aqui.

**MDN, `inputmode`.** [lido] `text` é o padrão: "Standard input keyboard for the user's current locale." `none` não serve: "No virtual keyboard. For when the page implements its own keyboard input control." A página diz também que `inputmode` "doesn't cause any validity requirements to be enforced on input."

**MDN, `enterkeyhint`.** [lido] Valores: `enter` ("Typically inserting a new line."), `done` ("Typically meaning there is nothing more to input and the input method editor (IME) will be closed."), `go`, `next` ("Typically taking the user to the next field that will accept text."), `previous`, `search`, `send`.

**W3C, "Personal names around the world".** [lido]
- "it will be simpler, where it is possible, to just use the full name as the user provides it."
- "Don't assume that a single letter name is an initial."
- "Make input fields long enough to enter long names, and avoid limiting name field sizes in the database."
- "Allow the user to enter a name with spaces."
- "Don't normalize the casing in names." E: "Don't require names to be entered all in upper case."
- "Don't assume that members of the same family will share the same family name." E: "don't require that people supply a family name."

**Base UI, `Field`.** [lido, parcial]
- `Field.Label`: "An accessible label that is automatically associated with the field control. Renders a `<label>` element."
- `Field.Description`: "A paragraph with additional information about the field. Renders a `<p>` element." No código (`FieldDescription.tsx`), o componente registra o próprio id no contexto do campo (`setMessageIds((v) => v.concat(id))`), e tira o id quando sai.
- `validationMode` do `Field.Root` tem padrão `'onSubmit'` (opções `onSubmit`, `onBlur`, `onChange`).
- **Não verificado:** a montagem do `aria-describedby` no controle. O `FieldControl.tsx` passa as props ao hook `validation.getValidationProps`, cujo código não foi lido. O que a página e o código lidos confirmam é o rótulo associado e o id da descrição registrado; a ligação final fica como não verificada.

### 4. Diálogo de sugestão (supervisor opcional)

**WAI-ARIA APG, "Modal Dialog Pattern".** [lido]
- "Escape: Closes the dialog."
- "Generally, focus is initially set on the first focusable element." E a página acrescenta que a melhor posição depende da natureza e do tamanho do conteúdo.
- "The element that serves as the dialog container has a role of dialog."
- aria-modal: "The dialog container element has aria-modal set to true." E o aviso: marque como modal só quando o código da aplicação bloqueia toda interação com o conteúdo de fora e o estilo visual o esconde.

**WAI-ARIA APG, "Alert Dialog".** [lido, parcial] O papel `alertdialog` é "designed for dialogs that divert users' attention to a brief, important message." Não serve para uma sugestão.

**Microsoft Learn, "Dialogs and flyouts" (13/10/2026).** [lido]
- "dialogs should be reserved for situations where you want the user to drop everything to focus on a specific bit of information or answer a question. Flyouts, on the other hand, can be used when you want to call attention to something, but it's ok if the user wants to ignore it."
- "Dialogs are modal (blocking)".
- Flyout: "can be quickly dismissed by tapping or clicking somewhere outside the flyout, pressing the Escape key".
- "Consider the importance of the information you want to share: is it important enough to interrupt the user?"

**Microsoft Learn, "Dialog controls" (15/07/2026).** [lido]
- "All dialogs should contain at least one safe action button to close the dialog."
- Botões: "Use specific responses to the main instruction or content as button text." Exemplo: "Allow" e "Block".
- "The 'do it' action button(s) should appear as the leftmost buttons. The safe, nondestructive action should appear as the rightmost button."
- "DefaultButton [...] The button will receive focus automatically when the Dialog is opened unless the dialog's content contains focusable UI." O botão padrão responde ao Enter.
- "Ensure that the text of the action buttons is concise."

**Microsoft Learn, "Writing style" (27/06/2026).** [lido]
- "Make sure that your buttons are clear answers to the question posed by the title, and that their format is consistent across your app."
- "Use periods to end full sentences in tooltips, error messages, and dialogs." E: "Don't end text for buttons, radio buttons, labels, or checkboxes with a period."
- "Be warm and relaxed"; "Always address the user as 'you.'"; "Use sentence case" (no título e nos rótulos: "Start of every sentence, label, and title").

### 5. Estado do Suup (repositório)

- **Primeira abertura hoje** (`docs/DESIGN.md` §3d, linhas 191 a 202): `FirstRunScreen` com duas escolhas ("Usar neste computador" e "Conectar à minha VPS"), depois `LocalScreen` (chave), depois "Iniciando o Suup…". A tela é um `WelcomeCard` no meio da janela, sem barra lateral. A linha 195 diz "nada guardado neste dispositivo".
- **Principal criado pelo servidor** (`packages/runtime/src/conversations.ts`, linhas 158 e 177 a 181): `ensureDefaultBot` cria "Principal" com todas as ferramentas e o marca como padrão quando não há bot ativo; é idempotente. Hoje é o que cria o primeiro bot.
- **Principal = supervisor** (`docs/SUPERVISOR.md`, linha 47): "A estrela no avatar do Principal vem de `bot.isDefault`." Revisão noturna, mensagem da manhã, `team_recall` e `delegate` são do Principal.
- **Recepção** (`docs/RECEPCAO.md`): a recepção geral é do Principal (`reception: general`), e a primeira pergunta é "como chamar o usuário". A seção "O que não está feito" diz: "não há campo estruturado de nome; fica 'the user', e o nome vem pelo perfil".
- **Acessibilidade e movimento** (`docs/DESIGN.md` §1, §6, §7): "Movimento reduzido zera as durações (`tokens.css`)" (§7, linha 332); no avatar, movimento reduzido mostra "a pose parada do desenho do dono" (§6, linha 324). "Nada de efeito decorativo" (§1, linha 36).
- **Peças de formulário** (`docs/DESIGN.md` §2a, linha 53): `TextField` é `Field` + `Input`; a validação do Base UI não é usada (`validate`, `validationMode`, `pattern=` não se usam), e o estado inválido vem da tela.
- **Diálogos** (`docs/DESIGN.md` §2a, linha 56): `Dialog`/`Modal` com `aria-modal="true"`, foco no primeiro controle, Tab preso, Esc e clique fora fecham o de cima.

## Inferências

Rotuladas: são conclusões minhas, não afirmações das fontes.

1. **O nome é a única pergunta que as diretrizes aceitam logo de cara.** A Microsoft põe o nome do computador na exceção de "personalização crucial para a identificação pessoal"; a NN/g pede só o que a pessoa precisa para começar e poucas perguntas. Uma pergunta (nome) cabe; a lista de perguntas da recepção (`RECEPCAO.md`) não cabe antes do app.
2. **Pular precisa ser visível, e não penaliza.** Vale para a boas-vindas e para o campo do nome, que deve ser opcional (a NN/g pede "highly visible Skip" e a Microsoft prefere "optional tasks and settings"). Se o nome ficar vazio, o Principal pergunta na recepção, uma vez, e não repete quando o nome já existe.
3. **O "Crie seu bot" deve sair com padrões escolhidos.** A Microsoft manda "choose safe, secure, convenient defaults" e "Don't present everything all at once". Avatar e cor já escolhidos, e o campo de descrição com um exemplo.
4. **O diálogo do supervisor é o ponto mais fraco desenhado pelo dono, em face das diretrizes.** A Microsoft reserva o diálogo para "drop everything" e diz que sugestão ignorável é flyout; o APG diz que modal só quando bloqueia tudo. Isso não proíbe o diálogo (é decisão do dono), mas o texto e o comportamento precisam ser os de um diálogo que se pode dispensar sem custo (ver recomendação 4).
5. **Animação curta e sem laço cumpre a WCAG 2.2.2 sem controle extra.** Se a sequência inteira assenta em até 5 segundos e o olhar do bot para de se mexer ao fim, o critério sobre movimento que dura mais de 5 segundos não se aplica. Um laço de "respiração" ou de olhar, sem fim, precisa de pausa ou de parada ao fim da sequência (o critério completo não foi lido; ver "não verificado").
6. **Movimento reduzido deve mostrar o texto inteiro de uma vez.** O MDN pede trocar o movimento por algo mais suave (o exemplo é dissolver), e o DESIGN já zera durações. Aqui a sugestão é: sem deslocamento, sem olhar e sem espera entre as linhas (o texto aparece junto).
7. **Os valores de intervalo entre as linhas e de olhar do bot não têm fonte.** Ver as recomendações: são pontos de partida a ajustar a olho, e não valores das diretrizes.
8. **Ordem boas-vindas, servidor, app: contradiz a checagem de "o servidor já tem o nome".** Para saber se o servidor já tem o nome é preciso ter escolhido o servidor. Ou a escolha do servidor vem antes da pergunta do nome (e ela é pulada quando o servidor já tem o nome), ou o nome é digitado antes e enviado depois de o servidor estar de pé. Isto é decisão do dono (ver a seção de contradições).

## O que não foi verificado

- **Apple HIG** (onboarding, alerts, motion): não abriu o corpo das páginas; nada citado dela. Sem isso, não há citação de Apple sobre quantidade de passos, pular ou alertas.
- **Material Design** (onboarding, motion, durações e easing de M3): só o título em todas as páginas; nada citado.
- **Durações do Fluent 2 em milissegundos**: não encontrei a tabela oficial. Uso só os valores do WinUI 3 (250, 167 e 83 ms), que são Microsoft.
- **Intervalo entre linhas, duração do olhar do bot, deslocamento em pixels**: nenhuma fonte lida dá esses números. São valores de partida, não fato.
- **WCAG 2.2.2 completo**: li só o começo do critério (5 segundos). Pausar, parar e ocultar, com as exceções, não foram lidos.
- **Base UI, ligação do `aria-describedby` no controle**: não confirmei no código do hook de validação (ver Fatos, 3).
- **Base UI, comportamento de `validationMode` com `onSubmit`** para um campo sem validação: não testado, e o DESIGN não usa a validação do Base UI.
- **APG, padrão `alertdialog` em detalhe**: a página lida não o descreve.
- **Guia Win32 de primeira experiência**: é de Windows 7 (2020), e a própria página avisa que a apresentação não reflete a atual; os princípios valem em parte.
- **Artigo de NN/g sobre "perguntas de personalização" em onboarding**: não achei um artigo com esse título; usei os três artigos acima, que tratam do tema.
- **Taxa de desistência por número de perguntas, ou número de passos ideal**: nenhuma fonte primária lida dá o número. Ver também a pesquisa anterior (`fase-4-recepcao-inicial.md`), que não achou esse número em artigo lido.

## Implicação para o Suup

### Recomendações práticas

**1. Boas-vindas: uma pergunta, opcional, com saída visível.**
- Ordem: "Olá, tudo bem?" → "Seja muito bem-vindo ao Suup…" → "Como você quer ser chamado?" → campo → "Continuar". Sem barra lateral, num `WelcomeCard`.
- Rótulo do campo: "Como você quer ser chamado?" (o texto do dono). Descrição, apagada, abaixo: uma frase curta sobre onde muda depois, por exemplo "Pode ser um apelido. Você muda em Configurações." (texto nosso, a confirmar).
- Atributos: `autocomplete="nickname"` (não `name`, porque o campo pede o nome como a pessoa quer ser chamada, não o nome completo; o MDN define `nickname` como "A nickname or handle"); sem `inputmode` (o padrão `text` serve); `enterkeyhint="done"` (o MDN diz que `done` é "nothing more to input"; é a única pergunta da tela).
- Sem validação de formato: aparar espaços, não trocar maiúsculas e minúsculas (W3C: "Don't normalize the casing"), aceitar espaços e acento, nenhuma regra de "nome e sobrenome" (W3C: "don't require that people supply a family name"). Limite de tamanho alto e explícito, para o banco (inferência: 100 caracteres), sem cortar em silêncio.
- Usar a peça `TextField` (`Field` + `Input`, DESIGN §2a). Estado inválido vindo da tela; nada de `pattern=` nem `validate`.
- O campo é opcional, com "Pular" visível ao lado de "Continuar". Se a pessoa pular, a recepção do Principal pergunta o nome uma vez.

**2. Animação: curta, uma linha por vez, e com saída para o movimento reduzido.**
- Cada linha: opacidade de 0 a 1 e um deslocamento de baixo para cima, **250 ms** (`ControlNormalAnimationDuration`) com `cubic-bezier(0, 0, 0, 1)` (entrada, Fluent). Deslocamento pequeno, em torno de 8 a 12 px (inferência).
- Intervalo entre as linhas: **300 a 400 ms** (inferência, sem fonte; ajustar a olho). A sequência de texto inteira assenta em **até 5 segundos**, para o critério 2.2.2 não exigir pausa.
- Olhar do bot (esquerda, direita, frente): cada movimento em **167 ms** (`ControlFastAnimationDuration`), com `cubic-bezier(0, 0, 0, 1)`, e uma pausa de cerca de 500 a 600 ms em cada ponto (inferência). Ao fim da sequência o bot fica parado na frente e para de se mexer; sem laço.
- Saída da boas-vindas para a escolha do servidor: **167 ms** com `cubic-bezier(1, 0, 1, 1)` (saída, Fluent), por opacidade (WCAG: a opacidade não é animação de movimento).
- Movimento reduzido (o do sistema ou o do app, DESIGN §7): sem deslocamento, sem olhar, sem espera entre as linhas; o texto aparece inteiro, o bot na pose parada (DESIGN §6). Isso é a troca do MDN por algo mais suave, e não só zerar.
- Tudo o que muda na tela por opção do usuário vai para Configurações quando for o caso (DESIGN §1: "Todo comportamento é configurável"); a animação em si não precisa.

**3. Ordem dos passos e o que se repete.**
- Boas-vindas (nome, opcional) → escolha do servidor (já existe) → app. Ver a contradição 1 sobre a ordem.
- "Crie seu bot": tela cheia do app, com **avatar grande**, **formas**, **cores** e o nome já com padrões. O campo de descrição tem um exemplo no lugar do texto ("Ex.: me ajuda a organizar a agenda da semana"), e a descrição pode ficar vazia (inferência: o modelo escreve a personalidade a partir do nome; a decisão de exigir a descrição é do dono).
- Rótulos com a linguagem do usuário, como manda a Microsoft ("Express questions and options in terms of users' goals"): "Nome do bot", "O que ele faz para você?" (não "descrição").
- Botão principal "Criar bot", **desligado** sem nome (o mesmo padrão do segredo, DESIGN §3, "Enviar só liga com algo digitado").
- Sem supervisor no primeiro passo (decisão 3 do dono).

**4. Diálogo do supervisor (opcional, dispensável, sem custo).**
- Papel `dialog` (não `alertdialog`: não é uma mensagem urgente, APG). `aria-modal="true"`, porque a interface atrás fica bloqueada, como as outras modais do DESIGN.
- Título em forma de pergunta, que responde aos botões (Microsoft: "call and response"): "Quer um supervisor para a equipe?". Corpo: **uma frase** com ponto final, por exemplo "Com um supervisor, a equipe fica mais produtiva: ele acompanha o que os bots fazem e leva trabalho de um para outro." (texto nosso; confirmar que bate com `docs/SUPERVISOR.md`).
- Rosto de um bot no centro, como o dono pediu (com a forma de um bot criado; sem novo desenho).
- Botões: **"Ligar supervisor"** à esquerda (ação primária, texto específico, sem ponto final) e **"Agora não"** à direita (ação segura, Microsoft: "rightmost"). Os dois valem: recusar não é erro e aceitar não é "ativar sem olhar".
- **Foco inicial no "Agora não"** (o padrão do Windows deixa o foco no primeiro controle ou no padrão; aqui escolhemos o seguro, e o APG diz que a posição depende do conteúdo). O Enter não deve ligar um supervisor por engano. Não usar o botão padrão do Windows para "Ligar".
- Esc, o X e o clique fora fazem "Agora não" (o mesmo efeito). Registrar a recusa para não voltar a perguntar na mesma criação (Microsoft recomenda não repetir o aviso com frequência, em "Ways to avoid using dialogs").
- Ligar o supervisor é **opt-in**: o padrão é desligado, e o supervisor só vira ativo com o clique (Microsoft: "Require users to opt in for [...] features that reveal personally identifiable information"; o supervisor lê o diário e as notas).
- Mudanças no DESIGN: o diálogo novo entra em §2a/§3c no mesmo commit (regra de `CLAUDE.md`).

**5. Nome guardado no servidor.**
- Campo estruturado (migração nova) e leitura pelo prompt, em vez do perfil livre. Hoje `RECEPCAO.md` diz que não há campo; a decisão 4 do dono muda isso e o doc precisa mudar no mesmo commit.
- Enquanto o servidor não existe (o embutido ainda está subindo), o nome fica só na memória do app e vai ao servidor quando ele responde; se o app fechar antes, a pessoa digita de novo (inferência; sem perder dado, mas sem gravar localmente, como o DESIGN §3d pede).

### Contradições com o plano e com as decisões

**Contradição 1 (ordem da boas-vindas x "pular se o servidor já tem o nome").** A decisão 1 coloca a boas-vindas antes da escolha do servidor; a decisão 4 pede para pular a boas-vindas quando o servidor já tem o nome, o que só se sabe depois de escolher o servidor. Opções para o dono: (a) escolher o servidor primeiro quando já existe um (segundo dispositivo) e a boas-vindas vem depois, só se o nome faltar; (b) manter a boas-vindas primeiro e checar o nome logo que o servidor responde, pulando o resto. A opção (a) é a que a Microsoft recomenda, e a mais simples: "Start simple". **Precisa de decisão do dono.**

**Contradição 2 (o servidor não cria mais o Principal x o código e os docs atuais).** `packages/runtime/src/conversations.ts` (linhas 177 a 181) cria o "Principal" quando não há bot ativo; `docs/PLANO.md` §4.5 e `docs/RECEPCAO.md` pressupõem que o Principal existe, e a recepção geral (`reception: general`), o `propose_team` e o `team_recall` são dele. A decisão 2 quebra isso. Três pontos para o dono: (a) o primeiro bot criado pela pessoa é o padrão? (b) sem supervisor, a recepção geral e o `propose_team` ainda existem? (c) o que acontece com o `DEFAULT_BOT_*` e o teste de idempotência. **Precisa de decisão.**

**Contradição 3 (supervisor opcional x supervisor = Principal = `isDefault`).** `docs/SUPERVISOR.md` (linha 47) liga a estrela (`bot.isDefault`) ao Principal e a todas as funções de supervisor a ele. A decisão 3 diz que o supervisor só existe se a pessoa ligar. Se o supervisor continuar sendo o bot padrão, ligar o supervisor vira "marcar o padrão" e o padrão vira um papel escolhido. Recomendação: separar o papel "supervisor" da marca de padrão, ou manter o padrão e tratar "supervisor ligado" como um interruptor à parte. **Precisa de decisão e de mudança em `SUPERVISOR.md`.**

**Contradição 4 (o nome é pergunta da recepção x a decisão 4).** `docs/RECEPCAO.md` (seção "Principal") manda o bot perguntar "como chamar o usuário" e diz que não há campo de nome. Com o campo estruturado, a pergunta do nome na recepção só cabe quando o campo estiver vazio (ver a recomendação 1). **Mudança em `RECEPCAO.md` e no prompt "First conversation".**

**Contradição 5 (diálogo do supervisor x Microsoft).** O dono decidiu um diálogo. A Microsoft reserva o diálogo para situações em que a pessoa precisa parar e diz que sugestão ignorável é flyout. Isto **não** impede o diálogo (é decisão do dono), mas se o dono quiser o comportamento de sugestão ignorável, o caminho é um flyout ou um cartão na tela de Equipe, e não um modal. Recomendação: manter o diálogo com "Agora não" seguro e foco inicial nele, e registrar a escolha no DESIGN. **Confirmar com o dono.**

**Contradição 6 (ordem da primeira abertura x DESIGN §3d e PLANO §4.12a).** `docs/DESIGN.md` §3d e `docs/PLANO.md` §4.12a descrevem a primeira abertura começando pela escolha de servidor (`FirstRunScreen`). A boas-vindas é uma tela nova antes dela. Mudar §3d e §4.12a no mesmo commit.

**Contradição 7 (animação e DESIGN §1, "Nada de efeito decorativo").** O olhar do bot e a entrada linha a linha são decorativos, por definição. A decisão do dono é explícita, então não há conflito de princípio; o DESIGN precisa dizer qual movimento a boas-vindas usa e que o movimento reduzido mostra o texto inteiro de uma vez (recomendação 2). Mudar §1 ou §6 no mesmo commit.

**Não contradiz:**
- A regra de aprovação e o cofre: o campo de nome não é segredo e não passa pelo cofre (o DESIGN e o `COFRE.md` não mudam).
- A regra de não validar por regex (`docs/REGRAS.md` §1): o campo de nome não tem validação de formato, o que segue a regra e a W3C.
- O princípio de pesquisa antes de implementar: esta pesquisa cumpre a regra, e as contradições 1 a 7 precisam de decisão antes do código.

### Próximo passo

Antes de escrever código: decidir as contradições 1 a 3 (ordem, Principal e supervisor), que mudam o desenho do servidor e do app. As demais são textos e ajustes de DESIGN e RECEPCAO, que entram no mesmo commit da mudança.
