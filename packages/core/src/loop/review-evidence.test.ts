import { describe, expect, it } from "vitest";
import { replayRun } from "../replay.js";
import {
  call,
  createRig,
  eventsOfType,
  type FakeStep,
  finishCall,
  needEvidence,
  type Rig,
  textOf,
  use,
  verdict,
} from "../testing/index.js";
import {
  allocateBudget,
  EVIDENCE_BUDGET_CHARS,
  EVIDENCE_MAX_FILE_BYTES,
  fingerprint,
  showWithinBudget,
} from "./evidence.js";

const LONG = `${"A".repeat(3000)}MIDDLE-FACT${"Z".repeat(3000)}`;

/** The conversation a reviewer request carried, as text, whatever the block kinds. */
function allText(rig: Rig, request: number): string {
  const req = rig.reviewerProvider?.requests[request];
  return (req?.messages ?? [])
    .flatMap((m) => m.blocks)
    .map((b) => (b.type === "tool_result" ? b.content : b.type === "text" ? b.text : ""))
    .join("\n");
}

const longRun = (reviewerScript: FakeStep[]) =>
  createRig({
    objective: "Check the long document.",
    script: [
      use(call("c1", "echo", { text: LONG })),
      use(finishCall("c2", "The document says MIDDLE-FACT.")),
      use(finishCall("c3", "The document says MIDDLE-FACT, checked.")),
    ],
    reviewerScript,
  });

describe("review: evidence rounds", () => {
  it("the digest marks shortened results with the id the reviewer can ask for", async () => {
    const rig = longRun([verdict("approve")]);
    await rig.run();
    const text = allText(rig, 0);
    expect(text).toContain("#1 echo");
    expect(text).toContain("[SHORTENED: only the start and end of");
    expect(text).toContain('ask for "#1" with need_evidence');
    expect(text).not.toContain('MIDDLE-FACT"');
    // The reviewer is told what it can do, and the verdict tool lists the new outcomes.
    expect(rig.reviewerProvider?.requests[0]?.system).toContain("need_evidence");
    const spec = rig.reviewerProvider?.requests[0]?.tools[0];
    expect(JSON.stringify(spec?.inputSchema)).toContain("need_evidence");
  });

  it("asks for a tool result, gets it in full, then approves", async () => {
    const rig = longRun([
      needEvidence("v1", "I cannot see the middle of the echo result", { results: ["#1"] }),
      verdict("approve", "MIDDLE-FACT is there"),
    ]);
    expect(await rig.run()).toBe("done");

    const requests = rig.reviewerProvider?.requests ?? [];
    expect(requests).toHaveLength(2);
    // Second request: the first message, the reviewer's own call, the evidence as its result.
    const second = requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(allText(rig, 1)).toContain("MIDDLE-FACT");
    expect(allText(rig, 1)).toContain("Evidence round 1 of 2");
    expect(allText(rig, 1)).toContain("shown in full");

    const events = await rig.events();
    const [evidence] = eventsOfType(events, "review_evidence");
    expect(evidence?.payload).toMatchObject({
      round: 1,
      callId: "v1",
      requested: { results: ["#1"], files: [] },
      missing: [],
      budgetChars: EVIDENCE_BUDGET_CHARS,
    });
    // A tool result is already in the log: it is referenced, not copied.
    expect(evidence?.payload.supplied).toEqual([
      { kind: "tool_result", ref: "c1", index: 1, chars: LONG.length + 6, sent: LONG.length + 6 },
    ]);
    expect(JSON.stringify(evidence?.payload)).not.toContain("MIDDLE-FACT");
    // Both requests and both answers are recorded, and the approval is the only review event.
    expect(
      eventsOfType(events, "model_request").filter((e) => e.payload.purpose === "review"),
    ).toHaveLength(2);
    expect(eventsOfType(events, "review").map((e) => e.payload.verdict)).toEqual(["approve"]);

    // The extra call counts as a turn (2 agent turns and 1 follow-up) and its tokens are counted.
    const run = await rig.record();
    expect(run.turns).toBe(3);
  });

  it("asks for a workspace file, read through the executor, then approves", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Wrote the report."))],
      reviewerScript: [
        needEvidence("v1", "check the report", { files: ["report.md"] }),
        verdict("approve"),
      ],
    });
    await rig.executor.writeFile("report.md", "Total: 42\n");
    const readsBefore = rig.executor.execCalls.length;
    expect(await rig.run()).toBe("done");

    expect(allText(rig, 1)).toContain("### File report.md (10 chars, shown in full)");
    expect(allText(rig, 1)).toContain("Total: 42");
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.supplied).toEqual([
      {
        kind: "file",
        ref: "report.md",
        chars: 10,
        sent: 10,
        hash: fingerprint("Total: 42\n"),
        content: "Total: 42\n",
      },
    ]);
    // Read only: nothing was executed.
    expect(rig.executor.execCalls.length).toBe(readsBefore);
  });

  it("asks for evidence and then rejects with a concrete discrepancy", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Total is 42.")), use(finishCall("c2", "Total is 41."))],
      reviewerScript: [
        needEvidence("v1", "need the report", { files: ["report.md"] }),
        verdict("reject", "The summary says 42 but report.md line 1 says Total: 41."),
        verdict("approve"),
      ],
    });
    await rig.executor.writeFile("report.md", "Total: 41\n");
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const attempts = eventsOfType(events, "finish_attempt").map((e) => e.payload);
    expect(attempts[0]).toMatchObject({ accepted: false });
    expect(attempts[0]?.rejectionReasons[0]).toContain("report.md line 1 says Total: 41");
    // The rounds belong to one review: the second finish starts a new one from scratch.
    expect(eventsOfType(events, "review_evidence")).toHaveLength(1);
    expect(textOf(rig.reviewerProvider?.requests[2]?.messages[0])).toContain("Total is 41.");
    expect(rig.reviewerProvider?.requests[2]?.messages).toHaveLength(1);
  });

  it("after the last round the reviewer must decide: it cannot ask again", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done.")), use(finishCall("c2", "Done, as decided."))],
      reviewerScript: [
        needEvidence("v1", "first", { files: ["a.md"] }),
        needEvidence("v2", "second", { files: ["b.md"] }),
        needEvidence("v3", "still not sure about the totals", { files: ["c.md"] }),
      ],
    });
    for (const f of ["a.md", "b.md", "c.md"]) await rig.executor.writeFile(f, `file ${f}`);
    expect(await rig.run()).toBe("waiting_user");

    const requests = rig.reviewerProvider?.requests ?? [];
    expect(requests).toHaveLength(3);
    // Rounds 1 and 2 may ask; the third request offers only a decision, and says so.
    expect(JSON.stringify(requests[0]?.tools[0]?.inputSchema)).toContain("need_evidence");
    expect(JSON.stringify(requests[2]?.tools[0]?.inputSchema)).not.toContain("need_evidence");
    expect(allText(rig, 2)).toContain("That was the last evidence round");

    const events = await rig.events();
    expect(eventsOfType(events, "review_evidence")).toHaveLength(2);
    const [review] = eventsOfType(events, "review");
    expect(review?.payload.verdict).toBe("unverified");
    expect(review?.payload.notes).toContain("still asking for evidence after 2 rounds");
    expect(review?.payload.notes).toContain("still not sure about the totals");

    // Not a rejection of the work: the owner is asked, and the question says what was not verified.
    const [escalated] = eventsOfType(events, "escalated");
    expect(escalated?.payload.reason).toBe("review_tie_break");
    expect(escalated?.payload.question).toContain("could not verify");
    expect(escalated?.payload.question).toContain("still not sure about the totals");
    expect(escalated?.payload.question).not.toContain("keeps disagreeing");
    const [attempt] = eventsOfType(events, "finish_attempt");
    expect(attempt?.payload).toMatchObject({ accepted: false, handedToUser: true });
    expect(attempt?.payload.rejectionReasons[0]).toContain("not a rejection of the work");
    // The extra calls (2 follow-ups) count as turns, besides the agent's own.
    expect((await rig.record()).turns).toBe(3);

    // When the owner answers, the finish is accepted without a new review.
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Looks fine." });
    expect(await rig.run()).toBe("done");
    expect(rig.reviewerProvider?.calls).toBe(3);
  });

  it("cannot_verify ends the review as unverified with the reviewer's words", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [
        needEvidence("v1", "need it", { files: ["gone.md"] }),
        verdict(
          "cannot_verify",
          "The CNPJ in the summary cannot be checked: gone.md does not exist.",
        ),
      ],
    });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    const [review] = eventsOfType(events, "review");
    expect(review).toMatchObject({
      payload: {
        verdict: "unverified",
        notes: "The CNPJ in the summary cannot be checked: gone.md does not exist.",
      },
    });
    // It is not counted as a rejection.
    expect(eventsOfType(events, "escalated")[0]?.payload.question).toContain(
      "The CNPJ in the summary",
    );
  });

  it("an item that does not exist is reported to the reviewer and does not fail the review", async () => {
    const rig = createRig({
      script: [use(call("c1", "echo", { text: "hi" })), use(finishCall("c2", "Done."))],
      reviewerScript: [
        needEvidence("v1", "look at these", {
          results: ["#9", "nope"],
          files: ["missing.md", "../outside.md"],
        }),
        verdict("approve"),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.supplied).toEqual([]);
    expect(evidence?.payload.missing.map((m) => m.item)).toEqual([
      "#9",
      "nope",
      "missing.md",
      "../outside.md",
    ]);
    const text = allText(rig, 1);
    expect(text).toContain("no such tool result (the digest lists #1 to #1)");
    expect(text).toContain("no such file in the workspace");
    expect(text).toContain("path escapes the workspace");
  });

  it("cuts what does not fit the budget, says how much, and tells the reviewer", async () => {
    const big = `HEAD-${"x".repeat(150_000)}-TAIL`;
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [needEvidence("v1", "read it", { files: ["big.txt"] }), verdict("approve")],
    });
    await rig.executor.writeFile("big.txt", big);
    expect(await rig.run()).toBe("done");
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    const [item] = evidence?.payload.supplied ?? [];
    expect(item).toMatchObject({ kind: "file", chars: big.length, sent: EVIDENCE_BUDGET_CHARS });
    const text = allText(rig, 1);
    expect(text).toContain(
      `CUT: showing ${EVIDENCE_BUDGET_CHARS}, ${big.length - EVIDENCE_BUDGET_CHARS} left out`,
    );
    expect(text).toContain(`[... ${big.length - EVIDENCE_BUDGET_CHARS} characters cut here`);
    expect(text).toContain("HEAD-");
    expect(text).toContain("-TAIL");
    expect(text).toContain("Anything inside a cut is NOT verified");
  });

  it("does not read a file above the size limit", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [needEvidence("v1", "read it", { files: ["huge.bin"] }), verdict("approve")],
    });
    await rig.executor.writeFile("huge.bin", "y".repeat(EVIDENCE_MAX_FILE_BYTES + 1));
    expect(await rig.run()).toBe("done");
    expect(allText(rig, 1)).toContain("file too large to supply");
  });

  it("stops asking when the run's limits are reached, and says it could not verify", async () => {
    const rig = createRig({
      bot: { limits: { maxTurns: 2 } },
      script: [use(call("c1", "echo", { text: LONG })), use(finishCall("c2", "Done."))],
      reviewerScript: [needEvidence("v1", "need it", { results: ["#1"] }), verdict("approve")],
    });
    expect(await rig.run()).toBe("waiting_user");
    const [review] = eventsOfType(await rig.events(), "review");
    expect(review?.payload.verdict).toBe("unverified");
    expect(review?.payload.notes).toContain("turn limit reached");
    expect(rig.reviewerProvider?.calls).toBe(1);
  });

  it("is replayed identically, files included, without touching the machine", async () => {
    const rig = createRig({
      objective: "Check the long document.",
      script: [use(call("c1", "echo", { text: LONG })), use(finishCall("c2", "Done."))],
      reviewerScript: [
        needEvidence("v1", "need both", {
          results: ["#1"],
          files: ["report.md", "missing.md"],
        }),
        verdict("approve"),
      ],
    });
    await rig.executor.writeFile("report.md", "Total: 42\n");
    expect(await rig.run()).toBe("done");
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.stoppedBecause).toBeUndefined();
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(report.requestDiffs).toEqual([]);
  });
});

describe("evidence helpers", () => {
  it("shares the budget: small items whole, large ones equally", () => {
    expect(allocateBudget([10, 100, 1000], 500)).toEqual([10, 100, 390]);
    expect(allocateBudget([1000, 1000], 500)).toEqual([250, 250]);
    expect(allocateBudget([5], 500)).toEqual([5]);
    expect(allocateBudget([], 500)).toEqual([]);
  });

  it("shows the start and the end of a cut text, with the size of the cut", () => {
    const shown = showWithinBudget("0123456789".repeat(10), 20);
    expect(shown).toContain("80 characters cut here");
    expect(shown.startsWith("01234567890123")).toBe(true);
    expect(shown.endsWith("456789")).toBe(true);
    expect(showWithinBudget("short", 100)).toBe("short");
  });

  it("fingerprints differ for different texts and are stable", () => {
    expect(fingerprint("a")).toBe(fingerprint("a"));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });
});
