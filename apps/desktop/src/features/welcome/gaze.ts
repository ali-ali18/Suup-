import { useEffect, useRef, useState } from "react";
import { gazeEase } from "../../lib/welcome.js";

/** Where a face looks, as the engine's own gaze vector (x to the right, y down, -1 to 1). */
export type Vector = { x: number; y: number };

/**
 * Where the eyes are now, gliding to `target` in `ms` (ease in and out) instead of the engine's
 * quick spring. Reduced motion: straight to the target. Shared by the stage's bot and its crew.
 */
export function useGlidingGaze(target: Vector, ms: number, reduced: boolean): Vector {
  const [now, setNow] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (reduced) {
      current.current = target;
      setNow(target);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let frame = 0;
    const step = (time: number) => {
      const k = gazeEase((time - start) / ms);
      const next = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k };
      current.current = next;
      setNow(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms, reduced]);
  return now;
}

/** Two looks this close are the same one (no new glide, no new render). */
export function sameLook(a: Vector | null, b: Vector | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02;
}

/** The middle of an element on the screen (what is drawn, so it follows the bot on its trip). */
export function centerOf(el: Element | null): Vector | null {
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
