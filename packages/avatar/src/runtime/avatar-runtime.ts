// Runtime of ONE avatar: owns the engine, takes the time from the host and hands back render
// data. It never reads the clock and never schedules anything by itself.

import type { AvatarCharacter } from "../avatar.js";
import { createAvatarEngine } from "../engine.js";
import { hash } from "../geometry/math.js";
import type { BrainBudget } from "../model/brain-budget.js";
import type { Frame } from "../model/character.js";
import { normalizeExpression } from "../model/expressions.js";
import { stateDef } from "../model/states.js";
import { PART_SLOTS, type PartAttrs, partAttrs } from "../render/parts.js";
import { createProjector } from "../render/project.js";
import { stillFrame } from "../render/still.js";
import { groupTransform, type ResolvedEyes, renderFrame, resolveEyes } from "../render/svg.js";
import { type AvatarStateId, engineStateOf } from "../states.js";

export type AvatarRuntimeOptions = {
  /** Still pose, no animation: `frame()` returns the same pose for a state whatever the time. */
  reducedMotion?: boolean;
  /** Size in px of the avatar on screen; very small sizes move less. Default: unknown (full motion). */
  size?: number;
  /** Idle breathing clips. Default `true`; `false` lets the avatar settle and only blink. */
  breathe?: boolean;
  /** Continuous "working" motion. Default `false` (a host enables it for the few avatars in focus). */
  brain?: boolean;
  /** Shared limit of avatars with brain motion (see `createBrainBudget`). */
  budget?: BrainBudget;
  /** Initial state. Default `"idle"`. */
  state?: AvatarStateId;
};

/** Everything a view needs to draw one frame, as plain data. */
export type AvatarRenderData = {
  /** SVG `viewBox` attribute. */
  viewBox: string;
  /** `transform` of the body group. */
  transform: string;
  /** `d` of the body path (already projected for the 3D orientation). */
  body: string;
  /** `d` of the two eyes (a single path with exactly two sub-paths). */
  eyes: string;
  /** Body fill. */
  color: string;
  /** How eyes are drawn: `cutout` (holes in the body) or `paint` (filled with `eyeColor`). */
  eyeMode: ResolvedEyes["mode"];
  eyeColor: string;
  /** Indicator parts (dots, rings) as `<circle>` attributes; length is always `PART_SLOTS`. */
  parts: readonly PartAttrs[];
  /** Complete `<svg>` string of this frame (convenient for hosts that do not diff attributes). */
  svg: (size?: number) => string;
};

export type AvatarRuntime = {
  /** Asks for a high-level state. */
  setState(state: AvatarStateId): void;
  /** Where the avatar looks, as a vector with each axis in -1..1; `null` returns to wandering. */
  setGaze(vector: { x: number; y: number } | null): void;
  /** A short "poke" reaction at an optional point (-1..1 per axis). */
  poke(x?: number, y?: number): void;
  blink(): void;
  /** Switches the still-pose mode on or off at runtime (e.g. a user preference change). */
  setReducedMotion(reduced: boolean): void;
  /**
   * Advances to `timeMs` (any monotonic clock the host chooses, in ms) and returns the frame.
   * Calls with the same or an earlier time return the current pose without advancing.
   */
  frame(timeMs: number): AvatarRenderData;
  /** True when nothing moves; the host may stop scheduling frames until the next input. */
  isSettled(): boolean;
  /** ms from the last frame until the engine wants a frame again when settled (`Infinity` = never). */
  nextWakeMs(): number;
  /** Minimum interval in ms the host should leave between frames (30 or 60 fps). */
  frameIntervalMs(): number;
  dispose(): void;
};

/** A frame longer than this is treated as this long (a slow tab must not make the avatar jump). */
const MAX_DT_MS = 100;

export function createAvatarRuntime(
  character: AvatarCharacter,
  options: AvatarRuntimeOptions = {},
): AvatarRuntime {
  const engine = createAvatarEngine({
    shape: character.shape,
    seed: character.id,
    breathe: options.breathe ?? true,
    brain: options.brain ?? false,
    ...(options.size !== undefined ? { size: options.size } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
  });
  const eyes = resolveEyes(character.color);
  const projector = createProjector();
  let reduced = options.reducedMotion ?? false;
  let state: AvatarStateId = options.state ?? "idle";
  let lastTime: number | null = null;
  let disposed = false;
  engine.setState(engineStateOf(state));

  const toData = (frame: Frame, project: typeof projector): AvatarRenderData => {
    const projected = project(frame);
    const indicatorParts = frame.indicator?.parts ?? [];
    const parts: PartAttrs[] = [];
    for (let i = 0; i < PART_SLOTS; i++) parts.push(partAttrs(indicatorParts[i], character.color));
    return {
      viewBox: "0 0 250 250",
      transform: groupTransform(frame),
      body: projected.body,
      eyes: projected.eyes,
      color: character.color,
      eyeMode: eyes.mode,
      eyeColor: eyes.color,
      parts,
      svg: (size) =>
        renderFrame(frame, {
          color: character.color,
          id: `av-${hash(character.id).toString(36)}`,
          ...(size !== undefined ? { size } : {}),
        }),
    };
  };

  const stillData = (): AvatarRenderData => {
    const face = stateDef(engineStateOf(state)).face;
    const frame = stillFrame(character.shape, face ? normalizeExpression(face) : "neutral");
    return toData(frame, createProjector());
  };

  return {
    setState(next) {
      if (next === state) return;
      state = next;
      engine.setState(engineStateOf(next));
    },
    setGaze(vector) {
      engine.setGaze(vector);
    },
    poke(x = 0, y = 0) {
      engine.poke(x, y);
    },
    blink() {
      engine.blink();
    },
    setReducedMotion(next) {
      reduced = next;
      lastTime = null;
    },
    frame(timeMs) {
      if (reduced || disposed) return stillData();
      if (lastTime === null) lastTime = timeMs;
      const dt = Math.min(timeMs - lastTime, MAX_DT_MS);
      if (dt > 0) {
        lastTime = timeMs;
        engine.advance(dt);
      }
      return toData(engine.snapshot(), projector);
    },
    isSettled: () => engine.isSettled(),
    nextWakeMs: () => engine.nextWakeMs(),
    frameIntervalMs: () => engine.frameIntervalMs(),
    dispose() {
      disposed = true;
      engine.dispose();
    },
  };
}
