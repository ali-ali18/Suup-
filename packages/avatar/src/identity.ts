// Identidade: id → { forma, cor, semente }. Quem não escolheu nada tem um
// visual fixo (o mesmo id sempre dá o mesmo avatar). Também traduz os valores
// que bots antigos guardaram (formas "rond", "goutte"... e cores em hex).

import { AVATAR_COLORS, type AvatarColor } from "./data/palette.js";
import { hash } from "./geometry/math.js";
import { DRAWABLE_SHAPES, isShape, type Shape } from "./geometry/shapes.js";

/** Cores sorteáveis por id (o preto fica de fora: só por escolha). */
const HASHED_COLORS = AVATAR_COLORS.filter((c) => c.id !== "black");

export type AvatarIdentity = { shape: Shape; color: string; seed: number };

/** Mistura de bits extra para o índice da forma não acompanhar o da cor. */
function mix(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 73244475);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function identityFor(id: string): AvatarIdentity {
  const base = hash(id);
  return {
    shape: DRAWABLE_SHAPES[mix(base) % DRAWABLE_SHAPES.length] as Shape,
    color: (HASHED_COLORS[hash(`${id}#color`) % HASHED_COLORS.length] as AvatarColor).value,
    seed: base,
  };
}

/** Returns the shape id when valid, `undefined` otherwise. */
export function normalizeShape(value: string | null | undefined): Shape | undefined {
  if (!value) return undefined;
  return isShape(value) ? value : undefined;
}

/** Forma efetiva: a escolhida (nova ou antiga) ou a sorteada pelo id. */
export function resolveShape(shape: string | null | undefined, id: string): Shape {
  return normalizeShape(shape) ?? identityFor(id).shape;
}

/** Cor efetiva: a escolhida (qualquer cor válida) ou a sorteada pelo id. */
export function resolveColor(color: string | null | undefined, id: string): string {
  return color?.trim() ? color.trim() : identityFor(id).color;
}

/** Olho escuro, exceto em corpo (quase) preto, onde fica claro. */
export function eyeColorFor(bodyColor: string): string {
  const hex = bodyColor.replace("#", "");
  if (hex.length < 6) return "#0a0a0c";
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.2 ? "#f9f9f9" : "#0a0a0c";
}

export { AVATAR_COLORS, type AvatarColor };
