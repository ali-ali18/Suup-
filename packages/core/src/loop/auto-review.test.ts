import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createModelReviewer,
  createToolGate,
  REVIEW_TOOL_NAME,
  type ToolGate,
  type WrittenRule,
} from "../approvals/index.js";
import { replayRun } from "../replay.js";
import type { FakeStep } from "../testing/fake-provider.js";
import {
  CrashingStore,
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  finishCall,
  planCall,
  type Rig,
  SimulatedCrash,
  testTools,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { runLoop } from "./loop.js";
import type { RunStatus, StoredEvent } from "./store.js";

const ALLOW: WrittenRule = {
  id: "w-allow",
  kind: "allow",
  text: "mensagens para ana",
  botId: null,
};
const NEVER: WrittenRule = {
  id: "w-never",
  kind: "never",
  text: "mensagens para bob",
  botId: null,
};

/** Answers by what the proposed call is about: who the message goes to. */
function reviewerSteps(seen: string[], count = 40): FakeStep[] {
  const step: FakeStep = (req) => {
    const text = req.messages[0]?.blocks[0]?.type === "text" ? req.messages[0].blocks[0].text : "";
    seen.push(text);
    const toAna = text.includes('"to": "ana"');
    const toBob = text.includes('"to": "bob"');
    const args = toAna
      ? { decision: "run", ruleId: ALLOW.id, reason: "Mensagem para a Ana." }
      : toBob
        ? { decision: "block", ruleId: NEVER.id, reason: "Nunca para o Bob." }
        : { decision: "ask", ruleId: null, reason: "Não sei." };
    return {
      blocks: [{ type: "tool_call", id: "r", name: REVIEW_TOOL_NAME, args }],
      usage: { inputTokens: 1000, outputTokens: 20 },
    };
  };
  return Array.from({ length: count }, () => step);
}

interface Setup {
  script: FakeStep[];
  rig: Rig;
  sent: string[];
  gate: ToolGate;
  reviewerProvider: FakeProvider;
  seen: string[];
}

function setup(script: FakeStep[], reviewerScript?: FakeStep[]): Setup {
  const sent: string[] = [];
  const seen: string[] = [];
  const tools = [
    ...testTools(),
    defineTool({
      name: "send",
      description: "Sends a message to someone.",
      input: z.object({ to: z.string(), body: z.string() }),
      risk: "external_irreversible",
      describe: ({ to }) => `Send a message to ${to}`,
      execute: async ({ to, body }) => {
        sent.push(`${to}|${body}`);
        return { content: `sent to ${to}` };
      },
    }),
  ];
  const rig = createRig({
    script,
    tools,
    objective: "Avise a Ana e o Bob.",
    bot: { allowedTools: ["echo", "counter", "write_note", "send"] },
  });
  const reviewerProvider = new FakeProvider(reviewerScript ?? reviewerSteps(seen), { id: "rev" });
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => [] },
    written: { writtenRulesFor: async () => [ALLOW, NEVER] },
    modelReviewer: createModelReviewer({
      provider: reviewerProvider,
      model: {
        id: "reviewer-model",
        maxOutputTokens: 400,
        pricing: { inputPerMTok: 1, outputPerMTok: 5 },
      },
    }),
    now: () => new Date(rig.clock.now),
  });
  return { script, rig, sent, gate, reviewerProvider, seen };
}

const SCRIPT = (): FakeStep[] => [
  use(
    planCall("p1", [{ id: "s1", title: "Avisar", status: "in_progress" }]),
    call("c1", "send", { to: "ana", body: "a" }),
    call("c2", "send", { to: "bob", body: "b" }),
  ),
  use(planCall("p2", [{ id: "s1", title: "Avisar", status: "done" }])),
  use(finishCall("f1", "Done.")),
];

const loop = (s: Setup): Promise<RunStatus> => runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId);

describe("auto-review in the loop", () => {
  it("records the review before the verdict, runs what a rule allows, refuses what a rule forbids", async () => {
    const s = setup(SCRIPT());
    expect(await loop(s)).toBe("done");
    // c1 ran; c2 never did: a call refused holds back the rest of its turn, c2 is itself the refused one.
    expect(s.sent).toEqual(["ana|a"]);
    const events = await s.rig.events();
    const types = events.map((e) => e.type);
    const reviews = eventsOfType(events, "approval_review");
    expect(reviews.map((e) => [e.payload.callId, e.payload.decision, e.payload.outcome])).toEqual([
      ["c1", "run", "allow"],
      ["c2", "block", "deny"],
    ]);
    expect(reviews[0]?.payload).toMatchObject({
      ruleId: "w-allow",
      model: "reviewer-model",
      promptVersion: "auto-review-v4",
      usage: { inputTokens: 1000, outputTokens: 20 },
    });
    // each review comes right before the verdict it led to
    const first = types.indexOf("approval_review");
    expect(types[first + 1]).toBe("policy_checked");
    const checked = eventsOfType(events, "policy_checked");
    expect(checked.map((e) => [e.payload.callId, e.payload.outcome, e.payload.source])).toEqual([
      ["c1", "allow", "reviewer"],
      ["c2", "deny", "reviewer"],
    ]);
    expect(checked[1]?.payload).toMatchObject({
      writtenRuleId: "w-never",
      reason: 'Bloqueado pela regra "mensagens para bob"',
    });
    // the bot is told, citing the rule
    const result = eventsOfType(events, "tool_result").find((e) => e.payload.callId === "c2");
    expect(result?.payload.content).toContain('Bloqueado pela regra "mensagens para bob"');
    expect(result?.payload.isError).toBe(true);
    // what the reviews cost is part of the run
    const record = await s.rig.record();
    expect(record.costUsd).toBeGreaterThan(0);
  });

  it("an ask is a card that says why, and the review is in the log first", async () => {
    const s = setup([
      use(call("c1", "send", { to: "carla", body: "x" })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    const types = events.map((e) => e.type);
    expect(types.indexOf("approval_review")).toBeLessThan(types.indexOf("approval_requested"));
    const [card] = eventsOfType(events, "approval_requested");
    expect(card?.payload).toMatchObject({ source: "reviewer", reason: "Não sei." });
    expect(s.sent).toEqual([]);
  });

  it("the reviewer is never shown assistant text or a tool result", async () => {
    const s = setup([
      use(call("c0", "echo", { text: "RESULTADO-SECRETO-DA-FERRAMENTA" })),
      use(call("c1", "send", { to: "ana", body: "a" })),
      use(finishCall("f1", "Done.")),
    ]);
    expect(await loop(s)).toBe("done");
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).not.toContain("RESULTADO-SECRETO-DA-FERRAMENTA");
    // the user's own words are there
    expect(s.seen[0]).toContain("Avise a Ana e o Bob.");
  });

  it("after 3 refusals in a row the next call asks the user (the model is not asked)", async () => {
    const blocks = Array.from({ length: 4 }, (_, i) =>
      use(call(`c${i}`, "send", { to: "bob", body: String(i) })),
    );
    const s = setup([...blocks, use(finishCall("f1", "Done."))]);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    const reviews = eventsOfType(events, "approval_review").map((e) => [
      e.payload.callId,
      e.payload.outcome,
      e.payload.skipped ?? null,
    ]);
    expect(reviews).toEqual([
      ["c0", "deny", null],
      ["c1", "deny", null],
      ["c2", "deny", null],
      ["c3", "ask", "cap"],
    ]);
    expect(s.reviewerProvider.calls).toBe(3);
    expect(eventsOfType(events, "approval_requested")).toHaveLength(1);
  });
});

describe("auto-review: resume and replay stay deterministic", () => {
  const project = (events: readonly StoredEvent[]) =>
    events
      .filter((e) => e.type !== "model_request")
      .map((e) => {
        const { durationMs: _d, latencyMs: _l, ...rest } = e.payload as Record<string, unknown>;
        return { type: e.type, payload: rest };
      });

  async function drive(s: Setup, crashAfter?: number): Promise<RunStatus> {
    for (let life = 0; life < 40; life++) {
      const answered = eventsOfType(await s.rig.events(), "model_response").length;
      const deps = s.rig.deps({
        provider: new FakeProvider(s.script.slice(answered)),
        gate: s.gate,
        ...(life === 0 && crashAfter !== undefined
          ? { store: new CrashingStore(s.rig.store, crashAfter) }
          : {}),
      });
      try {
        return await runLoop(deps, s.rig.runId);
      } catch (error) {
        if (error instanceof SimulatedCrash) continue;
        throw error;
      }
    }
    throw new Error("the run did not settle");
  }

  it("a crash at any event gives the same log, and the model reviews each call once", async () => {
    const base = setup(SCRIPT());
    expect(await drive(base)).toBe("done");
    const baseEvents = await base.rig.events();
    expect(base.reviewerProvider.calls).toBe(2);

    for (let n = 0; n <= baseEvents.length; n++) {
      // A process that dies between a tool's start and its result leaves that result unknown
      // ("interrupted"): the same at-most-once rule as without a reviewer. Not what is tested here.
      if (baseEvents[n - 1]?.type === "tool_call") continue;
      const s = setup(SCRIPT());
      expect(await drive(s, n), `crash after ${n} events`).toBe("done");
      expect(project(await s.rig.events()), `crash after ${n} events`).toEqual(project(baseEvents));
      expect(s.reviewerProvider.calls, `crash after ${n} events`).toBe(2);
      expect(s.sent, `crash after ${n} events`).toEqual(["ana|a"]);
    }
  });

  it("a replay serves the recorded reviews: identical log, no model call, no message sent", async () => {
    const s = setup(SCRIPT());
    expect(await loop(s)).toBe("done");
    const events = await s.rig.events();
    const report = await replayRun(events, { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(s.reviewerProvider.calls).toBe(2);
    expect(s.sent).toEqual(["ana|a"]);
  });
});
