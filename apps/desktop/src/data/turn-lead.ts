import type { Approval, RunEvent } from "@suup/api";

// What the bot said in the turn of a call, to be drawn ABOVE the card that call becomes (owner,
// 25/11/2026: "o bot fala e ENTÃO o cartão aparece"). Read from DECLARED data only: the
// `model_response` event holds the blocks of the turn, and the call is found by its exact id
// (`tool_call` block). No text is compared or searched.

/** The words of one turn, and which turn it was (so a turn with two cards says them once). */
export interface TurnLead {
  text: string;
  /** Unique per turn: the run and the position of its `model_response` event. */
  turn: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The text the bot wrote in the turn in which it made the call `callId`; `undefined` when none. */
export function turnLeadOf(
  runId: string,
  events: readonly RunEvent[],
  callId: string,
): TurnLead | undefined {
  for (const event of events) {
    if (event.type !== "model_response") continue;
    const blocks = event.payload.blocks;
    if (!Array.isArray(blocks)) continue;
    if (!blocks.some((b) => isObject(b) && b.type === "tool_call" && b.id === callId)) continue;
    // The same joining the harness uses for `lead` (text blocks, trimmed, in order).
    const text = blocks
      .flatMap((b) =>
        isObject(b) && b.type === "text" && typeof b.text === "string" ? [b.text.trim()] : [],
      )
      .filter((t) => t !== "")
      .join("\n\n");
    return text === "" ? undefined : { text, turn: `${runId}:${event.seq}` };
  }
  return undefined;
}

/**
 * The lead of each approval card, by approval id, from the events of the run that asked (only the
 * runs whose events are loaded: for another one the card has no words above it).
 */
export function approvalLeads(
  approvals: readonly Pick<Approval, "id" | "runId" | "callId">[],
  eventsByRun: Readonly<Record<string, readonly RunEvent[] | undefined>>,
): Record<string, TurnLead> {
  const out: Record<string, TurnLead> = {};
  for (const approval of approvals) {
    const events = eventsByRun[approval.runId];
    if (events === undefined) continue;
    const lead = turnLeadOf(approval.runId, events, approval.callId);
    if (lead !== undefined) out[approval.id] = lead;
  }
  return out;
}
