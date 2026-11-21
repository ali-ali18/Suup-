// A card approved long after it was asked (docs/APROVACOES.md, "Aprovação depois de muito tempo")
// and a message sent right after a denial. Both are decided by the order of the log and by numbers
// the store recorded, never by reading text.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ApprovalRule,
  createModelReviewer,
  createToolGate,
  REVIEW_TOOL_NAME,
  type ToolGate,
  type WrittenRule,
} from "../approvals/index.js";
import { replayRun } from "../replay.js";
import {
  CrashingStore,
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  finishCall,
  type Rig,
  SimulatedCrash,
  say,
  testTools,
  textOf,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { canonicalJson, formatWaited, sameCall } from "./grants.js";
import { runLoop } from "./loop.js";
import type { RunStatus, StoredEvent } from "./store.js";

const HOUR = 3_600_000;
const STALE = { waitedMs: 5 * HOUR, thresholdMs: HOUR };

interface Setup {
  script: Parameters<typeof createRig>[0]["script"];
  rig: Rig;
  sent: string[];
  gate: ToolGate;
  /** Exact rules and written rules the gate reads at every call: a test may add one later. */
  rules: ApprovalRule[];
  written: WrittenRule[];
}

const NEVER: WrittenRule = {
  id: "w-never",
  kind: "never",
  text: "mensagens para ana",
  botId: null,
};

function setup(script: Parameters<typeof createRig>[0]["script"], withReviewer = false): Setup {
  const rules: ApprovalRule[] = [];
  const written: WrittenRule[] = [];
  const sent: string[] = [];
  const rig = createRig({
    script,
    tools: [
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
    ],
    bot: { allowedTools: ["echo", "send"] },
  });
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => rules },
    written: { writtenRulesFor: async () => written },
    ...(withReviewer
      ? {
          // Blocks citing the never rule once it exists, asks until then.
          modelReviewer: createModelReviewer({
            provider: new FakeProvider(
              Array.from({ length: 20 }, () => () => ({
                blocks: [
                  {
                    type: "tool_call" as const,
                    id: "r",
                    name: REVIEW_TOOL_NAME,
                    args:
                      written.length > 0
                        ? { decision: "block", ruleId: NEVER.id, reason: "Nunca." }
                        : { decision: "ask", ruleId: null, reason: "Não sei." },
                  },
                ],
                usage: { inputTokens: 100, outputTokens: 10 },
              })),
              { id: "rev" },
            ),
            model: {
              id: "reviewer-model",
              maxOutputTokens: 400,
              pricing: { inputPerMTok: 1, outputPerMTok: 5 },
            },
          }),
        }
      : {}),
    now: () => new Date(rig.clock.now),
  });
  return { script, rig, sent, gate, rules, written };
}

const loop = (s: Setup): Promise<RunStatus> => runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId);

function claim(s: Setup): void {
  expect(s.rig.store.claimNext("worker-1")?.id).toBe(s.rig.runId);
}

const cards = (events: readonly StoredEvent[]) => eventsOfType(events, "approval_requested");

/** Answers the newest open card and hands the run back to a worker. */
async function answer(
  s: Setup,
  decision: "approved" | "denied",
  stale?: { waitedMs: number; thresholdMs: number },
): Promise<void> {
  const events = await s.rig.events();
  const open = cards(events).filter(
    (c) =>
      !eventsOfType(events, "approval_decided").some((d) => d.payload.callId === c.payload.callId),
  );
  const card = open.at(-1);
  if (card === undefined) throw new Error("no open card");
  s.rig.store.decideApproval(s.rig.runId, card.payload.approvalId, {
    decision,
    ...(stale === undefined ? {} : { stale }),
  });
  claim(s);
}

const ARGS = { to: "ana", body: "hello" };

describe("grants.ts helpers", () => {
  it("canonical JSON ignores key order and nothing else", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
    expect(
      sameCall({ tool: "send", args: ARGS }, { name: "send", args: { body: "hello", to: "ana" } }),
    ).toBe(true);
    expect(
      sameCall({ tool: "send", args: ARGS }, { name: "send", args: { ...ARGS, body: "hello " } }),
    ).toBe(false);
    expect(sameCall({ tool: "send", args: ARGS }, { name: "mail", args: ARGS })).toBe(false);
  });

  it("says how long a card waited", () => {
    expect(formatWaited(40 * 60_000)).toBe("40 min");
    expect(formatWaited(5 * HOUR)).toBe("5 h");
    expect(formatWaited(72 * HOUR)).toBe("3 d");
  });
});

describe("an approval that waited too long", () => {
  it("a fresh approval runs immediately (unchanged)", async () => {
    const s = setup([use(call("c1", "send", ARGS)), say("sent")]);
    await loop(s);
    await answer(s, "approved");
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|hello"]);
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_stale")).toHaveLength(0);
  });

  it("resumes with a harness notice and does NOT run the call", async () => {
    const s = setup([use(call("c1", "send", ARGS)), say("Resuming the old task; not sending.")]);
    await loop(s);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    const [decided] = eventsOfType(events, "approval_decided");
    expect(decided?.payload.decision).toBe("approved");
    const [stale] = eventsOfType(events, "approval_stale");
    expect(stale?.payload).toMatchObject({ callId: "c1", waitedMs: 5 * HOUR, thresholdMs: HOUR });
    const [result] = eventsOfType(events, "tool_result");
    expect(result?.payload.outcome).toBe("denied");
    expect(result?.payload.content).toContain("[Harness notice]");
    expect(result?.payload.content).toContain("5 h");
    expect(result?.payload.content).toContain("retomou uma tarefa antiga");
    // the sentence that reaches the user is the final message, not the text beside a tool call
    expect(result?.payload.content).toContain("mensagem final");
    expect(result?.payload.content).toContain("não chega a ele");
    // The model reads it as the harness, not as the user.
    const sent = s.rig.provider.requests[1]?.messages.at(-1);
    expect(textOf(sent)).not.toContain("[Message from the user");
  });

  it("the identical call runs without a card and consumes the grant; a third one asks", async () => {
    const s = setup([
      use(call("c1", "send", ARGS)),
      use(call("c2", "send", { body: "hello", to: "ana" })), // same call, other key order
      use(call("c3", "send", ARGS)),
    ]);
    await loop(s);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("waiting_approval");
    // c2 ran on the grant, c3 is a new card.
    expect(s.sent).toEqual(["ana|hello"]);
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_grant_used").map((e) => e.payload)).toEqual([
      { approvalId: cards(events)[0]?.payload.approvalId, callId: "c2", tool: "send" },
    ]);
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1", "c3"]);
  });

  it("a different argument is a new card, and the grant stays for the exact call", async () => {
    const s = setup([
      use(call("c1", "send", ARGS)),
      use(call("c2", "send", { to: "ana", body: "hello!" })),
    ]);
    await loop(s);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1", "c2"]);
    expect(eventsOfType(events, "approval_grant_used")).toHaveLength(0);
    expect(s.sent).toEqual([]);
  });

  it("an exact deny rule created after the late approval still refuses the identical call; the grant is not consumed", async () => {
    const s = setup([use(call("c1", "send", ARGS)), use(call("c2", "send", ARGS)), say("ok")]);
    await loop(s);
    s.rules.push({
      id: "r-deny",
      botId: null,
      tool: "send",
      effect: "deny",
      matchers: [],
      note: "no",
    });
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_grant_used")).toHaveLength(0);
    expect(eventsOfType(events, "tool_result").map((e) => e.payload.outcome)).toEqual([
      "denied",
      "denied",
    ]);
    expect(eventsOfType(events, "policy_checked")[0]?.payload).toMatchObject({
      callId: "c2",
      outcome: "deny",
      source: "rule",
    });
  });

  it("a written never-rule (the reviewer) created after the late approval refuses the identical call; the grant is not consumed", async () => {
    const s = setup(
      [use(call("c1", "send", ARGS)), use(call("c2", "send", ARGS)), say("ok")],
      true,
    );
    await loop(s);
    s.written.push(NEVER);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_grant_used")).toHaveLength(0);
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1"]);
    expect(eventsOfType(events, "policy_checked")[0]?.payload).toMatchObject({
      callId: "c2",
      outcome: "deny",
      source: "reviewer",
    });
  });

  it("with the reviewer asking, the grant still replaces the card", async () => {
    const s = setup(
      [use(call("c1", "send", ARGS)), use(call("c2", "send", ARGS)), say("ok")],
      true,
    );
    await loop(s);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|hello"]);
    expect(eventsOfType(await s.rig.events(), "approval_grant_used")).toHaveLength(1);
  });

  it("the grant does not survive the run", async () => {
    const first = setup([use(call("c1", "send", ARGS)), say("done")]);
    await loop(first);
    await answer(first, "approved", STALE);
    await loop(first);
    // Another run of the same bot starts with no grant: the same call asks.
    const second = setup([use(call("c1", "send", ARGS)), say("done")]);
    expect(await loop(second)).toBe("waiting_approval");
    expect(cards(await second.rig.events())).toHaveLength(1);
  });

  it("a denial or an expiry never leaves a grant", async () => {
    const s = setup([use(call("c1", "send", ARGS)), use(call("c2", "send", ARGS))]);
    await loop(s);
    await answer(s, "denied", STALE as never);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_stale")).toHaveLength(0);
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1", "c2"]);
  });

  it("replays to the same log", async () => {
    const s = setup([use(call("c1", "send", ARGS)), use(call("c2", "send", ARGS)), say("done")]);
    await loop(s);
    await answer(s, "approved", STALE);
    expect(await loop(s)).toBe("done");
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(s.sent).toEqual(["ana|hello"]);
  });
});

/** Runs to the end through every life, answering the card as asked, crashing once after `crashAfter` events. */
async function drive(s: Setup, crashAfter?: number): Promise<RunStatus> {
  let answered = false;
  for (let life = 0; life < 30; life++) {
    const responses = eventsOfType(await s.rig.events(), "model_response").length;
    const deps = s.rig.deps({
      provider: new FakeProvider(s.script.slice(responses)),
      gate: s.gate,
      ...(life === 0 && crashAfter !== undefined
        ? { store: new CrashingStore(s.rig.store, crashAfter) }
        : {}),
    });
    let status: RunStatus;
    try {
      status = await runLoop(deps, s.rig.runId);
    } catch (error) {
      if (error instanceof SimulatedCrash) continue;
      throw error;
    }
    if (status !== "waiting_approval") return status;
    if (!answered) {
      answered = true;
      const card = cards(await s.rig.events())[0];
      s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
        decision: "approved",
        stale: STALE,
      });
    }
    if ((await s.rig.record()).status === "queued") claim(s);
  }
  throw new Error("the run did not settle");
}

const project = (events: readonly StoredEvent[]) =>
  events
    .filter((e) => e.type !== "model_request")
    .map((e) => {
      const { durationMs: _d, usage: _u, ...rest } = e.payload as Record<string, unknown>;
      return { type: e.type, payload: rest };
    });

describe("a late approval survives a crash at every event", () => {
  const SCRIPT = () => [
    use(call("c1", "send", ARGS)),
    use(call("c2", "send", ARGS)),
    use(finishCall("f1", "Done.")),
  ];

  it("gives the same log and runs the call once", async () => {
    const base = setup(SCRIPT());
    expect(await drive(base)).toBe("done");
    const baseEvents = await base.rig.events();
    expect(base.sent).toEqual(["ana|hello"]);
    expect(eventsOfType(baseEvents, "approval_stale")).toHaveLength(1);
    expect(eventsOfType(baseEvents, "approval_grant_used")).toHaveLength(1);
    for (let n = 0; n <= baseEvents.length; n++) {
      const s = setup(SCRIPT());
      expect(await drive(s, n), `crash after ${n} events`).toBe("done");
      expect(project(await s.rig.events()), `crash after ${n} events`).toEqual(project(baseEvents));
      expect(s.sent, `crash after ${n} events`).toEqual(["ana|hello"]);
    }
  });
});

describe("a message right after a denial", () => {
  it("queued before the next turn: delivered linked to the denial, and the run goes on", async () => {
    const s = setup([use(call("c1", "send", ARGS)), say("Understood, using another way.")]);
    await loop(s);
    s.rig.store.postInbox(s.rig.runId, { kind: "user_message", text: "mande por e-mail" });
    await answer(s, "denied");
    expect(await loop(s)).toBe("done");
    const events = await s.rig.events();
    const [denied] = eventsOfType(events, "approval_decided");
    const [message] = eventsOfType(events, "user_message");
    expect(message?.payload.linkedApprovalId).toBe(denied?.payload.approvalId);
    expect(events.indexOf(denied as StoredEvent)).toBeLessThan(
      events.indexOf(message as StoredEvent),
    );
    const last = textOf(s.rig.provider.requests[1]?.messages.at(-1));
    expect(last).toContain(
      "Sobre a ação que você acabou de não poder fazer (send, recusada pelo usuário): mande por e-mail",
    );
  });

  it("a message that comes after the model already went on is not linked", async () => {
    const s = setup([
      use(call("c1", "send", ARGS)),
      use(call("c2", "send", { to: "bob", body: "x" })),
      say("ok"),
    ]);
    await loop(s);
    await answer(s, "denied");
    expect(await loop(s)).toBe("waiting_approval"); // the model went on and asked for c2
    s.rig.store.postInbox(s.rig.runId, { kind: "user_message", text: "e agora?" });
    await answer(s, "approved");
    expect(await loop(s)).toBe("done");
    const [message] = eventsOfType(await s.rig.events(), "user_message");
    expect(message?.payload.text).toBe("e agora?");
    expect("linkedApprovalId" in (message?.payload ?? {})).toBe(false);
    expect(textOf(s.rig.provider.requests[2]?.messages.at(-1))).not.toContain("Sobre a ação");
  });

  it("a message after an approval or without any denial is not linked", async () => {
    const s = setup([use(call("c1", "send", ARGS)), say("done")]);
    await loop(s);
    s.rig.store.postInbox(s.rig.runId, { kind: "user_message", text: "oi" });
    await answer(s, "approved");
    expect(await loop(s)).toBe("done");
    const [message] = eventsOfType(await s.rig.events(), "user_message");
    expect("linkedApprovalId" in (message?.payload ?? {})).toBe(false);
  });

  it("replays to the same log", async () => {
    const s = setup([use(call("c1", "send", ARGS)), say("fine")]);
    await loop(s);
    s.rig.store.postInbox(s.rig.runId, { kind: "user_message", text: "mande por e-mail" });
    await answer(s, "denied");
    expect(await loop(s)).toBe("done");
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
  });
});
