// Pixel 3D, passo 2: gira o sólido de voxels e desenha DE VOLTA numa grade de pixels.
//
// Para cada pixel da saída, um raio atravessa a grade de voxels (3D DDA, só inteiros de voxel) e
// o primeiro voxel que ele toca dá a cor. Não há suavização, mistura nem gradiente: cada pixel é
// uma cor exata da paleta ou um dos poucos degraus dela (mais claro em cima, mais escuro nas
// laterais). Câmera ortográfica; com giro e inclinação zero a vista é idêntica ao desenho 2D.

import { PIXEL_GRID } from "./data/characters.js";
import { colorOf } from "./draw.js";
import type { PixelPalette } from "./palette.js";
import { parseHexColor } from "./palette.js";
import { KIND_BODY, KIND_EMPTY, VOXEL_HALF_MAX, type VoxelModel } from "./voxel.js";

/** Margem (células) em volta da grade 19 x 19 para caber o sólido girado. */
export const RASTER_MARGIN = 3;
/** Lado da imagem 3D, em pixels (1 voxel = 1 pixel). */
export const RASTER_SIZE = PIXEL_GRID + 2 * RASTER_MARGIN;

/** Imagem pronta: `size` x `size` cores `#rrggbb` (ou `null` = transparente), linha a linha. */
export type PixelImage = { size: number; pixels: readonly (string | null)[] };

export type PixelView = {
  /** Giro em torno do eixo vertical, em radianos (0 = de frente; positivo gira a frente para a direita). */
  yaw: number;
  /** Inclinação, em radianos (positivo mostra o topo). */
  pitch: number;
  /** Deslocamento vertical do sólido, em células (negativo sobe). */
  dy?: number;
};

/** Os degraus de uma cor: base, mais claro (topo), mais escuro (laterais) e o mais escuro. */
export const SHADE_LIGHT_PERCENT = 22;
export const SHADE_DARK_PERCENT = 76;
export const SHADE_DEEP_PERCENT = 58;

export type Shades = { light: string; base: string; dark: string; deep: string };

const shadeCache = new Map<string, Shades>();

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** Aritmética inteira exata: sem floats no resultado, então o mesmo valor sempre dá a mesma cor. */
export function shadesOf(hex: string): Shades {
  const hit = shadeCache.get(hex);
  if (hit !== undefined) return hit;
  const rgb = parseHexColor(hex) ?? [0, 0, 0];
  const make = (f: (c: number) => number) => `#${rgb.map((c) => hex2(f(c))).join("")}`;
  const shades: Shades = {
    base: hex,
    light: make((c) => c + Math.floor(((255 - c) * SHADE_LIGHT_PERCENT) / 100)),
    dark: make((c) => Math.floor((c * SHADE_DARK_PERCENT) / 100)),
    deep: make((c) => Math.floor((c * SHADE_DEEP_PERCENT) / 100)),
  };
  shadeCache.set(hex, shades);
  return shades;
}

/** Todas as cores que a imagem 3D pode ter para uma paleta (para testes e documentação). */
export function paletteShadeSet(palette: PixelPalette): Set<string> {
  const out = new Set<string>();
  for (const letter of ["B", "E", "A", "a", "w", "l", "g"]) {
    const color = colorOf(letter, palette);
    if (color === null) continue;
    const s = shadesOf(color);
    out.add(s.base).add(s.light).add(s.dark).add(s.deep);
  }
  return out;
}

const HALF = VOXEL_HALF_MAX;
const N = PIXEL_GRID;
/** Um nada fora do pixel para raios que caem exatamente na quina entre dois voxels. */
const BIAS_X = 0.0013;
const BIAS_Y = 0.0007;
const FAR = 40;

type Hit = { col: number; k: number; axis: 0 | 1 | 2; dirSign: number };

/** Raio em coordenadas do modelo: origem `o`, direção `d`. Devolve o primeiro voxel ocupado. */
function cast(model: VoxelModel, o: number[], d: number[]): Hit | null {
  const lo = [0, 0, -HALF];
  const hi = [N, N, HALF];
  let tNear = Number.NEGATIVE_INFINITY;
  let tFar = Number.POSITIVE_INFINITY;
  let axisIn: 0 | 1 | 2 = 2;
  for (let a = 0; a < 3; a++) {
    const oa = o[a] as number;
    const da = d[a] as number;
    if (da === 0) {
      if (oa < (lo[a] as number) || oa >= (hi[a] as number)) return null;
      continue;
    }
    const t1 = ((lo[a] as number) - oa) / da;
    const t2 = ((hi[a] as number) - oa) / da;
    const tmin = Math.min(t1, t2);
    const tmax = Math.max(t1, t2);
    if (tmin > tNear) {
      tNear = tmin;
      axisIn = a as 0 | 1 | 2;
    }
    if (tmax < tFar) tFar = tmax;
  }
  if (tNear > tFar) return null;
  const idx = [0, 0, 0];
  const step = [0, 0, 0];
  const tMax = [0, 0, 0];
  const tDelta = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const da = d[a] as number;
    const p = (o[a] as number) + da * tNear;
    const l = lo[a] as number;
    const h = hi[a] as number;
    const i = Math.min(h - 1, Math.max(l, Math.floor(p)));
    idx[a] = i;
    if (da === 0) {
      step[a] = 0;
      tMax[a] = Number.POSITIVE_INFINITY;
      tDelta[a] = Number.POSITIVE_INFINITY;
    } else {
      step[a] = da > 0 ? 1 : -1;
      tMax[a] = tNear + ((da > 0 ? i + 1 : i) - p) / da;
      tDelta[a] = Math.abs(1 / da);
    }
  }
  let axis: 0 | 1 | 2 = axisIn;
  for (let guard = 0; guard < 4 * N; guard++) {
    const x = idx[0] as number;
    const y = idx[1] as number;
    const k = idx[2] as number;
    const col = y * N + x;
    const kind = model.kind[col] as number;
    if (kind !== KIND_EMPTY) {
      const h = model.half[col] as number;
      if (k >= -h && k < h) return { col, k, axis, dirSign: step[axis] as number };
    }
    axis = 0;
    if ((tMax[1] as number) < (tMax[axis] as number)) axis = 1;
    if ((tMax[2] as number) < (tMax[axis] as number)) axis = 2;
    idx[axis] = (idx[axis] as number) + (step[axis] as number);
    if (
      (idx[0] as number) < 0 ||
      (idx[0] as number) >= N ||
      (idx[1] as number) < 0 ||
      (idx[1] as number) >= N ||
      (idx[2] as number) < -HALF ||
      (idx[2] as number) >= HALF
    )
      return null;
    tMax[axis] = (tMax[axis] as number) + (tDelta[axis] as number);
  }
  return null;
}

/** A cor de um voxel visto por uma face: a letra da frente só vale na face da frente do corpo. */
function hitColor(model: VoxelModel, hit: Hit, palette: PixelPalette): string | null {
  const half = model.half[hit.col] as number;
  const kind = model.kind[hit.col] as number;
  const letter = model.letter[hit.col] as string;
  // Normal da face = contra o sentido do raio no eixo em que ele entrou.
  const normal = -hit.dirSign;
  const front = hit.axis === 2 && normal > 0;
  let ch = letter;
  if (kind === KIND_BODY && !(front && hit.k === half - 1)) ch = "B";
  const color = colorOf(ch, palette);
  if (color === null) return null;
  const s = shadesOf(color);
  if (hit.axis === 2) return front ? s.base : s.dark;
  if (hit.axis === 1) return normal < 0 ? s.light : s.deep;
  return normal < 0 ? s.dark : s.deep;
}

/** Desenha o sólido visto por `view`: `RASTER_SIZE` x `RASTER_SIZE` pixels, sem suavização. */
export function rasterVoxel(model: VoxelModel, palette: PixelPalette, view: PixelView): PixelImage {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  // mundo = M (modelo - C) + T, com M = Rpitch * Ryaw (linhas abaixo).
  const m = [
    [cy, 0, sy],
    [-sp * sy, cp, sp * cy],
    [-cp * sy, -sp, cp * cy],
  ] as const;
  const c = [N / 2, N / 2, 0];
  const dy = view.dy ?? 0;
  // direção do raio no modelo = - (terceira linha de M)
  const dir = [-(m[2][0] as number), -(m[2][1] as number), -(m[2][2] as number)];
  const pixels = new Array<string | null>(RASTER_SIZE * RASTER_SIZE).fill(null);
  const half = RASTER_SIZE / 2;
  for (let j = 0; j < RASTER_SIZE; j++) {
    for (let i = 0; i < RASTER_SIZE; i++) {
      const wx = i + 0.5 - half + BIAS_X;
      const wy = j + 0.5 - half + BIAS_Y - dy;
      const wz = FAR;
      // modelo = C + M^T (mundo - T)
      const o = [
        (c[0] as number) +
          (m[0][0] as number) * wx +
          (m[1][0] as number) * wy +
          (m[2][0] as number) * wz,
        (c[1] as number) +
          (m[0][1] as number) * wx +
          (m[1][1] as number) * wy +
          (m[2][1] as number) * wz,
        (c[2] as number) +
          (m[0][2] as number) * wx +
          (m[1][2] as number) * wy +
          (m[2][2] as number) * wz,
      ];
      const hit = cast(model, o, dir);
      if (hit !== null) pixels[j * RASTER_SIZE + i] = hitColor(model, hit, palette);
    }
  }
  return { size: RASTER_SIZE, pixels };
}
