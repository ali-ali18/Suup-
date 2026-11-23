import { describe, expect, it } from "vitest";
import type { Block, JsonValue } from "../messages.js";
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
import { verdictToolSpec } from "./control-tools.js";
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

  it("a malformed verdict is a failed review, never an approval: the owner decides", async () => {
    for (const bad of [
      say("Looks fine to me."),
      use(call("v", "verdict", { verdict: "maybe", notes: 3 })),
      use(call("v", "other_tool", {})),
    ]) {
      const rig = createRig({
        script: [use(finishCall("c1", "Done."))],
        reviewerScript: [bad],
      });
      expect(await rig.run()).toBe("waiting_user");
      const events = await rig.events();
      const [review] = eventsOfType(events, "review");
      expect(review?.payload).toMatchObject({ verdict: "unverified", failed: "model" });
      expect(review?.payload.notes).toContain("a revisão falhou");
      expect(review?.payload).not.toHaveProperty("warning");
      expect(eventsOfType(events, "finish_attempt")[0]?.payload).toMatchObject({
        accepted: false,
        handedToUser: true,
      });
      expect(eventsOfType(events, "escalated")[0]?.payload).toMatchObject({
        reason: "review_tie_break",
        reviewVerdict: "unverified",
      });
    }
  });

  it("a reviewer that errors is asked once more; failing again, the finish is not accepted and the owner decides", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [
        new ProviderError("auth", "reviewer key revoked"),
        new ProviderError("auth", "reviewer key revoked"),
      ],
    });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(rig.reviewerProvider?.calls).toBe(2);
    const errors = eventsOfType(events, "model_error");
    expect(errors.map((e) => e.payload.purpose)).toEqual(["review", "review"]);
    const [review] = eventsOfType(events, "review");
    expect(review?.payload).toMatchObject({ verdict: "unverified", failed: "provider" });
    expect(review?.payload.notes).toContain("a revisão falhou");
    expect(review?.payload.notes).toContain("reviewer key revoked");
    expect(eventsOfType(events, "finish_attempt")[0]?.payload).toMatchObject({
      accepted: false,
      handedToUser: true,
    });
    const [escalated] = eventsOfType(events, "escalated");
    expect(escalated?.payload.reason).toBe("review_tie_break");
    expect(escalated?.payload.question).toContain("a revisão falhou");
  });

  it("a passing reviewer error is retried: the second answer approves", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [new ProviderError("overloaded", "busy right now"), verdict("approve", "ok")],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(rig.reviewerProvider?.calls).toBe(2);
    expect(eventsOfType(events, "review")[0]?.payload).toEqual({ verdict: "approve", notes: "ok" });
    expect(eventsOfType(events, "finish_attempt")[0]?.payload.accepted).toBe(true);
    expect(eventsOfType(events, "escalated")).toEqual([]);
  });

  it("in a routine run (nobody answers live), a failed review ends the run not concluded, without asking", async () => {
    const rig = createRig({
      origin: "routine",
      script: [use(finishCall("c1", "Resumo pronto."))],
      reviewerScript: [new ProviderError("network", "down"), new ProviderError("network", "down")],
    });
    expect(await rig.run()).toBe("failed");
    const events = await rig.events();
    expect(eventsOfType(events, "escalated")).toEqual([]);
    expect(eventsOfType(events, "finish_attempt")[0]?.payload).toMatchObject({
      accepted: false,
      endsRun: { origin: "provider" },
    });
    expect(eventsOfType(events, "finish_attempt")[0]?.payload).not.toHaveProperty("handedToUser");
    const end = lastStatus(events);
    expect(end?.to).toBe("failed");
    expect(end?.failure?.origin).toBe("provider");
    expect(end?.failure?.detail).toContain("a revisão falhou");
    const run = await rig.record();
    expect(run.status).toBe("failed");
    // Run again: it stays as it is (nothing waits; the next fire is free to start).
    expect(await rig.run()).toBe("failed");
    expect(rig.reviewerProvider?.calls).toBe(2);
  });

  it("in a routine run, a review that cannot verify also ends the run, never parked for an answer", async () => {
    const rig = createRig({
      origin: "routine",
      script: [use(finishCall("c1", "Resumo pronto."))],
      reviewerScript: [
        use(
          call("v", "verdict", {
            verdict: "cannot_verify",
            notes: "the calendar was never read",
            unchecked: [{ what: "the calendar entries", kind: "result", ref: "#9" }],
          }),
        ),
      ],
    });
    expect(await rig.run()).toBe("failed");
    const events = await rig.events();
    expect(eventsOfType(events, "escalated")).toEqual([]);
    expect(lastStatus(events)?.failure?.origin).toBe("model");
    expect(lastStatus(events)?.failure?.detail).toContain("o revisor não conseguiu confirmar");
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

  it("shows the reviewer what the user was asked and answered (the digest alone has no control tools)", async () => {
    const rig = createRig({
      objective: "Total for last month, as the owner decides.",
      script: [
        use(call("c1", "escalate", { question: "Calendar month or last 30 days?" })),
        use(finishCall("c2", "Done with the calendar month.")),
      ],
      reviewerScript: [verdict("approve", "ok")],
    });
    expect(await rig.run()).toBe("waiting_user");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Calendar month, April." });
    expect(await rig.run()).toBe("done");
    const text = textOf(rig.reviewerProvider?.requests[0]?.messages[0]);
    expect(text).toContain("## Exchanges with the user");
    expect(text).toContain('The assistant asked the user: "Calendar month or last 30 days?"');
    expect(text).toContain('The user answered: "Calendar month, April."');
    // ...and it is not part of the tool-call digest.
    expect(text).not.toContain("#1 escalate");
  });

  it("says so when there was no exchange with the user", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [verdict("approve")],
    });
    await rig.run();
    expect(textOf(rig.reviewerProvider?.requests[0]?.messages[0])).toContain(
      "the user sent no messages",
    );
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
    argsLength: 15,
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
    expect(digest).toMatch(/^\(\d+ earlier tool call\(s\) omitted: #1 to #\d+;/);
    expect(digest).toContain("#200 shell");
    expect(digest).not.toContain("#1 shell");
  });

  it("says so when no tool was called", () => {
    expect(buildReviewDigest([])).toContain("no tool calls");
  });
});

describe("parseVerdict", () => {
  const verdictCall = (args: unknown): Block[] => [
    { type: "tool_call", id: "v", name: "verdict", args: args as JsonValue },
  ];

  it("a reject with no discrepancy is invalid (not a rejection), with the reason", () => {
    const parsed = parseVerdict(verdictCall({ verdict: "reject", notes: " " }));
    expect(parsed).toMatchObject({
      verdict: "reject",
      notes: "(no reason given)",
      callId: "v",
      results: [],
      calls: [],
      files: [],
      discrepancies: [],
    });
    expect(parsed.invalidReject).toContain("at least one concrete discrepancy");
  });

  it("a discrepancy with an empty part does not count", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "reject",
        notes: "wrong",
        discrepancies: [{ claimed: "42", shows: " ", where: "#1", real_mismatch: true }],
      }),
    );
    expect(parsed.invalidReject).toBeDefined();
  });

  it("a reject with a complete discrepancy is valid and keeps it", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "reject",
        notes: "fix the total",
        discrepancies: [
          { claimed: "Total 42", shows: "report says 41", where: "#2", real_mismatch: true },
        ],
      }),
    );
    expect(parsed.invalidReject).toBeUndefined();
    expect(parsed.discrepancies).toEqual([
      { claimed: "Total 42", shows: "report says 41", where: "#2" },
    ]);
  });

  it("an entry the reviewer marks as not a real mismatch is dropped; none left is a bare reject", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "reject",
        notes: "all matches",
        discrepancies: [
          {
            claimed: "CNPJ 0001-95",
            shows: "matches; no discrepancy",
            where: "#2",
            real_mismatch: false,
          },
          { claimed: "Total 42", shows: "consistent", where: "#3", real_mismatch: false },
        ],
      }),
    );
    expect(parsed.discrepancies).toEqual([]);
    expect(parsed.invalidReject).toContain("at least one concrete discrepancy");
    expect(parsed.invalidReject).toContain("The 2 entries you listed were discarded");
  });

  it("keeps only the real ones when real and not-real entries are mixed", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "reject",
        notes: "one is wrong",
        discrepancies: [
          { claimed: "a", shows: "same", where: "#1", real_mismatch: false },
          { claimed: "Total 42", shows: "report says 41", where: "#2", real_mismatch: true },
        ],
      }),
    );
    expect(parsed.invalidReject).toBeUndefined();
    expect(parsed.discrepancies).toEqual([
      { claimed: "Total 42", shows: "report says 41", where: "#2" },
    ]);
  });

  it("an entry without the flag is not confirmed: it is dropped, not an approval by default", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "reject",
        notes: "x",
        discrepancies: [{ claimed: "a", shows: "b", where: "#1" }],
      }),
    );
    expect(parsed.verdict).toBe("reject");
    expect(parsed.warning).toBeUndefined();
    expect(parsed.invalidReject).toBeDefined();
  });

  it("the verdict tool asks for the flag (and the unchecked list) in its schema", () => {
    const schema = JSON.stringify(verdictToolSpec(true).inputSchema);
    expect(schema).toContain('"required":["claimed","shows","where","real_mismatch"]');
    expect(schema).toContain('"required":["what","kind","ref"]');
    expect(JSON.stringify(verdictToolSpec(false).inputSchema)).toContain("real_mismatch");
  });

  it("reads what a cannot_verify says it lacked; a malformed list is empty, not an approval", () => {
    const parsed = parseVerdict(
      verdictCall({
        verdict: "cannot_verify",
        notes: "n",
        unchecked: [
          { what: "the CNPJ", kind: "file", ref: "contrato.md" },
          { what: " ", kind: "other", ref: "" },
          { what: "the total" },
        ],
      }),
    );
    expect(parsed.unchecked).toEqual([
      { what: "the CNPJ", kind: "file", ref: "contrato.md" },
      { what: "the total", kind: "other", ref: "" },
    ]);
    const bad = parseVerdict(verdictCall({ verdict: "cannot_verify", notes: "n", unchecked: "x" }));
    expect(bad.verdict).toBe("cannot_verify");
    expect(bad.unchecked).toEqual([]);
    expect(bad.warning).toBeUndefined();
  });

  it("an approval or cannot_verify needs no discrepancy", () => {
    expect(
      parseVerdict(verdictCall({ verdict: "approve", notes: "" })).invalidReject,
    ).toBeUndefined();
    expect(
      parseVerdict(verdictCall({ verdict: "cannot_verify", notes: "x" })).invalidReject,
    ).toBeUndefined();
  });

  it("reads the calls the reviewer asked for", () => {
    const parsed = parseVerdict(
      verdictCall({ verdict: "need_evidence", notes: "n", results: ["#1"], calls: ["#4"] }),
    );
    expect(parsed).toMatchObject({ results: ["#1"], calls: ["#4"], files: [] });
  });
});
