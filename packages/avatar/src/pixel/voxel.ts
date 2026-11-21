// Pixel 3D, passo 1: cada desenho 19 x 19 do dono vira um sólido de voxels (um prisma arredondado).
//
// O corpo ganha profundidade em cada coluna: quanto mais longe da borda da silhueta, mais fundo.
// O perfil segue um círculo (as bordas ficam finas e o miolo cheio), então o desenho lê como um
// volume macio e não como uma lajota. Olhos são só a cor da face da frente; o símbolo do estado
// (fora do corpo) é uma plaqueta fina que flutua, como no Figma. Tudo inteiro, sem sorteio.
import { inGlyphRegion, staticCells } from "./cells.js";
import type { PixelCharacterId } from "./character.js";
import { PIXEL_GRID } from "./data/characters.js";

/** Meia-profundidade da célula de borda (o chanfro). */
export const VOXEL_EDGE_HALF = 1;
/** Meia-profundidade máxima (inteira). O corpo ocupa `z` de `-h` a `h - 1`. */
export const VOXEL_HALF_MAX = 3;
/** O símbolo é uma plaqueta de 2 voxels (z = -1 e 0). */
export const VOXEL_SPRITE_HALF = 1;

export const KIND_EMPTY = 0;
export const KIND_BODY = 1;
export const KIND_SPRITE = 2;

export type VoxelModel = {
  /** Por coluna (`y * 19 + x`): 0 vazio, 1 corpo, 2 símbolo. */
  kind: Uint8Array;
  /** Por coluna: meia-profundidade (o sólido vai de `-half` a `half - 1`). */
  half: Uint8Array;
  /** Por coluna: a letra da grade de células (a cor da face da frente). */
  letter: string[];
};

const cache = new WeakMap<readonly string[], VoxelModel>();

/**
 * Perfil: a borda da silhueta (a primeira célula) é um chanfro mais fino; o resto é o miolo cheio.
 * Um degrau só, de `VOXEL_EDGE_HALF` para `VOXEL_HALF_MAX`: degraus em série viram um ruído de
 * pontinhos escuros quando o sólido gira, e um degrau largo fica uma linha firme.
 */
export function halfDepth(e: number): number {
  return e < 1 ? VOXEL_EDGE_HALF : VOXEL_HALF_MAX;
}

/**
 * O sólido de um quadro de células. O corpo é o que a pose parada do personagem já desenha;
 * dentro da região do símbolo, só o que a pose parada desenha como corpo continua corpo, o resto
 * (pontos, "?", "!", lâmpada) é plaqueta. Assim a vista de frente repete exatamente o desenho 2D.
 */
export function buildVoxelModel(character: PixelCharacterId, cells: readonly string[]): VoxelModel {
  const hit = cache.get(cells);
  if (hit !== undefined) return hit;
  const base = staticCells(character, "parado");
  const n = PIXEL_GRID;
  const kind = new Uint8Array(n * n);
  const half = new Uint8Array(n * n);
  const letter = new Array<string>(n * n).fill(".");
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const ch = cells[y]?.charAt(x) ?? ".";
      if (ch === ".") continue;
      const col = y * n + x;
      letter[col] = ch;
      const isBody =
        (ch === "B" || ch === "E" || ch === "A") &&
        (!inGlyphRegion(x, y) || (base[y]?.charAt(x) ?? ".") !== ".");
      kind[col] = isBody ? KIND_BODY : KIND_SPRITE;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const col = y * n + x;
      if (kind[col] === KIND_SPRITE) {
        half[col] = VOXEL_SPRITE_HALF;
      } else if (kind[col] === KIND_BODY) {
        // Distância (euclidiana, entre centros) até a célula não-corpo mais próxima; fora da
        // grade conta como vazio. A borda do desenho fica a meia célula do centro da vizinha.
        let best = Number.POSITIVE_INFINITY;
        const reach = 2;
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            const cx = x + dx;
            const cy = y + dy;
            const inside =
              cx >= 0 && cy >= 0 && cx < n && cy < n && kind[cy * n + cx] === KIND_BODY;
            if (!inside) best = Math.min(best, Math.hypot(dx, dy));
          }
        }
        half[col] = halfDepth(best - 0.5);
      }
    }
  }
  const model: VoxelModel = { kind, half, letter };
  cache.set(cells, model);
  return model;
}

/** Quantos voxels de corpo e de símbolo o modelo tem (para testes). */
export function voxelCount(model: VoxelModel): number {
  let total = 0;
  for (let col = 0; col < model.kind.length; col++) {
    if (model.kind[col] !== KIND_EMPTY) total += (model.half[col] as number) * 2;
  }
  return total;
}
