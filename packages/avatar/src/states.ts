// High-level states a host can ask for, mapped onto the engine's own state table.
// The host never needs to know the engine names: it picks one of `AVATAR_STATES`.
import type { AvatarState as EngineState } from "./model/states.js";

export const AVATAR_STATES = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "asking",
  "done",
  "failed",
  "paused",
  "sleeping",
  "celebrating",
] as const;

export type AvatarStateId = (typeof AVATAR_STATES)[number];

/** Public state -> engine state (clips, face and indicator morph live in `data/states.ts`). */
export const STATE_MAP: Readonly<Record<AvatarStateId, EngineState>> = {
  /** Resting; blinks and glances around. */
  idle: "idle",
  /** Working something out: the body turns into the "thinking" dots indicator. */
  thinking: "thinking",
  /** Busy doing a task: working clips. */
  working: "working",
  /** Waiting for something external (a tool, a process): orbit indicator. */
  waiting: "waiting",
  /** Needs the user's attention or an answer: curious, inspecting eyes. */
  asking: "curious",
  /** Finished successfully: happy face and a short celebration, then back to idle. */
  done: "finished",
  /** Failed: a dejected clip, then back to idle. */
  failed: "failed",
  /** Paused by the user: calm eyes, head slightly tilted, no activity. */
  paused: "listening",
  /** Asleep: sleepy face. */
  sleeping: "sleeping",
  /** Big celebration (spin). */
  celebrating: "celebrate",
};

export function isAvatarState(value: unknown): value is AvatarStateId {
  return typeof value === "string" && (AVATAR_STATES as readonly string[]).includes(value);
}

export function engineStateOf(state: AvatarStateId): EngineState {
  return STATE_MAP[state];
}
