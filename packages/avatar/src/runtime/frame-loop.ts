// A minimal frame loop for ONE runtime. Time and scheduling are injected, so this works with
// `requestAnimationFrame` in a browser, a timer in Node or a native display link in a mobile
// runtime. It keeps scheduling frames and only calls `onFrame` when the picture changed; for many
// avatars in a browser prefer the shared ticker (`createTicker`), which also sleeps when idle.
import type { AvatarRenderData, AvatarRuntime } from "./avatar-runtime.js";

/** Schedules `callback` for the next frame (with a timestamp in ms) and returns a cancel function. */
export type FrameScheduler = (callback: (timeMs: number) => void) => () => void;

export type FrameLoop = {
  start(): void;
  stop(): void;
};

const signature = (d: AvatarRenderData) =>
  `${d.transform}|${d.body}|${d.eyes}|${d.parts.map((p) => `${p.cx},${p.cy},${p.r},${p.opacity}`).join(";")}`;

export function createFrameLoop(
  runtime: AvatarRuntime,
  schedule: FrameScheduler,
  onFrame: (data: AvatarRenderData) => void,
): FrameLoop {
  let cancel: (() => void) | null = null;
  let running = false;
  let lastEmit = Number.NEGATIVE_INFINITY;
  let lastSignature = "";

  const tick = (timeMs: number) => {
    cancel = null;
    if (!running) return;
    if (timeMs - lastEmit >= runtime.frameIntervalMs() - 2) {
      lastEmit = timeMs;
      const data = runtime.frame(timeMs);
      const next = signature(data);
      if (next !== lastSignature) {
        lastSignature = next;
        onFrame(data);
      }
    }
    cancel = schedule(tick);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastSignature = "";
      cancel = schedule(tick);
    },
    stop() {
      running = false;
      cancel?.();
      cancel = null;
    },
  };
}
