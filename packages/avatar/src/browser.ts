// Browser adapter: the ONLY module of the package that touches `window`, `document`,
// `performance` or `requestAnimationFrame`. The core stays DOM-free and receives time and a
// scheduler from the host; this file builds those from the browser.
import {
  type AvatarTicker,
  createPixelClock,
  createTicker,
  type FrameScheduler,
  type PixelClock,
  type Target,
  type TickerEnv,
} from "./index.js";

export type { AvatarTicker, FrameScheduler, TickerEnv };

/** `requestAnimationFrame` as a `FrameScheduler`; `null` when the feature is missing (SSR, tests). */
export function createRafScheduler(): FrameScheduler | null {
  if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") {
    return null;
  }
  return (callback) => {
    const handle = requestAnimationFrame((timeMs) => callback(timeMs));
    return () => cancelAnimationFrame(handle);
  };
}

/** Monotonic clock in ms (`performance.now`, 0 when unavailable). */
export function browserNow(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** Current `prefers-reduced-motion` preference (`false` outside a browser). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_QUERY).matches;
}

/** Subscribes to preference changes; returns the unsubscribe function. */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(REDUCED_QUERY);
  const handler = () => onChange(media.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/** Ticker environment backed by the DOM (pointer, visibility, IntersectionObserver). */
export function createBrowserEnv(): TickerEnv {
  return {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (id) => window.clearTimeout(id),
    isHidden: () => document.hidden,
    onVisibilityChange(cb) {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    onPointerMove(cb) {
      const handler = (event: PointerEvent) => cb(event.clientX, event.clientY);
      window.addEventListener("pointermove", handler, { passive: true });
      return () => window.removeEventListener("pointermove", handler);
    },
    onPointerLeave(cb) {
      document.documentElement.addEventListener("pointerleave", cb);
      return () => document.documentElement.removeEventListener("pointerleave", cb);
    },
    observeVisible(target: Target, cb) {
      if (typeof IntersectionObserver === "undefined") return () => {};
      // 64 px margin: avoids flapping visible/invisible at the screen edge.
      const observer = new IntersectionObserver(
        (records) => {
          const last = records[records.length - 1];
          if (last) cb(last.isIntersecting);
        },
        { rootMargin: "64px" },
      );
      observer.observe(target as Element);
      return () => observer.disconnect();
    },
  };
}

let shared: AvatarTicker | null = null;

/** Shared browser ticker (one rAF loop for every registered avatar). Call from effects only. */
export function getTicker(): AvatarTicker {
  shared ??= createTicker(createBrowserEnv());
  return shared;
}

let sharedPixel: PixelClock | null = null;

/** Relógio compartilhado dos avatares pixel (um rAF para todos). Call from effects only. */
export function getPixelClock(): PixelClock {
  sharedPixel ??= createPixelClock(createBrowserEnv());
  return sharedPixel;
}
