# Pesquisa: motor do segundo avatar (os mascotes pixelados)

Data da pesquisa: 19/11/2026. Apoia a entrega "motor gráfico do 2º estilo de avatar" (`packages/avatar/src/pixel/`). Escrita antes do código, como pede `docs/REGRAS.md` §2.

## Pergunta

Como desenhar, no navegador (webview do Tauri), sprites de pixel de uma grade pequena (19 x 19) nítidos em qualquer tamanho e em telas de alta densidade, animados por um relógio compartilhado e respeitando "reduzir movimento"? E como o motor atual (formas, "Estilo Grok — motor Atlas") anima, para o segundo estilo seguir a mesma API e o mesmo ritmo de custo?

## Fontes

Lidas em 19/11/2026 pelo repositório oficial da MDN (`mdn/content`, ramo `main`, via `raw.githubusercontent.com`); o site `developer.mozilla.org` não foi aberto. As páginas não trazem data de publicação própria.

- `CanvasRenderingContext2D.imageSmoothingEnabled`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/canvasrenderingcontext2d/imagesmoothingenabled/index.md
- CSS `image-rendering`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/properties/image-rendering/index.md
- `Window.devicePixelRatio`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/window/devicepixelratio/index.md
- `ResizeObserverEntry.devicePixelContentBoxSize`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/resizeobserverentry/devicepixelcontentboxsize/index.md
- `ResizeObserver`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/resizeobserver/index.md
- `prefers-reduced-motion`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/at-rules/@media/prefers-reduced-motion/index.md
- Código local lido: `packages/avatar/src/runtime/ticker.ts`, `runtime/avatar-runtime.ts`, `engine.ts`, `states.ts`, `browser.ts`; `apps/desktop/src/ui/mascot.tsx`, `lib/reduced-motion.ts`.
- O desenho: arquivo Figma `c1FraH70ehfVHADeOXKspp`, páginas `0:1` ("Mascotes") e `5:2` ("Animação — folha"), lidas pela API de plugin (`use_figma`) em 19/11/2026.

## Fatos verificados

1. **Canvas:** `imageSmoothingEnabled` decide se imagens ampliadas são suavizadas (padrão `true`). A MDN diz que a propriedade serve a jogos e apps de pixel art, e que com `false` os pixels mantêm a nitidez ao ampliar (página `imageSmoothingEnabled`). Para retângulos preenchidos (`fillRect`) não há imagem a ampliar; o que borra é uma coordenada fracionária (inferência, ver abaixo).
2. **CSS:** `image-rendering` define o algoritmo de escala de imagens quando o tamanho de exibição difere do natural; "não tem efeito em imagens não escaladas" (página `image-rendering`). Os valores listados no exemplo oficial incluem `auto`, `smooth`, `crisp-edges` e `pixelated`.
3. **Densidade:** `devicePixelRatio` é a razão entre pixels físicos e pixels CSS; 1 = tela clássica, 2 = HiDPI/Retina; o zoom da página muda o valor; pode mudar se a janela vai para outra tela, e a MDN indica `matchMedia` para detectar (página `devicePixelRatio`). A MDN mostra o padrão de corrigir o `canvas` borrado em Retina multiplicando o tamanho do buffer por `devicePixelRatio`.
4. **Tamanho em pixels de dispositivo:** `ResizeObserverEntry.devicePixelContentBoxSize` devolve o tamanho da caixa de conteúdo em pixels do dispositivo (matriz de `{ inlineSize, blockSize }`); `ResizeObserver` avisa mudanças de tamanho do elemento (páginas homônimas). Suporte nas webviews do Tauri: não verificado (ver abaixo).
5. **Movimento reduzido:** `prefers-reduced-motion: reduce` indica que a pessoa pediu o mínimo de movimento não essencial; ampliar e deslocar objetos grandes pode causar desconforto vestibular (página `prefers-reduced-motion`).
6. **Motor atual (lido no código):**
   - Um `createTicker(env)` compartilhado: um laço `requestAnimationFrame` para todos os avatares, que **dorme** quando todos assentam (acorda por um único timer), **pausa** com a aba oculta e, por avatar, fora da tela (`IntersectionObserver`). O ambiente (rAF, relógio, DOM) é injetado; o núcleo não toca em `window`, `document`, `performance` nem `Date` (`architecture.test.ts` confere).
   - O ticker é preso ao `AvatarEngine` (olhar, mola, `Frame` de contorno SVG). Um avatar de pixel não tem nada disso.
   - O `Mascot` do app desenha o SVG de `renderStill` e o ticker reescreve os atributos; sem animação (movimento reduzido, tamanho `xs`, `still`) fica a imagem parada. A cor do bot (`BOT_PALETTE[cor].fill`) entra em `createCharacter({ color })` e pinta o corpo; o olho contrasta por luminância (`eyeColorFor`).
7. **O desenho do dono (Figma):**
   - 17 personagens x 10 estados, cada variante um quadro de 236 x 236 com 12 x 12 por célula, em `x,y = 4 + 12k`; grade de 19 x 19; um único retângulo por célula, sem sobreposição, só quatro nomes de camada (corpo, olho, acessório, lâmpada) e cores sólidas. A cor do corpo é uma só por personagem; olho `#ffffff`, acessório `#1b1f3b`, lâmpada `#ffd23f`.
   - Animação só da folha (página `5:2`), 22 quadros em 10 estados, com reações do protótipo: espera (`AFTER_TIMEOUT`, 120 a 1400 ms) e transição `SMART_ANIMATE` (0 a 900 ms; curvas ease in-out e ease out). O sprite sobe 4 unidades (um terço de célula) no segundo quadro de oito estados; o terceiro quadro de "Parado" é o piscar (a linha de cima dos olhos some); "Pensando" acende os pontos aos poucos; "Teve uma ideia" alterna os raios (amarelo) e o brilho (`#fff0a8`); "Trabalhando" pisca o cursor do terminal.

## Inferências

- **Escala inteira.** Para a grade ficar nítida cada célula tem de ocupar um número inteiro de pixels de dispositivo: `célula = floor(lado em px de dispositivo / 19)`, no mínimo 1, e o desenho é centralizado com deslocamento inteiro. Com `fillRect` em coordenadas inteiras não há suavização a controlar; `imageSmoothingEnabled = false` fica ligado por segurança (e vale se um dia houver `drawImage`). Em SVG, `shape-rendering: crispEdges` evita a suavização, mas a escala não é inteira; por isso o desenho animado usa canvas e o SVG fica para imagem parada (impressão, notificação, teste).
- **Alta densidade.** O buffer do canvas mede `lado CSS x devicePixelRatio` e o estilo CSS mede `lado CSS`; assim uma célula vira `floor(buffer / 19)` pixels físicos. Ler o tamanho em pixels de dispositivo (`devicePixelContentBoxSize`, ou `getBoundingClientRect() x devicePixelRatio` onde faltar) e refazer ao mudar o tamanho ou o `devicePixelRatio`.
- **Relógio.** Como o ticker atual é do `AvatarEngine`, o motor de pixel ganha um relógio compartilhado próprio, com o mesmo contrato do ambiente (`TickerEnv`: rAF, aba oculta, visibilidade): um laço para todos os avatares de pixel, sem timers por avatar; só redesenha quando o quadro muda (a posição em pixels inteiros e a grade), ~30 quadros por segundo no máximo (os movimentos são degraus de poucos pixels), pausa fora da tela e com a aba oculta.
- **Movimento reduzido.** Imagem parada = a variante estática do Figma (a pose completa de cada estado, com o símbolo inteiro), sem o balanço de um terço de célula, sem piscar e sem os pontos que acendem. Os estados continuam distinguíveis só pelo símbolo.
- **Cor.** Seguir o estilo atual: se o bot tem cor própria, ela pinta o corpo (e os pontos de "pensando", que no Figma são da cor do corpo); sem cor própria vale a cor do desenho do dono. Olho e símbolo seguem o Figma; só quando o corpo é muito claro (ou muito escuro) o olho troca para manter contraste, como o motor atual faz.
- **Animação dos outros 16.** O dono desenhou o movimento só da folha. Todo quadro da folha é o mesmo desenho estático da folha mais (a) um deslocamento vertical de -4 unidades, (b) o símbolo do estado (idêntico nos 17 personagens: as variantes estáticas confirmam, a menos dos olhos) e (c) o piscar. Isso se aplica a qualquer personagem sem inventar arte: só se reutilizam deslocamento, símbolo e a regra "a linha de cima do olho vira corpo".
- **Smart animate.** O protótipo interpola a posição entre quadros; em pixel o deslocamento é arredondado para pixels inteiros (degrau) e as células trocam no meio da transição.

## O que não foi verificado

- Suporte a `devicePixelContentBoxSize` nas webviews do Tauri (WebKitGTK, WebView2, WKWebView): a MDN diz o que a propriedade faz, mas a tabela de compatibilidade não foi lida (é gerada por `browser-compat`). O código usa a medida do elemento x `devicePixelRatio` como base e o `ResizeObserver` só para saber quando refazer.
- Os valores exatos da curva "ease in-out"/"ease out" do Figma (`SMART_ANIMATE`): a API devolve só o nome; o motor usa as curvas CSS padrão com o mesmo nome (`cubic-bezier(0.42, 0, 0.58, 1)` e `cubic-bezier(0, 0, 0.58, 1)`), por equivalência de nome, não por leitura de uma especificação do Figma.
- O desempenho com dezenas de avatares: medido só nos testes do motor (contagem de redesenhos), não em aparelho real.
- Estado "dormindo" e "comemorando" do motor atual não têm arte pixel; "Levou bronca" e "Teve uma ideia" do Figma não têm estado público no motor atual (ver o mapa em `packages/avatar/README.md`).

## Implicação para o Suup

Não contradiz o plano. Decisões: (1) um módulo `pixel/` ao lado do motor de formas, mesma API pública (`createPixelCharacter`, `pixelStill`, `drawPixelFrame`, relógio compartilhado), dados gerados do Figma por script; (2) canvas com escala inteira e `devicePixelRatio` para o animado, SVG de retângulos com `crispEdges` para o parado; (3) movimento reduzido = variante estática; (4) a escolha do estilo e do personagem é guardada no servidor junto do bot (coluna `avatar_style`), e bots antigos ficam no estilo de formas.
