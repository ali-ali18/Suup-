# @suup/avatar

Motor procedural de avatares: o "icone" de cada bot e um corpo (forma) + cor + dois olhos, desenhado por codigo como dados SVG e animado quadro a quadro. Sem imagens, sprites, canvas ou 3D de biblioteca.

**Zero dependencias**, sem DOM, React nem APIs so de Node no nucleo: roda em webview, em testes no Node e num runtime mobile. O motor nunca le o relogio nem `requestAnimationFrame`: quem hospeda passa o tempo (ou um agendador). O unico modulo que toca o navegador e `src/browser.ts` (entrada `@suup/avatar/browser`).

## API publica

```ts
import { createCharacter, renderStill, createAvatarRuntime } from "@suup/avatar";

// Identidade: sem forma/cor, o `id` escolhe de forma estavel.
const bot = createCharacter({ id: "bot-42", color: "blue" });

// Imagem estatica (string SVG), para listas, miniaturas, notificacoes:
const svg = renderStill(bot, "done", { size: 40 });

// Animado: o host passa o tempo (ms, relogio monotonico qualquer).
const rt = createAvatarRuntime(bot, { reducedMotion: false });
rt.setState("working");
const data = rt.frame(performance.now()); // data.body, data.eyes, data.transform, data.parts, data.svg()
rt.dispose();
```

| Funcao | O que faz |
|---|---|
| `createCharacter({ id, shape?, color? })` | Dados puros do personagem. `color` aceita id da paleta ou CSS. Valores invalidos caem no padrao do `id`. |
| `renderStill(character, state?, { size? })` | String `<svg>` da pose de repouso do estado (so o rosto muda; sem animacao nem indicador). |
| `createAvatarRuntime(character, opts?)` | `{ setState, setGaze, poke, blink, setReducedMotion, frame(timeMs), isSettled, nextWakeMs, frameIntervalMs, dispose }`. |
| `runtime.tickerEntry(onData)` | `{ engine, apply }` para `ticker.register({ ...entry, follow, getCenter, element })`: o runtime anda no ticker compartilhado e cada quadro chega a `onData` como `AvatarRenderData`. Mude estado e olhar pelo runtime dentro de `handle.interact(...)`. Não misture com `frame()` no mesmo runtime. |
| `createFrameLoop(runtime, schedule, onFrame)` | Laco simples de um avatar com agendador injetado (`schedule(cb) => cancel`). |
| `createTicker(env)` | Laco compartilhado para muitos avatares (dorme quando tudo assenta, pausa fora da tela ou aba oculta). Ambiente injetado (`TickerEnv`). |
| `SHAPE_IDS`, `AVATAR_COLORS`, `AVATAR_STATES`, `STATE_MAP` | Catalogos para seletores e documentacao. |

`AvatarRenderData` e dado puro: `viewBox`, `transform` do grupo do corpo, `body` e `eyes` (atributo `d`), `color`, `eyeMode` (`cutout`: olhos furados no corpo; `paint`: pintados com `eyeColor`), `parts` (ate 5 `<circle>` do indicador, sempre 5 entradas, as vazias escondidas) e `svg(size?)` com o SVG completo do quadro.

### Entrada `@suup/avatar/browser`

`createRafScheduler()` (`requestAnimationFrame` com checagem de recurso, `null` se faltar), `browserNow()`, `prefersReducedMotion()`, `watchReducedMotion(cb)`, `createBrowserEnv()` e `getTicker()` (ticker compartilhado com ponteiro, visibilidade da aba e `IntersectionObserver`).

## Formas (25)

blob, pebble, bean, egg, squircle, tablet, capsule, cylinder, hex, gem, crystal, wedge, shield, dome, arch, cloud, teardrop, leaf, square, sparkle, clover, flower, heart, house, star

Dados em `src/data/shapes.ts` (ids, subconjunto sorteavel por id, contornos livres, tamanhos), `src/data/eye-fit.ts` (olhos por forma) e `src/data/solid-kinds.ts` (como cada forma vira solido 3D).

## Cores (11)

| id | valor |
|---|---|
| `black` | #000000 |
| `brown` | #936439 |
| `red` | #FF263C |
| `orange` | #FF6700 |
| `yellow` | #FF9800 |
| `green` | #00C972 |
| `cyan` | #00BCA6 |
| `blue` | #1084FE |
| `violet` | #9159FE |
| `magenta` | #FF309B |
| `gray` | #777777 |

Dados em `src/data/palette.ts`. O sorteio por `id` nunca escolhe `black` (so por escolha explicita).

## Estados publicos

O host escolhe um destes; o mapa para os estados internos fica em `src/states.ts` (`STATE_MAP`) e a tabela de clipes/rosto/indicador em `src/data/states.ts`.

| Estado | Interno | Efeito |
|---|---|---|
| `idle` | `idle` | Repouso: pisca, olha em volta, respira |
| `thinking` | `thinking` | O corpo vira um indicador de pontos |
| `working` | `working` | Clipes de trabalho |
| `waiting` | `waiting` | Indicador em orbita |
| `asking` | `curious` | Olhos "inspecionando" (precisa de voce) |
| `done` | `finished` | Rosto feliz e volta a `idle` sozinho |
| `failed` | `failed` | Clipe abatido e volta a `idle` sozinho |
| `paused` | `listening` | Olhos calmos, sem atividade |
| `sleeping` | `sleeping` | Olhos sonolentos |
| `celebrating` | `celebrate` | Giro de comemoracao |

A ligacao entre eventos do Suup (execucoes, aprovacoes, erros) e estes estados e responsabilidade do app.

## Estilo pixel (os 17 mascotes do dono)

Um segundo estilo, ao lado das formas: os mascotes pixelados desenhados pelo dono no Figma (`c1FraH70ehfVHADeOXKspp`, paginas "Mascotes" e "Animacao - folha"). Mesma ideia (dado puro, sem DOM, o relogio e de quem hospeda), outro desenho: grade de 19 x 19 celulas (a celula mede 12 no Figma, margem 4, quadro 236). Pesquisa: `docs/pesquisas/avatar-pixel.md`.

```ts
import { createPixelCharacter, createPixelPlayer, drawPixelFrame, layoutPixels, pixelStillSvg, pixelStill } from "@suup/avatar";
import { getPixelClock } from "@suup/avatar/browser";

const bot = createPixelCharacter({ id: "bot-42", character: "gato", color: "#1084ff" }); // color: opcional
const player = createPixelPlayer(bot, { state: "thinking", reducedMotion: false });
const layout = layoutPixels(cssSize, devicePixelRatio);       // celula INTEIRA em pixels do aparelho
canvas.width = canvas.height = layout.buffer;
getPixelClock().register({ element: canvas, paint: (now) => drawPixelFrame(ctx, bot, player.frameAt(now), layout) });
const svg = pixelStillSvg(bot, pixelStill(bot, "done"), { size: 40 }); // imagem parada (bordas nitidas)
```

| Funcao | O que faz |
|---|---|
| `createPixelCharacter({ id, character?, color? })` | Escolhe 1 dos 17 (`PIXEL_CHARACTER_IDS`: folha, xicara, gota, nuvem, brasa, gato, broto, estrela, cogumelo, polvo, robo, urso, coruja, lua, fantasma, raposa, cacto). Sem `character`, o `id` decide. `color` (`#rrggbb`) pinta o corpo; sem ela vale a cor do desenho. |
| `createPixelPlayer(character, opts)` | Estado e "desde quando" de um avatar; `frameAt(ms)` devolve o quadro. `reducedMotion` = sempre a pose parada do Figma. |
| `layoutPixels(cssSize, dpr)` / `drawPixelFrame` | Escala inteira (`floor(buffer / 19)` por celula), sem suavizacao, centralizado; so retangulos de coordenadas inteiras. |
| `pixelStill` / `pixelStillSvg` | A pose parada (a variante do Figma) e o SVG dela (`shape-rendering="crispEdges"`). |
| `createPixelClock(env)` / `getPixelClock()` | UM laco de rAF para todos os avatares pixel (~30 quadros/s), pausa com a aba oculta e fora da tela, dorme sem nenhum animado. |

### Estados: mapa do app para as 10 poses do Figma

| Estado publico | Pose (Figma `Estado=`) | Observacao |
|---|---|---|
| `idle` | Parado | balanca, pisca |
| `thinking` | Pensando | os pontos acendem |
| `working` | Trabalhando | cursor do terminal |
| `asking` | Com duvida | "?" |
| `waiting` | Pedindo permissao | "!" |
| `done` | Concluiu | visto |
| `failed` | Falhou | X |
| `paused` | Pausado | olhos fechados e "||" |
| `sleeping` | Parado | **sem arte no Figma**: nao se inventou |
| `celebrating` | Concluiu | **sem arte propria** |
| `scolded` (so pixel) | Levou bronca | sem estado publico no motor de formas |
| `idea` (so pixel) | Teve uma ideia | sem estado publico no motor de formas |

### Animacao

Os tempos vem do prototipo do Figma (espera + transicao de cada quadro, curvas ease in-out e ease out); o dono animou **so a folha**. Para os outros 16 vale a mesma regra aplicada ao desenho estatico de cada um: o balanco (sprite sobe 4 unidades = 1/3 de celula, arredondado para pixels inteiros), o simbolo do estado (identico nos 17) e o piscar (a linha de cima de cada olho vira corpo). Nada de arte nova. Movimento reduzido: a pose parada do Figma.

### Dados

`scripts/figma-pixel.json` guarda o que a API do Figma devolveu (`scripts/figma-extract.figma.txt` e o codigo que roda no Figma); `node packages/avatar/scripts/gen-pixel-data.mjs` gera `src/pixel/data/*.ts` e confere os hashes FNV calculados dentro do Figma. Depois rode `pnpm biome check --write packages/avatar`.

## Como dirigir

- **Estatico (listas, miniaturas):** `renderStill`. Barato e sem laco.
- **Animado:** um runtime por avatar visivel e `frame(timeMs)` a cada quadro do host. O avanço por quadro e limitado a 100 ms (aba lenta nao faz o avatar "pular"); tempo igual ou anterior nao avanca.
- **Reduced motion:** `reducedMotion: true` (ou `setReducedMotion`) devolve sempre a pose de repouso do estado, sem depender do tempo. No navegador use `prefersReducedMotion()` / `watchReducedMotion()`.
- **Muitos avatares:** use `createTicker` (um unico laco, dorme quando todos assentam, pausa com aba oculta e fora da tela), nao um laco por avatar. Deixe `breathe: false` e `brain: false` (padrao do `brain`) nos avatares de lista: assim eles assentam e so piscam. Passe `size`: abaixo de 32 px o avatar fica compacto e abaixo de 64 px nao olha em volta. `brain: true` (movimento continuo de trabalho) e caro: limite com `createBrainBudget(n)` passado em `budget`.
- `frameIntervalMs()` indica o intervalo desejado (cerca de 16 ms em gesto, 33 ms em repouso ativo).

## Como ligar no React (esboço)

```tsx
import { createAvatarRuntime, createCharacter, createFrameLoop, renderStill } from "@suup/avatar";
import type { AvatarStateId } from "@suup/avatar";
import { createRafScheduler, prefersReducedMotion } from "@suup/avatar/browser";

export function Avatar({ id, state = "idle", size = 40 }: { id: string; state?: AvatarStateId; size?: number }) {
  const character = useMemo(() => createCharacter({ id }), [id]);
  const host = useRef<HTMLSpanElement>(null);
  const runtime = useRef<ReturnType<typeof createAvatarRuntime> | null>(null);

  useEffect(() => {
    const schedule = createRafScheduler();
    const svg = host.current?.querySelector("svg");
    if (!schedule || !svg) return; // sem rAF: fica o SVG estatico
    const group = svg.querySelector("g");
    const paths = svg.querySelectorAll("path");
    const rt = createAvatarRuntime(character, { size, reducedMotion: prefersReducedMotion() });
    runtime.current = rt;
    const loop = createFrameLoop(rt, schedule, (d) => {
      group?.setAttribute("transform", d.transform);
      // No SVG de renderStill: paths[0] = olhos (mascara), paths[1] = corpo (modo "cutout").
      paths[0]?.setAttribute("d", d.eyes);
      paths[1]?.setAttribute("d", d.body);
    });
    loop.start();
    return () => {
      loop.stop();
      rt.dispose();
      runtime.current = null;
    };
  }, [character, size]);

  useEffect(() => runtime.current?.setState(state), [state]);

  // Render inicial e SSR: SVG estatico. O laco so reescreve atributos.
  return <span ref={host} dangerouslySetInnerHTML={{ __html: renderStill(character, state, { size }) }} />;
}
```

O esboço e ilustrativo (a ordem dos `path` no modo `paint`, corpo preto/branco, difere): um componente real deve renderizar a estrutura SVG (corpo, mascara dos olhos, ate 5 circulos de `parts`) uma vez e deixar o laco escrever so os atributos que mudam (para varios avatares, `getTicker()` em vez de um laco por componente), sem estado do React por quadro.

## Testes

`pnpm vitest run packages/avatar`. Typecheck dos testes: `pnpm tsc -p packages/avatar/tsconfig.test.json`.

## NOTICE

Ported from the owner's Atlas repository (MIT), commit `a413315`.
