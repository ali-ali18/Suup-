// Grades de células: o desenho estático do Figma e os quadros da animação, montados em cima dele.
//
// Letras de uma grade pronta (as que o desenho usa mais duas de papel):
//   B corpo · E olho aberto · A olho fechado · a escuro (símbolo) · w branco (símbolo)
//   l lâmpada · g brilho da lâmpada · . vazio

import { dataOf, type PixelCharacterId } from "./character.js";
import { PIXEL_ANIMATION, type PixelAnimFrame } from "./data/animation.js";
import { PIXEL_GRID } from "./data/characters.js";
import type { PixelPose } from "./states.js";

export { PIXEL_GRID };

/** Os símbolos de estado ficam nesta região (linhas 0 a 5 da coluna 7 em diante; 0 a 9 da 15). */
export function inGlyphRegion(x: number, y: number): boolean {
  return (y <= 5 && x >= 7) || (y <= 9 && x >= 15);
}

/** Fora do símbolo, `e` é olho aberto e `a` é olho fechado; dentro, ficam como são. */
function classify(rows: readonly string[]): string[] {
  return rows.map((row, y) =>
    Array.from(row, (ch, x) => {
      if (inGlyphRegion(x, y)) return ch;
      if (ch === "e") return "E";
      if (ch === "a") return "A";
      return ch;
    }).join(""),
  );
}

const staticCache = new Map<string, readonly string[]>();

/** A pose parada do Figma (o desenho completo, com o símbolo inteiro). */
export function staticCells(character: PixelCharacterId, pose: PixelPose): readonly string[] {
  const key = `${character}|${pose}`;
  let cells = staticCache.get(key);
  if (cells === undefined) {
    const rows = dataOf(character).states[pose];
    if (rows === undefined) throw new Error(`pose sem desenho: ${character}/${pose}`);
    cells = classify(rows);
    staticCache.set(key, cells);
  }
  return cells;
}

/** Linha de cima de cada olho vira corpo (o quadro de piscar da folha, para qualquer personagem). */
function blinkCells(rows: readonly string[]): string[] {
  return rows.map((row, y) =>
    Array.from(row, (ch, x) => {
      if (ch === "E" && rows[y + 1]?.[x] === "E" && !inGlyphRegion(x, y)) return "B";
      return ch;
    }).join(""),
  );
}

const frameCache = new Map<string, readonly string[]>();

/**
 * Quadro `index` da animação da pose: o desenho parado do personagem, com a região do símbolo
 * trocada pelo símbolo daquele quadro e, no quadro de piscar, os olhos fechando.
 */
export function animatedCells(
  character: PixelCharacterId,
  pose: PixelPose,
  index: number,
): readonly string[] {
  const key = `${character}|${pose}|${index}`;
  let cells = frameCache.get(key);
  if (cells === undefined) {
    const frame = animationOf(pose)[index];
    if (frame === undefined) throw new Error(`quadro inexistente: ${pose}/${index}`);
    const base = frame.blink
      ? blinkCells(staticCells(character, pose))
      : staticCells(character, pose);
    cells = base.map((row, y) =>
      Array.from(row, (ch, x) => {
        if (!inGlyphRegion(x, y)) return ch;
        return frame.glyph[y]?.[x] ?? ".";
      }).join(""),
    );
    frameCache.set(key, cells);
  }
  return cells;
}

/** Os quadros da pose, na ordem do ciclo. */
export function animationOf(pose: PixelPose): readonly PixelAnimFrame[] {
  const frames = PIXEL_ANIMATION[pose];
  if (frames === undefined) throw new Error(`pose sem animação: ${pose}`);
  return frames;
}
