import { describe, expect, it } from "vitest";
import { replayRun } from "../replay.js";
import { createRedactor } from "../secrets.js";
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
  EVIDENCE_BUDGET_CHARS,
  EVIDENCE_MAX_FILE_BYTES,
  EVIDENCE_MAX_ROUNDS,
  fillBudget,
  fingerprint,
} from "./evidence.js";
import { showWithinBudget } from "./evidence-render.js";
import { runLoop } from "./loop.js";

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
    expect(text).toContain('ask for "#1" in "results" with need_evidence');
    // The call's arguments are long too: that is marked apart, as ARGUMENTS, with its own request.
    expect(text).toContain("[ARGUMENTS SHORTENED: only the first 200 of");
    expect(text).toContain('ask for "#1" in "calls" with need_evidence');
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
    expect(allText(rig, 1)).toContain("Evidence round 1 of 3");
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
      script: [
        use(finishCall("c1", "Done.")),
        use(finishCall("c1b", "Done; the totals are in d.md.")),
        use(finishCall("c2", "Done, as decided.")),
      ],
      reviewerScript: [
        needEvidence("v1", "first", { files: ["a.md"] }),
        needEvidence("v2", "second", { files: ["b.md"] }),
        needEvidence("v3", "third", { files: ["c.md"] }),
        needEvidence("v4", "still not sure about the totals", { files: ["d.md"] }),
        // Sent back once to the bot, which finishes again: the second review still lacks it.
        verdict("cannot_verify", "the totals still cannot be checked"),
      ],
    });
    for (const f of ["a.md", "b.md", "c.md", "d.md"]) await rig.executor.writeFile(f, `file ${f}`);
    expect(await rig.run()).toBe("waiting_user");

    const requests = rig.reviewerProvider?.requests ?? [];
    expect(requests).toHaveLength(EVIDENCE_MAX_ROUNDS + 2);
    // The rounds may ask; the last request offers only a decision, and says so.
    expect(JSON.stringify(requests[0]?.tools[0]?.inputSchema)).toContain("need_evidence");
    expect(JSON.stringify(requests[3]?.tools[0]?.inputSchema)).not.toContain("need_evidence");
    expect(allText(rig, 3)).toContain("That was the last evidence round");

    const events = await rig.events();
    expect(eventsOfType(events, "review_evidence")).toHaveLength(3);
    const [review] = eventsOfType(events, "review");
    expect(review?.payload.verdict).toBe("unverified");
    expect(review?.payload.notes).toContain("still asking for evidence after 3 rounds");
    expect(review?.payload.notes).toContain("still not sure about the totals");

    // It lacked evidence: first back to the bot with what the reviewer asked for.
    expect(review?.payload.missingEvidence).toBe(true);
    const [first, attempt] = eventsOfType(events, "finish_attempt");
    expect(first?.payload).toMatchObject({ accepted: false, sentBack: true });
    expect(first?.payload.rejectionReasons[0]).toContain("still not sure about the totals");
    // Then not a rejection of the work: the owner is asked, and the question says what was not verified.
    const [escalated] = eventsOfType(events, "escalated");
    expect(escalated?.payload.reason).toBe("review_tie_break");
    expect(escalated?.payload.question).toContain("could not verify");
    expect(escalated?.payload.question).toContain("the totals still cannot be checked");
    expect(escalated?.payload.question).not.toContain("keeps disagreeing");
    expect(attempt?.payload).toMatchObject({ accepted: false, handedToUser: true });
    expect(attempt?.payload.rejectionReasons[0]).toContain("not a rejection of the work");
    // The extra calls (3 follow-ups) count as turns, besides the agent's own two.
    expect((await rig.record()).turns).toBe(5);

    // When the owner answers, the finish is accepted without a new review.
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Looks fine." });
    expect(await rig.run()).toBe("done");
    // the tie-break is settled: no new review
    expect(rig.reviewerProvider?.calls).toBe(5);
  });

  it("cannot_verify ends the review as unverified with the reviewer's words", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Done.")), use(finishCall("c2", "Done."))],
      reviewerScript: [
        needEvidence("v1", "need it", { files: ["gone.md"] }),
        verdict(
          "cannot_verify",
          "The CNPJ in the summary cannot be checked: gone.md does not exist.",
        ),
        // The bot was sent back once and could not produce it: the second review says the same.
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
    // The event says WHY the user is asked, so the screen can tell "could not verify" from "disagree".
    expect(eventsOfType(events, "escalated")[0]?.payload).toMatchObject({
      reason: "review_tie_break",
      reviewVerdict: "unverified",
    });
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
  it("fills the budget in the order asked: whole items first, one fragment, the rest left out", () => {
    expect(fillBudget([10, 100, 20000], 10000)).toEqual([10, 100, 9890]);
    // The first item that does not fit is the one cut; a later one that fits is shown whole.
    expect(fillBudget([20000, 800, 3000], 10000)).toEqual([6200, 800, 3000]);
    // Nothing worth showing is left: the item is left out (0) instead of a useless fragment.
    expect(fillBudget([9000, 5000], 10000)).toEqual([9000, 0]);
    expect(fillBudget([5], 500)).toEqual([5]);
    expect(fillBudget([], 500)).toEqual([]);
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

describe("review: evidence and secrets", () => {
  const value = "sk-live-9f8e7d6c5b4a";
  const secrets = {
    redactor: createRedactor({ API_TOKEN: value }),
    resolve: async () => ({}),
  };

  it("a file the reviewer asks for is scrubbed in the event and in what the reviewer sees", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "Wrote the config."))],
      reviewerScript: [
        needEvidence("v1", "check the config", { files: ["config.env", "missing.txt"] }),
        verdict("approve"),
      ],
    });
    await rig.executor.writeFile("config.env", `TOKEN=${value}\nREGION=eu\n`);
    expect(await runLoop(rig.deps({ secrets }), rig.runId)).toBe("done");

    const events = await rig.events();
    expect(JSON.stringify(events)).not.toContain(value);
    expect(JSON.stringify(rig.reviewerProvider?.requests)).not.toContain(value);
    expect(JSON.stringify(rig.provider.requests)).not.toContain(value);
    // The reviewer still gets the useful part, with the mark where the value was.
    expect(allText(rig, 1)).toContain("TOKEN=[REDACTED:API_TOKEN]");
    expect(allText(rig, 1)).toContain("REGION=eu");
    // The numbers describe the text that was recorded, not the raw file.
    const [evidence] = eventsOfType(events, "review_evidence");
    const file = evidence?.payload.supplied[0];
    expect(file?.kind === "file" && file.chars).toBe(
      file?.kind === "file" ? file.content.length : -1,
    );
    expect(file?.kind === "file" && file.hash).toBe(
      fingerprint(file?.kind === "file" ? file.content : ""),
    );
  });

  it("a tool result that held a value reaches the reviewer scrubbed too", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: `token ${value} ${"x".repeat(5000)} END-MARK` })),
        use(finishCall("c2", "Echoed the token.")),
      ],
      reviewerScript: [
        needEvidence("v1", "see the whole echo", { results: ["#1"] }),
        verdict("approve"),
      ],
    });
    expect(await runLoop(rig.deps({ secrets }), rig.runId)).toBe("done");
    expect(JSON.stringify(await rig.events())).not.toContain(value);
    expect(JSON.stringify(rig.reviewerProvider?.requests)).not.toContain(value);
    expect(allText(rig, 1)).toContain("[REDACTED:API_TOKEN]");
    expect(allText(rig, 1)).toContain("END-MARK");
  });
  /** O texto que o revisor recebeu como resposta ao seu último pedido de evidência. */
  function evidenceReply(rig: Rig, request: number): string {
    const blocks = (rig.reviewerProvider?.requests[request]?.messages ?? []).flatMap(
      (m) => m.blocks,
    );
    const last = blocks.filter((b) => b.type === "tool_result").at(-1);
    return last?.type === "tool_result" ? last.content : "";
  }

  it("the full arguments of a call are scrubbed in the event and in what the reviewer sees", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: `${"x".repeat(400)} TOKEN=${value} END-ARGS` })),
        use(finishCall("c2", "Echoed with the token.")),
      ],
      reviewerScript: [
        needEvidence("v1", "see the arguments", { calls: ["#1"] }),
        verdict("approve"),
      ],
    });
    expect(await runLoop(rig.deps({ secrets }), rig.runId)).toBe("done");

    const events = await rig.events();
    expect(JSON.stringify(events)).not.toContain(value);
    expect(JSON.stringify(rig.reviewerProvider?.requests)).not.toContain(value);
    expect(evidenceReply(rig, 1)).toContain("TOKEN=[REDACTED:API_TOKEN] END-ARGS");
    const [evidence] = eventsOfType(events, "review_evidence");
    const item = evidence?.payload.supplied[0];
    expect(item?.kind).toBe("tool_call");
    // The numbers describe the scrubbed text the reviewer got, not the raw arguments.
    const shown = evidenceReply(rig, 1);
    expect(shown).toContain(`(${item?.chars} chars, shown in full)`);
  });

  it("a value learned only after the call was recorded is still scrubbed from call arguments and results", async () => {
    // O redator começa vazio: o log guarda o valor cru. Ele é ensinado só quando o revisor pede
    // a evidência; nem o evento de evidência nem o que o revisor recebe podem trazê-lo.
    const late = createRedactor();
    const lateSecrets = { redactor: late, resolve: async () => ({}) };
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: `${"x".repeat(400)} TOKEN=${value} END-ARGS` })),
        use(finishCall("c2", "Echoed with the token.")),
      ],
      reviewerScript: [
        () => {
          late.add("API_TOKEN", value);
          return needEvidence("v1", "see both", { calls: ["#1"], results: ["#1"] });
        },
        verdict("approve"),
      ],
    });
    expect(await runLoop(rig.deps({ secrets: lateSecrets }), rig.runId)).toBe("done");

    const events = await rig.events();
    expect(JSON.stringify(eventsOfType(events, "review_evidence"))).not.toContain(value);
    const reply = evidenceReply(rig, 1);
    expect(reply).not.toContain(value);
    expect(reply).toContain("TOKEN=[REDACTED:API_TOKEN] END-ARGS");
    expect(reply).toContain("Tool CALL #1");
    expect(reply).toContain("Tool RESULT of call #1");
  });
});
