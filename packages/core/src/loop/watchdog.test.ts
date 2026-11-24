import { describe, expect, it } from "vitest";
import { z } from "zod";
import { replayRun } from "../replay.js";
import { createRedactor } from "../secrets.js";
import { FakeProvider } from "../testing/fake-provider.js";
import {
  call,
  createRig,
  eventsOfType,
  type FakeStep,
  lastStatus,
  planCall,
  type Rig,
  say,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { runLoop } from "./loop.js";
import { rebuildState } from "./state.js";
import type { ProgressJudge, WatchdogConfig } from "./watchdog.js";

const CONTINUE = "Continuar";
const STOP = "Parar por aqui";

/** Distinct, successful reads: the run moves (every call and result is new). */
const distinct = (n: number, prefix = "d"): FakeStep[] =>
  Array.from({ length: n }, (_, i) => use(call(`${prefix}${i}`, "echo", { text: `step ${i}` })));

const verdictOf = (verdict: string, reason = "because"): FakeStep =>
  use(call("j", "progress_verdict", { verdict, reason }));

function judgeOf(
  steps: FakeStep[],
  pricing = false,
): { judge: ProgressJudge; provider: FakeProvider } {
  const provider = new FakeProvider(steps, { id: "judge" });
  return {
    provider,
    judge: {
      provider,
      model: {
        id: "judge-model",
        maxOutputTokens: 512,
        ...(pricing ? { pricing: { inputPerMTok: 1_000_000, outputPerMTok: 0 } } : {}),
      },
    },
  };
}

/** Runs the rig with a judge (and other watchdog settings) in the deps. */
const runWith = (rig: Rig, watchdog: Partial<WatchdogConfig>) =>
  runLoop(rig.deps({ watchdog }), rig.runId);

const checks = async (rig: Rig) => eventsOfType(await rig.events(), "progress_check");
const asked = async (rig: Rig) => eventsOfType(await rig.events(), "escalated");

describe("watchdog: the structural signals", () => {
  it("S1 exact repeat: a nudge at 3, the owner is asked at 5, never a failure", async () => {
    const rig = createRig({
      script: Array.from({ length: 8 }, (_, i) => use(call(`c${i}`, "fixed"))),
    });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge").map((e) => e.payload.reason)).toEqual(["repetition"]);
    const [card] = await asked(rig);
    expect(card?.payload.progress).toEqual({ cause: "repeat", grant: 25 });
    expect(rig.provider.calls).toBe(5);
    expect(lastStatus(events)?.to).toBe("waiting_user");
    const triggers = (await checks(rig)).map((e) => `${e.payload.trigger}:${e.payload.action}`);
    expect(triggers).toEqual(["repeat:nudge", "repeat:ask"]);
  });

  it("S2 near repeat: 4 of the last 8 calls are the same call with results that differ; it only feeds the judge", async () => {
    // `counter` never repeats a result: no nudge, no question, however long it goes on.
    const script = [
      ...Array.from({ length: 12 }, (_, i) => use(call(`c${i}`, "counter"))),
      say("done"),
    ];
    const rig = createRig({ script, bot: { limits: { maxTurns: 100 } } });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge")).toHaveLength(0);
    expect(await asked(rig)).toHaveLength(0);
    // The judge is shown the signal.
    const judged = createRig({
      script: [
        ...distinct(2),
        ...Array.from({ length: 6 }, (_, i) => use(call(`c${i}`, "counter"))),
      ],
      bot: { limits: { maxTurns: 8 } },
    });
    const { judge, provider } = judgeOf([verdictOf("incerto")]);
    await runWith(judged, { judge });
    const digest = JSON.stringify(provider.requests[0]?.messages);
    expect(digest).toContain(
      "most times one call (same arguments, any result) appears in the last 8: 5",
    );
    const [check] = (await checks(judged)).filter((e) => e.payload.trigger === "soft_limit");
    expect(check?.payload.signals.nearRepeat).toBe(5);
  });

  it("S3 the same error 3 times in a row: a nudge once; at 5 the owner is asked", async () => {
    const script = Array.from({ length: 8 }, (_, i) => use(call(`b${i}`, "boom")));
    const rig = createRig({ script });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    // The same error and the same arguments are also an exact repeat: that nudge comes first.
    expect(eventsOfType(events, "nudge").length).toBeGreaterThanOrEqual(1);
    expect((await asked(rig))[0]?.payload.progress?.cause).toBe("repeat");
  });

  it("S3 the same tool failing the same way with different arguments: nudge at 3, ask at 5", async () => {
    // `unknown_tool` is a declared outcome: three different unknown tools in a row is not a
    // repeat of one call, but it is the same failure of the same kind.
    const script = Array.from({ length: 8 }, (_, i) => use(call(`u${i}`, "echo", { wrong: i })));
    const rig = createRig({ script });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge").map((e) => e.payload.reason)).toEqual(["error_loop"]);
    expect((await asked(rig))[0]?.payload.progress?.cause).toBe("error_loop");
    expect(rig.provider.calls).toBe(5);
  });

  it("S4 no tool for 2 turns: nudged each time; the 3rd asks the owner", async () => {
    const rig = createRig({
      script: [
        use(planCall("p", [{ id: "s1", title: "Do it", status: "in_progress" }])),
        say("a"),
        say("b"),
        say("c"),
      ],
    });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge")).toHaveLength(2);
    expect((await asked(rig))[0]?.payload.progress?.cause).toBe("no_tool");
  });

  it("S5 alternation A-B-A-B-A-B: a nudge at 6 calls; the owner is asked at 10", async () => {
    // Two different calls whose results never change, one after the other.
    const script = Array.from({ length: 14 }, (_, i) =>
      use(i % 2 === 0 ? call(`f${i}`, "fixed") : call(`e${i}`, "echo", { text: "same" })),
    );
    const rig = createRig({ script, bot: { limits: { maxTurns: 100 } } });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge").map((e) => e.payload.reason)).toEqual(["alternation"]);
    expect((await asked(rig))[0]?.payload.progress?.cause).toBe("alternation");
    expect(rig.provider.calls).toBe(10);
    const nudgeAt = (await checks(rig)).find((e) => e.payload.action === "nudge");
    expect(nudgeAt?.payload.signals.alternation).toBe(6);
  });
});

describe("watchdog: false positives", () => {
  it("polling a build whose status changes never nudges or asks", async () => {
    const statuses = ["queued", "building 10%", "building 40%", "building 80%", "built"];
    let n = 0;
    const rig = createRig({
      script: [...Array.from({ length: 5 }, (_, i) => use(call(`p${i}`, "status"))), say("built.")],
      tools: [
        defineTool({
          name: "status",
          description: "Build status.",
          input: z.object({}),
          risk: "read",
          execute: async () => ({ content: statuses[n++] ?? "built" }),
        }),
      ],
      // The limit falls in the middle of the polling: the results change, so it extends by itself.
      bot: { limits: { maxTurns: 4 }, allowedTools: ["status"] },
    });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "nudge")).toHaveLength(0);
    expect(await asked(rig)).toHaveLength(0);
    expect((await checks(rig)).some((e) => e.payload.action === "extend")).toBe(true);
  });

  it("waiting twice on the same status is not a loop (the nudge needs 3)", async () => {
    const rig = createRig({
      script: [
        use(call("a", "fixed")),
        use(call("b", "fixed")),
        use(call("c", "echo", { text: "built" })),
        say("ok"),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "nudge")).toHaveLength(0);
    expect(await asked(rig)).toHaveLength(0);
  });

  it("a long run that keeps moving is not asked at the limit: it extends by itself", async () => {
    const rig = createRig({
      script: [...distinct(10), say("done")],
      bot: { limits: { maxTurns: 5 } },
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(await asked(rig)).toHaveLength(0);
    const extension = (await checks(rig)).find((e) => e.payload.action === "extend");
    expect(extension?.payload).toMatchObject({ trigger: "limit", extension: 25, judged: false });
    expect(rebuildState(events).watch.autoExtensions).toBe(1);
  });
});

describe("watchdog: the judge", () => {
  it("avanca with progress extends by 25, without a question", async () => {
    const rig = createRig({
      script: [...distinct(6), say("done")],
      bot: { limits: { maxTurns: 4 } },
    });
    const { judge, provider } = judgeOf([verdictOf("avanca", "files keep changing")]);
    expect(await runWith(rig, { judge })).toBe("done");
    expect(await asked(rig)).toHaveLength(0);
    // Asked at the soft limit (80% of 4 = turn 4, which is also the limit): one call is enough.
    expect(provider.calls).toBeGreaterThanOrEqual(1);
    const extension = (await checks(rig)).find((e) => e.payload.action === "extend");
    expect(extension?.payload).toMatchObject({
      judged: true,
      verdict: "avanca",
      reason: "files keep changing",
      extension: 25,
    });
  });

  it("avanca WITHOUT structural progress does not extend", async () => {
    // The same call, same result: no new call and no new evidence after the first.
    const script = [
      use(call("a", "echo", { text: "x" })),
      use(call("b", "echo", { text: "x" })),
      use(call("c", "echo", { text: "x" })),
      say("not reached"),
    ];
    const rig = createRig({ script, bot: { limits: { maxTurns: 3 } } });
    const { judge } = judgeOf([verdictOf("avanca"), verdictOf("avanca")]);
    // 3 equal calls: the nudge (at 3) comes first and the limit is hit with the repeat active.
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    expect((await asked(rig))[0]?.payload.progress?.cause).toBe("limit");
    expect((await checks(rig)).some((e) => e.payload.action === "extend")).toBe(false);
  });

  it("circulo at the limit asks the owner; incerto asks too", async () => {
    for (const verdict of ["circulo", "incerto"]) {
      const rig = createRig({
        script: [...distinct(4), say("never")],
        bot: { limits: { maxTurns: 3 } },
      });
      const { judge } = judgeOf([verdictOf(verdict), verdictOf(verdict)]);
      expect(await runWith(rig, { judge })).toBe("waiting_user");
      expect((await asked(rig))[0]?.payload.progress?.cause).toBe("limit");
      const limitCheck = (await checks(rig)).find((e) => e.payload.trigger === "limit");
      expect(limitCheck?.payload).toMatchObject({ judged: true, verdict, action: "ask" });
    }
  });

  it("an answer outside the schema counts as incerto and goes to the owner", async () => {
    const bad: FakeStep[] = [
      use(call("j", "progress_verdict", { verdict: "great" })),
      say("text instead of the tool"),
      use(call("j", "progress_verdict", { verdict: "avanca" })),
    ];
    for (const step of bad) {
      const rig = createRig({
        script: [...distinct(4), say("never")],
        bot: { limits: { maxTurns: 3 } },
      });
      const { judge } = judgeOf([step, step]);
      expect(await runWith(rig, { judge })).toBe("waiting_user");
      const limitCheck = (await checks(rig)).find((e) => e.payload.trigger === "limit");
      expect(limitCheck?.payload.verdict).toBe("incerto");
    }
  });

  it("a judge that fails is incerto, and the run is not failed because of it", async () => {
    const rig = createRig({
      script: [...distinct(4), say("never")],
      bot: { limits: { maxTurns: 3 } },
    });
    const { judge } = judgeOf([new Error("down"), new Error("down")]);
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    const limitCheck = (await checks(rig)).find((e) => e.payload.trigger === "limit");
    expect(limitCheck?.payload.verdict).toBe("incerto");
  });

  it("the judge costs money but is not a step", async () => {
    const rig = createRig({
      script: [...distinct(4), say("never")],
      bot: {
        limits: { maxTurns: 3 },
        model: { id: "m", contextWindow: 100_000, maxOutputTokens: 1000 },
      },
    });
    const { judge, provider } = judgeOf([verdictOf("incerto"), verdictOf("incerto")], true);
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    const record = await rig.record();
    expect(record.turns).toBe(3);
    expect(provider.calls).toBeGreaterThan(0);
    // 10 input tokens per call at $1,000,000 per MTok = $10 a judge call.
    expect(record.costUsd).toBeCloseTo(provider.calls * 10);
    expect(
      eventsOfType(await rig.events(), "model_request").some(
        (e) => e.payload.purpose === "progress",
      ),
    ).toBe(true);
  });

  it("the judge sees a compact digest: no arguments, no secret values", async () => {
    const SECRET = "hunter2-very-secret";
    const redactor = createRedactor({ TOKEN: SECRET });
    const rig = createRig({
      objective: "Do the task.",
      script: [
        use(call("a", "echo", { text: `the value is ${SECRET}` })),
        use(call("b", "write_note", { name: "n.txt", body: "ARGS-ONLY-MARK" })),
        use(call("c", "echo", { text: "three" })),
        say("never"),
      ],
      bot: { limits: { maxTurns: 3 } },
    });
    const { judge, provider } = judgeOf([verdictOf("incerto"), verdictOf("incerto")]);
    await runLoop(
      rig.deps({
        watchdog: { judge },
        secrets: { redactor, resolve: async () => ({}) },
      }),
      rig.runId,
    );
    const request = provider.requests[0];
    expect(request?.toolChoice).toEqual({ name: "progress_verdict" });
    const sent = JSON.stringify(request?.messages);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain("ARGS-ONLY-MARK");
    expect(sent).toContain("args#");
    const log = JSON.stringify(await rig.events());
    expect(log).not.toContain(SECRET);
  });
});

describe("watchdog: extensions and the ceiling", () => {
  it("extends by itself at most twice, then always asks", async () => {
    const rig = createRig({ script: distinct(120), bot: { limits: { maxTurns: 3 } } });
    const { judge, provider } = judgeOf(Array.from({ length: 12 }, () => verdictOf("avanca")));
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    const events = await checks(rig);
    expect(events.filter((e) => e.payload.action === "extend")).toHaveLength(2);
    expect(events.filter((e) => e.payload.action === "ask")).toHaveLength(1);
    const state = rebuildState(await rig.events());
    expect(state.watch.autoExtensions).toBe(2);
    expect((await rig.record()).turns).toBe(3 + 25 + 25);
    expect(provider.calls).toBeGreaterThanOrEqual(3);
  });

  it("the owner can keep granting +25 each time", async () => {
    const rig = createRig({ script: distinct(200), bot: { limits: { maxTurns: 3 } } });
    expect(await rig.run()).toBe("waiting_user"); // 2 automatic extensions, then the question
    for (let round = 1; round <= 2; round++) {
      rig.store.postInbox(rig.runId, { kind: "user_message", text: CONTINUE });
      expect(await rig.run()).toBe("waiting_user");
      const state = rebuildState(await rig.events());
      expect(state.watch.ownerExtensions).toBe(round);
    }
    expect((await rig.record()).turns).toBe(3 + 25 * 4);
  });
});

describe("watchdog: the owner's answer", () => {
  const limited = (extra: Partial<Parameters<typeof createRig>[0]> = {}) =>
    createRig({
      script: [
        ...Array.from({ length: 5 }, (_, i) => use(call(`f${i}`, "fixed"))),
        ...distinct(40),
        say("All done."),
      ],
      bot: { limits: { maxTurns: 100 } },
      ...extra,
    });

  it("the card carries the question, the two options and a friendly lead", async () => {
    const rig = createRig({
      script: [
        use(
          planCall("p", [
            { id: "a", title: "Read the data", status: "done" },
            { id: "b", title: "Write the report", status: "in_progress" },
          ]),
        ),
        ...Array.from({ length: 6 }, (_, i) => use(call(`f${i}`, "fixed"))),
      ],
    });
    expect(await rig.run()).toBe("waiting_user");
    const [card] = await asked(rig);
    expect(card?.payload).toMatchObject({
      reason: "progress_limit",
      question: "Quer que eu continue?",
      questions: [
        {
          question: "Quer que eu continue?",
          options: [{ label: CONTINUE }, { label: STOP }],
        },
      ],
    });
    expect(card?.payload.lead).toBe(
      "Acho que estou andando em círculos. Já fiz: Read the data. Falta: Write the report.",
    );
    expect(card?.payload.callId).toBeUndefined();
  });

  it("Continuar grants +25, reopens the window and the run goes on", async () => {
    const rig = limited();
    expect(await rig.run()).toBe("waiting_user");
    const before = rebuildState(await rig.events());
    expect(before.waiting?.kind).toBe("progress");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: CONTINUE });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const [decided] = eventsOfType(events, "progress_decided");
    expect(decided?.payload).toMatchObject({ choice: "continue", grant: 25, text: CONTINUE });
    expect(decided?.payload.typed).toBeUndefined();
    const state = rebuildState(events);
    expect(state.watch.grants).toEqual([25]);
    expect(state.watch.ownerExtensions).toBe(1);
    expect(lastStatus(events)?.result?.summary).toBe("All done.");
    // The model reads a note of the harness, never the owner's words as such.
    const sent = JSON.stringify(rig.provider.requests.at(-1)?.messages);
    expect(sent).toContain("The owner let you continue: you have 25 more steps.");
    expect(sent).toContain("change your approach");
    expect(sent).not.toContain(CONTINUE);
    // The same call that looped is not counted again: the detection window is new.
    expect(state.repeat.count).toBeLessThan(5);
  });

  it("the option can be answered by its letter or number", async () => {
    for (const typed of ["A", "a", "1"]) {
      const rig = limited();
      await rig.run();
      rig.store.postInbox(rig.runId, { kind: "user_message", text: typed });
      expect(await rig.run()).toBe("done");
      expect(eventsOfType(await rig.events(), "progress_decided")[0]?.payload.choice).toBe(
        "continue",
      );
    }
    const rig = limited();
    await rig.run();
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "B" });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "progress_decided")[0]?.payload.choice).toBe("stop");
  });

  it("Parar ends the run cleanly, with a friendly message, not as an error", async () => {
    const rig = limited();
    expect(await rig.run()).toBe("waiting_user");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: STOP });
    const callsBefore = rig.provider.calls;
    expect(await rig.run()).toBe("done");
    expect(rig.provider.calls).toBe(callsBefore);
    const status = lastStatus(await rig.events());
    expect(status?.to).toBe("done");
    expect(status?.failure).toBeUndefined();
    expect(status?.result?.summary).toContain("Parei por aqui, como você pediu.");
    expect((await rig.record()).status).toBe("done");
  });

  it("closing the card with the X stops without spending anything more", async () => {
    const rig = limited();
    await rig.run();
    rig.store.postInbox(rig.runId, { kind: "user_message", text: DISMISSED });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "progress_decided")[0]?.payload.choice).toBe("stop");
  });

  it("something typed instead goes on, and the model reads it", async () => {
    const rig = limited();
    await rig.run();
    rig.store.postInbox(rig.runId, {
      kind: "user_message",
      text: "continue, but try the other file",
    });
    expect(await rig.run()).toBe("done");
    const [decided] = eventsOfType(await rig.events(), "progress_decided");
    expect(decided?.payload).toMatchObject({ choice: "continue", typed: true });
    const sent = JSON.stringify(rig.provider.requests.at(-1)?.messages);
    expect(sent).toContain("continue, but try the other file");
  });

  it("a resumed process finds the question where it was and does not ask twice", async () => {
    const rig = limited();
    await rig.run();
    expect(await rig.run()).toBe("waiting_user");
    expect(await asked(rig)).toHaveLength(1);
    expect(rig.provider.calls).toBe(5);
  });
});

const DISMISSED =
  "(The user closed this question without choosing an option. They may still answer in the chat. Do not ask the same question again now: go on with what you can do without it, or end your turn and wait for their message.)";

describe("watchdog: a routine has nobody to ask", () => {
  it("stops at a loop with a friendly message, and does not ask", async () => {
    const rig = createRig({
      origin: "routine",
      script: Array.from({ length: 8 }, (_, i) => use(call(`c${i}`, "fixed"))),
    });
    expect(await rig.run()).toBe("failed");
    const events = await rig.events();
    expect(await asked(rig)).toHaveLength(0);
    const status = lastStatus(events);
    expect(status?.failure?.origin).toBe("limit");
    expect(status?.failure?.detail).toContain("Acho que estou andando em círculos.");
    expect(status?.failure?.detail).toContain("sem ninguém acompanhando");
    expect(eventsOfType(events, "nudge")).toHaveLength(1);
    expect((await checks(rig)).at(-1)?.payload.action).toBe("stop");
  });

  it("stops at the step limit when the progress does not show", async () => {
    const rig = createRig({
      origin: "routine",
      // Two calls that failed: nothing was changed and nothing was learned.
      script: [
        use(call("a", "echo", { wrong: 1 })),
        use(call("b", "echo", { wrong: 2 })),
        say("never"),
      ],
      bot: { limits: { maxTurns: 2 } },
    });
    expect(await rig.run()).toBe("failed");
    expect(await asked(rig)).toHaveLength(0);
    expect(lastStatus(await rig.events())?.failure?.detail).toContain(
      "Esta tarefa está levando mais tempo do que o normal.",
    );
  });

  it("never goes on past the 2 automatic extensions", async () => {
    const rig = createRig({
      origin: "routine",
      script: distinct(120),
      bot: { limits: { maxTurns: 3 } },
    });
    expect(await rig.run()).toBe("failed");
    expect(await asked(rig)).toHaveLength(0);
    expect((await rig.record()).turns).toBe(3 + 25 + 25);
    const extended = (await checks(rig)).filter((e) => e.payload.action === "extend");
    expect(extended).toHaveLength(2);
  });
});

describe("watchdog: the soft limit and the switch", () => {
  it("a judge that says circulo at 80% nudges the model once", async () => {
    const rig = createRig({
      script: [...distinct(12), say("done")],
      bot: { limits: { maxTurns: 10 } },
    });
    const { judge } = judgeOf([verdictOf("circulo", "same files again"), verdictOf("avanca")]);
    await runWith(rig, { judge });
    const events = await rig.events();
    const stuck = eventsOfType(events, "nudge").filter((e) => e.payload.reason === "stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.payload.text).toContain("same files again");
    const soft = (await checks(rig)).find((e) => e.payload.trigger === "soft_limit");
    expect(soft?.payload).toMatchObject({ verdict: "circulo", action: "nudge", turns: 8 });
  });

  it("with the watchdog off the run fails at its limits, as it used to", async () => {
    const rig = createRig({ script: distinct(10), bot: { limits: { maxTurns: 3 } } });
    expect(await runWith(rig, { enabled: false })).toBe("failed");
    expect(lastStatus(await rig.events())?.failure?.origin).toBe("limit");
    expect(await asked(rig)).toHaveLength(0);
  });

  it("the thresholds are settings", async () => {
    const rig = createRig({
      script: Array.from({ length: 8 }, (_, i) => use(call(`c${i}`, "fixed"))),
    });
    expect(await runWith(rig, { repeatNudgeAt: 2, repeatAskAt: 3 })).toBe("waiting_user");
    expect(rig.provider.calls).toBe(3);
  });
});

describe("watchdog: replay", () => {
  it("a run with a judge, a question and the owner's answer replays as identical", async () => {
    const rig = createRig({
      script: [...distinct(200), say("All done.")],
      bot: { limits: { maxTurns: 3 } },
    });
    const { judge } = judgeOf(Array.from({ length: 8 }, () => verdictOf("avanca", "moving")));
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: CONTINUE });
    expect(await runWith(rig, { judge })).toBe("waiting_user");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: STOP });
    expect(await runWith(rig, { judge })).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "progress_check").some((e) => e.payload.judged)).toBe(true);
    const report = await replayRun(events, { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.stoppedBecause).toBeUndefined();
    expect(report.identical).toBe(true);
  });
});
