import type { RunEvent } from "@suup/api";

// Where a card sits in its run's log: the `seq` of the event of the call that became the card. The
// words the bot wrote in the same turn are messages of their own that carry the `seq` of their
// `model_response` event (`message.eventSeq`), so the chat orders the two by these numbers and
// never by time (two writes can share an instant). Read from DECLARED data only: the `callId` the
// event carries, compared exactly.

/** `"<runId>:<callId>"`, the key of `callSeqsOf`. */
export const callSeqKey = (runId: string, callId: string): string => `${runId}:${callId}`;

/** The `seq` of the `tool_call` event of every call of the run, by `callSeqKey`. */
export function callSeqsOf(
  runId: string,
  events: readonly RunEvent[] | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events ?? []) {
    if (event.type !== "tool_call") continue;
    const callId = event.payload.callId;
    if (typeof callId === "string") out[callSeqKey(runId, callId)] ??= event.seq;
  }
  return out;
}
