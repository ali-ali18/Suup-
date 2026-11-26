// The grant an approved card leaves for the rest of the run (docs/APROVACOES.md, "Autorização da
// sessão"): the same action, by the tool's own key, needs no new card when the reviewer again says
// it can be undone. Decided by the log and by declared fields, never by reading text.
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
import {
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  type Rig,
  say,
  testTools,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { runLoop } from "./loop.js";
import type { RunStatus, StoredEvent } from "./store.js";

interface Setup {
  rig: Rig;
  ran: string[];
  gate: ToolGate;
  written: WrittenRule[];
}

/** The reviewer answers by the arguments' declared fields: `risky` is irreversible, `unsure` has no answer. */
function setup(script: Parameters<typeof createRig>[0]["script"], mode?: "ask_all"): Setup {
  const ran: string[] = [];
  const written: WrittenRule[] = [];
  const rig = createRig({
    script,
    tools: [
      ...testTools(),
      defineTool({
        name: "act",
        description: "Does something outside.",
        input: z.object({ name: z.string(), risky: z.boolean().optional() }),
        risk: "external_irreversible",
        grantKey: ({ name }) => name,
        describe: ({ name }) => `Act ${name}`,
        execute: async ({ name }) => {
          ran.push(name);
          return { content: `did ${name}` };
        },
      }),
      defineTool({
        name: "page",
        description: "Reads a page.",
        input: z.object({ url: z.string() }),
        risk: "external_irreversible",
        // Like web_read: a page has no grantKey, so an approval never covers another address.
        judged: () => "unseen_web_page",
        execute: async ({ url }) => {
          ran.push(`page:${url}`);
          return { content: "page" };
        },
      }),
      defineTool({
        name: "mail",
        description: "Sends a message.",
        input: z.object({ name: z.string() }),
        risk: "external_irreversible",
        outbound: { kind: "message", recipientFields: ["name"] },
        grantKey: ({ name }) => name,
        execute: async ({ name }) => {
          ran.push(`mail:${name}`);
          return { content: "sent" };
        },
      }),
    ],
    bot: { allowedTools: ["echo", "act", "mail", "page"] },
  });
  const reply = (req: { messages: { blocks: { type: string; text?: string }[] }[] }) => {
    const text = req.messages[0]?.blocks[0]?.text ?? "";
    const risky = text.includes('"risky": true');
    return {
      blocks: [
        {
          type: "tool_call" as const,
          id: "r",
          name: REVIEW_TOOL_NAME,
          args: { decision: "ask", ruleId: null, reason: "Pergunta.", reversible: !risky },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 10 },
    };
  };
  const gate = createToolGate({
    tools: rig.registry,
    rules: { rulesFor: async () => [] },
    written: { writtenRulesFor: async () => written },
    ...(mode === "ask_all" ? { mode: { approvalMode: async () => "ask_all" as const } } : {}),
    modelReviewer: createModelReviewer({
      provider: new FakeProvider(
        Array.from({ length: 30 }, () => reply as never),
        { id: "rev" },
      ),
      model: { id: "reviewer-model", maxOutputTokens: 400 },
    }),
    now: () => new Date(rig.clock.now),
  });
  return { rig, ran, gate, written };
}

const loop = (s: Setup): Promise<RunStatus> => runLoop(s.rig.deps({ gate: s.gate }), s.rig.runId);
const cards = (events: readonly StoredEvent[]) => eventsOfType(events, "approval_requested");

async function approveOpen(s: Setup): Promise<void> {
  const events = await s.rig.events();
  const open = cards(events).filter(
    (c) =>
      !eventsOfType(events, "approval_decided").some((d) => d.payload.callId === c.payload.callId),
  );
  const card = open.at(-1);
  if (card === undefined) throw new Error("no open card");
  s.rig.store.decideApproval(s.rig.runId, card.payload.approvalId, { decision: "approved" });
  expect(s.rig.store.claimNext("worker-1")?.id).toBe(s.rig.runId);
}

describe("the grant of an approved card", () => {
  it("the same action runs without a new card; another action asks", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a" })),
      use(call("c2", "act", { name: "a" })),
      use(call("c3", "act", { name: "b" })),
      say("fim"),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1", "c3"]);
    expect(s.ran).toEqual(["a", "a"]);
    expect(eventsOfType(events, "approval_session_grant").map((e) => e.payload)).toMatchObject([
      { callId: "c1", tool: "act", key: "a" },
    ]);
    expect(eventsOfType(events, "approval_grant_used").map((e) => e.payload)).toMatchObject([
      { callId: "c2", kind: "session" },
    ]);
  });

  it("approving one page grants nothing: another address on the same host goes to the reviewer and asks", async () => {
    const s = setup([
      use(call("c1", "page", { url: "https://pt.wikipedia.org/wiki/Fotossíntese" })),
      use(call("c2", "page", { url: "https://pt.wikipedia.org/wiki/Clima?q=dado-do-usuario" })),
      say("fim"),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    // the reviewer said ask (reversible true) and no grant exists: c2 is a card of its own
    expect(cards(events).map((c) => c.payload.callId)).toEqual(["c1", "c2"]);
    expect(eventsOfType(events, "approval_session_grant")).toHaveLength(0);
    expect(eventsOfType(events, "approval_grant_used")).toHaveLength(0);
    expect(s.ran).toEqual(["page:https://pt.wikipedia.org/wiki/Fotossíntese"]);
  });

  it("the grant stays for the whole run: a third identical call also runs", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a" })),
      use(call("c2", "act", { name: "a" })),
      use(call("c3", "act", { name: "a" })),
      say("fim"),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("done");
    expect(s.ran).toEqual(["a", "a", "a"]);
  });

  it("a card the reviewer judged irreversible leaves no grant", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a", risky: true })),
      use(call("c2", "act", { name: "a", risky: true })),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_session_grant")).toHaveLength(0);
    expect(cards(events)).toHaveLength(2);
    expect(cards(events)[0]?.payload.grantKey).toBeUndefined();
  });

  it("the same key but this call judged irreversible still asks", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a" })),
      use(call("c2", "act", { name: "a", risky: true })),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    expect(cards(await s.rig.events()).map((c) => c.payload.callId)).toEqual(["c1", "c2"]);
  });

  it("a message to another person never leaves a grant", async () => {
    const s = setup([
      use(call("c1", "mail", { name: "ana" })),
      use(call("c2", "mail", { name: "ana" })),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_session_grant")).toHaveLength(0);
    expect(cards(events)).toHaveLength(2);
  });

  it("an approval written in the chat is the same decision, logged with its message and review, and leaves the same grant", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a" })),
      use(call("c2", "act", { name: "a" })),
      say("fim"),
    ]);
    await loop(s);
    const [card] = cards(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "approved",
      via: "chat",
      messageId: "m-1",
      chatReview: {
        answer: "yes",
        reason: "Sim claro.",
        model: "judge",
        promptVersion: "chat-approval-v1",
        usage: { inputTokens: 300, outputTokens: 20 },
        costUsd: 0.001,
        latencyMs: 7,
      },
    });
    s.rig.store.claimNext("worker-1");
    expect(await loop(s)).toBe("done");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_decided")[0]?.payload).toMatchObject({
      decision: "approved",
      via: "chat",
      messageId: "m-1",
      chatReview: { answer: "yes", costUsd: 0.001 },
    });
    expect(eventsOfType(events, "approval_session_grant")).toHaveLength(1);
    expect(s.ran).toEqual(["a", "a"]);
    const report = await replayRun(events, { bot: s.rig.bot });
    expect(report.identical).toBe(true);
  });

  it("a denied card leaves no grant", async () => {
    const s = setup([use(call("c1", "act", { name: "a" })), use(call("c2", "act", { name: "a" }))]);
    await loop(s);
    const [card] = cards(await s.rig.events());
    s.rig.store.decideApproval(s.rig.runId, card?.payload.approvalId as string, {
      decision: "denied",
    });
    s.rig.store.claimNext("worker-1");
    expect(await loop(s)).toBe("waiting_approval");
    expect(eventsOfType(await s.rig.events(), "approval_session_grant")).toHaveLength(0);
  });

  it("'ask all' never uses a grant (and issues none: no review happens)", async () => {
    const s = setup(
      [use(call("c1", "act", { name: "a" })), use(call("c2", "act", { name: "a" }))],
      "ask_all",
    );
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("waiting_approval");
    expect(cards(await s.rig.events())).toHaveLength(2);
  });

  it("a replay of the recorded run gives the same events", async () => {
    const s = setup([
      use(call("c1", "act", { name: "a" })),
      use(call("c2", "act", { name: "a" })),
      say("fim"),
    ]);
    await loop(s);
    await approveOpen(s);
    expect(await loop(s)).toBe("done");
    const events = await s.rig.events();
    expect(eventsOfType(events, "approval_session_grant")).toHaveLength(1);
    const report = await replayRun(events, { bot: s.rig.bot });
    expect(report.firstDivergence).toBeUndefined();
    expect(report.identical).toBe(true);
    expect(s.ran).toEqual(["a", "a"]);
  });
});
