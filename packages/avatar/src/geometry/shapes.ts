// Catálogo de formas: cada forma vira um contorno de N pontos fixos numa área
// de 250×250 (centro em 125,125), com o ponto 0 no topo e o sentido horário.
// Mesmo N e mesmo ponto de partida em todas as formas: é isso que permite o
// morph ponto a ponto. As formas são geradas por fórmula (superelipse, raio
// modulado, polígono com cantos arredondados, união de círculos); coração,
// brilho e estrela têm contorno livre e vêm pré-amostrados abaixo.
import { BASE_SIZE, FREEFORM, SHAPE_SIZE, type Shape } from "../data/shapes.js";
import { clamp, TAU } from "./math.js";

export { DRAWABLE_SHAPES, isShape, SHAPE_IDS, type Shape } from "../data/shapes.js";

export const SHAPE_POINTS = 96;
export const AVATAR_BOX = 250;
export const CENTER = AVATAR_BOX / 2;
/** Tamanho (maior lado) que todo contorno ocupa depois de normalizado. */
const FIT = 228.44;
/** Raio (px do viewBox) do círculo normalizado: 1 "unidade de corpo". */
export const BODY_RADIUS_PX = 114.27;
/**
 * Fração do viewBox que o corpo ocupa. A folga (~25%) é para o giro 3D, o
 * squash, a respiração e o deslocamento dos clipes; a maior forma (a cunha)
 * chega a ~112 px do centro em ±30° de yaw/pitch.
 */
export const VIEW_FIT = 0.77;

/** Escala relativa da forma (círculo = 1). */
export function shapeScale(shape: Shape): number {
  return (SHAPE_SIZE[shape] ?? BASE_SIZE) / BASE_SIZE;
}

/** Escala da forma no viewBox: enquadramento · folga do viewBox. */
export function shapeFit(shape: Shape): number {
  return VIEW_FIT * shapeScale(shape);
}

/**
 * Diagnostic only: the scale that would put the outline's worst point exactly on the body radius.
 * The engine uses the hand-tuned size table (`shapeScale`) instead.
 */
export function worstPointScale(shape: Shape): number {
  return BODY_RADIUS_PX / worstPointRadius(shapeOutline(shape));
}

/** Maior distância de um ponto do contorno ao centro (o "pior ponto"). */
export function worstPointRadius(outline: Outline): number {
  let max = 0;
  for (let i = 0; i < outline.length; i += 2) {
    max = Math.max(
      max,
      Math.hypot((outline[i] as number) - CENTER, (outline[i + 1] as number) - CENTER),
    );
  }
  return max;
}

export type Point = readonly [number, number];
/** Contorno achatado: [x0, y0, x1, y1, ...] com SHAPE_POINTS pontos. */
export type Outline = readonly number[];

// ---------------------------------------------------------------- polilinhas

type Poly = Point[];

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Poly {
  const out: Poly = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Arco elíptico de a0 a a1 (rad, y para baixo). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Poly {
  const steps = Math.max(4, Math.ceil((Math.abs(a1 - a0) / TAU) * 64));
  const out: Poly = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function polar(fn: (angle: number) => Point, steps = 256): Poly {
  return Array.from({ length: steps }, (_, i) => fn((i / steps) * TAU));
}

/** Polígono com cantos arredondados por curva quadrática (raio por canto). */
function rounded(corners: Point[], radius: number | number[]): Poly {
  const n = corners.length;
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n] as Point;
    const cur = corners[i] as Point;
    const next = corners[(i + 1) % n] as Point;
    const r = typeof radius === "number" ? radius : (radius[i % radius.length] as number);
    const toward = (from: Point, to: Point): Point => {
      const dx = from[0] - to[0];
      const dy = from[1] - to[1];
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };
    const a = toward(prev, cur);
    const b = toward(next, cur);
    const p0: Point = [cur[0] + a[0] * r, cur[1] + a[1] * r];
    const p2: Point = [cur[0] + b[0] * r, cur[1] + b[1] * r];
    for (let s = 0; s <= 12; s++) {
      const t = s / 12;
      const u = 1 - t;
      out.push([
        u * u * p0[0] + 2 * u * t * cur[0] + t * t * p2[0],
        u * u * p0[1] + 2 * u * t * cur[1] + t * t * p2[1],
      ]);
    }
  }
  return out;
}

/** Raio máximo, por ângulo, de uma união de círculos (nuvem, trevo). */
function circleUnion(circles: [number, number, number][]): Poly {
  return polar((angle) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let best = 0;
    for (const [x, y, r] of circles) {
      const ox = x - CENTER;
      const oy = y - CENTER;
      const d = c * ox + s * oy;
      const disc = d * d - (ox * ox + oy * oy) + r * r;
      if (disc <= 0) continue;
      best = Math.max(best, d + Math.sqrt(disc));
    }
    return [CENTER + c * best, CENTER + s * best];
  }, 384);
}

const superellipse = (rx: number, ry: number, n: number): Poly =>
  polar((a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      CENTER + Math.sign(c) * Math.abs(c) ** (2 / n) * rx,
      CENTER + Math.sign(s) * Math.abs(s) ** (2 / n) * ry,
    ];
  });

function stadium(halfLong: number, halfShort: number, horizontal: boolean): Poly {
  const body = halfLong - halfShort;
  const pts: Poly = [];
  if (horizontal) {
    pts.push(...arc(CENTER + body, CENTER, halfShort, halfShort, -Math.PI / 2, Math.PI / 2));
    pts.push(...arc(CENTER - body, CENTER, halfShort, halfShort, Math.PI / 2, (Math.PI * 3) / 2));
  } else {
    pts.push(...arc(CENTER, CENTER + body, halfShort, halfShort, 0, Math.PI));
    pts.push(...arc(CENTER, CENTER - body, halfShort, halfShort, Math.PI, TAU));
  }
  return pts;
}

/** Corpo de topo elíptico e base reta com cantos suaves (cilindro, domo). */
function slab(halfW: number, halfH: number, topRadiusY: number, bottomCorner: number): Poly {
  const top = CENTER - halfH;
  const bottom = CENTER + halfH;
  const right = CENTER + halfW;
  const left = CENTER - halfW;
  return [
    ...arc(CENTER, top + topRadiusY, halfW, topRadiusY, Math.PI, TAU),
    ...bezier(
      [right, bottom - bottomCorner],
      [right, bottom],
      [right, bottom],
      [right - bottomCorner, bottom],
      8,
    ),
    ...bezier(
      [left + bottomCorner, bottom],
      [left, bottom],
      [left, bottom],
      [left, bottom - bottomCorner],
      8,
    ),
  ];
}

const GENERATORS: Record<Exclude<Shape, "heart" | "sparkle" | "star">, () => Poly> = {
  blob: () => polar((a) => [CENTER + Math.cos(a) * 110, CENTER + Math.sin(a) * 110]),
  pebble: () =>
    polar((a) => {
      const r = 108 * (1 + 0.075 * (Math.sin(a * 2 + 1.1) * 0.6 + Math.sin(a * 3 - 1.1) * 0.4));
      return [CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r * 0.98];
    }),
  bean: () =>
    polar((a) => {
      const bump = (center: number) => {
        const d = Math.abs(((((a - center + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
        return Math.exp(-(d * d) / 0.4232);
      };
      const f = 1 - 0.34 * bump(Math.PI) + 0.34 * 0.34 * bump(0);
      return [CENTER + Math.cos(a) * 94 * f, CENTER + Math.sin(a) * 112 * f];
    }),
  egg: () =>
    polar((a) => {
      const bottomness = (1 - Math.sin(a)) / 2;
      return [
        CENTER + Math.cos(a) * 98 * (1 - 0.22 * bottomness * bottomness),
        CENTER + Math.sin(a) * 113,
      ];
    }),
  squircle: () => superellipse(107, 107, 3.2),
  tablet: () => stadium(114, 74, true),
  capsule: () => stadium(113, 72, false),
  cylinder: () => [
    ...arc(CENTER, CENTER - 62, 94, 48, Math.PI, TAU),
    ...arc(CENTER, CENTER + 62, 94, 48, 0, Math.PI),
  ],
  hex: () =>
    rounded(
      Array.from({ length: 6 }, (_, i) => {
        const a = Math.PI / 6 + (i / 6) * TAU;
        return [CENTER + Math.cos(a) * 114, CENTER + Math.sin(a) * 114] as Point;
      }),
      20,
    ),
  gem: () => superellipse(112, 113, 1.5),
  crystal: () =>
    rounded(
      [
        [CENTER, CENTER - 118],
        [CENTER + 70, CENTER - 44],
        [CENTER + 70, CENTER + 44],
        [CENTER, CENTER + 118],
        [CENTER - 70, CENTER + 44],
        [CENTER - 70, CENTER - 44],
      ],
      16,
    ),
  wedge: () =>
    rounded(
      Array.from({ length: 3 }, (_, i) => {
        const a = -Math.PI / 2 + (i / 3) * TAU;
        return [CENTER + Math.cos(a) * 130, CENTER + Math.sin(a) * 130] as Point;
      }),
      [80, 60, 60],
    ),
  shield: () => {
    const w = 98;
    const top = CENTER - 108;
    const bottom = CENTER + 108;
    return [
      ...bezier(
        [CENTER - w, top + 30],
        [CENTER - w, top - 2],
        [CENTER - w * 0.5, top - 10],
        [CENTER, top - 10],
        12,
      ),
      ...bezier(
        [CENTER, top - 10],
        [CENTER + w * 0.5, top - 10],
        [CENTER + w, top - 2],
        [CENTER + w, top + 30],
        12,
      ),
      ...bezier(
        [CENTER + w, top + 30],
        [CENTER + w, CENTER + 45],
        [CENTER + w * 0.62, bottom],
        [CENTER, bottom],
        16,
      ),
      ...bezier(
        [CENTER, bottom],
        [CENTER - w * 0.62, bottom],
        [CENTER - w, CENTER + 45],
        [CENTER - w, top + 30],
        16,
      ),
    ];
  },
  dome: () => slab(114, 82, 138, 26),
  arch: () => {
    const halfW = 76;
    const halfH = 113;
    const bottom = CENTER + halfH;
    const corner = 42;
    return [
      ...arc(CENTER, CENTER - halfH + halfW, halfW, halfW, Math.PI, TAU),
      ...bezier(
        [CENTER + halfW, bottom - corner],
        [CENTER + halfW, bottom],
        [CENTER + halfW, bottom],
        [CENTER + halfW - corner, bottom],
        10,
      ),
      ...bezier(
        [CENTER - halfW + corner, bottom],
        [CENTER - halfW, bottom],
        [CENTER - halfW, bottom],
        [CENTER - halfW, bottom - corner],
        10,
      ),
    ];
  },
  cloud: () =>
    circleUnion([
      [CENTER - 62, CENTER + 26, 56],
      [CENTER + 62, CENTER + 26, 54],
      [CENTER, CENTER + 34, 62],
      [CENTER - 24, CENTER - 30, 62],
      [CENTER + 38, CENTER - 26, 54],
    ]),
  teardrop: () => {
    const r = 88;
    const apexY = CENTER - 114;
    const baseY = CENTER + 26;
    const s = clamp(r / (baseY - apexY), -1, 1);
    const k = Math.sqrt(1 - s * s);
    const right: Point = [CENTER + r * k, baseY - r * s];
    const left: Point = [CENTER - r * k, baseY - r * s];
    const a = Math.atan2(right[1] - baseY, right[0] - CENTER);
    return [
      ...rounded([right, [CENTER, apexY], left], [0, 48, 0]),
      ...arc(CENTER, baseY, r, r, Math.PI - a, a),
    ];
  },
  leaf: () =>
    polar((a) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      return [CENTER + c * 88 * Math.max(1 - s * s, 0) ** 0.25, CENTER + s * 113];
    }),
  square: () =>
    rounded(
      [
        [CENTER - 107, CENTER - 107],
        [CENTER + 107, CENTER - 107],
        [CENTER + 107, CENTER + 107],
        [CENTER - 107, CENTER + 107],
      ],
      28,
    ),
  clover: () =>
    circleUnion([
      [CENTER - 38, CENTER - 38, 58],
      [CENTER + 38, CENTER - 38, 58],
      [CENTER + 38, CENTER + 38, 58],
      [CENTER - 38, CENTER + 38, 58],
    ]),
  flower: () =>
    polar((a) => {
      const r = 92 * (1 + 0.16 * Math.cos(5 * a));
      return [CENTER + Math.cos(a) * r, CENTER + Math.sin(a) * r];
    }),
  house: () =>
    rounded(
      [
        [CENTER - 100, CENTER + 110],
        [CENTER + 100, CENTER + 110],
        [CENTER + 100, CENTER - 110 + 78],
        [CENTER, CENTER - 110],
        [CENTER - 100, CENTER - 110 + 78],
      ],
      29,
    ),
};

// ------------------------------------------------------- amostragem uniforme

function polylineOf(shape: Shape): Poly {
  if (shape === "heart" || shape === "sparkle" || shape === "star") {
    const flat = FREEFORM[shape];
    return Array.from(
      { length: flat.length / 2 },
      (_, i) => [flat[i * 2] as number, flat[i * 2 + 1] as number] as Point,
    );
  }
  return GENERATORS[shape]();
}

function signedArea(poly: Poly): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point;
    const b = poly[(i + 1) % poly.length] as Point;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** Centra no bbox e escala para ocupar ~FIT (limitado a 0,9–1,35×). */
function normalize(poly: Poly): Poly {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const k = clamp(FIT / Math.max(maxX - minX, maxY - minY), 0.9, 1.35);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  return poly.map(([x, y]) => [CENTER + (x - mx) * k, CENTER + (y - my) * k] as Point);
}

/** Reamostra em N pontos por comprimento de arco, começando no topo (x = centro). */
export function resampleOutline(input: Poly, count = SHAPE_POINTS): Outline {
  let poly = normalize(input);
  if (signedArea(poly) < 0) poly = poly.slice().reverse();

  let best: { index: number; y: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point;
    const b = poly[(i + 1) % poly.length] as Point;
    if ((a[0] - CENTER) * (b[0] - CENTER) > 0 || a[0] === b[0]) continue;
    const t = (CENTER - a[0]) / (b[0] - a[0]);
    const y = a[1] + (b[1] - a[1]) * t;
    if (y < CENTER && (best === null || y < best.y)) best = { index: i, y };
  }
  const start: Point = [CENTER, best?.y ?? CENTER - FIT / 2];
  const from = best ? best.index + 1 : 0;
  const ring: Poly = [start, ...poly.slice(from), ...poly.slice(0, from), start];

  const lengths = [0];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1] as Point;
    const b = ring[i] as Point;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[lengths.length - 1] as number;
  const out: number[] = [];
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (seg < ring.length - 1 && (lengths[seg] as number) < target) seg++;
    const a = ring[seg - 1] as Point;
    const b = ring[seg] as Point;
    const span = (lengths[seg] as number) - (lengths[seg - 1] as number) || 1;
    const t = (target - (lengths[seg - 1] as number)) / span;
    out.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  }
  return out;
}

const cache = new Map<Shape, Outline>();

/** Contorno da forma (memoizado): SHAPE_POINTS pontos, ponto 0 no topo. */
export function shapeOutline(shape: Shape): Outline {
  let outline = cache.get(shape);
  if (!outline) {
    outline = resampleOutline(polylineOf(shape));
    cache.set(shape, outline);
  }
  return outline;
}
