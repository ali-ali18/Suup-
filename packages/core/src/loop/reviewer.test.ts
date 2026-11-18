import { describe, expect, it } from "vitest";
import { ProviderError } from "../provider.js";
import {
  call,
  createRig,
  eventsOfType,
  eventTypes,
  finishCall,
  lastStatus,
  planCall,
  problemsInRequests,
  say,
  textOf,
  use,
  verdict,
} from "../testing/index.js";
import { buildReviewDigest, parseVerdict } from "./reviewer.js";
import type { ToolLogEntry } from "./state.js";

const evidence = [{ criterion: "1", evidence: "echo returned: echo: hi" }];

describe("reviewer", () => {
  it("approves: the finish is accepted after one separate call with a fresh context", async () => {
    const rig = createRig({
      objective: "Check the echo tool.",
      criteria: ["echo works"],
      script: [
        use(planCall("c1", [{ id: "s1", title: "Call echo", status: "done" }])),
        use(call("c2", "echo", { text: "hi" })),
        use(finishCall("c3", "Echo works.", evidence)),
      ],
      reviewerScript: [verdict("approve", "evidence matches")],
    });
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    const types = eventTypes(events);
    const at = types.indexOf("review");
    expect(types.slice(at - 3, at + 4)).toEqual([
      "tool_call",
      "model_request",
      "model_response",
      "review",
      "finish_attempt",
      "tool_result",
      "status_changed",
    ]);
    expect(eventsOfType(events, "review")[0]?.payload).toEqual({
      verdict: "approve",
      notes: "evidence matches",
    });
    // The review call is recorded in full but marked as such.
    const reviewRequest = eventsOfType(events, "model_request").find(
      (e) => e.payload.purpose === "review",
    );
    expect(reviewRequest?.payload.model).toBe("reviewer-model");
    // The verdict is forced, on the wire request and in the log; agent turns leave it at auto.
    expect(reviewRequest?.payload.toolChoice).toEqual({ name: "verdict" });
    expect(rig.reviewerProvider?.requests[0]?.toolChoice).toEqual({ name: "verdict" });
    for (const e of eventsOfType(events, "model_request")) {
      if (e.payload.purpose === undefined) expect(e.payload).not.toHaveProperty("toolChoice");
    }
    expect(rig.provider.requests.every((r) => r.toolChoice === undefined)).toBe(true);

    // Fresh context: one message, no conversation history, only the verdict tool.
    const request = rig.reviewerProvider?.requests[0];
    expect(request?.messages).toHaveLength(1);
    expect(request?.tools.map((t) => t.name)).toEqual(["verdict"]);
    expect(request?.system).toContain("independent reviewer");
    const text = textOf(request?.messages[0]);
    expect(text).toContain("Check the echo tool.");
    expect(text).toContain("1. echo works");
    expect(text).toContain("[done] s1: Call echo");
    expect(text).toContain("Echo works.");
    expect(text).toContain("echo returned: echo: hi");
    expect(text).toContain('#1 echo {"text":"hi"} -> ok');
    expect(text).toContain('"echo: hi"');
    // The plan control calls are not in the digest of real actions.
    expect(text).not.toContain("#1 plan");

    // Reviewer usage counts toward the run, but not as a turn.
    const run = await rig.record();
    expect(run.turns).toBe(3);
    expect(run.inputTokens).toBe(40);
    expect(problemsInRequests(rig.provider)).toEqual([]);
  });

  it("rejects, the model fixes it, the second review approves", async () => {
    const rig = createRig({
      script: [
        use(finishCall("c1", "Done.")),
        use(call("c2", "echo", { text: "proof" })),
        use(finishCall("c3", "Done, with proof.")),
      ],
      reviewerScript: [verdict("reject", "You showed no proof."), verdict("approve")],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const attempts = eventsOfType(events, "finish_attempt").map((e) => e.payload);
    expect(attempts[0]).toMatchObject({ accepted: false });
    expect(attempts[0]?.rejectionReasons[0]).toContain("You showed no proof.");
    expect(attempts[1]).toMatchObject({ accepted: true });
    expect(eventsOfType(events, "review").map((e) => e.payload.verdict)).toEqual([
      "reject",
      "approve",
    ]);
    // The reviewer's notes reach the model as the result of its finish call.
    const seen = rig.provider.requests[1]?.messages.at(-1)?.blocks[0];
    expect(seen).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect(JSON.stringify(seen)).toContain("You showed no proof.");
    expect(rig.reviewerProvider?.calls).toBe(2);
  });

  it("after maxRejections, a passing finish is not reviewed again: a human decides", async () => {
    const rig = createRig({
      maxRejections: 1,
      script: [
        use(finishCall("c1", "First try.")),
        use(finishCall("c2", "Second try.")),
        use(finishCall("c3", "Third try, after the user spoke.")),
      ],
      reviewerScript: [verdict("reject", "Still no evidence of the deploy.")],
    });
    expect(await rig.run()).toBe("waiting_user");

    const events = await rig.events();
    expect(rig.reviewerProvider?.calls).toBe(1);
    const [escalated] = eventsOfType(events, "escalated");
    expect(escalated?.payload.reason).toBe("review_tie_break");
    expect(escalated?.payload.callId).toBeUndefined();
    expect(escalated?.payload.question).toContain("Second try.");
    expect(escalated?.payload.question).toContain("Still no evidence of the deploy.");
    expect((await rig.record()).status).toBe("waiting_user");
    const attempts = eventsOfType(events, "finish_attempt").map((e) => e.payload);
    expect(attempts[1]).toMatchObject({ accepted: false, handedToUser: true });

    // Without an answer, nothing moves.
    expect(await rig.run()).toBe("waiting_user");
    expect(rig.provider.calls).toBe(2);

    // The user's reply arrives as a message; the next finish is accepted without a review.
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Fine, accept it." });
    expect(await rig.run()).toBe("done");
    expect(rig.reviewerProvider?.calls).toBe(1);
    const after = await rig.events();
    expect(eventsOfType(after, "user_message")[0]?.payload.text).toBe("Fine, accept it.");
    expect(lastStatus(after)?.to).toBe("done");
    expect(problemsInRequests(rig.provider)).toEqual([]);
  });

  it("a malformed verdict counts as an approval with a warning", async () => {
    for (const bad of [
      say("Looks fine to me."),
      use(call("v", "verdict", { verdict: "maybe", notes: 3 })),
      use(call("v", "other_tool", {})),
    ]) {
      const rig = createRig({
        script: [use(finishCall("c1", "Done."))],
        reviewerScript: [bad],
      });
      expect(await rig.run()).toBe("done");
      const [review] = eventsOfType(await rig.events(), "review");
      expect(review?.payload.verdict).toBe("approve");
      expect(review?.payload.warning).toMatch(/approved by default/);
    }
  });

  it("a reviewer that errors is skipped with a warning, and never blocks the run", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [new ProviderError("auth", "reviewer key revoked")],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const [review] = eventsOfType(events, "review");
    expect(review?.payload.verdict).toBe("approve");
    expect(review?.payload.warning).toContain("reviewer key revoked");
    const error = eventsOfType(events, "model_error")[0];
    expect(error?.payload.purpose).toBe("review");
  });

  it("does not force the verdict tool for a model configured as not supporting a forced choice", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [verdict("approve", "ok")],
      reviewerForcedToolChoice: false,
    });
    expect(await rig.run()).toBe("done");
    expect(rig.reviewerProvider?.requests[0]?.toolChoice).toBeUndefined();
    expect(rig.reviewerProvider?.requests[0]?.tools.map((t) => t.name)).toEqual(["verdict"]);
    const events = await rig.events();
    const request = eventsOfType(events, "model_request").find(
      (e) => e.payload.purpose === "review",
    );
    expect(request?.payload).not.toHaveProperty("toolChoice");
    expect(eventsOfType(events, "review")[0]?.payload).toEqual({ verdict: "approve", notes: "ok" });
  });

  it("retries the review once without the forced choice when the API refuses it (HTTP 400)", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done.")), use(finishCall("c2", "Done again."))],
      reviewerScript: [
        new ProviderError("invalid_request", 'tool_choice: type "tool" is not supported', {
          status: 400,
        }),
        verdict("reject", "evidence is thin"),
        verdict("approve", "ok"),
      ],
    });
    // The first review is rejected (after the fallback), the model then finishes again.
    expect(await rig.run()).toBe("done");
    const requests = rig.reviewerProvider?.requests ?? [];
    expect(requests[0]?.toolChoice).toEqual({ name: "verdict" });
    expect(requests[1]?.toolChoice).toBeUndefined();
    const reviews = eventsOfType(await rig.events(), "review");
    expect(reviews[0]?.payload.verdict).toBe("reject");
    expect(reviews[0]?.payload).not.toHaveProperty("warning");
  });

  it("does not call the reviewer when the harness already rejected the finish", async () => {
    const rig = createRig({
      criteria: ["A"],
      script: [
        use(finishCall("c1", "Done.")),
        use(finishCall("c2", "Done.", [{ criterion: "A", evidence: "yes" }])),
      ],
      reviewerScript: [verdict("approve")],
    });
    expect(await rig.run()).toBe("done");
    expect(rig.reviewerProvider?.calls).toBe(1);
  });
});

describe("review digest", () => {
  const entry = (i: number, over: Partial<ToolLogEntry> = {}): ToolLogEntry => ({
    callId: `c${i}`,
    name: "shell",
    args: '{"command":"ls"}',
    outcome: "ok",
    isError: false,
    length: 5,
    head: "hello",
    tail: "",
    ...over,
  });

  it("shows outcome and the start and end of long results", () => {
    const digest = buildReviewDigest([
      entry(1, { length: 5000, head: "AAA", tail: "ZZZ" }),
      entry(2, { outcome: "tool_error", isError: true, head: "boom" }),
    ]);
    expect(digest).toContain('#1 shell {"command":"ls"} -> ok (5000 chars)');
    expect(digest).toContain('start: "AAA"');
    expect(digest).toContain('end: "ZZZ"');
    expect(digest).toContain("-> tool_error, error");
  });

  it("is capped: the oldest calls are left out", () => {
    const log = Array.from({ length: 200 }, (_, i) => entry(i + 1));
    const digest = buildReviewDigest(log, 1000);
    expect(digest.length).toBeLessThan(1200);
    expect(digest).toMatch(/^\(\d+ earlier tool call\(s\) omitted\)/);
    expect(digest).toContain("#200 shell");
    expect(digest).not.toContain("#1 shell");
  });

  it("says so when no tool was called", () => {
    expect(buildReviewDigest([])).toContain("no tool calls");
  });
});

describe("parseVerdict", () => {
  it("reads a well-formed verdict and fills notes for a bare rejection", () => {
    expect(
      parseVerdict([
        { type: "tool_call", id: "v", name: "verdict", args: { verdict: "reject", notes: " " } },
      ]),
    ).toEqual({ verdict: "reject", notes: "(no reason given)" });
  });
});
