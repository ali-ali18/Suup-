import { describe, expect, it } from "vitest";
import { z } from "zod";
import { replayRun } from "../replay.js";
import { FakeProvider } from "../testing/fake-provider.js";
import {
  call,
  createRig,
  eventsOfType,
  type FakeStep,
  type Rig,
  say,
  testTools,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { ASK_CHECK_TOOL, handedOffText } from "./handoff.js";
import { runLoop } from "./loop.js";
import type { HandoffDeps, HandoffOutcome, HandoffRequest, LoopDeps } from "./run-context.js";
import type { ProgressJudge } from "./watchdog.js";

const TASK_TOOL = "start_task";

/** A stand-in for the real task tool: it only says the task was opened. */
const startTask = defineTool({
  name: TASK_TOOL,
  description: "Opens a task.",
  input: z.object({ title: z.string() }),
  risk: "read",
  async execute(input) {
    return { content: `Task "${input.title}" opened.` };
  },
});

const reads = (n: number, prefix = "r"): FakeStep[] =>
  Array.from({ length: n }, (_, i) => use(call(`${prefix}${i}`, "echo", { text: `step ${i}` })));

const STARTED: HandoffOutcome = { started: true, taskId: "task-1", title: "Auditar os arquivos" };

function brake(
  overrides: Partial<HandoffDeps> = {},
  outcome: HandoffOutcome = STARTED,
): { deps: HandoffDeps; requests: HandoffRequest[] } {
  const requests: HandoffRequest[] = [];
  return {
    requests,
    deps: {
      atTurns: 3,
      taskTool: TASK_TOOL,
      async start(request) {
        requests.push(request);
        return outcome;
      },
      ...overrides,
    },
  };
}

function judgeOf(steps: FakeStep[]): { judge: ProgressJudge; provider: FakeProvider } {
  const provider = new FakeProvider(steps, { id: "asks" });
  return { provider, judge: { provider, model: { id: "asks-model", maxOutputTokens: 512 } } };
}

const asksAnswer = (asks: { ask: string; handled: string }[]): FakeStep =>
  use(call("a", ASK_CHECK_TOOL, { asks }));

function rigWith(script: FakeStep[], origin?: "user" | "task"): Rig {
  return createRig({
    script,
    tools: [...testTools(), startTask],
    bot: { allowedTools: ["echo", TASK_TOOL] },
    ...(origin === undefined ? {} : { origin }),
  });
}

const run = (rig: Rig, deps: Partial<LoopDeps>) => runLoop(rig.deps(deps), rig.runId);

describe("the early brake of a chat run", () => {
  it("moves the work to a task after the set number of model calls and ends the chat run", async () => {
    const rig = rigWith([...reads(8), say("done")]);
    const { deps, requests } = brake();
    expect(await run(rig, { handoff: deps })).toBe("done");
    expect(rig.provider.calls).toBe(3);
    const [handed] = eventsOfType(await rig.events(), "handed_off");
    expect(handed?.payload).toMatchObject({ trigger: "turns", turns: 3, outcome: "started" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.trail.map((e) => e.name)).toEqual(["echo", "echo", "echo"]);
    const finished = eventsOfType(await rig.events(), "status_changed").at(-1)?.payload;
    expect(finished?.result).toMatchObject({ summary: handedOffText("Auditar os arquivos") });
  });

  it("moves it after the set time, counted from the run's start", async () => {
    const rig = rigWith([...reads(8), say("done")]);
    let ticks = 0;
    const start = rig.clock.now;
    const { deps: withTurns } = brake({ atMs: 60_000 });
    const { atTurns: _byTurns, ...deps } = withTurns;
    // Each look at the clock is 25 s later: the minute passes after a few calls.
    const now = () => new Date(start + 25_000 * ticks++);
    expect(await run(rig, { handoff: deps, now })).toBe("done");
    const [handed] = eventsOfType(await rig.events(), "handed_off");
    expect(handed?.payload).toMatchObject({ trigger: "time", outcome: "started" });
    expect(rig.provider.calls).toBeLessThan(8);
  });

  it("leaves the run alone when the bot opened a task by itself", async () => {
    const rig = rigWith([
      use(call("t", TASK_TOOL, { title: "Auditar" })),
      ...reads(5),
      say("Abri a tarefa."),
    ]);
    const { deps, requests } = brake();
    expect(await run(rig, { handoff: deps })).toBe("done");
    expect(requests).toHaveLength(0);
    expect(eventsOfType(await rig.events(), "handed_off")).toHaveLength(0);
  });

  it("records a refusal once and lets the chat run go on", async () => {
    const rig = rigWith([...reads(5), say("done")]);
    const { deps, requests } = brake({}, { started: false, reason: "limit" });
    expect(await run(rig, { handoff: deps })).toBe("done");
    expect(requests).toHaveLength(1);
    const handed = eventsOfType(await rig.events(), "handed_off");
    expect(handed.map((e) => e.payload.outcome)).toEqual(["declined"]);
    expect(rig.provider.calls).toBe(6);
  });

  it("leaves the reply to the asks check's note alone, so the written answer is kept", async () => {
    const rig = rigWith([
      say("15% de 800 é 120."),
      use(call("t", TASK_TOOL, { title: "Auditar os CSV" })),
      say("15% de 800 é 120, e abri a tarefa da auditoria."),
    ]);
    const { judge } = judgeOf([
      asksAnswer([
        { ask: "15% de 800", handled: "answered" },
        { ask: "auditar os CSV", handled: "not_handled" },
      ]),
    ]);
    // One call already reaches the brake's count: only the check's note decides what comes next.
    const { deps, requests } = brake({ atTurns: 1 });
    const askCheck = { judge, taskTool: TASK_TOOL };
    expect(await run(rig, { handoff: deps, askCheck })).toBe("done");
    expect(requests).toHaveLength(0);
    expect(rig.provider.calls).toBe(3);
  });

  it("never brakes a run that is itself a task", async () => {
    const rig = rigWith([...reads(5), say("done")], "task");
    const { deps, requests } = brake();
    expect(await run(rig, { handoff: deps })).toBe("done");
    expect(requests).toHaveLength(0);
  });

  it("replays to the same log", async () => {
    const rig = rigWith([...reads(8), say("done")]);
    const { deps } = brake();
    await run(rig, { handoff: deps });
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });
});

describe("the end-of-turn check of the asks", () => {
  it("lets the answer stand when every ask was handled", async () => {
    const rig = rigWith([say("15% de 800 é 120.")]);
    const { judge } = judgeOf([asksAnswer([{ ask: "15% de 800", handled: "answered" }])]);
    expect(await run(rig, { askCheck: { judge, taskTool: TASK_TOOL } })).toBe("done");
    const events = await rig.events();
    const [checked] = eventsOfType(events, "asks_checked");
    expect(checked?.payload).toMatchObject({ judged: true, unhandled: [] });
    expect(eventsOfType(events, "nudge")).toHaveLength(0);
    expect(rig.provider.calls).toBe(1);
  });

  it("names a left-out ask to the model once, and the turn goes on", async () => {
    const rig = rigWith([
      say("15% de 800 é 120."),
      use(call("t", TASK_TOOL, { title: "Auditar os CSV" })),
      say("15% de 800 é 120, e abri a tarefa da auditoria."),
    ]);
    const { judge, provider } = judgeOf([
      asksAnswer([
        { ask: "15% de 800", handled: "answered" },
        { ask: "auditar os CSV", handled: "not_handled" },
      ]),
    ]);
    expect(await run(rig, { askCheck: { judge, taskTool: TASK_TOOL } })).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "asks_checked")).toHaveLength(1);
    const [nudged] = eventsOfType(events, "nudge");
    expect(nudged?.payload.reason).toBe("unhandled_asks");
    expect(nudged?.payload.text).toContain("auditar os CSV");
    expect(provider.calls).toBe(1);
    expect(rig.provider.calls).toBe(3);
  });

  it("never blocks the answer when the checker gives no valid answer", async () => {
    const rig = rigWith([say("Pronto.")]);
    const { judge } = judgeOf([say("não sei")]);
    expect(await run(rig, { askCheck: { judge, taskTool: TASK_TOOL } })).toBe("done");
    const [checked] = eventsOfType(await rig.events(), "asks_checked");
    expect(checked?.payload).toMatchObject({ judged: false });
  });

  it("does not run for a run that is itself a task", async () => {
    const rig = rigWith([say("Pronto.")], "task");
    const { judge, provider } = judgeOf([asksAnswer([])]);
    expect(await run(rig, { askCheck: { judge, taskTool: TASK_TOOL } })).toBe("done");
    expect(provider.calls).toBe(0);
  });

  it("replays to the same log", async () => {
    const rig = rigWith([
      say("Só a conta."),
      use(call("t", TASK_TOOL, { title: "Auditar" })),
      say("A conta e a tarefa."),
    ]);
    const { judge } = judgeOf([
      asksAnswer([
        { ask: "conta", handled: "answered" },
        { ask: "auditoria", handled: "not_handled" },
      ]),
    ]);
    await run(rig, { askCheck: { judge, taskTool: TASK_TOOL } });
    const report = await replayRun(await rig.events(), { bot: rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });
});
