import { describe, expect, it } from "vitest";
import { validateConversation } from "../messages.js";
import {
  CrashingStore,
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  type FakeStep,
  finishCall,
  needEvidence,
  planCall,
  type Rig,
  SimulatedCrash,
  type StepInput,
  say,
  use,
  verdict,
} from "../testing/index.js";
import { INTERRUPTED_RESULT, runLoop } from "./loop.js";
import type { RunContextSnapshot } from "./run-context.js";
import { rebuildState } from "./state.js";
import type { StoredEvent } from "./store.js";

const step = (id: string, status: StepInput["status"]): StepInput => ({
  id,
  title: `Step ${id}`,
  status,
});

interface Scenario {
  name: string;
  script: FakeStep[];
  reviewerScript?: FakeStep[];
  criteria?: string[];
  maxRejections?: number;
  bot?: Parameters<typeof createRig>[0]["bot"];
  /** Posted when the run stops in waiting_user. */
  answer?: string;
  /** Posted by the user while the model produces response number `atCall` (0-based). */
  midRun?: { atCall: number; text: string };
  /** The run starts with this outside context (rules, profile, history). */
  context?: RunContextSnapshot;
  /** Files in the workspace at the start (the reviewer may ask to read them). */
  files?: Record<string, string>;
}

/** How many times each rig's `loadRunContext` was called, across every life of the run. */
const contextLoads = new WeakMap<object, number>();

const scenarios: Scenario[] = [
  {
    name: "plan, parallel tools with side effects, a nudge, a harness rejection and a reviewer rejection",
    criteria: ["notes.txt was written"],
    script: [
      use(
        planCall("c1", [step("s1", "in_progress"), step("s2", "pending"), step("s3", "pending")]),
        call("c2", "echo", { text: "one" }),
      ),
      use(call("c3", "write_note", { name: "notes.txt", body: "hello" }), call("c4", "counter")),
      say("I think that is everything."),
      use(planCall("c5", [step("s1", "done"), step("s2", "done"), step("s3", "done")])),
      use(finishCall("c6", "All done.")),
      use(
        finishCall("c7", "All done.", [
          { criterion: "1", evidence: "write_note: wrote notes.txt" },
        ]),
      ),
      use(call("c8", "echo", { text: "proof" })),
      use(
        finishCall("c9", "All done, with proof.", [
          { criterion: "1", evidence: "wrote notes.txt; echo proof" },
        ]),
      ),
    ],
    reviewerScript: [verdict("reject", "Show me the file was checked."), verdict("approve")],
  },
  {
    name: "a user message arrives while the bot works",
    script: [
      use(planCall("c1", [step("s1", "in_progress")])),
      use(call("c2", "echo", { text: "x" })),
      use(call("c3", "counter")),
      use(planCall("c4", [step("s1", "done")])),
      use(finishCall("c5", "Done, and I took your note into account.")),
    ],
    midRun: { atCall: 1, text: "Also mention the date." },
  },
  {
    name: "a user message while working, then an escalate answered by the user",
    script: [
      use(planCall("c1", [step("s1", "in_progress")])),
      use(call("c2", "echo", { text: "x" })),
      use(call("c3", "escalate", { question: "Which colour?" })),
      use(planCall("c4", [step("s1", "done")])),
      use(finishCall("c5", "Went with green.")),
    ],
    midRun: { atCall: 1, text: "Keep it short." },
    answer: "Green.",
  },
  {
    name: "escalate, an answer, and a finish",
    script: [
      use(planCall("c1", [step("s1", "in_progress")])),
      use(call("c2", "echo", { text: "x" }), call("c3", "counter")),
      use(call("c4", "escalate", { question: "Blue or red?" })),
      use(planCall("c5", [step("s1", "done")])),
      use(finishCall("c6", "Went with blue.")),
    ],
    answer: "Blue.",
  },
  {
    name: "a review tie-break handed to the user",
    maxRejections: 1,
    script: [
      use(call("c1", "echo", { text: "a" })),
      use(finishCall("c2", "First.")),
      use(finishCall("c3", "Second.")),
      use(finishCall("c4", "Third.")),
    ],
    reviewerScript: [verdict("reject", "Not convincing.")],
    answer: "Accept it.",
  },
  {
    name: "a review in which the reviewer asks for evidence twice and then rejects, then approves",
    files: { "report.md": "Total: 42\n" },
    script: [use(finishCall("c1", "Total is 42.")), use(finishCall("c2", "Total is 42, checked."))],
    reviewerScript: [
      needEvidence("v1", "need the report", { files: ["report.md", "absent.md"] }),
      needEvidence("v2", "need the report again", { files: ["report.md"] }),
      verdict("reject", "The summary says 42 but nothing shows it."),
      verdict("approve"),
    ],
  },
  {
    name: "a run that starts with rules, a profile and the history of the conversation",
    context: {
      rules: [{ id: "r1", text: "Always confirm before writing files." }],
      profile: [{ id: "p1", text: "The user is called Marina." }],
      history: [
        { role: "user", blocks: [{ type: "text", text: "Earlier question." }] },
        { role: "assistant", blocks: [{ type: "text", text: "Earlier answer." }] },
      ],
      historyNote: "Older messages were left out.",
    },
    script: [
      use(planCall("c1", [step("s1", "in_progress")])),
      use(call("c2", "echo", { text: "x" }), call("c3", "counter")),
      use(call("c4", "escalate", { question: "Blue or red?" })),
      use(planCall("c5", [step("s1", "done")])),
      use(finishCall("c6", "Went with blue, Marina.")),
    ],
    midRun: { atCall: 1, text: "Keep it short." },
    answer: "Blue.",
  },
  {
    name: "a compaction in the middle",
    bot: { model: { id: "m", contextWindow: 1000, maxOutputTokens: 500 } },
    script: [
      use(call("c1", "echo", { text: "alpha" })),
      use(call("c2", "echo", { text: "bravo" })),
      use(call("c3", "echo", { text: "charlie" })),
      {
        blocks: [call("c4", "echo", { text: "delta" })],
        usage: { inputTokens: 800, outputTokens: 10 },
      },
      say("SUMMARY of the early work."),
      say("All done."),
    ],
  },
];

/** What a person would compare: the log without timings and without the (bulky) requests. */
function project(events: readonly StoredEvent[], ignoreMidRunMessage = false): unknown[] {
  return (
    events
      .filter((e) => e.type !== "model_request")
      // A message posted during a model call that a crash then lost is already waiting when the
      // next life starts, so it may be delivered one safe point earlier. When is not what is
      // compared here: that it is delivered exactly once is checked separately.
      .filter((e) => !(ignoreMidRunMessage && e.type === "user_message"))
      .map((e) => {
        const payload: Record<string, unknown> = { ...e.payload };
        delete payload.durationMs;
        // Positions shift when a request was logged twice (died before its response).
        delete payload.uptoSeq;
        return { type: e.type, ...payload };
      })
  );
}

const isInterrupted = (item: unknown): boolean =>
  typeof item === "object" &&
  item !== null &&
  (item as { type?: string }).type === "tool_result" &&
  String((item as { content?: string }).content).includes(INTERRUPTED_RESULT);

/** Responses already taken from a script: the agent's and the summarizer's share one provider. */
function countResponses(events: readonly StoredEvent[], who: "main" | "review"): number {
  return events.filter(
    (e) =>
      e.type === "model_response" &&
      (who === "main" ? e.payload.purpose !== "review" : e.payload.purpose === "review"),
  ).length;
}

const posted = new WeakSet<object>();

/** The scripted steps from `offset` on, with the mid-run user message posted once, on time. */
function withMidRun(rig: Rig, scenario: Scenario, steps: FakeStep[], offset: number): FakeStep[] {
  const { midRun } = scenario;
  if (midRun === undefined) return steps;
  return steps.map((original, i) =>
    offset + i !== midRun.atCall
      ? original
      : async (req) => {
          // A resumed life may replay this call; the user only wrote once.
          if (!posted.has(rig.store)) {
            posted.add(rig.store);
            rig.store.postInbox(rig.runId, { kind: "user_message", text: midRun.text });
          }
          if (original instanceof Error) throw original;
          return typeof original === "function" ? original(req) : original;
        },
  );
}

/** Runs (or resumes) the rig's run to the end, posting `answer` when it waits for the user. */
async function drive(rig: Rig, scenario: Scenario): Promise<string> {
  for (let round = 0; round < 6; round++) {
    const events = await rig.events();
    const mainDone = countResponses(events, "main");
    const reviewDone = countResponses(events, "review");
    const reviewer =
      scenario.reviewerScript === undefined
        ? undefined
        : {
            provider: new FakeProvider(scenario.reviewerScript.slice(reviewDone), {
              id: "reviewer",
            }),
            model: { id: "reviewer-model", maxOutputTokens: 1024 },
            ...(scenario.maxRejections === undefined
              ? {}
              : { maxRejections: scenario.maxRejections }),
          };
    const status = await runLoop(
      {
        ...rig.deps({
          provider: new FakeProvider(
            withMidRun(rig, scenario, scenario.script.slice(mainDone), mainDone),
          ),
        }),
        ...(reviewer === undefined ? {} : { reviewer }),
      },
      rig.runId,
    );
    if (status === "waiting_user" && scenario.answer !== undefined) {
      // Only answer once: a second wait would be a bug in the scenario.
      const hasAnswer = (await rig.events()).some(
        (e) =>
          (e.type === "tool_result" && e.payload.content === scenario.answer) ||
          (e.type === "user_message" && e.payload.text === scenario.answer),
      );
      if (hasAnswer) return status;
      rig.store.postInbox(rig.runId, { kind: "user_message", text: scenario.answer });
      continue;
    }
    return status;
  }
  throw new Error("scenario did not settle");
}

/** Every inbox item was delivered by exactly one event and acknowledged; texts appear once. */
async function expectDeliveredOnce(rig: Rig, scenario: Scenario, label: string): Promise<void> {
  const events = await rig.events();
  const seen = new Map<string, number>();
  const count = (id: string) => seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const e of events) {
    if (e.type === "user_message" && e.payload.inboxId !== undefined) count(e.payload.inboxId);
    if (e.type === "tool_result") for (const id of e.payload.inboxIds ?? []) count(id);
    if (e.type === "status_changed") for (const id of e.payload.inboxIds ?? []) count(id);
  }
  const log = rig.store.inboxLog(rig.runId);
  expect(log.length, `${label}: items posted`).toBe(
    (scenario.midRun === undefined ? 0 : 1) + (scenario.answer === undefined ? 0 : 1),
  );
  for (const item of log) {
    expect(seen.get(item.id), `${label}: inbox item ${item.id} delivered`).toBe(1);
    expect(item.acked, `${label}: inbox item ${item.id} acknowledged`).toBe(true);
  }
  expect(await rig.store.peekInbox(rig.runId), label).toEqual([]);
  for (const text of [scenario.midRun?.text, scenario.answer]) {
    if (text === undefined) continue;
    const carriers = events.filter(
      (e) =>
        (e.type === "user_message" && e.payload.text === text) ||
        (e.type === "tool_result" && e.payload.content === text),
    );
    expect(carriers, `${label}: "${text}" in the log`).toHaveLength(1);
  }
}

function makeRig(scenario: Scenario): Rig {
  const rig = createRigFor(scenario);
  const { context } = scenario;
  for (const [path, content] of Object.entries(scenario.files ?? {})) {
    rig.executor.files.set(`/workspace/${path}`, content);
  }
  if (context !== undefined) {
    const original = rig.deps.bind(rig);
    rig.deps = (overrides = {}) =>
      original({
        loadRunContext: async () => {
          contextLoads.set(rig, (contextLoads.get(rig) ?? 0) + 1);
          return structuredClone(context);
        },
        ...overrides,
      });
  }
  return rig;
}

function createRigFor(scenario: Scenario): Rig {
  return createRig({
    script: scenario.script,
    ...(scenario.reviewerScript === undefined ? {} : { reviewerScript: scenario.reviewerScript }),
    ...(scenario.criteria === undefined ? {} : { criteria: scenario.criteria }),
    ...(scenario.bot === undefined ? {} : { bot: scenario.bot }),
    ...(scenario.maxRejections === undefined ? {} : { maxRejections: scenario.maxRejections }),
  });
}

describe("resume: kill the process after every possible event", () => {
  for (const scenario of scenarios) {
    it(`gives the same log as an uninterrupted run: ${scenario.name}`, async () => {
      const base = makeRig(scenario);
      const baseStatus = await drive(base, scenario);
      const baseEvents = await base.events();
      const baseProjection = project(baseEvents, scenario.midRun !== undefined);
      expect(baseStatus).toBe("done");
      await expectDeliveredOnce(base, scenario, "uninterrupted run");

      let interruptedRuns = 0;
      let crashes = 0;
      for (let n = 0; n <= baseEvents.length; n++) {
        const rig = makeRig(scenario);

        // First life: dies after `n` appended events.
        try {
          await runLoop(
            rig.deps({
              store: new CrashingStore(rig.store, n),
              provider: new FakeProvider(withMidRun(rig, scenario, scenario.script, 0)),
            }),
            rig.runId,
          );
        } catch (error) {
          if (!(error instanceof SimulatedCrash)) throw error;
          crashes += 1;
        }

        // Second life: a fresh loop with only the part of the script not yet consumed.
        const status = await drive(rig, scenario);
        expect(status, `status after a crash at event ${n}`).toBe("done");

        const resumed = project(await rig.events(), scenario.midRun !== undefined);

        const label = `crash after ${n} events`;
        if (scenario.context !== undefined) {
          // Once the event is in the log nobody asks again; only a death between `run_started`
          // and `context_loaded` (n = 1) makes the second life ask once more.
          expect(contextLoads.get(rig), `${label}: context loads`).toBe(n === 1 ? 2 : 1);
          expect(eventsOfType(await rig.events(), "context_loaded"), label).toHaveLength(1);
        }
        await expectDeliveredOnce(rig, scenario, label);
        expect(resumed.length, label).toBe(baseProjection.length);
        let interrupted = 0;
        resumed.forEach((item, i) => {
          if (isInterrupted(item)) {
            interrupted += 1;
            const original = baseProjection[i] as { type: string; callId: string };
            expect(original.type, `${label}, event ${i}`).toBe("tool_result");
            expect((item as { callId: string }).callId, `${label}, event ${i}`).toBe(
              original.callId,
            );
          } else {
            expect(item, `${label}, event ${i}`).toEqual(baseProjection[i]);
          }
        });
        if (interrupted > 0) interruptedRuns += 1;
        expect(interrupted, label).toBeLessThanOrEqual(1);

        // The store agrees with the log, and the conversation is sound.
        const record = await rig.record();
        expect(record.status, label).toBe("done");
        expect(record.plan, label).toEqual((await base.record()).plan);
        expect(rig.store.outcome(rig.runId).result, label).toEqual(
          base.store.outcome(base.runId).result,
        );
        expect(validateConversation(rebuildState(await rig.events()).messages), label).toEqual([]);
      }
      expect(crashes).toBeGreaterThan(5);
      // At least some kill points fell between a tool_call and its tool_result.
      if (
        scenario.script.some(
          (s) =>
            "blocks" in s &&
            s.blocks.some(
              (b) => b.type === "tool_call" && ["echo", "counter", "write_note"].includes(b.name),
            ),
        )
      ) {
        expect(interruptedRuns).toBeGreaterThan(0);
      }
    });
  }

  for (const scenario of scenarios.filter((sc) => sc.answer !== undefined)) {
    it(`delivers the user's answer exactly once when the process dies at any point after it was posted: ${scenario.name}`, async () => {
      const base = makeRig(scenario);
      await drive(base, scenario);
      const baseEvents = await base.events();
      const baseProjection = project(baseEvents, scenario.midRun !== undefined);

      // The run up to the first wait for the user, and the number of events at that point.
      const reachWait = async (): Promise<Rig> => {
        const rig = makeRig(scenario);
        const status = await runLoop(
          rig.deps({ provider: new FakeProvider(withMidRun(rig, scenario, scenario.script, 0)) }),
          rig.runId,
        );
        expect(status).toBe("waiting_user");
        return rig;
      };
      const waitingAt = (await (await reachWait()).events()).length;

      let crashes = 0;
      for (let m = 0; m <= baseEvents.length - waitingAt; m++) {
        const rig = await reachWait();
        const answer = scenario.answer as string;
        rig.store.postInbox(rig.runId, { kind: "user_message", text: answer });
        const events = await rig.events();
        const mainDone = countResponses(events, "main");
        const reviewDone = countResponses(events, "review");
        const reviewer =
          scenario.reviewerScript === undefined
            ? undefined
            : {
                provider: new FakeProvider(scenario.reviewerScript.slice(reviewDone), {
                  id: "reviewer",
                }),
                model: { id: "reviewer-model", maxOutputTokens: 1024 },
                ...(scenario.maxRejections === undefined
                  ? {}
                  : { maxRejections: scenario.maxRejections }),
              };
        try {
          await runLoop(
            {
              ...rig.deps({
                store: new CrashingStore(rig.store, m),
                provider: new FakeProvider(
                  withMidRun(rig, scenario, scenario.script.slice(mainDone), mainDone),
                ),
              }),
              ...(reviewer === undefined ? {} : { reviewer }),
            },
            rig.runId,
          );
        } catch (error) {
          if (!(error instanceof SimulatedCrash)) throw error;
          crashes += 1;
        }
        const label = `answer posted, then dying after ${m} more events`;
        expect(await drive(rig, scenario), label).toBe("done");
        await expectDeliveredOnce(rig, scenario, label);
        const resumed = project(await rig.events(), scenario.midRun !== undefined);
        expect(resumed.length, label).toBe(baseProjection.length);
        expect(validateConversation(rebuildState(await rig.events()).messages), label).toEqual([]);
      }
      expect(crashes).toBeGreaterThan(3);
    });
  }

  it("a tool that died mid-way is not run again; the model gets the unknown-result message", async () => {
    const scenario: Scenario = {
      name: "single tool",
      script: [use(call("c1", "write_note", { name: "f.txt", body: "v" })), say("Checked.")],
    };
    const rig = makeRig(scenario);
    // Die right after the tool_call was logged (run_started, model_request, model_response, tool_call).
    await expect(
      runLoop(rig.deps({ store: new CrashingStore(rig.store, 4) }), rig.runId),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(rig.executor.files.get("/workspace/f.txt")).toBe("v");

    const status = await drive(rig, scenario);
    expect(status).toBe("done");
    const results = eventsOfType(await rig.events(), "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toMatchObject({ callId: "c1", outcome: "aborted", isError: true });
    expect(results[0]?.payload.content).toContain(
      "interrupted — the result is unknown; check the actual state before repeating this action",
    );
    expect(rig.executor.files.size).toBe(1);
  });
});

describe("rebuildState", () => {
  it("rebuilds a valid conversation at every prefix of a real run", async () => {
    const scenario = scenarios[0] as Scenario;
    const rig = makeRig(scenario);
    await drive(rig, scenario);
    const events = await rig.events();
    for (let n = 0; n <= events.length; n++) {
      const state = rebuildState(events.slice(0, n));
      const problems = validateConversation(state.messages);
      // The only acceptable problems are calls whose results are still to come.
      for (const problem of problems) expect(problem).toMatch(/has no tool_result/);
      if (state.pendingCalls.length === 0 && state.messages.length > 0) {
        expect(problems).toEqual([]);
      }
    }
  });

  it("is deterministic: the same events give the same state", async () => {
    const scenario = scenarios[0] as Scenario;
    const rig = makeRig(scenario);
    await drive(rig, scenario);
    const events = await rig.events();
    expect(rebuildState(events)).toEqual(rebuildState(structuredClone(events)));
  });
});
