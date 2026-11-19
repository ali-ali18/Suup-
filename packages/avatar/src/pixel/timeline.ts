// A linha do tempo de uma pose: espera, transição, próximo quadro, e de novo. Os tempos e as
// curvas são os do protótipo do dono (Figma: AFTER_TIMEOUT e SMART_ANIMATE). Puro: o relógio é de
// quem chama.

import { animationOf } from "./cells.js";
import type { PixelEase } from "./data/animation.js";
import type { PixelPose } from "./states.js";

/** Curva cúbica de Bézier (como `cubic-bezier()` do CSS), de (0,0) a (1,1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Bissecção: sobra precisão e não precisa de derivada.
    let lo = 0;
    let hi = 1;
    let s = x;
    for (let i = 0; i < 24; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = s;
      else lo = s;
      s = (lo + hi) / 2;
    }
    return sampleY(s);
  };
}

/** Curvas nomeadas do Figma (as do CSS com o mesmo nome). */
const EASE: Readonly<Record<PixelEase, (t: number) => number>> = {
  io: cubicBezier(0.42, 0, 0.58, 1),
  o: cubicBezier(0, 0, 0.58, 1),
  n: (t) => (t < 1 ? 0 : 1),
};

export type TimelineSample = {
  /** Quadro cujas células aparecem (na transição, troca no meio). */
  cells: number;
  /** Deslocamento vertical em unidades do Figma (0 ou -4; entre os dois durante a transição). */
  dy: number;
};

type Plan = { total: number; starts: number[] };

const plans = new Map<PixelPose, Plan>();

function planOf(pose: PixelPose): Plan {
  let plan = plans.get(pose);
  if (plan === undefined) {
    const starts: number[] = [];
    let at = 0;
    for (const f of animationOf(pose)) {
      starts.push(at);
      at += f.holdMs + f.transMs;
    }
    plan = { total: at, starts };
    plans.set(pose, plan);
  }
  return plan;
}

/** Duração do ciclo completo da pose (ms). */
export function cycleMs(pose: PixelPose): number {
  return planOf(pose).total;
}

/** O que aparece `elapsedMs` depois de a pose começar (o ciclo se repete). */
export function sampleTimeline(pose: PixelPose, elapsedMs: number): TimelineSample {
  const frames = animationOf(pose);
  const { total, starts } = planOf(pose);
  const t = ((elapsedMs % total) + total) % total;
  let i = frames.length - 1;
  while (i > 0 && (starts[i] as number) > t) i--;
  const frame = frames[i];
  if (frame === undefined) return { cells: 0, dy: 0 };
  const local = t - (starts[i] as number);
  if (local < frame.holdMs) return { cells: i, dy: frame.dy };
  const next = frames[(i + 1) % frames.length] ?? frame;
  const progress = frame.transMs > 0 ? (local - frame.holdMs) / frame.transMs : 1;
  const eased = EASE[frame.ease](progress);
  return {
    cells: progress < 0.5 ? i : (i + 1) % frames.length,
    dy: frame.dy + (next.dy - frame.dy) * eased,
  };
}
