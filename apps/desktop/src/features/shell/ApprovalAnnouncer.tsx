import { useEffect, useRef, useState } from "react";
import { useData } from "../../app/context.js";
import { pendingApprovals } from "../../data/reducers.js";

/**
 * Says, to screen readers, that an approval is waiting: once for what is already waiting when the app
 * opens, then for each new card as it arrives, on whatever screen the person is.
 */
export function ApprovalAnnouncer() {
  const approvals = useData((s) => s.approvals);
  const bots = useData((s) => s.bots);
  const loaded = useData((s) => s.approvalsLoaded);
  const seen = useRef<Set<string> | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!loaded) return;
    const waiting = pendingApprovals({ approvals, bots });
    if (seen.current === null) {
      seen.current = new Set(waiting.map((a) => a.id));
      if (waiting.length > 0) {
        setText(
          waiting.length === 1
            ? "Há um pedido de aprovação esperando você."
            : `Há ${waiting.length} pedidos de aprovação esperando você.`,
        );
      }
      return;
    }
    const fresh = waiting.filter((a) => !(seen.current as Set<string>).has(a.id));
    for (const a of fresh) (seen.current as Set<string>).add(a.id);
    const last = fresh[fresh.length - 1];
    if (last !== undefined) {
      setText(`${bots[last.botId]?.name ?? "Um bot"} pede aprovação: ${last.summary}`);
    }
  }, [approvals, bots, loaded]);
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="approval-announcer">
      {text}
    </div>
  );
}
