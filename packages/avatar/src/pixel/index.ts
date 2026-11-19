// Estilo pixel: os 17 mascotes desenhados pelo dono no Figma, em grade de 19 x 19.
export {
  type CreatePixelCharacterInput,
  createPixelCharacter,
  defaultPixelCharacter,
  isPixelCharacterId,
  PIXEL_CHARACTER_IDS,
  PIXEL_CHARACTERS,
  type PixelCharacter,
  type PixelCharacterId,
} from "./character.js";
export {
  createPixelClock,
  PIXEL_FRAME_MS,
  type PixelClock,
  type PixelClockEntry,
  type PixelClockHandle,
} from "./clock.js";
export { PIXEL_GRID, PIXEL_UNIT } from "./data/characters.js";
export {
  bobPixels,
  drawPixelFrame,
  layoutPixels,
  type PixelCanvasContext,
  type PixelLayout,
  type PixelRun,
  type PixelSvgOptions,
  pixelRuns,
  pixelStillSvg,
} from "./draw.js";
export { type PixelFrame, pixelFrameAt, pixelStill } from "./frame.js";
export { PIXEL_INK, type PixelPalette, paletteFor, parseHexColor } from "./palette.js";
export { createPixelPlayer, type PixelPlayer, type PixelPlayerOptions } from "./player.js";
export {
  isPixelOnlyState,
  PIXEL_ONLY_STATES,
  PIXEL_POSE_OF,
  PIXEL_POSES,
  type PixelOnlyState,
  type PixelPose,
  type PixelStateInput,
  POSE_FIGMA_NAME,
  poseOf,
} from "./states.js";
export { cycleMs, sampleTimeline, type TimelineSample } from "./timeline.js";
