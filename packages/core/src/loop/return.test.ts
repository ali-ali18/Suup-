import { describe, expect, it } from "vitest";
import { validateConversation } from "../messages.js";
import { replayRun } from "../replay.js";
import {
  CrashingStore,
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  type FakeStep,
  finishCall,
  type Rig,
  SimulatedCrash,
  say,
  textOf,
  use,
} from "../testing/index.js";
import { controlToolSpecs } from "./control-tools.js";
import { runLoop } from "./loop.js";
import { rebuildState } from "./state.js";
import type { RunStatus, StoredEvent } from "./store.js";

const MINUTE = 60_000;
const schedule = (id: string, inMinutes: number, note: string) =>
  call(id, "schedule_return", { inMinutes, note });

/** The loop with the tool on, as a conversation run of the user has it. */
const returning = (rig: Rig, extra: Parameters<Rig["deps"]>[0] = {}) =>
  rig.deps({ allowReturns: true, ...extra });

/** What the wake job and a worker do: the due run is woken and claimed. */
function wake(rig: Rig, afterMs = 61 * MINUTE): string[] {
  rig.clock.advance(afterMs);
  const woken = rig.store.wakeDue(new Date(rig.clock.now));
  if (woken.length > 0) rig.store.claimNext("worker-2");
  return woken;
}

/** Runs the loop, waking the run each time it parks, until it settles. */
async function drive(
  rig: Rig,
  script: FakeStep[],
  options: { wrap?: (store: Rig["store"]) => CrashingStore; afterMs?: number } = {},
): Promise<RunStatus> {
  for (let round = 0; round < 20; round++) {
    const done = countResponses(await rig.events());
    const deps = returning(rig, {
      provider: new FakeProvider(script.slice(done)),
      ...(options.wrap === undefined ? {} : { store: options.wrap(rig.store) }),
    });
    const status = await runLoop(deps, rig.runId);
    if (status !== "waiting_timer") return status;
    wake(rig, options.afterMs);
  }
  throw new Error("the run kept parking");
}

function countResponses(events: readonly StoredEvent[]): number {
  return events.filter((e) => e.type === "model_response" && e.payload.purpose === undefined)
    .length;
}

describe("schedule_return: parking the run", () => {
  it("is offered only to a run that may come back by itself", async () => {
    expect(controlToolSpecs({ scheduleReturn: true }).map((s) => s.name)).toContain(
      "schedule_return",
    );
    expect(controlToolSpecs({}).map((s) => s.name)).not.toContain("schedule_return");

    const rig = createRig({ script: [say("hello")] });
    await runLoop(returning(rig), rig.runId);
    const [first] = rig.provider.requests;
    expect(first?.tools.map((t) => t.name)).toContain("schedule_return");
    const spec = first?.tools.find((t) => t.name === "schedule_return");
    expect(spec?.description).toContain("Agenda um retorno");
    expect(JSON.stringify(spec?.inputSchema)).toContain("inMinutes");

    const plain = createRig({ script: [say("hello")] });
    await plain.run();
    expect(plain.provider.requests[0]?.tools.map((t) => t.name)).not.toContain("schedule_return");
  });

  it("parks the run after the reply, and the reply is kept for the chat", async () => {
    const rig = createRig({
      script: [
        use(schedule("r1", 20, "Check the deploy of build 42 and tell the user.")),
        say("Disparei o deploy. Volto em 20 minutos para conferir."),
      ],
    });
    expect(await runLoop(returning(rig), rig.runId)).toBe("waiting_timer");
    const events = await rig.events();
    const [scheduled] = eventsOfType(events, "wait_scheduled");
    expect(scheduled?.payload).toMatchObject({
      minutes: 20,
      note: "Check the deploy of build 42 and tell the user.",
    });
    expect(scheduled?.payload.at).toBe(new Date(rig.clock.now + 20 * MINUTE).toISOString());
    const parked = eventsOfType(events, "status_changed").at(-1)?.payload;
    expect(parked).toMatchObject({ from: "running", to: "waiting_timer" });
    expect(parked?.result?.summary).toBe("Disparei o deploy. Volto em 20 minutos para conferir.");
    expect((await rig.record()).status).toBe("waiting_timer");
    expect(rig.store.wakeOf(rig.runId)).toEqual({
      at: scheduled?.payload.at,
      note: scheduled?.payload.note,
      count: 0,
    });
    // The tool result told the model to write to the user and stop.
    const result = eventsOfType(events, "tool_result")[0]?.payload;
    expect(result?.content).toContain("mensagem");
    expect(result?.isError).toBe(false);
  });

  it("does not wake before the time, and wakes once at it", async () => {
    const rig = createRig({
      script: [use(schedule("r1", 5, "look")), say("Volto em 5 minutos.")],
    });
    await runLoop(returning(rig), rig.runId);
    expect(rig.store.wakeDue(new Date(rig.clock.now + 4 * MINUTE))).toEqual([]);
    expect((await rig.record()).status).toBe("waiting_timer");
    expect(rig.store.wakeDue(new Date(rig.clock.now + 5 * MINUTE))).toEqual([rig.runId]);
    expect(rig.store.wakeDue(new Date(rig.clock.now + 6 * MINUTE))).toEqual([]);
    expect(eventsOfType(await rig.events(), "wait_fired")).toHaveLength(1);
  });

  it("resumes the same run with the note as a notice of the system, and the plan", async () => {
    const script: FakeStep[] = [
      use(call("p", "plan", { steps: [{ id: "s1", title: "Deploy", status: "in_progress" }] })),
      use(schedule("r1", 20, "Check the CI of build 42.")),
      say("Volto em 20 minutos."),
      use(call("p2", "plan", { steps: [{ id: "s1", title: "Deploy", status: "done" }] })),
      use(finishCall("f", "O deploy passou.")),
    ];
    const rig = createRig({ script });
    expect(await drive(rig, script, { afterMs: 20 * MINUTE })).toBe("done");
    expect(rig.store.outcome(rig.runId).result?.summary).toBe("O deploy passou.");
    const events = await rig.events();
    expect(events.map((e) => e.type).filter((t) => t.startsWith("wait_"))).toEqual([
      "wait_scheduled",
      "wait_fired",
    ]);
    // The request after the wake carries the note, from the harness and not from the user, with the plan.
    const state = rebuildState(events);
    expect(state.wakeCount).toBe(1);
    expect(state.wait).toBeNull();
    expect(eventsOfType(events, "wait_fired")[0]?.payload.delayMs).toBe(0);
    const userTexts = state.messages
      .filter((m) => m.role === "user")
      .map((m) => textOf(m))
      .filter((t) => t.includes("Retorno agendado"));
    expect(userTexts).toHaveLength(1);
    expect(userTexts[0]).toContain("[Harness notice] Retorno agendado: Check the CI of build 42.");
    expect(userTexts[0]).toContain("[in_progress] s1: Deploy");
    expect(userTexts[0]).not.toContain("[Message from the user");
    expect(validateConversation(state.messages)).toEqual([]);
  });

  it("a second call replaces the first, and both are in the log", async () => {
    const script: FakeStep[] = [
      use(schedule("r1", 10, "first")),
      use(schedule("r2", 30, "second")),
      say("Volto em 30 minutos."),
    ];
    const rig = createRig({ script });
    expect(await runLoop(returning(rig), rig.runId)).toBe("waiting_timer");
    const events = await rig.events();
    expect(
      events
        .filter((e) => e.type.startsWith("wait_"))
        .map((e) => [e.type, "reason" in e.payload ? e.payload.reason : ""]),
    ).toEqual([
      ["wait_scheduled", ""],
      ["wait_cancelled", "replaced"],
      ["wait_scheduled", ""],
    ]);
    expect(rig.store.wakeOf(rig.runId)).toMatchObject({ note: "second" });
    expect(rig.store.wakeDue(new Date(rig.clock.now + 11 * MINUTE))).toEqual([]);
    expect(rig.store.wakeDue(new Date(rig.clock.now + 31 * MINUTE))).toEqual([rig.runId]);
  });

  it("refuses bad arguments, an empty note and a run that may not return", async () => {
    const script: FakeStep[] = [
      use(call("a", "schedule_return", { inMinutes: 0, note: "x" })),
      use(call("b", "schedule_return", { inMinutes: 61, note: "x" })),
      use(call("c", "schedule_return", { inMinutes: 5, note: "   " })),
      use(call("d", "schedule_return", { inMinutes: 5, note: "x".repeat(501) })),
      say("Não consegui agendar."),
    ];
    const rig = createRig({ script });
    expect(await runLoop(returning(rig), rig.runId)).toBe("done");
    const results = eventsOfType(await rig.events(), "tool_result").map((e) => e.payload);
    expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(eventsOfType(await rig.events(), "wait_scheduled")).toEqual([]);

    // Called anyway in a run that is not offered the tool (an evaluation): refused, run goes on.
    const isolated = createRig({
      script: [use(schedule("e", 5, "x")), say("Ok, sem retorno.")],
    });
    expect(await runLoop(isolated.deps(), isolated.runId)).toBe("done");
    const refused = eventsOfType(await isolated.events(), "tool_result")[0]?.payload;
    expect(refused).toMatchObject({ isError: true });
    expect(refused?.content).toContain("not available");
    expect(eventsOfType(await isolated.events(), "wait_scheduled")).toEqual([]);
  });

  it("is refused in a run that was not opened by the user", async () => {
    const rig = createRig({ script: [use(schedule("e", 5, "x")), say("ok")] });
    rig.store.createRun({ id: "routine", objective: "Daily.", origin: "routine" });
    const deps = returning(rig);
    expect(await runLoop(deps, "routine")).toBe("done");
    expect(rig.provider.requests[0]?.tools.map((t) => t.name)).not.toContain("schedule_return");
    expect(
      eventsOfType(await rig.store.listEvents("routine"), "tool_result")[0]?.payload.content,
    ).toContain("not available");
  });

  it("allows at most six returns in a row, then tells the bot to finish or ask", async () => {
    const script: FakeStep[] = [];
    for (let i = 1; i <= 6; i++) script.push(use(schedule(`r${i}`, 1, `n${i}`)), say(`volto ${i}`));
    script.push(use(schedule("r7", 1, "n7")), say("Não posso agendar mais: terminei por aqui."));
    const rig = createRig({ script });
    expect(await drive(rig, script)).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "wait_fired")).toHaveLength(6);
    expect(eventsOfType(events, "wait_scheduled")).toHaveLength(6);
    const refusal = eventsOfType(events, "tool_result").at(-1)?.payload;
    expect(refusal?.isError).toBe(true);
    expect(refusal?.content).toContain("6 times in a row");
    expect(rebuildState(events).wakeCount).toBe(6);
  });

  it("the limit is configurable", async () => {
    const script: FakeStep[] = [
      use(schedule("r1", 1, "n1")),
      say("volto"),
      use(schedule("r2", 1, "n2")),
      say("Sem mais retornos."),
    ];
    const rig = createRig({ script, bot: { limits: { maxTurns: 50, maxReturns: 1 } } });
    expect(await drive(rig, script)).toBe("done");
    expect(eventsOfType(await rig.events(), "wait_scheduled")).toHaveLength(1);
  });

  it("a user message during the wait cancels the return and the run goes on with it", async () => {
    const script: FakeStep[] = [
      use(schedule("r1", 20, "check")),
      say("Volto em 20 minutos."),
      say("Entendi: cancelo a conferência."),
    ];
    const rig = createRig({ script });
    expect(await runLoop(returning(rig), rig.runId)).toBe("waiting_timer");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Pode esquecer o deploy." });
    expect((await rig.record()).status).toBe("queued");
    rig.store.claimNext("worker-2");
    const second = new FakeProvider(script.slice(2));
    expect(await runLoop(returning(rig, { provider: second }), rig.runId)).toBe("done");
    const events = await rig.events();
    expect(
      events.map((e) => e.type).filter((t) => t.startsWith("wait_") || t === "user_message"),
    ).toEqual(["wait_scheduled", "wait_cancelled", "user_message"]);
    expect(eventsOfType(events, "wait_cancelled")[0]?.payload.reason).toBe("user_message");
    const state = rebuildState(events);
    expect(state.wakeCount).toBe(0);
    expect(state.userSaid.at(-1)).toBe("Pode esquecer o deploy.");
    expect(rig.store.wakeDue(new Date(rig.clock.now + 99 * MINUTE))).toEqual([]);
    expect(rig.store.inboxLog(rig.runId).every((i) => i.acked)).toBe(true);
  });

  it("a stop during the wait cancels the return and the run", async () => {
    const script: FakeStep[] = [use(schedule("r1", 20, "check")), say("Volto em 20 minutos.")];
    const rig = createRig({ script });
    await runLoop(returning(rig), rig.runId);
    rig.store.postInbox(rig.runId, { kind: "stop" });
    rig.store.claimNext("worker-2");
    expect(await runLoop(returning(rig), rig.runId)).toBe("cancelled");
    const events = await rig.events();
    expect(eventsOfType(events, "wait_cancelled")[0]?.payload.reason).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({ type: "status_changed", payload: { to: "cancelled" } });
    expect(rig.store.wakeOf(rig.runId)).toBeNull();
    expect(rig.store.wakeDue(new Date(rig.clock.now + 99 * MINUTE))).toEqual([]);
  });

  it("finishing with a return pending drops the return", async () => {
    const script: FakeStep[] = [use(schedule("r1", 20, "check")), use(finishCall("f", "Pronto."))];
    const rig = createRig({ script });
    expect(await runLoop(returning(rig), rig.runId)).toBe("done");
    expect(eventsOfType(await rig.events(), "wait_cancelled")[0]?.payload.reason).toBe("finished");
  });

  it("the budgets keep counting across returns", async () => {
    const script: FakeStep[] = [use(schedule("r1", 1, "n")), say("volto"), say("Terminei.")];
    // Two model calls were used before the wake: a limit of two stops the run when it comes back.
    const tight = createRig({ script, bot: { limits: { maxTurns: 2 } } });
    expect(await drive(tight, script)).toBe("failed");
    expect(rebuildState(await tight.events()).wakeCount).toBe(1);
    const failed = eventsOfType(await tight.events(), "status_changed").at(-1)?.payload;
    expect(failed?.failure?.detail).toContain("turn limit");

    const roomy = createRig({ script, bot: { limits: { maxTurns: 3 } } });
    expect(await drive(roomy, script)).toBe("done");
    expect((await roomy.record()).turns).toBe(3);
  });

  it("the time spent waiting does not count against the duration limit", async () => {
    const script: FakeStep[] = [use(schedule("r1", 20, "n")), say("volto"), say("Terminei.")];
    const rig = createRig({
      script,
      bot: { limits: { maxTurns: 50, maxDurationMs: 10 * MINUTE } },
    });
    expect(await drive(rig, script, { afterMs: 25 * MINUTE })).toBe("done");
    expect(rebuildState(await rig.events()).waitedMs).toBeGreaterThanOrEqual(25 * MINUTE);
  });

  it("replays the whole run, wake included, as identical", async () => {
    const script: FakeStep[] = [
      use(schedule("r1", 20, "Check the CI.")),
      say("Volto em 20 minutos."),
      use(schedule("r2", 5, "Check again.")),
      say("Ainda rodando; volto em 5 minutos."),
      use(finishCall("f", "Deploy ok.")),
    ];
    const rig = createRig({ script });
    expect(await drive(rig, script)).toBe("done");
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });

  it("replays a run that the user interrupted during the wait", async () => {
    const script: FakeStep[] = [
      use(schedule("r1", 20, "Check the CI.")),
      say("Volto em 20 minutos."),
      say("Certo."),
    ];
    const rig = createRig({ script });
    await runLoop(returning(rig), rig.runId);
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Esquece." });
    rig.store.claimNext("w");
    await runLoop(returning(rig, { provider: new FakeProvider(script.slice(2)) }), rig.runId);
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });
});

describe("schedule_return: killing the process at every event", () => {
  const script: FakeStep[] = [
    use(call("p", "plan", { steps: [{ id: "s1", title: "Deploy", status: "in_progress" }] })),
    use(schedule("r1", 20, "Check the CI.")),
    say("Volto em 20 minutos."),
    use(call("c", "echo", { text: "status" })),
    use(schedule("r2", 5, "Look again.")),
    say("Ainda rodando; volto em 5 minutos."),
    use(call("p2", "plan", { steps: [{ id: "s1", title: "Deploy", status: "done" }] })),
    use(finishCall("f", "Deploy ok.")),
  ];

  const project = (events: readonly StoredEvent[]) =>
    events
      .filter((e) => e.type !== "model_request")
      .map((e) => {
        const payload: Record<string, unknown> = { ...e.payload };
        delete payload.durationMs;
        delete payload.measure;
        return { type: e.type, ...payload };
      });

  it("gives the same log as an uninterrupted run, with the return fired exactly once", async () => {
    const base = createRig({ script });
    expect(await drive(base, script, { afterMs: 21 * MINUTE })).toBe("done");
    const baseEvents = await base.events();
    const expected = project(baseEvents);
    expect(eventsOfType(baseEvents, "wait_fired")).toHaveLength(2);

    let crashes = 0;
    for (let n = 0; n <= baseEvents.length; n++) {
      const rig = createRig({ script });
      // First life: dies after `n` appended events in all, whichever side of a wake they fall (the
      // wake job's own writes do not count).
      const crashing = new CrashingStore(rig.store, n);
      try {
        await drive(rig, script, { afterMs: 21 * MINUTE, wrap: () => crashing });
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        crashes += 1;
      }
      // Second life: no crash. Time is where the first life left it, so the instants line up.
      const status = await drive(rig, script, { afterMs: 21 * MINUTE });
      const label = `crash after ${n} events`;
      expect(status, label).toBe("done");
      const events = await rig.events();
      expect(eventsOfType(events, "wait_fired"), label).toHaveLength(2);
      expect(eventsOfType(events, "wait_scheduled"), label).toHaveLength(2);
      expect(project(events).length, label).toBe(expected.length);
      expect(validateConversation(rebuildState(events).messages), label).toEqual([]);
      expect((await rig.record()).status, label).toBe("done");
      expect(rig.store.outcome(rig.runId).result?.summary, label).toBe("Deploy ok.");
    }
    expect(crashes).toBeGreaterThan(8);
  });
});
