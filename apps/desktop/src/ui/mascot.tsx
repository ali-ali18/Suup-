import { BOT_PALETTE, type BotColor } from "@suup/api";
import {
  type AvatarRenderData,
  type AvatarStateId,
  type AvatarTicker,
  createAvatarRuntime,
  createBrainBudget,
  createCharacter,
  type PixelClock,
  renderStill,
  type ShapeId,
} from "@suup/avatar";
import { getTicker } from "@suup/avatar/browser";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "../lib/cx.js";
import { useReducedMotion } from "../lib/reduced-motion.js";

// O ÚNICO lugar onde o rosto dos bots é desenhado, sobre o motor `@suup/avatar`. Quem chama diz o
// formato, a cor e o estado; aqui se decide se vira imagem parada (`renderStill`) ou animação
// (um runtime no ticker compartilhado, que dorme quando todos assentam). Nada mais no app desenha
// um mascote.

export type MascotSize = "xs" | "sm" | "md" | "lg" | "xl" | "tile";

/** O tamanho de cada `MascotSize` na tela, em px (o motor usa para mexer menos nos pequenos). */
const SIZE_PX: Record<MascotSize, number> = { xs: 16, sm: 28, md: 36, lg: 56, xl: 88, tile: 70 };

/** Quanto tempo o rosto de "concluído" fica antes de voltar ao repouso. */
export const DONE_HOLD_MS = 3500;

/** The colour an animated mascot that repaints is made with: white gives the painted eyes (`resolveEyes`). */
const REPAINT_BASE = BOT_PALETTE.branco.fill;

/** No máximo estes avatares fazem o movimento contínuo de "trabalhando" ao mesmo tempo. */
const BRAIN_BUDGET = createBrainBudget(3);

/**
 * O que o ambiente fornece ao `Mascot`. Em produção nada (ticker do navegador, movimento reduzido
 * lido do app e do sistema); os testes entregam um ticker com relógio falso.
 */
export interface MascotHost {
  ticker?: AvatarTicker;
  /** O relógio dos mascotes pixel (um laço só para todos); em produção o do navegador. */
  pixelClock?: PixelClock;
  reducedMotion?: boolean;
  doneHoldMs?: number;
}

export const MascotHostContext = createContext<MascotHost>({});

export interface MascotProps {
  shape: ShapeId;
  color: BotColor;
  /** O que o bot está fazendo (ver `avatarStateOf`). */
  state?: AvatarStateId;
  size?: MascotSize;
  /** Identidade do avatar (o id do bot): define os tempos de piscar. Sem ela, o formato. */
  seed?: string;
  /** Sempre imagem parada (listas de escolha, onde há dezenas de uma vez). */
  still?: boolean;
  /** O escolhido numa lista: a forma é contornada, em vez de ganhar uma caixa em volta. */
  picked?: boolean;
  /**
   * O avatar vivo do chat: respira e tem o movimento contínuo de cada atividade (o "cérebro" do
   * motor: lendo e programando se mexem diferente) mesmo pequeno. Sem isso, só os grandes.
   */
  lively?: boolean;
  /**
   * Where the face looks, as the engine's own gaze vector (x to the right, y down, -1 to 1): the
   * welcome makes the bot look aside and back to the front. While it is given, the face does not
   * follow the pointer; `null` lets it wander. Absent: the usual behaviour.
   */
  gaze?: { x: number; y: number } | null;
  /** `false`: the body never breathes (the welcome, owner's decision of 24/11/2026). */
  breathe?: boolean;
  /**
   * One turn on its own axis, ending facing front, lasting `ms`: every new `key` (above 0) makes
   * one (the welcome's bot on its way to the corner). The still image never turns.
   */
  spin?: { key: number; ms: number };
  /**
   * A poke at a point (-1 to 1 on each axis): every new `key` (above 0) pokes once. `strength`
   * (0 to 1, default 1) softens the jolt.
   */
  poke?: { key: number; x: number; y: number; strength?: number };
  /**
   * The colour changes while the bot is on screen (the bot being made): the body is only repainted,
   * the character and the runtime are NOT recreated, so the animation in progress (a smile, a look)
   * goes on instead of starting over. The eyes are painted (not cut out) so the face reads on any
   * colour, as the white bot's always did. Only the animated mascot works this way.
   */
  repaint?: boolean;
}

/**
 * "Concluído" só aparece por um instante: o rosto feliz fica `holdMs` e volta ao repouso. Um
 * "concluído" que já estava lá quando o avatar apareceu (a execução antiga de um bot) é só repouso.
 */
export function useBriefDone(state: AvatarStateId, holdMs: number): AvatarStateId {
  const [armed, setArmed] = useState(state !== "done");
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (state !== "done") {
      setArmed(true);
      setOver(false);
      return;
    }
    if (!armed) return;
    const timer = setTimeout(() => setOver(true), holdMs);
    return () => clearTimeout(timer);
  }, [state, armed, holdMs]);
  return state === "done" && (!armed || over) ? "idle" : state;
}

/** Os elementos do SVG de `renderStill` que o ticker reescreve a cada quadro. */
interface SvgParts {
  group: Element;
  body: Element;
  eyes: Element;
  circles: Element[];
}

const childrenNamed = (parent: Element | undefined, tag: string): Element[] =>
  parent === undefined ? [] : Array.from(parent.children).filter((c) => c.localName === tag);

/**
 * Acha corpo, olhos e o grupo no SVG parado e acrescenta os círculos do indicador (pontos e
 * anéis). Olhos recortados: o corpo está no grupo dentro do `g` com máscara e os olhos na máscara.
 * Olhos pintados: o corpo é o `path` de `defs` e os olhos o `path` dentro do `g` com máscara.
 * `null` se a estrutura não for a esperada (o avatar então fica parado).
 */
function findParts(root: Element, circleCount: number): SvgParts | null {
  const svg = root.querySelector("svg");
  const group = childrenNamed(svg ?? undefined, "g")[0];
  const defs = childrenNamed(svg ?? undefined, "defs")[0];
  if (svg === null || group === undefined || defs === undefined) return null;
  const masked = childrenNamed(childrenNamed(group, "g")[0], "path")[0];
  const bodyDef = childrenNamed(defs, "path")[0];
  const body = bodyDef ?? masked;
  const eyes =
    bodyDef === undefined ? childrenNamed(childrenNamed(defs, "mask")[0], "path")[0] : masked;
  if (body === undefined || eyes === undefined) return null;
  const circles: Element[] = [];
  for (let i = 0; i < circleCount; i++) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("opacity", "0");
    group.appendChild(circle);
    circles.push(circle);
  }
  return { group, body, eyes, circles };
}

/** Escreve o quadro nos elementos; só toca no que mudou. */
function paint(parts: SvgParts, data: AvatarRenderData): void {
  const set = (el: Element, name: string, value: string) => {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };
  set(parts.group, "transform", data.transform);
  set(parts.body, "d", data.body);
  set(parts.eyes, "d", data.eyes);
  data.parts.forEach((attrs, i) => {
    const circle = parts.circles[i];
    if (circle === undefined) return;
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "transform" && value === "") circle.removeAttribute("transform");
      else set(circle, name, value);
    }
  });
}

export function Mascot({
  shape,
  color,
  state = "idle",
  size = "md",
  seed = shape,
  still = false,
  picked = false,
  lively = false,
  gaze,
  breathe,
  spin,
  poke,
  repaint = false,
}: MascotProps) {
  const host = useContext(MascotHostContext);
  const systemReduced = useReducedMotion();
  const reduced = host.reducedMotion ?? systemReduced;
  const shown = useBriefDone(state, host.doneHoldMs ?? DONE_HOLD_MS);
  const animated = !still && !reduced && size !== "xs";
  const uid = useId();
  const root = useRef<HTMLSpanElement>(null);
  const live = useRef<{
    runtime: ReturnType<typeof createAvatarRuntime>;
    handle: ReturnType<AvatarTicker["register"]>;
  } | null>(null);
  const latest = useRef(shown);
  const gazeRef = useRef(gaze);
  const gazeSet = gaze !== undefined;

  // O id do personagem também nomeia as máscaras do SVG: um por instância, senão duas caras do
  // mesmo bot na tela (barra lateral e cabeçalho) usariam a máscara uma da outra.
  // `repaint`: the character is made once in the base colour (white: painted eyes) and the colour
  // goes on the body afterwards, so changing it never recreates the character or its runtime.
  const fill = BOT_PALETTE[color].fill;
  const bodyColor = repaint && animated ? REPAINT_BASE : fill;
  const character = useMemo(
    () => createCharacter({ id: `${seed}-${uid}`, shape, color: bodyColor }),
    [seed, uid, shape, bodyColor],
  );
  // Animado: o SVG de repouso é só o esqueleto (o ticker escreve o resto); parado: o rosto do estado.
  const stillState: AvatarStateId = animated ? "idle" : shown;
  // The picked mascot has an outline around its silhouette (a filter): its eyes are painted, never
  // cut out, or the outline would ring the holes (owner, 24/11/2026: the eyes "bugged" on colours).
  const html = useMemo(
    () => renderStill(character, stillState, { paintEyes: picked }),
    [character, stillState, picked],
  );

  useLayoutEffect(() => {
    latest.current = shown;
    gazeRef.current = gaze;
  });

  // The body of an animated mascot that repaints: its fill is set here (the SVG is the skeleton).
  useLayoutEffect(() => {
    if (!repaint || !animated) return;
    const body = root.current?.querySelector("svg > g > use");
    if (body !== null && body !== undefined && body.getAttribute("fill") !== fill) {
      body.setAttribute("fill", fill);
    }
  }, [repaint, animated, fill, html]);

  const px = SIZE_PX[size];
  const tickerOverride = host.ticker;
  useLayoutEffect(() => {
    const el = root.current;
    if (!animated || el === null) return;
    const parts = findParts(el, 5);
    if (parts === null) return;
    const runtime = createAvatarRuntime(character, {
      state: latest.current,
      size: px,
      // Os pequenos só piscam e assentam; respirar e "trabalhar" ficam para os grandes.
      breathe: breathe ?? (lively || px >= 64),
      brain: lively || px >= 56,
      budget: BRAIN_BUDGET,
    });
    const handle = (tickerOverride ?? getTicker()).register({
      ...runtime.tickerEntry((data) => paint(parts, data)),
      follow: size === "xl" && !gazeSet ? "always" : "off",
      getCenter: () => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      element: el,
    });
    live.current = { runtime, handle };
    // A look asked for before the runtime existed (the first frame) is applied now.
    const first = gazeRef.current;
    if (first !== undefined) handle.interact(() => runtime.setGaze(first));
    return () => {
      handle.unregister();
      runtime.dispose();
      live.current = null;
    };
  }, [animated, character, px, size, tickerOverride, lively, gazeSet, breathe]);

  useLayoutEffect(() => {
    const current = live.current;
    current?.handle.interact(() => current.runtime.setState(shown));
  }, [shown, animated, character, px, size, tickerOverride]);

  const spinKey = spin?.key ?? 0;
  const spinMs = spin?.ms;
  useLayoutEffect(() => {
    const current = live.current;
    if (current === null || spinKey === 0 || spinMs === undefined) return;
    current.handle.interact(() => current.runtime.spin(spinMs / 1000));
  }, [spinKey, spinMs]);

  const pokeKey = poke?.key ?? 0;
  const pokeX = poke?.x;
  const pokeY = poke?.y;
  const pokeStrength = poke?.strength;
  useLayoutEffect(() => {
    const current = live.current;
    if (current === null || pokeKey === 0) return;
    current.handle.interact(() => current.runtime.poke(pokeX, pokeY, pokeStrength));
  }, [pokeKey, pokeX, pokeY, pokeStrength]);

  const gazeX = gaze?.x;
  const gazeY = gaze?.y;
  useLayoutEffect(() => {
    const current = live.current;
    if (current === null || gazeX === undefined || gazeY === undefined) return;
    current.handle.interact(() => current.runtime.setGaze({ x: gazeX, y: gazeY }));
  }, [gazeX, gazeY]);

  return (
    <span
      ref={root}
      // The engine leaves room around the body for the animation: the scale makes the body fill the box.
      className={cx(
        "inline-flex size-full items-center justify-center [&_svg]:block [&_svg]:size-full [&_svg]:scale-140",
        picked && "filter-(--filter-mascot-picked)",
      )}
      data-mascot={shape}
      data-color={color}
      data-state={shown}
      data-mode={animated ? "animated" : "still"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: o SVG vem do motor, que só emite números e cores validadas
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
