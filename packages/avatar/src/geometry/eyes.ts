// Ajuste dos olhos por forma. Unidades de rosto: 1,0 = FACE_UNIT unidades do
// SVG (viewBox 250). `gap` é a distância entre os centros dos dois olhos e
// `shiftY` sobe (positivo) ou desce o par em relação ao centro do corpo.
// Os valores vêm do visual tuning, shape by shape.
import { EYE_FIT, type EyeFit } from "../data/eye-fit.js";
import type { Shape } from "./shapes.js";

export { EYE_FIT, type EyeFit };

export const FACE_UNIT = 114.27;

/** Base (a do hexágono): as expressões são definidas nestas dimensões. */
export const BASE_EYE = { width: 0.26, height: 0.57, gap: 0.64 } as const;

/** Escalas de uma forma em relação à base (largura, altura, distância). */
export function eyeScales(shape: Shape): { w: number; h: number; gap: number } {
  const fit = EYE_FIT[shape];
  return {
    w: fit.width / BASE_EYE.width,
    h: fit.height / BASE_EYE.height,
    gap: fit.gap / BASE_EYE.gap,
  };
}
