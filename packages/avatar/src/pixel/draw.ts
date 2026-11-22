// Desenho: grade de células -> retângulos de pixels INTEIROS, no canvas (animado) ou em SVG (parado).
import type { PixelCharacter } from "./character.js";
import { PIXEL_GRID } from "./data/characters.js";
import type { PixelFrame } from "./frame.js";
import type { PixelPalette } from "./palette.js";
import type { PixelImage } from "./raster3d.js";

/** O pedaço de um `CanvasRenderingContext2D` que o motor usa (o núcleo não conhece o DOM). */
export interface PixelCanvasContext {
  fillStyle: unknown;
  imageSmoothingEnabled: boolean;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}

export type PixelLayout = {
  /** Lado do buffer do canvas, em pixels de dispositivo. */
  buffer: number;
  /** Pixels de dispositivo por célula (inteiro, no mínimo 1). */
  cell: number;
  /** Margem (inteira) para centralizar a grade no buffer. */
  offset: number;
  /** Lado da grade desenhada (`cell` x 19). */
  side: number;
};

/**
 * Escala inteira: o lado em pixels CSS vezes `devicePixelRatio` vira o buffer; cada célula ocupa
 * `floor(buffer / 19)` pixels de dispositivo e a grade é centralizada com margem inteira. Nunca há
 * meia célula, então nada borra e nenhuma célula é maior que a outra.
 */
export function layoutPixels(
  cssSize: number,
  devicePixelRatio = 1,
  grid: number = PIXEL_GRID,
): PixelLayout {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const buffer = Math.max(1, Math.round(cssSize * ratio));
  const cell = Math.max(1, Math.floor(buffer / grid));
  const side = cell * grid;
  return { buffer, cell, offset: Math.max(0, Math.floor((buffer - side) / 2)), side };
}

/** Quantos pixels de dispositivo o sprite sobe neste quadro (inteiro, 0 ou negativo). */
export function bobPixels(frame: PixelFrame, layout: PixelLayout): number {
  return Math.round(frame.dyCells * layout.cell) || 0;
}

/** A cor de cada letra da grade. */
export function colorOf(letter: string, palette: PixelPalette): string | null {
  switch (letter) {
    case "B":
      return palette.body;
    case "E":
      return palette.eye;
    case "A":
      return palette.eyeClosed;
    case "a":
      return palette.dark;
    case "w":
      return palette.white;
    case "l":
      return palette.lamp;
    case "g":
      return palette.glow;
    default:
      return null;
  }
}

export type PixelRun = { x: number; y: number; width: number; color: string };

/** Faixas horizontais de células da mesma cor (menos retângulos que um por célula). */
export function pixelRuns(cells: readonly string[], palette: PixelPalette): PixelRun[] {
  const runs: PixelRun[] = [];
  cells.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const color = colorOf(row.charAt(x), palette);
      let end = x + 1;
      if (color !== null)
        while (end < row.length && colorOf(row.charAt(end), palette) === color) end++;
      if (color !== null) runs.push({ x, y, width: end - x, color });
      x = end;
    }
  });
  return runs;
}

/** Desenha o quadro no canvas (limpa antes). O buffer do canvas deve medir `layout.buffer`. */
export function drawPixelFrame(
  ctx: PixelCanvasContext,
  character: PixelCharacter,
  frame: PixelFrame,
  layout: PixelLayout,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, layout.buffer, layout.buffer);
  const { cell, offset } = layout;
  const bob = bobPixels(frame, layout);
  for (const run of pixelRuns(frame.cells, character.palette)) {
    ctx.fillStyle = run.color;
    ctx.fillRect(offset + run.x * cell, offset + bob + run.y * cell, run.width * cell, cell);
  }
}

/** Desenha uma imagem pixel 3D (ver `raster3d.ts`): faixas de pixels da mesma cor, escala inteira. */
export function drawPixelImage(
  ctx: PixelCanvasContext,
  image: PixelImage,
  layout: PixelLayout,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, layout.buffer, layout.buffer);
  const { cell, offset } = layout;
  for (let y = 0; y < image.size; y++) {
    let x = 0;
    while (x < image.size) {
      const color = image.pixels[y * image.size + x] ?? null;
      let end = x + 1;
      while (end < image.size && (image.pixels[y * image.size + end] ?? null) === color) end++;
      if (color !== null) {
        ctx.fillStyle = color;
        ctx.fillRect(offset + x * cell, offset + y * cell, (end - x) * cell, cell);
      }
      x = end;
    }
  }
}

export type PixelSvgOptions = {
  /** Lado em px; sem isso o SVG escala com o contêiner. */
  size?: number;
};

/**
 * O quadro como `<svg>` (retângulos com bordas nítidas): imagem parada para listas e
 * miniaturas. Decorativo. As cores vêm da paleta validada (`#rrggbb`).
 */
export function pixelStillSvg(
  character: PixelCharacter,
  frame: PixelFrame,
  options: PixelSvgOptions = {},
): string {
  const dims = options.size ? ` width="${options.size}" height="${options.size}"` : "";
  const rects = pixelRuns(frame.cells, character.palette)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="1" fill="${r.color}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIXEL_GRID} ${PIXEL_GRID}"${dims} shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
