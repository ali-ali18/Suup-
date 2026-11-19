import { describe, expect, it } from "vitest";
import { replayRun } from "../replay.js";
import {
  bareReject,
  call,
  createRig,
  eventsOfType,
  finishCall,
  needEvidence,
  type Rig,
  use,
  verdict,
} from "../testing/index.js";
import { EVIDENCE_BUDGET_CHARS, EVIDENCE_MAX_ITEMS } from "./evidence.js";

// Evidence about tool CALLS (their arguments), the character budget filled in the order asked, and
// the reviewer that rejects without naming a discrepancy.

const SCRIPT = `cat > /tmp/calc.py <<'EOF'\n${"total = total + 1\n".repeat(40)}print(total)  # LAST-LINE\nEOF`;

/** The conversation the reviewer carried in request `n`, as text. */
function allText(rig: Rig, n: number): string {
  return (rig.reviewerProvider?.requests[n]?.messages ?? [])
    .flatMap((m) => m.blocks)
    .map((b) => (b.type === "tool_result" ? b.content : b.type === "text" ? b.text : ""))
    .join("\n");
}

describe("review: evidence about tool calls", () => {
  it("supplies the full arguments of a call, apart from its result, with real line breaks", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: SCRIPT })),
        use(finishCall("c2", "Computed with /tmp/calc.py.")),
      ],
      reviewerScript: [
        needEvidence("v1", "need the script text", { calls: ["#1"] }),
        verdict("approve"),
      ],
    });
    expect(await rig.run()).toBe("done");

    // The digest shows only the start of the arguments and marks them apart from the result.
    const digest = allText(rig, 0);
    expect(digest.split("\n").find((l) => l.startsWith("#1 echo"))).not.toContain("LAST-LINE");
    expect(digest).toContain("[ARGUMENTS SHORTENED:");
    expect(digest).toContain('ask for "#1" in "calls"');

    const text = allText(rig, 1);
    expect(text).toContain("### Tool CALL #1 echo: its full ARGUMENTS, not its result");
    expect(text).toContain("LAST-LINE");
    expect(text).toContain("total = total + 1\ntotal = total + 1\n");
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.requested.calls).toEqual(["#1"]);
    expect(evidence?.payload.supplied[0]).toMatchObject({ kind: "tool_call", ref: "c1", index: 1 });
    // The log keeps a reference, not a copy: the arguments are already in the tool_call event.
    expect(JSON.stringify(evidence?.payload)).not.toContain("LAST-LINE");
    // The reviewer's own request, as the model sees it later, names the calls it asked for.
    const asked = rig.reviewerProvider?.requests[1]?.messages[1]?.blocks[0];
    expect(asked).toMatchObject({ type: "tool_call", args: { calls: ["#1"] } });
  });

  it("a file outside the workspace stays unreadable, and the reason points to the call that wrote it", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: SCRIPT })),
        use(finishCall("c2", "Computed with /tmp/calc.py.")),
      ],
      reviewerScript: [
        needEvidence("v1", "the script", { files: ["/tmp/calc.py"] }),
        verdict("approve"),
      ],
    });
    expect(await rig.run()).toBe("done");
    const text = allText(rig, 1);
    expect(text).toContain("### Not supplied");
    expect(text).toContain('"/tmp/calc.py"');
    expect(text).toContain("Only files inside the workspace can be read");
    expect(text).toContain("call #1 mentions this path");
    expect(text).toContain('ask for it in "calls"');
    // The boundary was not relaxed: nothing was supplied from outside.
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.supplied).toEqual([]);
  });

  it("a call that does not exist is reported, with the range the digest lists", async () => {
    const rig = createRig({
      script: [use(call("c1", "echo", { text: "x" })), use(finishCall("c2", "Done."))],
      reviewerScript: [needEvidence("v1", "?", { calls: ["#9"] }), verdict("approve")],
    });
    await rig.run();
    expect(allText(rig, 1)).toContain('"#9": no such tool call (the digest lists #1 to #1)');
  });

  it("is replayed identically, call arguments included", async () => {
    const rig = createRig({
      script: [use(call("c1", "echo", { text: SCRIPT })), use(finishCall("c2", "Done."))],
      reviewerScript: [needEvidence("v1", "script", { calls: ["#1"] }), verdict("approve")],
    });
    expect(await rig.run()).toBe("done");
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.identical).toBe(true);
    expect(report.requestDiffs).toEqual([]);
  });
});

describe("review: the budget is the limit, filled in the order asked", () => {
  it("supplies many small items (more than the old cap of 6) in one round", async () => {
    const names = Array.from({ length: 13 }, (_, i) => `f${i}.md`);
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [needEvidence("v1", "all of them", { files: names }), verdict("approve")],
    });
    for (const n of names) await rig.executor.writeFile(n, `content of ${n}`);
    expect(await rig.run()).toBe("done");
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.supplied).toHaveLength(13);
    expect(evidence?.payload.omitted).toBeUndefined();
    expect(allText(rig, 1)).not.toContain("Left out for budget");
  });

  it("an item that does not fit is left out and named; the reviewer gets it next round", async () => {
    const part = EVIDENCE_BUDGET_CHARS / 2 + 1000;
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [
        needEvidence("v1", "three files", { files: ["a.md", "b.md", "c.md"] }),
        needEvidence("v2", "the one left out", { files: ["c.md"] }),
        verdict("approve"),
      ],
    });
    for (const n of ["a.md", "b.md", "c.md"]) {
      await rig.executor.writeFile(n, `${n}:${"x".repeat(part)}`);
    }
    expect(await rig.run()).toBe("done");

    const [first, second] = eventsOfType(await rig.events(), "review_evidence");
    // a.md fits whole; b.md does not fit and is the one cut (what is left is worth showing);
    // c.md is left out, by name, with its size.
    expect(first?.payload.supplied.map((i) => [i.ref, i.sent < i.chars])).toEqual([
      ["a.md", false],
      ["b.md", true],
    ]);
    expect(first?.payload.omitted).toEqual([{ item: "c.md", chars: part + 5 }]);
    const text = allText(rig, 1);
    expect(text).toContain("### Left out for budget");
    expect(text).toContain(`- "c.md" (${part + 5} chars)`);
    expect(text).toContain("Ask for the items left out for budget first");
    expect(second?.payload.supplied[0]).toMatchObject({ ref: "c.md", sent: part + 5 });
  });

  it("naming more items than the sanity cap leaves the rest out, with the reason", async () => {
    const names = Array.from({ length: EVIDENCE_MAX_ITEMS + 2 }, (_, i) => `f${i}.md`);
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [needEvidence("v1", "everything", { files: names }), verdict("approve")],
    });
    for (const n of names) await rig.executor.writeFile(n, "x");
    await rig.run();
    const [evidence] = eventsOfType(await rig.events(), "review_evidence");
    expect(evidence?.payload.supplied).toHaveLength(EVIDENCE_MAX_ITEMS);
    expect(evidence?.payload.missing.map((m) => m.item)).toEqual(names.slice(EVIDENCE_MAX_ITEMS));
  });
});

describe("review: a reject must name a concrete discrepancy", () => {
  it("a reject without one is asked once more; approving then is an approval", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done."))],
      reviewerScript: [bareReject("I cannot point to a specific discrepancy"), verdict("approve")],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "review_reprompt")).toHaveLength(1);
    expect(eventsOfType(events, "review").map((e) => e.payload.verdict)).toEqual(["approve"]);
    // The second question shows the reviewer its own answer and why it was not accepted.
    const messages = rig.reviewerProvider?.requests[1]?.messages ?? [];
    expect(messages[1]?.blocks[0]).toMatchObject({
      type: "tool_call",
      args: { verdict: "reject" },
    });
    expect(allText(rig, 1)).toContain("at least one concrete discrepancy");
    // The extra call is a turn like any other.
    expect((await rig.record()).turns).toBe(2);
  });

  it("twice without a discrepancy is unverified, not a rejection, and says why", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done.")), use(finishCall("c2", "Done."))],
      reviewerScript: [bareReject("vague unease"), bareReject("still vague")],
    });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    const [review] = eventsOfType(events, "review");
    expect(review?.payload.verdict).toBe("unverified");
    expect(review?.payload.notes).toContain("without naming a concrete discrepancy");
    expect(review?.payload.notes).toContain("still vague");
    expect(eventsOfType(events, "review_reprompt")).toHaveLength(1);
    expect(eventsOfType(events, "escalated")[0]?.payload.reason).toBe("review_tie_break");
    // Not counted as a rejection of the work.
    expect(eventsOfType(events, "finish_attempt")[0]?.payload.rejectionReasons[0]).toContain(
      "could not verify",
    );
  });

  it("a valid reject feeds the structured discrepancies to the assistant", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Total is 42.")), use(finishCall("c2", "Total is 41."))],
      reviewerScript: [
        verdict("reject", "Fix the total.", [
          { claimed: "Total is 42", shows: "report.md says Total: 41", where: "report.md line 1" },
        ]),
        verdict("approve"),
      ],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const [attempt] = eventsOfType(events, "finish_attempt");
    const reason = attempt?.payload.rejectionReasons[0] ?? "";
    expect(reason).toContain("Fix the total.");
    expect(reason).toContain("1. Claimed: Total is 42");
    expect(reason).toContain("Evidence shows: report.md says Total: 41");
    expect(reason).toContain("Where: report.md line 1");
    expect(eventsOfType(events, "review")[0]?.payload.discrepancies).toHaveLength(1);
  });

  it("a bare reject after evidence is asked again too, and the replay is identical", async () => {
    const rig = createRig({
      script: [use(call("c1", "echo", { text: SCRIPT })), use(finishCall("c2", "Done."))],
      reviewerScript: [
        needEvidence("v1", "script", { calls: ["#1"] }),
        bareReject("hmm"),
        verdict("approve"),
      ],
    });
    expect(await rig.run()).toBe("done");
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.identical).toBe(true);
    expect(report.requestDiffs).toEqual([]);
  });
});
