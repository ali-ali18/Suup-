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
