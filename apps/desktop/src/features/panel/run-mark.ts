import { useMemo } from "react";
import { useData } from "../../app/context.js";

/**
 * A mark that moves whenever a run of this bot changes status (a routine's run, or a chat run that
 * created or changed a routine): what the panel shows of the routines is read again on it.
 */
export function useBotRunMark(botId: string): string {
  const runs = useData((s) => s.runs);
  return useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.botId === botId)
        .map((r) => `${r.id}:${r.status}`)
        .sort()
        .join(","),
    [runs, botId],
  );
}
