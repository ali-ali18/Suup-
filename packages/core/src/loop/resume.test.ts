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
  planCall,
  type Rig,
  SimulatedCrash,
  type StepInput,
  say,
  use,
  verdict,
} from "../testing/index.js";
import { INTERRUPTED_RESULT, runLoop } from "./loop.js";
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
}

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
function project(events: readonly StoredEvent[]): unknown[] {
  return events
    .filter((e) => e.type !== "model_request")
    .map((e) => {
      const payload: Record<string, unknown> = { ...e.payload };
      delete payload.durationMs;
      // Positions shift when a request was logged twice (died before its response).
      delete payload.uptoSeq;
      return { type: e.type, ...payload };
    });
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
        ...rig.deps({ provider: new FakeProvider(scenario.script.slice(mainDone)) }),
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

function makeRig(scenario: Scenario): Rig {
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
      const baseProjection = project(baseEvents);
      expect(baseStatus).toBe("done");

      let interruptedRuns = 0;
      let crashes = 0;
      for (let n = 0; n <= baseEvents.length; n++) {
        const rig = makeRig(scenario);

        // First life: dies after `n` appended events.
        try {
          await runLoop(rig.deps({ store: new CrashingStore(rig.store, n) }), rig.runId);
        } catch (error) {
          if (!(error instanceof SimulatedCrash)) throw error;
          crashes += 1;
        }

        // Second life: a fresh loop with only the part of the script not yet consumed.
        const status = await drive(rig, scenario);
        expect(status, `status after a crash at event ${n}`).toBe("done");

        const resumed = project(await rig.events());
        const label = `crash after ${n} events`;
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
