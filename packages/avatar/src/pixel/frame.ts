// Um quadro pronto para desenhar: grade de células, deslocamento e uma chave para saber se mudou.
import { hash } from "../geometry/math.js";
import { animatedCells, staticCells } from "./cells.js";
import type { PixelCharacter } from "./character.js";
import { PIXEL_UNIT } from "./data/characters.js";
import { type PixelPose, type PixelStateInput, poseOf } from "./states.js";
import { sampleTimeline } from "./timeline.js";

export type PixelFrame = {
  /** 19 linhas de 19 letras (ver `cells.ts`). */
  cells: readonly string[];
  /** Deslocamento vertical em células (0 ou até -1/3). Negativo = sobe. */
  dyCells: number;
  /** Muda quando (e só quando) o que se vê muda, depois de arredondar para pixels. */
  key: string;
};

/** A pose parada (a variante do Figma): imagens fixas e movimento reduzido. */
export function pixelStill(character: PixelCharacter, state: PixelStateInput = "idle"): PixelFrame {
  const pose = poseOf(state);
  return {
    cells: staticCells(character.character, pose),
    dyCells: 0,
    key: `s|${character.character}|${pose}`,
  };
}

/** Quanto tempo o avatar já está nesta pose (ms) -> o quadro. */
export function pixelFrameAt(
  character: PixelCharacter,
  state: PixelStateInput,
  elapsedMs: number,
): PixelFrame {
  const pose: PixelPose = poseOf(state);
  const s = sampleTimeline(pose, elapsedMs + (pose === "parado" ? phaseMs(character.id) : 0));
  return {
    cells: animatedCells(character.character, pose, s.cells),
    dyCells: s.dy / PIXEL_UNIT,
    key: `a|${character.character}|${pose}|${s.cells}`,
  };
}

/** Parados, os avatares começam o ciclo em pontos diferentes (os da barra não balançam juntos). */
function phaseMs(id: string): number {
  return hash(id) % 1000;
}
