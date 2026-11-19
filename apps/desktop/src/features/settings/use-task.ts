import { useCallback, useRef, useState } from "react";

export type TaskResult = { ok: true } | { ok: false; message: string };

/**
 * One write at a time with its state: `busy` while it is on its way, `error` with the server's
 * message when it failed (shown next to what was being done). Nothing is assumed before the answer.
 */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const run = useCallback(async (job: () => Promise<TaskResult>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    const result = await job();
    if (mounted.current) {
      setBusy(false);
      if (!result.ok) setError(result.message);
    }
    return result.ok;
  }, []);
  return { busy, error, run, clear: () => setError(undefined) };
}
