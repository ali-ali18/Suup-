import type { StoredEvent } from "@suup/core";
import { CONTROL_TOOLS, eventsOf, toolCalls } from "./kit.js";

/** What the event log of one run says about how the model and the harness behaved. */
export interface EventMetrics {
  /** The model versions the provider reported on the agent's own turns, in order of first use. */
  modelVersions: string[];
  /** Times the harness sent the model back to work (it stopped, was cut off or repeated itself). */
  nudges: number;
  /** `finish` attempts refused: by the harness's own checks, or after the reviewer's rejection. */
  finishRejections: { harness: number; reviewer: number };
  /** Times the reviewer was consulted (a review that did not really happen is not counted). */
  reviews: number;
  /** Times the reviewer said no. */
  reviewerRejects: number;
  /** Every tool call, the control tools (`plan`, `finish`, `escalate`) included. */
  toolCalls: number;
  /** Results of working tools that failed (not counting invalid arguments, counted apart). */
  toolErrors: number;
  /** Calls whose arguments did not validate, of any tool. */
  invalidArgs: number;
  /** Provider errors recorded in the log. */
  modelErrors: number;
}

const REVIEWER_REJECTION = "An independent reviewer rejected";

export function eventMetrics(events: readonly StoredEvent[]): EventMetrics {
  const versions: string[] = [];
  for (const event of eventsOf(events, "model_response")) {
    const purpose = event.payload.purpose ?? "agent";
    if (purpose === "agent" && !versions.includes(event.payload.modelVersion)) {
      versions.push(event.payload.modelVersion);
    }
  }
  let harness = 0;
  let reviewer = 0;
  for (const attempt of eventsOf(events, "finish_attempt")) {
    if (attempt.payload.accepted) continue;
    const byReviewer =
      attempt.payload.handedToUser === true ||
      attempt.payload.rejectionReasons.some((r) => r.startsWith(REVIEWER_REJECTION));
    if (byReviewer) reviewer += 1;
    else harness += 1;
  }
  const calls = toolCalls(events);
  const reviews = eventsOf(events, "review").filter((e) => e.payload.warning === undefined);
  return {
    modelVersions: versions,
    nudges: eventsOf(events, "nudge").length,
    finishRejections: { harness, reviewer },
    reviews: reviews.length,
    reviewerRejects: reviews.filter((e) => e.payload.verdict === "reject").length,
    toolCalls: calls.length,
    toolErrors: calls.filter(
      (c) =>
        !CONTROL_TOOLS.has(c.name) &&
        c.result !== undefined &&
        c.result.outcome !== "ok" &&
        c.result.outcome !== "invalid_args",
    ).length,
    invalidArgs: calls.filter((c) => c.result?.outcome === "invalid_args").length,
    modelErrors: eventsOf(events, "model_error").length,
  };
}

/** The `seq` of the last model request of the agent's own turns, to point `suup resend` at. */
export function lastAgentRequestSeq(events: readonly StoredEvent[]): number | null {
  const requests = eventsOf(events, "model_request").filter(
    (e) => (e.payload.purpose ?? "agent") === "agent",
  );
  return requests.at(-1)?.seq ?? null;
}
