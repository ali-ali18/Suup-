// Public character model: identity (shape + colour + seed) and the still SVG renderer.
import { AVATAR_COLORS } from "./data/palette.js";
import { isShape, SHAPE_IDS, type Shape } from "./geometry/shapes.js";
import { eyeColorFor, resolveColor, resolveShape } from "./identity.js";
import { normalizeExpression } from "./model/expressions.js";
import { stateDef } from "./model/states.js";
import { toSvg } from "./render/still.js";
import { safeColor } from "./render/svg.js";
import { type AvatarStateId, engineStateOf } from "./states.js";

export type { Shape };
export { AVATAR_COLORS, SHAPE_IDS };
export type ShapeId = Shape;
export type ColorId = (typeof AVATAR_COLORS)[number]["id"];

/** Everything needed to draw one avatar. Plain data: safe to store, compare and send around. */
export type AvatarCharacter = {
  id: string;
  shape: ShapeId;
  /** Body colour as a CSS colour (hex for the palette colours). */
  color: string;
  /** Colour id when `color` came from the palette, otherwise `null` (custom colour). */
  colorId: string | null;
  /** Eye colour that contrasts with the body (used when eyes are painted instead of cut out). */
  eyeColor: string;
};

export type CreateCharacterInput = {
  /** Stable identity (e.g. a bot id). Drives the default shape, colour and animation timings. */
  id: string;
  /** Shape id; unknown or missing values fall back to the stable per-id default. */
  shape?: string | null | undefined;
  /** Palette colour id (`"blue"`) or a CSS colour (`"#1084FE"`); missing falls back to the per-id default. */
  color?: string | null | undefined;
};

/** Resolves a palette id or a raw colour into a CSS colour. */
function colorValue(color: string | null | undefined, id: string): string {
  const trimmed = color?.trim();
  if (trimmed) {
    const entry = AVATAR_COLORS.find((c) => c.id === trimmed.toLowerCase());
    if (entry) return entry.value;
  }
  return safeColor(resolveColor(trimmed, id), "#777777");
}

export function createCharacter(input: CreateCharacterInput): AvatarCharacter {
  const shape = resolveShape(input.shape, input.id);
  const color = colorValue(input.color, input.id);
  const entry = AVATAR_COLORS.find((c) => c.value.toLowerCase() === color.toLowerCase());
  return {
    id: input.id,
    shape,
    color,
    colorId: entry?.id ?? null,
    eyeColor: eyeColorFor(color),
  };
}

export type RenderStillOptions = {
  /** Width and height in px. Without it the SVG scales with its container. */
  size?: number;
  /**
   * Paint the eyes in the character's own eye colour instead of cutting them out. For a mascot
   * drawn with an outline around its silhouette (a filter): cut-out eyes are holes, and the outline
   * would ring them too.
   */
  paintEyes?: boolean;
};

/**
 * Still SVG string of a character in a state's resting pose. Only the face of the state is used
 * (no animation, no indicator morph). Eyes are cut out of the body, so the background shows
 * through; near-black or near-white bodies paint the eyes with a contrasting colour instead.
 */
export function renderStill(
  character: AvatarCharacter,
  state: AvatarStateId = "idle",
  options: RenderStillOptions = {},
): string {
  const face = stateDef(engineStateOf(state)).face;
  return toSvg({
    shape: isShape(character.shape) ? character.shape : "blob",
    expression: face ? normalizeExpression(face) : "neutral",
    color: character.color,
    ...(options.paintEyes === true ? { eyeColor: character.eyeColor } : {}),
    ...(options.size !== undefined ? { size: options.size } : {}),
    id: `av-${character.id.replace(/[^a-zA-Z0-9_-]/g, "") || "x"}`,
  });
}
