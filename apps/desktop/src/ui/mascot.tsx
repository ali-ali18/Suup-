import { BOT_PALETTE, type BotColor } from "@suup/api";
import {
  type AvatarRenderData,
  type AvatarStateId,
  type AvatarTicker,
  createAvatarRuntime,
  createBrainBudget,
  createCharacter,
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

/** No máximo estes avatares fazem o movimento contínuo de "trabalhando" ao mesmo tempo. */
const BRAIN_BUDGET = createBrainBudget(3);

/**
 * O que o ambiente fornece ao `Mascot`. Em produção nada (ticker do navegador, movimento reduzido
 * lido do app e do sistema); os testes entregam um ticker com relógio falso.
 */
export interface MascotHost {
  ticker?: AvatarTicker;
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
}

/**
 * "Concluído" só aparece por um instante: o rosto feliz fica `holdMs` e volta ao repouso. Um
 * "concluído" que já estava lá quando o avatar apareceu (a execução antiga de um bot) é só repouso.
 */
function useBriefDone(state: AvatarStateId, holdMs: number): AvatarStateId {
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

  // O id do personagem também nomeia as máscaras do SVG: um por instância, senão duas caras do
  // mesmo bot na tela (barra lateral e cabeçalho) usariam a máscara uma da outra.
  const character = useMemo(
    () => createCharacter({ id: `${seed}-${uid}`, shape, color: BOT_PALETTE[color].fill }),
    [seed, uid, shape, color],
  );
  // Animado: o SVG de repouso é só o esqueleto (o ticker escreve o resto); parado: o rosto do estado.
  const stillState: AvatarStateId = animated ? "idle" : shown;
  const html = useMemo(() => renderStill(character, stillState), [character, stillState]);

  useLayoutEffect(() => {
    latest.current = shown;
  });

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
      breathe: px >= 64,
      brain: px >= 56,
      budget: BRAIN_BUDGET,
    });
    const handle = (tickerOverride ?? getTicker()).register({
      ...runtime.tickerEntry((data) => paint(parts, data)),
      follow: size === "xl" ? "always" : "off",
      getCenter: () => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      element: el,
    });
    live.current = { runtime, handle };
    return () => {
      handle.unregister();
      runtime.dispose();
      live.current = null;
    };
  }, [animated, character, px, size, tickerOverride]);

  useLayoutEffect(() => {
    const current = live.current;
    current?.handle.interact(() => current.runtime.setState(shown));
  }, [shown, animated, character, px, size, tickerOverride]);

  return (
    <span
      ref={root}
      // The engine leaves room around the body for the animation: the scale makes the body fill the box.
      // `ui-mascot` is a hook (the picker of the new-bot dialog outlines the chosen one), not a style.
      className="ui-mascot inline-flex size-full items-center justify-center [&_svg]:block [&_svg]:size-full [&_svg]:scale-140"
      data-mascot={shape}
      data-color={color}
      data-state={shown}
      data-mode={animated ? "animated" : "still"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: o SVG vem do motor, que só emite números e cores validadas
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
