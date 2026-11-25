import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ApprovalRule, createToolGate, type ToolGate } from "../approvals/index.js";
import { outboundMessage } from "../outbound.js";
import { replayRun } from "../replay.js";
import { createRedactor } from "../secrets.js";
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
  say,
  testTools,
  use,
} from "../testing/index.js";
import { defineTool, type Tool } from "../tool.js";
import { runLoop } from "./loop.js";
import type { RunStatus, StoredEvent } from "./store.js";

/** A tool with effects outside: it asks, unless a rule says otherwise. */
function makeTools(sent: string[]): Tool[] {
  return [
    ...testTools(),
    defineTool({
      name: "send",
      description: "Sends a message to someone.",
      input: z.object({ to: z.string(), body: z.string() }),
      risk: "external_irreversible",
      secretFields: ["body"],
      secretDestination: "to",
      describe: ({ to }) => `Send a message to ${to}`,
      execute: async ({ to, body }) => {
        sent.push(`${to}|${body}`);
        return { content: `sent to ${to}` };
      },
    }),
    defineTool({
      // Declares that a call is a message to another person: only a declaration says it.
      name: "mail",
      description: "Sends an e-mail.",
      input: z.object({ to: z.string(), subject: z.string() }),
      risk: "read",
      outbound: outboundMessage("to"),
      execute: async ({ to, subject }) => {
        sent.push(`mail:${to}|${subject}`);
        return { content: `mailed ${to}` };
      },
    }),
    defineTool({
      name: "deploy",
      description: "Deploys. A dry run only reads.",
      input: z.object({ dry_run: z.boolean(), target: z.string() }),
      risk: "external_irreversible",
      classify: ({ dry_run }) => (dry_run ? "read" : "external_irreversible"),
      execute: async ({ dry_run, target }) => ({
        content: `${dry_run ? "checked" : "deployed"} ${target}`,
      }),
    }),
  ];
}

const ALLOWED = ["echo", "counter", "write_note", "send", "mail", "deploy"];

interface Setup {
  script: Parameters<typeof createRig>[0]["script"];
  rig: Rig;
  sent: string[];
  gate: ToolGate;
  rules: ApprovalRule[];
}

function setup(
  script: Parameters<typeof createRig>[0]["script"],
  rules: ApprovalRule[] = [],
): Setup {
  const sent: string[] = [];
  const rig = createRig({ script, tools: makeTools(sent), bot: { allowedTools: ALLOWED } });
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => rules },
    now: () => new Date(rig.clock.now),
  });
  return { script, rig, sent, gate, rules };
}

const loop = (s: Setup, extra: Parameters<Rig["deps"]>[0] = {}): Promise<RunStatus> =>
  runLoop(s.rig.deps({ gate: s.gate, ...extra }), s.rig.runId);

/** What the worker does when the user answered: take the run back from the queue. */
function claim(s: Setup): void {
  const claimed = s.rig.store.claimNext("worker-1");
  expect(claimed?.id).toBe(s.rig.runId);
}

const requested = (events: readonly StoredEvent[]) => eventsOfType(events, "approval_requested");

describe("approval gate in the loop", () => {
  it("a read runs without a card and without a policy event", async () => {
    const s = setup([use(call("c1", "echo", { text: "hi" })), say("done")]);
    expect(await loop(s)).toBe("done");
    const events = await s.rig.events();
    expect(requested(events)).toHaveLength(0);
    expect(eventsOfType(events, "policy_checked")).toHaveLength(0);
  });

  it("a tool that DECLARES a message to another person asks even if its risk says read, and the request records the declaration", async () => {
    const s = setup([use(call("c1", "mail", { to: "ana@x.com", subject: "Oi" })), say("ok")]);
    expect(await loop(s)).toBe("waiting_approval");
    const [card] = requested(await s.rig.events());
    expect(card?.payload).toMatchObject({
      tool: "mail",
      level: "external_irreversible",
      outbound: { kind: "message", recipientFields: ["to"] },
    });
    expect(s.sent).toEqual([]);
  });

  it("a tool that does not declare it never gets the declaration, whatever its name or text say", async () => {
    // `send` sends a message in its description and name, but nobody declared it an outbound message.
    const s = setup([use(call("c1", "send", { to: "ana", body: "hi" })), say("ok")]);
    expect(await loop(s)).toBe("waiting_approval");
    const [card] = requested(await s.rig.events());
    expect(card?.payload.outbound).toBeUndefined();
    expect("outbound" in (card?.payload ?? {})).toBe(false);
  });

  it("a reversible write runs and leaves a policy event naming its level", async () => {
    const s = setup([use(call("c1", "write_note", { name: "a.txt", body: "x" })), say("done")]);
    expect(await loop(s)).toBe("done");
    const [policy] = eventsOfType(await s.rig.events(), "policy_checked");
    expect(policy?.payload).toMatchObject({
      callId: "c1",
      level: "write_reversible",
      outcome: "allow",
      source: "default",
    });
  });

  it("the level can depend on the arguments", async () => {
    const dry = setup([use(call("c1", "deploy", { dry_run: true, target: "prod" })), say("ok")]);
    expect(await loop(dry)).toBe("done");
    const real = setup([use(call("c1", "deploy", { dry_run: false, target: "prod" })), say("ok")]);
    expect(await loop(real)).toBe("waiting_approval");
  });

  it("an external call asks: the run waits at a safe point and nothing runs", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "hello" })), say("done")]);
    expect(await loop(s)).toBe("waiting_approval");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    const [card] = requested(events);
    expect(card?.payload).toMatchObject({
      callId: "c1",
      tool: "send",
      args: { to: "ana", body: "hello" },
      level: "external_irreversible",
      summary: "Send a message to ana",
      secrets: [],
      source: "default",
    });
    expect(card?.payload.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab]/);
    // The call has no result yet and the model was not asked again.
    expect(eventsOfType(events, "tool_result")).toHaveLength(0);
    expect(s.rig.provider.requests).toHaveLength(1);
    expect((await s.rig.record()).status).toBe("waiting_approval");
    // A loop started on a run waiting for approval changes nothing.
    expect(await loop(s)).toBe("waiting_approval");
    expect((await s.rig.events()).length).toBe(events.length);
  });

  it("approve: the tool runs with exactly the recorded arguments and the run goes on", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "hello" })), say("sent it")]);
    await loop(s);
    const [card] = requested(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "approved",
    });
    expect((await s.rig.record()).status).toBe("queued");
    claim(s);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|hello"]);
    const events = await s.rig.events();
    const [decided] = eventsOfType(events, "approval_decided");
    expect(decided?.payload).toMatchObject({ callId: "c1", decision: "approved" });
    const [result] = eventsOfType(events, "tool_result");
    expect(result?.payload).toMatchObject({ callId: "c1", outcome: "ok", content: "sent to ana" });
    expect(s.rig.provider.requests).toHaveLength(2);
    expect(await s.rig.store.peekApprovalDecisions(s.rig.runId)).toEqual([]);
  });

  it("deny: the model gets a result with the reason, the run is not failed", async () => {
    const s = setup([
      use(call("c1", "send", { to: "ana", body: "hello" })),
      say("Understood, I will not send it."),
    ]);
    await loop(s);
    const [card] = requested(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "denied",
      reason: "ana is on vacation",
    });
    claim(s);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    const [result] = eventsOfType(events, "tool_result");
    expect(result?.payload.outcome).toBe("denied");
    expect(result?.payload.isError).toBe(true);
    expect(result?.payload.content).toContain("user denied");
    expect(result?.payload.content).toContain("ana is on vacation");
    const last = s.rig.provider.requests[1];
    const resultBlock = last?.messages.at(-1)?.blocks.find((b) => b.type === "tool_result");
    expect(resultBlock).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect((await s.rig.record()).status).toBe("done");
  });

  it("a rule that allows runs the call without a card, and says so in the log", async () => {
    const rules: ApprovalRule[] = [
      {
        id: "rule-1",
        botId: null,
        tool: "send",
        effect: "allow",
        matchers: [{ field: "to", value: "ana" }],
      },
    ];
    const s = setup([use(call("c1", "send", { to: "ana", body: "hi" })), say("ok")], rules);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|hi"]);
    const [policy] = eventsOfType(await s.rig.events(), "policy_checked");
    expect(policy?.payload).toMatchObject({ outcome: "allow", source: "rule", ruleId: "rule-1" });
  });

  it("a rule that denies refuses the call without asking", async () => {
    const rules: ApprovalRule[] = [
      {
        id: "rule-2",
        botId: null,
        tool: "send",
        effect: "deny",
        matchers: [],
        note: "no messages",
      },
    ];
    const s = setup([use(call("c1", "send", { to: "ana", body: "hi" })), say("ok")], rules);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    const events = await s.rig.events();
    expect(requested(events)).toHaveLength(0);
    const [result] = eventsOfType(events, "tool_result");
    expect(result?.payload.outcome).toBe("denied");
    expect(result?.payload.content).toContain("no messages");
  });

  it("a call the model repeats after a denial is asked about again, as a new call", async () => {
    const s = setup([
      use(call("c1", "send", { to: "ana", body: "hello" })),
      use(call("c2", "send", { to: "ana", body: "hello" })),
    ]);
    await loop(s);
    const approvalId = (id: number) => requested(id === 0 ? [] : [])[0];
    expect(approvalId).toBeDefined();
    const [first] = requested(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, first?.payload.approvalId as string, {
      decision: "denied",
    });
    claim(s);
    expect(await loop(s)).toBe("waiting_approval");
    const cards = requested(await s.rig.events());
    expect(cards.map((c) => c.payload.callId)).toEqual(["c1", "c2"]);
    expect(cards[0]?.payload.approvalId).not.toBe(cards[1]?.payload.approvalId);
  });
});

describe("a card that ends without the user", () => {
  it("an expired card tells the model so, and the run goes on", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "a" })), say("ok, dropped it")]);
    const gate = createToolGate({
      tools: s.rig.registry,
      rules: { rulesFor: async () => [] },
      expireAfterMs: 60_000,
      now: () => new Date(s.rig.clock.now),
    });
    expect(await runLoop(s.rig.deps({ gate }), s.rig.runId)).toBe("waiting_approval");
    const [card] = requested(await s.rig.events());
    expect(card?.payload.expiresAt).toBe(new Date(s.rig.clock.now + 60_000).toISOString());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "expired",
    });
    claim(s);
    expect(await runLoop(s.rig.deps({ gate }), s.rig.runId)).toBe("done");
    expect(s.sent).toEqual([]);
    const [result] = eventsOfType(await s.rig.events(), "tool_result");
    expect(result?.payload.outcome).toBe("denied");
    expect(result?.payload.content).toContain("expired");
  });

  it("a cancelled card is not an approval either", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "a" })), say("fine")]);
    await loop(s);
    const [card] = requested(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "cancelled",
    });
    claim(s);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
  });
});

describe("several calls in one turn", () => {
  it("are handled in order, one card at a time, and later calls wait for the earlier one", async () => {
    const s = setup([
      use(
        call("c1", "echo", { text: "first" }),
        call("c2", "send", { to: "ana", body: "a" }),
        call("c3", "send", { to: "bob", body: "b" }),
        call("c4", "echo", { text: "last" }),
      ),
      say("all done"),
    ]);
    expect(await loop(s)).toBe("waiting_approval");
    let events = await s.rig.events();
    // The first call ran; the card is for the second; the third and fourth were not touched.
    expect(eventsOfType(events, "tool_result").map((e) => e.payload.callId)).toEqual(["c1"]);
    expect(requested(events).map((e) => e.payload.callId)).toEqual(["c2"]);

    s.rig.store.decideApproval(s.rig.runId, requested(events)[0]?.payload.approvalId as string, {
      decision: "approved",
    });
    claim(s);
    expect(await loop(s)).toBe("waiting_approval");
    events = await s.rig.events();
    expect(s.sent).toEqual(["ana|a"]);
    expect(requested(events).map((e) => e.payload.callId)).toEqual(["c2", "c3"]);

    s.rig.store.decideApproval(s.rig.runId, requested(events)[1]?.payload.approvalId as string, {
      decision: "approved",
    });
    claim(s);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|a", "bob|b"]);
    const results = eventsOfType(await s.rig.events(), "tool_result");
    expect(results.map((e) => e.payload.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("a denial holds back the rest of the turn", async () => {
    const s = setup([
      use(
        call("c1", "send", { to: "ana", body: "a" }),
        call("c2", "write_note", { name: "x.txt", body: "needs the message" }),
        call("c3", "echo", { text: "t" }),
      ),
      say("I will rethink."),
    ]);
    await loop(s);
    const [card] = requested(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "denied",
    });
    claim(s);
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual([]);
    expect(await s.rig.executor.stat("x.txt")).toBeNull();
    const results = eventsOfType(await s.rig.events(), "tool_result");
    expect(results.map((e) => [e.payload.callId, e.payload.outcome])).toEqual([
      ["c1", "denied"],
      ["c2", "denied"],
      ["c3", "denied"],
    ]);
    expect(results[1]?.payload.content).toContain("earlier call of this same turn was denied");
    // The conversation stays valid for the model.
    expect(s.rig.provider.requests).toHaveLength(2);
  });
});

describe("a decision that arrives before the loop paused", () => {
  it("does not pause at all", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "a" })), say("done")]);
    // The user answers while the loop is between asking and pausing (the store holds the decision).
    const original = s.rig.store.appendEvent.bind(s.rig.store);
    s.rig.store.appendEvent = async (runId, event) => {
      const result = await original(runId, event);
      if (event.type === "approval_requested") {
        s.rig.store.decideApproval(runId, event.payload.approvalId, { decision: "approved" });
      }
      return result;
    };
    expect(await loop(s)).toBe("done");
    expect(s.sent).toEqual(["ana|a"]);
    const statuses = eventsOfType(await s.rig.events(), "status_changed").map((e) => e.payload.to);
    expect(statuses).not.toContain("waiting_approval");
  });
});

/** Drives a run to its end, answering every card as `decide` says, whatever the lives in between. */
async function drive(
  s: Setup,
  decide: (card: StoredEvent & { type: "approval_requested" }) => "approved" | "denied",
  crashAfter?: number,
): Promise<RunStatus> {
  const decided = new Set<string>();
  for (let life = 0; life < 30; life++) {
    // A new life has a new model connection: it is told only what the log says came back.
    const answered = eventsOfType(await s.rig.events(), "model_response").length;
    const deps = s.rig.deps({
      provider: new FakeProvider(s.script.slice(answered)),
      gate: s.gate,
      ...(life === 0 && crashAfter !== undefined
        ? { store: new CrashingStore(s.rig.store, crashAfter) }
        : {}),
    });
    let status: RunStatus;
    try {
      status = await runLoop(deps, s.rig.runId);
    } catch (error) {
      if (error instanceof SimulatedCrash) continue; // the process died: start another life
      throw error;
    }
    if (status !== "waiting_approval") return status;
    const events = await s.rig.events();
    const pending = requested(events).filter(
      (c) =>
        !eventsOfType(events, "approval_decided").some(
          (d) => d.payload.callId === c.payload.callId,
        ),
    );
    const card = pending[0];
    if (card === undefined) throw new Error("waiting for an approval nobody asked for");
    if (!decided.has(card.payload.approvalId)) {
      decided.add(card.payload.approvalId);
      s.rig.store.decideApproval(s.rig.runId, card.payload.approvalId, { decision: decide(card) });
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

const SCRIPT = () => [
  use(
    planCall("p1", [{ id: "s1", title: "Send both", status: "in_progress" }]),
    call("c1", "send", { to: "ana", body: "a" }),
    call("c2", "send", { to: "bob", body: "b" }),
  ),
  use(call("c3", "echo", { text: "check" })),
  use(planCall("p2", [{ id: "s1", title: "Send both", status: "done" }])),
  use(finishCall("f1", "Done.")),
];

describe("resume after a crash at every step of an approval", () => {
  const decide = (card: { payload: { callId: string } }) =>
    card.payload.callId === "c1" ? "approved" : "denied";

  it("gives the same log as a run that did not crash", async () => {
    const base = setup(SCRIPT());
    expect(await drive(base, decide)).toBe("done");
    const baseEvents = await base.rig.events();
    expect(base.sent).toEqual(["ana|a"]);
    expect(eventsOfType(baseEvents, "approval_decided").map((e) => e.payload.decision)).toEqual([
      "approved",
      "denied",
    ]);

    for (let n = 0; n <= baseEvents.length; n++) {
      const s = setup(SCRIPT());
      const status = await drive(s, decide, n);
      expect(status, `crash after ${n} events`).toBe("done");
      expect(project(await s.rig.events()), `crash after ${n} events`).toEqual(project(baseEvents));
      // The message is sent once, never twice, whatever moment the process died at.
      expect(s.sent, `crash after ${n} events`).toEqual(["ana|a"]);
    }
  });
});

describe("replay", () => {
  it("replays a run with approvals to the same log, with the recorded decisions", async () => {
    const s = setup(SCRIPT());
    expect(await drive(s, (card) => (card.payload.callId === "c1" ? "approved" : "denied"))).toBe(
      "done",
    );
    const events = await s.rig.events();
    const report = await replayRun(events, { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(report.finalStatus).toEqual({ recorded: "done", replayed: "done" });
    // Nothing was sent again: a replay never repeats a side effect.
    expect(s.sent).toEqual(["ana|a"]);
  });

  it("replays a run that ended while its card was still open", async () => {
    const s = setup([use(call("c1", "send", { to: "ana", body: "a" })), say("x")]);
    expect(await loop(s)).toBe("waiting_approval");
    const report = await replayRun(await s.rig.events(), { bot: s.rig.bot });
    expect(report.identical).toBe(true);
    expect(report.finalStatus.replayed).toBe("waiting_approval");
  });
});

describe("secrets in the log", () => {
  it("scrubs a known value out of events and results, keeping the placeholder", async () => {
    const value = "sk-live-abcdef123456";
    const redactor = createRedactor({ API_TOKEN: value });
    const s = setup([
      use(
        call("c1", "send", {
          to: "https://api.exemplo.com/ana",
          body: "token {{secret:API_TOKEN}}",
        }),
      ),
      say("done"),
    ]);
    const secrets = {
      redactor,
      hostsOf: async (names: readonly string[]) =>
        Object.fromEntries(names.map((n) => [n, ["api.exemplo.com"]])),
      resolve: async (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, value])),
    };
    // Allowed by a rule so that the call runs now: what matters here is where the value ends up.
    const rules: ApprovalRule[] = [
      { id: "r", botId: null, tool: "send", effect: "allow", matchers: [] },
    ];
    const gate = createToolGate({
      tools: s.rig.registry,
      rules: { rulesFor: async () => rules },
      now: () => new Date(s.rig.clock.now),
    });
    expect(await runLoop(s.rig.deps({ gate, secrets }), s.rig.runId)).toBe("done");
    // The tool received the real value...
    expect(s.sent).toEqual([`https://api.exemplo.com/ana|token ${value}`]);
    // ...and no event or request holds it.
    expect(JSON.stringify(await s.rig.events())).not.toContain(value);
    expect(JSON.stringify(s.rig.provider.requests)).not.toContain(value);
    expect(JSON.stringify(await s.rig.events())).toContain("{{secret:API_TOKEN}}");
  });

  it("the card of a call that uses a secret shows the placeholder, and the call asks", async () => {
    const s = setup([
      use(
        call("c1", "send", {
          to: "https://api.exemplo.com/ana",
          body: "token {{secret:API_TOKEN}}",
        }),
      ),
      say("done"),
    ]);
    expect(await loop(s)).toBe("waiting_approval");
    const [card] = requested(await s.rig.events());
    expect(card?.payload.secrets).toEqual(["API_TOKEN"]);
    // The card says where the secret would go: the server reads it from the declared destination.
    expect(card?.payload.secretHost).toBe("api.exemplo.com");
    expect(JSON.stringify(card?.payload.args)).toContain("{{secret:API_TOKEN}}");
  });
});

describe("request_secret", () => {
  const secrets = {
    redactor: createRedactor(),
    resolve: async () => ({}),
    hostsOf: async () => ({}),
  };

  it("is offered only to a run that has a vault", async () => {
    const without = setup([say("hi")]);
    await loop(without);
    expect(without.rig.provider.requests[0]?.tools.map((t) => t.name)).not.toContain(
      "request_secret",
    );
    const withVault = setup([say("hi")]);
    await loop(withVault, { secrets });
    expect(withVault.rig.provider.requests[0]?.tools.map((t) => t.name)).toContain(
      "request_secret",
    );
  });

  it("pauses like a question; the answer the model gets holds no value", async () => {
    const s = setup([
      use(
        call("c1", "request_secret", {
          name: "GITHUB_TOKEN",
          reason: "to push the branch",
          hosts: ["API.github.com"],
        }),
      ),
      say("Got it."),
    ]);
    expect(await loop(s, { secrets })).toBe("waiting_user");
    const events = await s.rig.events();
    expect(eventsOfType(events, "secret_requested")[0]?.payload).toEqual({
      callId: "c1",
      name: "GITHUB_TOKEN",
      reason: "to push the branch",
      hosts: ["api.github.com"],
    });
    s.rig.store.postInbox(s.rig.runId, {
      kind: "user_message",
      text: "The secret GITHUB_TOKEN is now available. Use it as {{secret:GITHUB_TOKEN}}.",
    });
    claim(s);
    expect(await loop(s, { secrets })).toBe("done");
    const [result] = eventsOfType(await s.rig.events(), "tool_result");
    expect(result?.payload).toMatchObject({ callId: "c1", outcome: "ok", isError: false });
    expect(result?.payload.content).toContain("is now available");
  });

  it("refuses a name that is not a secret name, and a call that is not alone", async () => {
    const bad = setup([
      use(call("c1", "request_secret", { name: "not valid", hosts: ["api.x.test"] })),
      say("ok"),
    ]);
    expect(await loop(bad, { secrets })).toBe("done");
    expect(eventsOfType(await bad.rig.events(), "tool_result")[0]?.payload.outcome).toBe(
      "invalid_args",
    );
    // The hosts the bot suggests are only names: a URL, a port, a wildcard or an IP is refused.
    for (const host of ["https://api.x.test", "api.x.test:8443", "*.x.test", "10.0.0.1"]) {
      const odd = setup([
        use(call("c1", "request_secret", { name: "TOKEN_X", hosts: [host] })),
        say("ok"),
      ]);
      expect(await loop(odd, { secrets })).toBe("done");
      expect(eventsOfType(await odd.rig.events(), "tool_result")[0]?.payload.outcome).toBe(
        "invalid_args",
      );
    }
    const none = setup([use(call("c1", "request_secret", { name: "TOKEN_X" })), say("ok")]);
    expect(await loop(none, { secrets })).toBe("done");
    expect(eventsOfType(await none.rig.events(), "tool_result")[0]?.payload.outcome).toBe(
      "invalid_args",
    );
    const crowd = setup([
      use(
        call("c1", "request_secret", { name: "TOKEN_X", hosts: ["api.x.test"] }),
        call("c2", "echo", { text: "x" }),
      ),
      say("ok"),
    ]);
    expect(await loop(crowd, { secrets })).toBe("done");
    expect(eventsOfType(await crowd.rig.events(), "tool_result")[0]?.payload.content).toContain(
      "only tool call",
    );
  });
});

describe("approval gate after a return", () => {
  it("a call that asks still asks when the run comes back by itself", async () => {
    const s = setup([
      use(call("r1", "schedule_return", { inMinutes: 5, note: "send the report" })),
      say("Volto em 5 minutos para enviar o relatório."),
      use(call("c1", "send", { to: "ana", body: "relatório" })),
      say("ok"),
    ]);
    const extra = { allowReturns: true } as const;
    expect(await loop(s, extra)).toBe("waiting_timer");
    s.rig.clock.advance(6 * 60_000);
    expect(s.rig.store.wakeDue(new Date(s.rig.clock.now))).toEqual([s.rig.runId]);
    claim(s);
    const events0 = await s.rig.events();
    const second = new FakeProvider(
      s.script.slice(events0.filter((e) => e.type === "model_response").length),
    );
    expect(await loop(s, { ...extra, provider: second })).toBe("waiting_approval");
    const [card] = requested(await s.rig.events());
    expect(card?.payload).toMatchObject({ tool: "send", callId: "c1" });
    expect(s.sent).toEqual([]);
  });
});
