import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./loop/store.js";
import { collect, ProviderError } from "./provider.js";
import {
  type RecordedEvent,
  ReplayInvoker,
  ReplayMissingError,
  ReplayProvider,
  replayRun,
} from "./replay.js";
import {
  call,
  createRig,
  eventsOfType,
  eventTypes,
  finishCall,
  planCall,
  type Rig,
  say,
  use,
  verdict,
} from "./testing/index.js";

const step = (id: string, status: "pending" | "in_progress" | "done" | "dropped") => ({
  id,
  title: `Step ${id}`,
  status,
});

/**
 * A recorded run that exercises most of the loop: a plan, a tool error, a user message that
 * arrives while the model is working, a compaction, a nudge, a reviewer rejection and then an
 * approval.
 */
async function recordRichRun(): Promise<{ rig: Rig; events: StoredEvent[] }> {
  const holder: { rig?: Rig } = {};
  const rig = createRig({
    objective: "Write the notes.",
    criteria: ["notes.txt was written"],
    bot: { model: { id: "model-x", contextWindow: 1000, maxOutputTokens: 500 } },
    script: [
      use(
        planCall("c1", [step("s1", "in_progress"), step("s2", "pending")]),
        call("c2", "echo", { text: "one" }),
      ),
      // The user writes while this response is being produced.
      (() => {
        const response = use(
          call("c3", "boom"),
          call("c4", "write_note", { name: "notes.txt", body: "hi" }),
        );
        return Object.assign(async () => {
          holder.rig?.store.postInbox(holder.rig.runId, {
            kind: "user_message",
            text: "Please keep it short.",
          });
          return response;
        });
      })(),
      use(call("c5", "echo", { text: "two" })),
      {
        blocks: [call("c6", "echo", { text: "three" })],
        usage: { inputTokens: 800, outputTokens: 10 },
      },
      say("SUMMARY of the early work."), // the compaction call
      say("I think that is everything."), // a nudge: the plan is still open
      use(planCall("c7", [step("s1", "done"), step("s2", "done")])),
      use(finishCall("c8", "All done.", [{ criterion: "1", evidence: "wrote notes.txt" }])),
      use(call("c9", "echo", { text: "proof" })),
      use(finishCall("c10", "All done, with proof.", [{ criterion: "1", evidence: "echo proof" }])),
    ],
    reviewerScript: [verdict("reject", "Show me the file was checked."), verdict("approve")],
  });
  holder.rig = rig;
  expect(await rig.run()).toBe("done");
  return { rig, events: await rig.events() };
}

describe("replayRun", () => {
  it("replays a rich recorded run as identical, without running anything", async () => {
    const { rig, events } = await recordRichRun();
    // The recording really has what the test claims.
    const types = eventTypes(events);
    for (const type of ["nudge", "compacted", "review", "user_message", "plan_updated"] as const) {
      expect(types, type).toContain(type);
    }
    expect(eventsOfType(events, "tool_result").some((e) => e.payload.isError)).toBe(true);
    expect(eventsOfType(events, "review").map((e) => e.payload.verdict)).toEqual([
      "reject",
      "approve",
    ]);

    const filesBefore = new Map(rig.executor.files);
    const report = await replayRun(events, { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.stoppedBecause).toBeUndefined();
    expect(report.requestDiffs).toEqual([]);
    expect(report.finalStatus).toEqual({ recorded: "done", replayed: "done" });
    expect(report.identical).toBe(true);
    expect(report.replayedEvents).toHaveLength(events.length);
    // No side effect was repeated: the recorded machine was not touched.
    expect(rig.executor.files).toEqual(filesBefore);
    expect(rig.executor.execCalls).toEqual([]);
  });

  it("replays a run that waits for the user and gets an answer, and one that was stopped", async () => {
    const answered = createRig({
      script: [use(call("c1", "escalate", { question: "Blue or red?" })), say("Blue it is.")],
    });
    await answered.run();
    answered.store.postInbox(answered.runId, { kind: "user_message", text: "one" });
    answered.store.postInbox(answered.runId, {
      kind: "user_message",
      text: "two\n\nwith a blank line",
    });
    await answered.run();
    const events = await answered.events();
    expect(eventsOfType(events, "tool_result")[0]?.payload.content).toBe(
      "one\n\ntwo\n\nwith a blank line",
    );
    const report = await replayRun(events, { bot: answered.bot });
    expect(report.identical).toBe(true);
    expect(report.firstDivergence).toBeUndefined();

    const stopped = createRig({ script: [use(call("c1", "escalate", { question: "Which?" }))] });
    await stopped.run();
    stopped.store.postInbox(stopped.runId, { kind: "user_message", text: "never mind" });
    stopped.store.postInbox(stopped.runId, { kind: "stop" });
    await stopped.run();
    const stoppedReport = await replayRun(await stopped.events(), { bot: stopped.bot });
    expect(stoppedReport.finalStatus).toEqual({ recorded: "cancelled", replayed: "cancelled" });
    expect(stoppedReport.identical).toBe(true);

    const mid = createRig({
      script: [use(call("c1", "echo", { text: "x" })), say("Done.")],
    });
    mid.store.postInbox(mid.runId, { kind: "user_message", text: "Also say hi." });
    await mid.run();
    expect((await replayRun(await mid.events(), { bot: mid.bot })).identical).toBe(true);
  });

  it("replays provider errors and loop-level retries", async () => {
    const rig = createRig({
      script: [new ProviderError("rate_limit", "slow down"), say("Fine.")],
    });
    await rig.run();
    const events = await rig.events();
    expect(eventTypes(events)).toContain("model_error");
    const report = await replayRun(events, { bot: rig.bot });
    expect(report.identical).toBe(true);
  });

  it("shows a changed prompt as request diffs, not as a divergence", async () => {
    const { rig, events } = await recordRichRun();
    const changed = { ...rig.bot, personality: "Be extremely formal and long-winded." };
    const report = await replayRun(events, { bot: changed });

    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(report.finalStatus).toEqual({ recorded: "done", replayed: "done" });
    expect(report.requestDiffs.length).toBeGreaterThan(0);
    for (const diff of report.requestDiffs) {
      // Only the agent's own requests carry the personality: reviewer and compaction are untouched.
      expect(diff.purpose).toBe("agent");
      expect(diff.changes.map((c) => c.field)).toEqual(["system"]);
      expect(String(diff.changes[0]?.replayed)).toContain("extremely formal");
      expect(String(diff.changes[0]?.recorded)).not.toContain("extremely formal");
    }
    const agentRequests = eventsOfType(events, "model_request").filter(
      (e) => e.payload.purpose === undefined,
    );
    expect(report.requestDiffs).toHaveLength(agentRequests.length);
    // `index` points at the recorded model_request.
    for (const diff of report.requestDiffs) expect(events[diff.index]?.type).toBe("model_request");
  });

  it("reports which message differs when the run inputs change", async () => {
    const { rig, events } = await recordRichRun();
    // Same answers, but the objective the run started with is worded differently now.
    const tampered = events.map((e) =>
      e.type === "run_started"
        ? { ...e, payload: { ...e.payload, objective: "Write the notes, carefully." } }
        : e,
    );
    const report = await replayRun(tampered as StoredEvent[], { bot: rig.bot });
    // The replay starts from the (changed) run inputs, so its own log matches; what the model
    // would have seen is not what was recorded, and the diffs say where: the first message.
    expect(report.firstDivergence).toBeUndefined();
    expect(report.requestDiffs.length).toBeGreaterThan(0);
    const agentDiffs = report.requestDiffs.filter((d) => d.purpose === "agent");
    expect(agentDiffs.length).toBeGreaterThan(0);
    for (const diff of agentDiffs) expect(diff.changes.map((c) => c.field)).toEqual(["messages"]);
    // The first request differs from its very first message (the objective); after the compaction
    // the objective only survives in the state reminder at the end.
    expect(agentDiffs[0]?.changes[0]?.firstMessage).toBe(0);
    expect(agentDiffs.at(-1)?.changes[0]?.firstMessage).toBeGreaterThan(0);
  });

  describe("a corrupted recording is reported where it breaks", () => {
    it("a model response removed", async () => {
      const { rig, events } = await recordRichRun();
      const responses = events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.type === "model_response" && e.payload.purpose === undefined);
      const victim = responses[2];
      if (victim === undefined) throw new Error("scenario changed");
      const corrupted = events.filter((_, i) => i !== victim.i);

      const report = await replayRun(corrupted, { bot: rig.bot });
      expect(report.identical).toBe(false);
      // The log now has the request followed by what came after the missing answer; the replay
      // (which serves the next recorded answer to this call) writes a response right there.
      expect(report.firstDivergence?.index).toBe(victim.i);
      expect(report.firstDivergence?.recorded?.type).not.toBe("model_response");
      expect(report.firstDivergence?.replayed?.type).toBe("model_response");
    });

    it("the last model response removed: the replay stops asking and says so", async () => {
      const { rig, events } = await recordRichRun();
      const lastResponse = events.map((e) => e.type).lastIndexOf("model_response");
      const corrupted = events.slice(0, lastResponse); // the run is cut off after its last request
      const report = await replayRun(corrupted, { bot: rig.bot });
      expect(report.identical).toBe(false);
      expect(report.firstDivergence?.index).toBe(corrupted.length);
      expect(report.firstDivergence?.reason).toMatch(/no (agent|review) model response number/);
      expect(report.stoppedBecause).toBe(report.firstDivergence?.reason);
      // Nothing after the stop was invented.
      expect(report.replayedEvents).toHaveLength(corrupted.length);
    });

    it("a tool result missing or attached to another call", async () => {
      const { rig, events } = await recordRichRun();
      const at = events.findIndex((e) => e.type === "tool_result" && e.payload.callId === "c4");
      const original = events[at];
      if (original?.type !== "tool_result") throw new Error("scenario changed");
      const corrupted: StoredEvent[] = events.map((e, i) =>
        i === at && e.type === "tool_result"
          ? { ...e, payload: { ...e.payload, callId: "c4-lost" } }
          : e,
      );
      const report = await replayRun(corrupted, { bot: rig.bot });
      expect(report.identical).toBe(false);
      expect(report.firstDivergence?.reason).toBe(
        'the recording has no result for tool call c4 ("write_note")',
      );
      // The replay got as far as logging the call, and no further: no result was invented.
      const callIndex = events.findIndex(
        (e) => e.type === "tool_call" && e.payload.callId === "c4",
      );
      expect(report.firstDivergence?.index).toBe(callIndex + 1);
      expect(report.replayedEvents).toHaveLength(callIndex + 1);
      expect(rig.executor.execCalls).toEqual([]);
    });

    it("a changed tool result shows where the model's next request would differ", async () => {
      const { rig, events } = await recordRichRun();
      const corrupted: StoredEvent[] = events.map((e) =>
        e.type === "tool_result" && e.payload.callId === "c5"
          ? { ...e, payload: { ...e.payload, content: "echo: something else entirely" } }
          : e,
      );
      const report = await replayRun(corrupted, { bot: rig.bot });
      // The replay serves the altered result, so its own log matches the altered recording; the
      // requests recorded afterwards still carry the original text, which is what gives it away.
      expect(report.requestDiffs.length).toBeGreaterThan(0);
      const first = report.requestDiffs[0];
      expect(first?.changes[0]?.field).toBe("messages");
      expect(first?.changes[0]?.firstMessage).toBeGreaterThan(0);
    });

    it("a changed event is reported at its position, with the fields that differ", async () => {
      const { rig, events } = await recordRichRun();
      const at = events.findIndex((e) => e.type === "plan_updated");
      const corrupted: StoredEvent[] = events.map((e, i) =>
        i === at && e.type === "plan_updated"
          ? { ...e, payload: { plan: [step("s1", "done"), step("s2", "done")] } }
          : e,
      );
      const report = await replayRun(corrupted, { bot: rig.bot });
      expect(report.firstDivergence?.index).toBe(at);
      expect(report.firstDivergence?.changedFields).toEqual(["plan"]);
    });
  });

  it("needs a run_started event", async () => {
    await expect(replayRun([], { bot: createRig({ script: [] }).bot })).rejects.toThrow(
      /run_started/,
    );
  });
});

describe("ReplayProvider and ReplayInvoker", () => {
  it("serves the recorded responses per purpose, in order, and fails when they run out", async () => {
    const { events } = await recordRichRun();
    const agent = new ReplayProvider(events);
    const req = { model: "m", system: "s", messages: [], maxOutputTokens: 10 };
    const first = await collect(
      agent.generate({
        ...req,
        tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      }),
      agent.id,
    );
    expect(first.blocks.map((b) => b.type)).toEqual(["tool_call", "tool_call"]);
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // A request without tools is the compaction call.
    const summary = await collect(agent.generate({ ...req, tools: [] }), agent.id);
    expect(summary.blocks).toEqual([{ type: "text", text: "SUMMARY of the early work." }]);

    const reviewer = new ReplayProvider(events, { purpose: "review" });
    expect(reviewer.id).toBe("reviewer");
    const verdicts = [];
    for (let i = 0; i < 2; i++)
      verdicts.push(await collect(reviewer.generate({ ...req, tools: [] })));
    expect(
      verdicts.map((v) => (v.blocks[0] as unknown as { args: { verdict: string } }).args.verdict),
    ).toEqual(["reject", "approve"]);

    const seen: string[] = [];
    const exhausted = new ReplayProvider(events, {
      purpose: "review",
      onMissing: (m) => seen.push(m.message),
    });
    for (let i = 0; i < 2; i++) await collect(exhausted.generate({ ...req, tools: [] }));
    await expect(collect(exhausted.generate({ ...req, tools: [] }))).rejects.toMatchObject({
      kind: "unknown",
      retryable: false,
    });
    expect(seen).toEqual([expect.stringContaining("review model response number 3")]);
  });

  it("returns recorded tool results by call id and never executes anything", async () => {
    const { rig, events } = await recordRichRun();
    const invoker = new ReplayInvoker(events as RecordedEvent[]);
    expect(invoker.specs().map((s) => s.name)).toEqual(rig.registry.specs().map((s) => s.name));
    expect(invoker.specs(["echo"]).map((s) => s.name)).toEqual(["echo"]);
    const ctx = {
      runId: "r",
      botId: "b",
      executor: rig.executor,
      signal: new AbortController().signal,
      now: () => new Date(),
    };

    const failed = await invoker.invoke("boom", {}, ctx, { callId: "c3" });
    expect(failed).toMatchObject({ outcome: "tool_error", output: { isError: true } });
    const wrote = await invoker.invoke("write_note", { name: "other.txt", body: "x" }, ctx, {
      callId: "c4",
    });
    expect(wrote.output.content).toBe("wrote notes.txt"); // the recorded one, whatever the args now say
    expect(rig.executor.files.has("/workspace/other.txt")).toBe(false);

    await expect(invoker.invoke("echo", {}, ctx, { callId: "nope" })).rejects.toBeInstanceOf(
      ReplayMissingError,
    );
    await expect(invoker.invoke("echo", {}, ctx)).rejects.toBeInstanceOf(ReplayMissingError);
  });
});
