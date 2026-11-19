import { describe, expect, it } from "vitest";
import { type Message, validateConversation } from "../messages.js";
import { ProviderError } from "../provider.js";
import { replayRun } from "../replay.js";
import {
  call,
  createRig,
  eventsOfType,
  lastStatus,
  problemsInRequests,
  say,
  textOf,
  use,
} from "../testing/index.js";
import {
  COMPACTION_THRESHOLD_RANGE,
  chooseCutIndex,
  DEFAULT_COMPACTION_THRESHOLD,
  renderTranscript,
} from "./context.js";
import { runLoop } from "./loop.js";
import { rebuildState } from "./state.js";

const BIG = { inputTokens: 800, outputTokens: 10 };
const echo = (id: string, text: string) => call(id, "echo", { text });

/** Four tool turns; the fourth reports a context size above 70% of a 1000-token window. */
function fourTurns(summaryStep: unknown, tail: unknown[] = [say("All done.")]) {
  return [
    use(echo("c1", "alpha")),
    use(echo("c2", "bravo")),
    use(echo("c3", "charlie")),
    { blocks: [echo("c4", "delta")], usage: BIG },
    summaryStep,
    ...tail,
  ] as never[];
}

const smallWindow = { model: { id: "m", contextWindow: 1000, maxOutputTokens: 500 } };

describe("compaction", () => {
  it("triggers at 70% of the window, keeps tool pairs together and starts with the summary", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: fourTurns(say("SUMMARY: alpha and bravo were echoed.")),
    });
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    const [compacted] = eventsOfType(events, "compacted");
    expect(compacted?.payload).toMatchObject({
      summary: "SUMMARY: alpha and bravo were echoed.",
      droppedMessages: 5,
    });
    expect(compacted?.payload.degraded).toBeUndefined();

    // The summarizer saw the old part as a transcript, with the instructions.
    const summarizer = rig.provider.requests[4];
    expect(summarizer?.tools).toEqual([]);
    expect(summarizer?.system).toContain("decisions made");
    expect(summarizer?.system).toContain("what was tried and failed");
    const transcript = textOf(summarizer?.messages[0]);
    expect(transcript).toContain("[result of echo] echo: alpha");
    expect(transcript).toContain("echo: bravo");
    expect(transcript).not.toContain("charlie");

    // The next agent request: the summary first, then the verbatim tail.
    const after = rig.provider.requests[5]?.messages as Message[];
    expect(after).toHaveLength(5);
    expect(after[0]?.role).toBe("user");
    expect(textOf(after[0])).toContain("SUMMARY: alpha and bravo were echoed.");
    expect(after[1]?.role).toBe("assistant");
    expect(validateConversation(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("echo: alpha");
    expect(JSON.stringify(after)).toContain("echo: charlie");
    expect(JSON.stringify(after)).toContain("echo: delta");

    // The rebuilt state agrees with what was sent (minus the reminder).
    const rebuilt = rebuildState(events).messages;
    expect(validateConversation(rebuilt)).toEqual([]);
    expect(textOf(rebuilt[0])).toContain("SUMMARY");

    // The summarizer call is a recorded, separate call and its tokens count.
    const requests = eventsOfType(events, "model_request");
    expect(requests.filter((e) => e.payload.purpose === "compaction")).toHaveLength(1);
    expect((await rig.record()).turns).toBe(5);
    expect(problemsInRequests(rig.provider)).toEqual([]);
  });

  it("does nothing below the threshold", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: [use(echo("c1", "a")), use(echo("c2", "b")), say("ok")],
    });
    await rig.run();
    expect(eventsOfType(await rig.events(), "compacted")).toHaveLength(0);
  });

  it("estimates from the real count plus chars/4 of what was added since", async () => {
    // 600 real tokens are under the 700 threshold; the 3000-character result adds ~750 more.
    const rig = createRig({
      bot: smallWindow,
      script: [
        use(echo("c1", "a")),
        use(echo("c2", "b")),
        { blocks: [echo("c3", "z".repeat(3000))], usage: { inputTokens: 590, outputTokens: 10 } },
        say("SUMMARY"),
        say("ok"),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "compacted")).toHaveLength(1);
  });

  it("falls back to chars/4 of the whole request when no usage is known yet", async () => {
    // A huge objective: no response has reported usage, so the estimate comes from the text.
    const rig = createRig({
      bot: smallWindow,
      objective: "x".repeat(10_000),
      script: [say("ok")],
    });
    await rig.run();
    // Nothing to cut in a one-message conversation, so no compaction call was made.
    expect(rig.provider.calls).toBe(1);
    expect(eventsOfType(await rig.events(), "compacted")).toHaveLength(0);
  });

  it("on context_overflow compacts and retries the call once", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: [
        use(echo("c1", "alpha")),
        use(echo("c2", "bravo")),
        use(echo("c3", "charlie")),
        new ProviderError("context_overflow", "too long"),
        say("SUMMARY"),
        say("done"),
      ],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const kinds = events.map((e) => e.type).filter((t) => t === "model_error" || t === "compacted");
    expect(kinds).toEqual(["model_error", "compacted"]);
    expect(eventsOfType(events, "model_error")[0]?.payload.kind).toBe("context_overflow");
    // Two requests were recorded for the call that overflowed: before and after compaction.
    const agentRequests = eventsOfType(events, "model_request").filter(
      (e) => e.payload.purpose === undefined,
    );
    expect(agentRequests).toHaveLength(5);
    expect(problemsInRequests(rig.provider)).toEqual([]);
  });

  it("fails with origin provider when the retry overflows again", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: [
        use(echo("c1", "alpha")),
        use(echo("c2", "bravo")),
        use(echo("c3", "charlie")),
        new ProviderError("context_overflow", "too long"),
        say("SUMMARY"),
        new ProviderError("context_overflow", "still too long"),
      ],
    });
    expect(await rig.run()).toBe("failed");
    expect(lastStatus(await rig.events())?.failure?.origin).toBe("provider");
  });

  it("fails with origin limit when an overflow cannot be helped by compacting", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: [new ProviderError("context_overflow", "too long")],
    });
    expect(await rig.run()).toBe("failed");
    expect(lastStatus(await rig.events())?.failure?.origin).toBe("limit");
  });

  it("drops the oldest messages with a stub when the summarizer fails, and records it", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: fourTurns(new ProviderError("network", "summarizer unreachable")),
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const [compacted] = eventsOfType(events, "compacted");
    expect(compacted?.payload.degraded).toBe(true);
    expect(compacted?.payload.warning).toContain("summarizer unreachable");
    expect(compacted?.payload.droppedMessages).toBe(5);
    const after = rig.provider.requests[5]?.messages as Message[];
    expect(textOf(after[0])).toContain("could not be summarized");
    expect(validateConversation(after)).toEqual([]);
    expect(eventsOfType(events, "model_error")[0]?.payload.purpose).toBe("compaction");
  });

  it("treats an empty summary as a failure of the summarizer", async () => {
    const rig = createRig({
      bot: smallWindow,
      script: fourTurns({ blocks: [] }),
    });
    expect(await rig.run()).toBe("done");
    const [compacted] = eventsOfType(await rig.events(), "compacted");
    expect(compacted?.payload.degraded).toBe(true);
    expect(compacted?.payload.warning).toContain("no text");
  });

  it("a second compaction summarizes the first summary too, and everything stays valid", async () => {
    const turn = (i: number, usage?: typeof BIG) => ({
      blocks: [echo(`c${i}`, `item${i}`)],
      ...(usage === undefined ? {} : { usage }),
    });
    const rig = createRig({
      bot: smallWindow,
      script: [
        turn(1),
        turn(2),
        turn(3),
        turn(4, BIG),
        say("SUMMARY ONE"),
        turn(5),
        turn(6),
        turn(7, BIG),
        say("SUMMARY TWO"),
        say("finished"),
      ] as never[],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "compacted")).toHaveLength(2);
    const last = rig.provider.requests.at(-1)?.messages as Message[];
    expect(textOf(last[0])).toContain("SUMMARY TWO");
    expect(JSON.stringify(last)).not.toContain("SUMMARY ONE");
    expect(textOf(rig.provider.requests[8]?.messages[0])).toContain("SUMMARY ONE");
    expect(validateConversation(rebuildState(events).messages)).toEqual([]);
    expect(problemsInRequests(rig.provider)).toEqual([]);
  });
});

describe("chooseCutIndex", () => {
  const u = (text: string): Message => ({ role: "user", blocks: [{ type: "text", text }] });
  const a = (id: string): Message => ({
    role: "assistant",
    blocks: [{ type: "tool_call", id, name: "t", args: {} }],
  });
  const r = (id: string): Message => ({
    role: "user",
    blocks: [{ type: "tool_result", callId: id, content: "ok" }],
  });

  it("cuts at an assistant message and keeps at least four messages", () => {
    const messages = [u("goal"), a("1"), r("1"), a("2"), r("2"), a("3"), r("3"), a("4"), r("4")];
    expect(chooseCutIndex(messages)).toBe(5);
    expect(messages[5]?.role).toBe("assistant");
  });

  it("returns null when there is too little to summarize", () => {
    expect(chooseCutIndex([u("goal"), a("1"), r("1"), a("2"), r("2")])).toBeNull();
    expect(chooseCutIndex([u("goal"), a("1"), r("1")])).toBeNull();
    expect(chooseCutIndex([])).toBeNull();
  });

  it("never separates a tool call from its result", () => {
    const messages = [
      u("g"),
      a("1"),
      r("1"),
      a("2"),
      r("2"),
      a("3"),
      r("3"),
      a("4"),
      r("4"),
      a("5"),
      r("5"),
    ];
    // Conversations at a safe point end with a user message: odd lengths.
    for (let n = 7; n <= messages.length; n += 2) {
      const cut = chooseCutIndex(messages.slice(0, n));
      if (cut === null) continue;
      expect(validateConversation(messages.slice(cut, n))).toEqual([]);
      expect(validateConversation(messages.slice(0, cut))).toEqual([]);
    }
  });
});

describe("renderTranscript", () => {
  it("shortens long results and cuts the oldest part when over budget", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_call", id: "1", name: "shell", args: { c: "ls" } }],
      },
      { role: "user", blocks: [{ type: "tool_result", callId: "1", content: "q".repeat(10_000) }] },
    ];
    const text = renderTranscript(messages, 100_000);
    expect(text).toContain("[assistant called shell]");
    expect(text).toContain("characters omitted");
    expect(text.length).toBeLessThan(2500);
    const cut = renderTranscript(messages, 200);
    expect(cut).toContain("oldest part of the transcript is omitted");
  });
});

describe("compaction threshold (the user's setting, recorded with the run)", () => {
  const withThreshold = (compactionThreshold?: number) => ({
    loadRunContext: async () => ({
      rules: [],
      profile: [],
      history: [],
      ...(compactionThreshold === undefined ? {} : { compactionThreshold }),
    }),
  });

  it("uses the recorded setting: 95% does not compact a request at 80%, 50% does", async () => {
    const relaxed = createRig({
      bot: smallWindow,
      script: fourTurns(say("SUMMARY"), [say("done")]),
    });
    expect(await runLoop(relaxed.deps(withThreshold(0.95)), relaxed.runId)).toBe("done");
    const events = await relaxed.events();
    expect(eventsOfType(events, "compacted")).toEqual([]);
    expect(eventsOfType(events, "context_loaded")[0]?.payload.compactionThreshold).toBe(0.95);

    const tight = createRig({
      bot: smallWindow,
      script: [
        use(echo("c1", "alpha")),
        use(echo("c2", "bravo")),
        use(echo("c3", "charlie")),
        { blocks: [echo("c4", "delta")], usage: { inputTokens: 560, outputTokens: 10 } },
        say("SUMMARY"),
        say("done"),
      ] as never[],
    });
    expect(await runLoop(tight.deps(withThreshold(0.5)), tight.runId)).toBe("done");
    expect(eventsOfType(await tight.events(), "compacted")).toHaveLength(1);
  });

  it("keeps the old point (70%) for a run whose log does not say otherwise", async () => {
    const rig = createRig({ bot: smallWindow, script: fourTurns(say("SUMMARY"), [say("done")]) });
    expect(await runLoop(rig.deps(withThreshold()), rig.runId)).toBe("done");
    expect(eventsOfType(await rig.events(), "compacted")).toHaveLength(1);
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.8);
    expect(COMPACTION_THRESHOLD_RANGE).toEqual({ min: 0.5, max: 0.95 });
  });

  it("a replay compacts at the recorded point, not at whatever the setting is now", async () => {
    for (const threshold of [0.95, 0.5]) {
      const rig = createRig({
        bot: smallWindow,
        script: [
          use(echo("c1", "alpha")),
          use(echo("c2", "bravo")),
          use(echo("c3", "charlie")),
          { blocks: [echo("c4", "delta")], usage: { inputTokens: 560, outputTokens: 10 } },
          ...(threshold === 0.5 ? [say("SUMMARY")] : []),
          say("done"),
        ] as never[],
      });
      await runLoop(rig.deps(withThreshold(threshold)), rig.runId);
      const events = await rig.events();
      const report = await replayRun(events, { bot: rig.bot });
      expect(report.identical, `threshold ${threshold}`).toBe(true);
      expect(eventsOfType(events, "compacted").length).toBe(threshold === 0.5 ? 1 : 0);
    }
  });

  it("asks for the consolidation just before the summary, only queues, and changes nothing the run sees", async () => {
    const seen: string[] = [];
    const withHook = createRig({
      bot: smallWindow,
      script: fourTurns(say("SUMMARY"), [say("done")]),
    });
    await runLoop(
      withHook.deps({
        beforeCompaction: async (run) => {
          // the summarizer has not been called yet
          seen.push(
            `${run.id === withHook.runId ? "run" : "other"}:${withHook.provider.requests.length}`,
          );
        },
      }),
      withHook.runId,
    );
    expect(seen).toEqual(["run:4"]);
    const without = createRig({
      bot: smallWindow,
      script: fourTurns(say("SUMMARY"), [say("done")]),
    });
    await without.run();
    expect(JSON.stringify(withHook.provider.requests)).toBe(
      JSON.stringify(without.provider.requests),
    );
    // the same events, apart from how long a tool really took
    const shape = async (rig: typeof withHook) =>
      JSON.stringify(
        (await rig.events()).map((e) => [e.type, { ...e.payload, durationMs: undefined }]),
      );
    expect(await shape(withHook)).toBe(await shape(without));
  });

  it("a hook that throws changes nothing: the run compacts and finishes", async () => {
    const rig = createRig({ bot: smallWindow, script: fourTurns(say("SUMMARY"), [say("done")]) });
    const status = await runLoop(
      rig.deps({
        beforeCompaction: async () => {
          throw new Error("database down");
        },
      }),
      rig.runId,
    );
    expect(status).toBe("done");
    expect(eventsOfType(await rig.events(), "compacted")).toHaveLength(1);
  });

  it("is not asked when nothing is compacted", async () => {
    let asked = 0;
    const rig = createRig({ script: [use(echo("c1", "a")), say("done")] });
    await runLoop(rig.deps({ beforeCompaction: async () => void asked++ }), rig.runId);
    expect(asked).toBe(0);
  });
});
