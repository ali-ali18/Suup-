// DATA MODULE (swappable): how each shape is built as a 3D solid.
import type { Shape } from "./shapes.js";

export type SolidKind =
  | { type: "sphere" }
  | { type: "revolve"; axis: "x" | "y" }
  /** `halfDepth` e `bevel` em raios do corpo. */
  | { type: "extrusion"; halfDepth: number; bevel: number }
  | { type: "loft"; depth: number };

const SLAB = { type: "extrusion", halfDepth: 0.36, bevel: 0.22 } as const;
const REVOLVE = { type: "revolve", axis: "y" } as const;

/** Depth and bevel per shape. */
export const SOLID_KIND: Record<Shape, SolidKind> = {
  blob: { type: "sphere" },
  pebble: REVOLVE,
  bean: REVOLVE,
  egg: REVOLVE,
  squircle: { type: "extrusion", halfDepth: 0.28, bevel: 0.11 },
  tablet: { type: "revolve", axis: "x" },
  capsule: REVOLVE,
  cylinder: REVOLVE,
  hex: SLAB,
  gem: REVOLVE,
  crystal: REVOLVE,
  wedge: REVOLVE,
  shield: REVOLVE,
  dome: REVOLVE,
  arch: REVOLVE,
  cloud: { type: "loft", depth: 0.72 },
  teardrop: REVOLVE,
  leaf: REVOLVE,
  square: SLAB,
  sparkle: SLAB,
  clover: SLAB,
  flower: SLAB,
  heart: { type: "loft", depth: 0.62 },
  house: SLAB,
  star: { type: "extrusion", halfDepth: 0.3, bevel: 0.18 },
};
