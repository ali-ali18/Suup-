// Construtores de path (strings) do corpo e dos olhos, sem orientação 3D.
import { round1 } from "../geometry/math.js";
import type { EyeFrame } from "../model/character.js";

/** Pontos por ponta arredondada (meia-volta) e por lado reto do olho. */
const CAP_POINTS = 12;
const SIDE_POINTS = 10;

/** Corpo: `M x y L x y … Z`, 1 casa decimal. */
export function bodyPath(body: readonly number[]): string {
  let d = "";
  for (let i = 0; i < body.length; i += 2) {
    d += `${i === 0 ? "M" : "L"}${round1(body[i] as number)} ${round1(body[i + 1] as number)}`;
  }
  return `${d}Z`;
}

/**
 * Contorno do olho: cápsula (ou elipse achatada, se mais larga que comprida)
 * dobrada ao longo de uma parábola de flecha `bend`, girada por `rot` e
 * espelhada no olho direito. Devolve [x0, y0, …] em px do viewBox (y para baixo).
 *
 * A dobra segue a espinha curva: os lados ficam a meia largura da curva, medida
 * na perpendicular dela (espessura constante), e cada ponta é um semicírculo
 * girado na direção da curva. Antes, cada ponto só subia na vertical, e num
 * arco forte (o "^" do feliz) o olho afinava e as pontas viravam bico (dono,
 * 24/11/2026: "no grok ele é bem redondinho"). Sem dobra, é a cápsula de sempre.
 */
export function eyePoints(eye: EyeFrame): number[] {
  const half = eye.length / 2;
  const radiusAlong = Math.min(eye.width / 2, half);
  const radiusAcross = eye.width / 2;
  const spine = half - radiusAlong;
  const angle = (eye.rot * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // A espinha: y(x) = bend * (1 - (x / half)²), com a inclinação dela em cada x.
  const lift = (x: number) => eye.bend * (1 - (x / half) * (x / half));
  const slope = (x: number) => (-2 * eye.bend * x) / (half * half);
  // Um ponto a `across` da espinha em `x`, na perpendicular da curva ali.
  const offset = (x: number, across: number): [number, number] => {
    const s = slope(x);
    const n = Math.hypot(s, 1);
    return [x - (across * s) / n, lift(x) + across / n];
  };
  // Contorno local: ponta direita, lado de cima, ponta esquerda, lado de baixo.
  // Os lados recebem pontos; sem eles a dobra só aparece nas pontas.
  const local: number[] = [];
  const cap = (center: number, from: number) => {
    // O semicírculo é girado pela inclinação da espinha na ponta: fica redondo.
    const tilt = Math.atan(slope(center));
    const tc = Math.cos(tilt);
    const ts = Math.sin(tilt);
    for (let i = 0; i < CAP_POINTS; i++) {
      const t = from + (i / CAP_POINTS) * Math.PI;
      const dx = radiusAlong * Math.cos(t);
      const dy = radiusAcross * Math.sin(t);
      local.push(center + dx * tc - dy * ts, lift(center) + dx * ts + dy * tc);
    }
  };
  const side = (fromX: number, across: number) => {
    if (spine <= 0) return;
    for (let i = 0; i < SIDE_POINTS; i++) {
      local.push(...offset(fromX - Math.sign(fromX) * (i / SIDE_POINTS) * 2 * spine, across));
    }
  };
  cap(spine, -Math.PI / 2);
  side(spine, radiusAcross);
  cap(-spine, Math.PI / 2);
  side(-spine, -radiusAcross);
  const out: number[] = [];
  for (let i = 0; i < local.length; i += 2) {
    const lx = local[i] as number;
    const ly = local[i + 1] as number;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    out.push(eye.cx + (eye.mirror ? -rx : rx), eye.cy - ry);
  }
  return out;
}

/** Olho como path fechado (sem orientação 3D). */
export function eyePath(eye: EyeFrame): string {
  const pts = eyePoints(eye);
  let d = "";
  for (let i = 0; i < pts.length; i += 2) {
    d += `${i === 0 ? "M" : "L"}${round1(pts[i] as number)} ${round1(pts[i + 1] as number)}`;
  }
  return `${d}Z`;
}

/** Os dois olhos num único `d` (dois subcaminhos): uma escrita por quadro. */
export function eyesPath(eyes: readonly EyeFrame[]): string {
  let d = "";
  for (const eye of eyes) d += eyePath(eye);
  return d;
}
