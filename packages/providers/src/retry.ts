/** Waits `ms` milliseconds; must reject (any error) if `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });
    if (signal?.aborted) return reject(abort());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abort());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Exponential backoff with "equal jitter": half of the exponential step is fixed, the other
 * half is random. `retryIndex` is 0 for the first retry. `random` returns [0, 1).
 */
export function backoffDelay(
  retryIndex: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** retryIndex);
  return Math.round(exp / 2 + (random() * exp) / 2);
}
