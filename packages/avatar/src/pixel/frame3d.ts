// Pixel 3D (opção, desligada por padrão): o mesmo quadro 2D do dono, visto como sólido que balança.

import { hash } from "../geometry/math.js";
import { animatedCells, staticCells } from "./cells.js";
import type { PixelCharacter } from "./character.js";
import { PIXEL_UNIT } from "./data/characters.js";
import { type PixelImage, type PixelView, rasterVoxel } from "./raster3d.js";
import { type PixelStateInput, poseOf } from "./states.js";
import { sampleTimeline } from "./timeline.js";
import { buildVoxelModel } from "./voxel.js";

const DEG = Math.PI / 180;
/** Balanço: gira até 28 graus para cada lado, em 4,8 s por vai-e-vem. */
export const SWAY_YAW_DEG = 28;
export const SWAY_PERIOD_MS = 4800;
/** Inclinação: fica um pouco de cima (6 graus) e oscila 3 graus, para o topo aparecer. */
export const SWAY_PITCH_DEG = 6;
export const SWAY_PITCH_WOBBLE_DEG = 3;
export const SWAY_PITCH_PERIOD_MS = 3200;

/** A vista do balanço parado, no instante `ms` (a fase de cada avatar vem do `id`). */
export function swayView(ms: number, id = ""): PixelView {
  const phase = (hash(id) % 1000) / 1000;
  const yaw = SWAY_YAW_DEG * DEG * Math.sin(2 * Math.PI * (ms / SWAY_PERIOD_MS + phase));
  const pitch =
    (SWAY_PITCH_DEG +
      SWAY_PITCH_WOBBLE_DEG * Math.sin(2 * Math.PI * (ms / SWAY_PITCH_PERIOD_MS + phase))) *
    DEG;
  return { yaw, pitch };
}

/** Uma volta completa (360 graus) em `durationMs`, começando e terminando de frente. */
export function turnView(elapsedMs: number, durationMs: number): PixelView {
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs));
  // suave nas pontas (ease in-out) para parar de frente sem tranco
  const eased = t * t * (3 - 2 * t);
  return { yaw: 2 * Math.PI * eased, pitch: SWAY_PITCH_DEG * DEG * Math.sin(Math.PI * t) };
}

/** A pose parada em 3D de frente: igual ao 2D (grade 19 x 19 no meio da imagem). */
export function pixelStill3d(
  character: PixelCharacter,
  state: PixelStateInput = "idle",
  view: PixelView = { yaw: 0, pitch: 0 },
): PixelImage {
  const cells = staticCells(character.character, poseOf(state));
  return rasterVoxel(buildVoxelModel(character.character, cells), character.palette, view);
}

/** O quadro animado em 3D: os mesmos quadros do dono, girados por `view` (ou pelo balanço). */
export function pixelFrame3dAt(
  character: PixelCharacter,
  state: PixelStateInput,
  elapsedMs: number,
  view?: PixelView,
): PixelImage {
  const pose = poseOf(state);
  const s = sampleTimeline(pose, elapsedMs + (pose === "parado" ? hash(character.id) % 1000 : 0));
  const cells = animatedCells(character.character, pose, s.cells);
  const v = view ?? swayView(elapsedMs, character.id);
  return rasterVoxel(buildVoxelModel(character.character, cells), character.palette, {
    ...v,
    dy: s.dy / PIXEL_UNIT,
  });
}
