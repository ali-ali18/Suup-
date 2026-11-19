// Public API of @suup/avatar. A host needs nothing else: pick a character, ask for a state,
// either render a still SVG string or drive a runtime frame by frame with its own clock.
export {
  AVATAR_COLORS,
  type AvatarCharacter,
  type ColorId,
  type CreateCharacterInput,
  createCharacter,
  type RenderStillOptions,
  renderStill,
  SHAPE_IDS,
  type ShapeId,
} from "./avatar.js";
export { identityFor } from "./identity.js";
export { type BrainBudget, createBrainBudget } from "./model/brain-budget.js";
export { PART_SLOTS, type PartAttrs } from "./render/parts.js";
export {
  type AvatarRenderData,
  type AvatarRuntime,
  type AvatarRuntimeOptions,
  createAvatarRuntime,
} from "./runtime/avatar-runtime.js";
export { createFrameLoop, type FrameLoop, type FrameScheduler } from "./runtime/frame-loop.js";
export {
  type AvatarEntryInput,
  type AvatarHandle,
  type AvatarTicker,
  createTicker,
  type FollowMode,
  gazeVector,
  type Target,
  type TickerEnv,
} from "./runtime/ticker.js";
export { AVATAR_STATES, type AvatarStateId, isAvatarState, STATE_MAP } from "./states.js";
