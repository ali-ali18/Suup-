// DATA MODULE (swappable): the state table (clips, face, indicator morph, follow-up state).
import type { Expression } from "../model/expressions.js";

export type MorphName =
  | "thinking"
  | "orbit"
  | "radar"
  | "progress"
  | "spawning"
  | "dictating"
  | "sending"
  | "receiving"
  | "uploading"
  | "writing"
  | "alerting"
  | "bouncing"
  | "powering-down";

export type StateDef = {
  clips: readonly string[];
  /** Em avatar pequeno só estes clipes (discretos). */
  compactClips?: readonly string[];
  face?: Expression;
  morph?: MorphName;
  next?: string;
  holdSeconds?: number;
};

const WORKING: StateDef = {
  clips: ["Working_A", "Working_B", "Working_C", "Working_D", "Working_E", "Working_F"],
};

/** Segundos até o bloqueio cansar (blocked → drowsy). */
const BLOCKED_HOLD_S = 120;

export const STATE_TABLE = {
  // repouso (a repetição de Idle_B é o peso do sorteio: 3 de 5)
  idle: { clips: ["Idle_B", "Idle_B", "Idle_D", "Idle_B", "Idle_A"], compactClips: ["Idle_B"] },
  listening: { clips: ["Idle_D"], face: "calm" },
  // conversa
  thinking: { clips: ["Idle_B"], morph: "thinking" },
  streaming: { clips: ["Streaming_A", "Streaming_B", "Streaming_C"] },
  // trabalho
  searching: { clips: ["Idle_B"], morph: "radar" },
  // mesmos clipes de trabalho; cada atividade tem rosto próprio (olhos) e o cérebro dá o movimento (brain.ts)
  reading: { ...WORKING, face: "calm" },
  working: WORKING,
  coding: { ...WORKING, face: "squinted" },
  running: WORKING,
  computing: WORKING,
  controlling: { ...WORKING, face: "inspecting" },
  waiting: { clips: ["Idle_B"], morph: "orbit" },
  // resultado
  blocked: { clips: ["Blocked_A"], next: "drowsy", holdSeconds: BLOCKED_HOLD_S },
  finished: { clips: ["Done_B", "Done_A"], face: "happy", next: "idle" },
  failed: { clips: ["Blocked_B"], next: "idle" },
  sleeping: { clips: ["Idle_B"], face: "sleepy" },
  waking: { clips: ["Idle_B"], face: "surprised", next: "idle", holdSeconds: 1.6 },
  // emoções
  happy: { clips: ["Done_A"] },
  excited: { clips: ["Done_C"] },
  laughing: { clips: ["Done_B"] },
  proud: { clips: ["Marketing_B"] },
  curious: { clips: ["Working_B"], face: "inspecting" },
  playful: { clips: ["Bodymoves_A"] },
  shy: { clips: ["Idle_D"], face: "calm" },
  surprised: { clips: ["Idle_B"], face: "surprised" },
  suspicious: { clips: ["Idle_D"], face: "squinted" },
  angry: { clips: ["Blocked_A"], face: "squinted" },
  confused: { clips: ["Blocked_A"] },
  sad: { clips: ["Blocked_B"] },
  drowsy: { clips: ["Blocked_C"] },
  bored: { clips: ["Idle_B"], face: "sleepy" },
  scared: { clips: ["Idle_D"], face: "surprised" },
  // comemoração
  celebrate: { clips: ["Rotation_A"], face: "happy" },
  approving: { clips: ["Rotation_C"], next: "idle" },
  // morphs de indicador
  orbit: { clips: ["Idle_B"], morph: "orbit" },
  radar: { clips: ["Idle_B"], morph: "radar" },
  progress: { clips: ["Idle_B"], morph: "progress" },
  spawning: { clips: ["Idle_B"], morph: "spawning" },
  loading: { clips: ["Idle_B"], morph: "progress" },
  dictating: { clips: ["Idle_B"], morph: "dictating" },
  sending: { clips: ["Idle_B"], morph: "sending" },
  receiving: { clips: ["Idle_B"], morph: "receiving" },
  uploading: { clips: ["Idle_B"], morph: "uploading" },
  writing: { clips: ["Idle_B"], morph: "writing" },
  alerting: { clips: ["Idle_B"], morph: "alerting" },
  bouncing: { clips: ["Idle_B"], morph: "bouncing" },
  "powering-down": { clips: ["Idle_B"], morph: "powering-down" },
  // produto
  humming: { clips: ["Idle_B"], face: "calm" },
  notifying: { clips: ["Done_B"], face: "surprised" },
  dragging: { clips: ["Idle_B"], face: "surprised" },
} as const satisfies Record<string, StateDef>;
