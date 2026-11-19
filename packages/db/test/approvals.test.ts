import { describe, expect, it } from "vitest";
import {
  ApprovalError,
  appendMessage,
  appendRunEvent,
  cancelRun,
  changeLogBounds,
  createBot,
  createDirectConversation,
  createRule,
  createRun,
  decideApproval,
  deleteRule,
  expireOverdueApprovals,
  getApproval,
  getRule,
  getRun,
  hasUndeliveredDecision,
  listApprovals,
  listChanges,
  listRules,
  listRunEvents,
  peekApprovalDecisionRows,
  peekInboxEntries,
  rulesForBot,
  setRunStatus,
  updateRule,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { botFor, makeRun } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("approvals and rules"), () => {
  const ctx = useIsolatedDb();

  const request = (callId: string, over: Record<string, unknown> = {}) => ({
    approvalId: crypto.randomUUID(),
    callId,
    tool: "send",
    args: { to: "ana", body: "hello {{secret:TOKEN}}" },
    level: "external_irreversible",
    summary: "Send a message to ana",
    secrets: ["TOKEN"],
    source: "default",
    ...over,
  });

  /** An outbound message: the tool DECLARED it (`outbound`), as the loop records it. */
  const message = (callId: string, over: Record<string, unknown> = {}) =>
    request(callId, {
      tool: "conn_mail__send_email",
      args: { to: "ana@x.com", subject: "Oi", body: "Tudo bem?" },
      secrets: [],
      outbound: { kind: "message", recipientFields: ["to"] },
      ...over,
    });

  /** A run that asked for approval and paused: `running` with the card, then `waiting_approval`. */
  async function waiting(
    callId = "c1",
    over: Record<string, unknown> = {},
    make: typeof request = request,
  ) {
    const run = await makeRun(ctx.db, { status: "running", leasedTo: "w1" });
    const payload = make(callId, over);
    await appendRunEvent(ctx.db, run.id, "approval_requested", payload, { leaseHolder: "w1" });
    await setRunStatus(ctx.db, run.id, { from: "running", to: "waiting_approval" });
    return { run, approvalId: payload.approvalId as string };
  }

  describe("the card is a projection of the event", () => {
    it("is created with the event, with the exact content and no value", async () => {
      const { run, approvalId } = await waiting();
      const card = await getApproval(ctx.db, approvalId);
      expect(card).toMatchObject({
        id: approvalId,
        runId: run.id,
        botId: run.botId,
        callId: "c1",
        tool: "send",
        args: { to: "ana", body: "hello {{secret:TOKEN}}" },
        level: "external_irreversible",
        summary: "Send a message to ana",
        secrets: ["TOKEN"],
        source: "default",
        outbound: null,
        status: "pending",
        reason: null,
        ruleId: null,
        expiresAt: null,
        decidedAt: null,
        conversationId: null,
      });
    });

    it("keeps the tool's declaration that the call is a message to another person", async () => {
      const { approvalId } = await waiting("c1", {}, message);
      expect((await getApproval(ctx.db, approvalId))?.outbound).toEqual({
        kind: "message",
        recipientFields: ["to"],
      });
    });

    it("is created once even if the same event is written again", async () => {
      const { run } = await waiting("c1");
      const again = request("c1");
      await appendRunEvent(ctx.db, run.id, "approval_requested", again);
      expect(await listApprovals(ctx.db, { runId: run.id, limit: 10 })).toHaveLength(1);
    });

    it("refuses a second pending card for the same run: calls are asked one at a time", async () => {
      const { run } = await waiting("c1");
      await expect(
        appendRunEvent(ctx.db, run.id, "approval_requested", request("c2")),
      ).rejects.toThrow(/approvals_one_pending_per_run_idx/);
      // The event was rolled back with the card: the log never claims what the table refused.
      const events = await listRunEvents(ctx.db, run.id, { types: ["approval_requested"] });
      expect(events).toHaveLength(1);
    });

    it("rejects a level or source the loop does not know", async () => {
      const run = await makeRun(ctx.db, { status: "running", leasedTo: "w1" });
      await expect(
        appendRunEvent(ctx.db, run.id, "approval_requested", request("c1", { level: "nuclear" })),
      ).rejects.toThrow();
    });
  });

  describe("listing", () => {
    it("filters by status, bot, conversation and run, newest first", async () => {
      const bot = await createBot(ctx.db, { name: "lister", modelProvider: "p", modelId: "m" });
      const conversation = await createDirectConversation(ctx.db, bot.id);
      const inChat = await createRun(ctx.db, {
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        objective: "o",
      });
      await ctx.db
        .sql`update runs set status = 'running', locked_by = 'w1' where id = ${inChat.id}`;
      const first = request("c1");
      await appendRunEvent(ctx.db, inChat.id, "approval_requested", first);
      const standalone = await waiting("c9");

      const mine = await listApprovals(ctx.db, { botId: bot.id, limit: 10 });
      expect(mine.map((a) => a.id)).toEqual([first.approvalId]);
      expect(mine[0]?.conversationId).toBe(conversation.id);
      expect(
        (await listApprovals(ctx.db, { conversationId: conversation.id, limit: 10 })).map(
          (a) => a.id,
        ),
      ).toEqual([first.approvalId]);
      expect((await listApprovals(ctx.db, { runId: standalone.run.id, limit: 10 })).length).toBe(1);
      const pending = await listApprovals(ctx.db, { status: "pending", limit: 500 });
      expect(pending.map((a) => a.id)).toEqual(
        expect.arrayContaining([first.approvalId, standalone.approvalId]),
      );
      expect(await listApprovals(ctx.db, { status: "approved", botId: bot.id, limit: 10 })).toEqual(
        [],
      );
    });
  });

  describe("deciding", () => {
    it("approves: the card is decided and the run that waited is claimable again", async () => {
      const { run, approvalId } = await waiting();
      const { approval, ruleId } = await decideApproval(ctx.db, approvalId, {
        decision: "approved",
      });
      expect(approval).toMatchObject({ status: "approved", reason: null });
      expect(approval.decidedAt).toBeInstanceOf(Date);
      expect(ruleId).toBeNull();
      const after = await getRun(ctx.db, run.id);
      expect(after).toMatchObject({ status: "queued", lockedBy: null });
    });

    it("denies with a reason", async () => {
      const { approvalId } = await waiting();
      const { approval } = await decideApproval(ctx.db, approvalId, {
        decision: "denied",
        reason: "not now",
      });
      expect(approval).toMatchObject({ status: "denied", reason: "not now" });
    });

    it("is decided once: a second answer is a conflict, and so is an unknown card", async () => {
      const { approvalId } = await waiting();
      await decideApproval(ctx.db, approvalId, { decision: "approved" });
      await expect(
        decideApproval(ctx.db, approvalId, { decision: "denied" }),
      ).rejects.toMatchObject({
        name: "ApprovalError",
        code: "conflict",
      });
      await expect(
        decideApproval(ctx.db, crypto.randomUUID(), { decision: "approved" }),
      ).rejects.toBeInstanceOf(ApprovalError);
      await expect(
        decideApproval(ctx.db, crypto.randomUUID(), { decision: "approved" }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("answers at the same time from two places: exactly one wins", async () => {
      const { approvalId } = await waiting();
      const results = await Promise.allSettled([
        decideApproval(ctx.db, approvalId, { decision: "approved" }),
        decideApproval(ctx.db, approvalId, { decision: "denied", reason: "x" }),
        decideApproval(ctx.db, approvalId, { decision: "approved" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await getApproval(ctx.db, approvalId))?.status).not.toBe("pending");
    });

    it("a run that has not paused yet is left alone: it reads the decision at its safe point", async () => {
      const run = await makeRun(ctx.db, { status: "running", leasedTo: "w1" });
      const payload = request("c1");
      await appendRunEvent(ctx.db, run.id, "approval_requested", payload);
      await decideApproval(ctx.db, payload.approvalId, { decision: "approved" });
      expect(await getRun(ctx.db, run.id)).toMatchObject({ status: "running", lockedBy: "w1" });
    });

    it("'allow this recipient' creates a rule: exactly the recipient, for this bot, other fields free", async () => {
      const { run, approvalId } = await waiting("c1", {}, message);
      const { ruleId } = await decideApproval(ctx.db, approvalId, {
        decision: "approved",
        allowRecipient: true,
      });
      const rule = await getRule(ctx.db, ruleId as string);
      expect(rule).toMatchObject({
        botId: run.botId,
        tool: "conn_mail__send_email",
        effect: "allow",
        createdBy: "approval",
        sourceApprovalId: approvalId,
        enabled: true,
        matchers: [{ field: "to", value: "ana@x.com" }],
      });
      expect((await getApproval(ctx.db, approvalId))?.ruleId).toBe(ruleId);
    });

    it("a call that is not a declared message cannot create a rule from its card", async () => {
      const { approvalId } = await waiting();
      const before = (await listRules(ctx.db)).length;
      await expect(
        decideApproval(ctx.db, approvalId, { decision: "approved", allowRecipient: true }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await getApproval(ctx.db, approvalId))?.status).toBe("pending");
      expect((await listRules(ctx.db)).length).toBe(before);
    });

    it("a message whose recipient is not one text value cannot be allowed by recipient", async () => {
      const list = await waiting(
        "c1",
        { args: { to: ["a@x.com", "b@x.com"], body: "x" } },
        message,
      );
      await expect(
        decideApproval(ctx.db, list.approvalId, { decision: "approved", allowRecipient: true }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await getApproval(ctx.db, list.approvalId))?.status).toBe("pending");
      // approving only this send still works
      await decideApproval(ctx.db, list.approvalId, { decision: "approved" });
    });

    it("only an approval can allow a recipient, and a failed decision creates no rule", async () => {
      const { approvalId } = await waiting("c1", {}, message);
      const before = (await listRules(ctx.db)).length;
      await expect(
        decideApproval(ctx.db, approvalId, { decision: "denied", allowRecipient: true }),
      ).rejects.toMatchObject({ code: "conflict" });
      await decideApproval(ctx.db, approvalId, { decision: "denied" });
      await expect(
        decideApproval(ctx.db, approvalId, { decision: "approved", allowRecipient: true }),
      ).rejects.toBeInstanceOf(ApprovalError);
      expect((await listRules(ctx.db)).length).toBe(before);
    });
  });

  describe("cancelling and expiring", () => {
    it("cancelling a run that waits cancels its card and logs it", async () => {
      const { run, approvalId } = await waiting();
      const done = await cancelRun(ctx.db, run.id);
      expect(done.status).toBe("cancelled");
      expect(await getApproval(ctx.db, approvalId)).toMatchObject({ status: "cancelled" });
      const events = await listRunEvents(ctx.db, run.id, { limit: 100 });
      expect(events.map((e) => e.type)).toEqual([
        "approval_requested",
        "approval_decided",
        "status_changed",
      ]);
      expect(events[1]?.payload).toMatchObject({ approvalId, callId: "c1", decision: "cancelled" });
      await expect(
        decideApproval(ctx.db, approvalId, { decision: "approved" }),
      ).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("cancelling a run that is still running (the card exists, the run is not parked yet) ends the card as a decision the loop has not recorded, and the run is not left waiting", async () => {
      const run = await makeRun(ctx.db, { status: "running", leasedTo: "w1" });
      const asked = request("c1");
      await appendRunEvent(ctx.db, run.id, "approval_requested", asked, { leaseHolder: "w1" });
      const answer = await cancelRun(ctx.db, run.id);
      expect(answer.status).toBe("running");
      expect(await getApproval(ctx.db, asked.approvalId)).toMatchObject({ status: "cancelled" });
      // The worker still holds the run: it must find the decision (so it records it and does not
      // park the run for a card nobody can answer), and the stop in its inbox.
      expect(await peekApprovalDecisionRows(ctx.db, run.id)).toEqual([
        { approvalId: asked.approvalId, callId: "c1", decision: "cancelled" },
      ]);
      expect(await peekInboxEntries(ctx.db, run.id)).toMatchObject([{ kind: "stop" }]);
      // And if the loop parks the run right then, the undelivered decision requeues it.
      expect(await hasUndeliveredDecision(ctx.db, run.id)).toBe(true);
    });

    it("nothing expires on its own: only a card with a limit does, and then it wakes the run", async () => {
      const kept = await waiting("c1");
      const limited = await waiting("c1", { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const future = await waiting("c1", {
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(await expireOverdueApprovals(ctx.db)).toBe(1);
      expect((await getApproval(ctx.db, kept.approvalId))?.status).toBe("pending");
      expect((await getApproval(ctx.db, future.approvalId))?.status).toBe("pending");
      expect((await getApproval(ctx.db, limited.approvalId))?.status).toBe("expired");
      expect((await getRun(ctx.db, limited.run.id))?.status).toBe("queued");
      expect(await expireOverdueApprovals(ctx.db)).toBe(0);
    });

    it("refuses to approve a card that expired but was not swept yet, and says so", async () => {
      const late = await waiting("c1", { expiresAt: new Date(Date.now() - 1000).toISOString() });
      await expect(
        decideApproval(ctx.db, late.approvalId, { decision: "approved" }),
      ).rejects.toThrow(/expirou/);
      expect((await getApproval(ctx.db, late.approvalId))?.status).toBe("expired");
    });
  });

  describe("the change log", () => {
    it("records the card as ids only, when it appears and when it is decided", async () => {
      const before = (await changeLogBounds(ctx.db)).newest;
      const { approvalId } = await waiting();
      await decideApproval(ctx.db, approvalId, { decision: "approved" });
      const changes = (await listChanges(ctx.db, before)).filter((c) => c.kind === "approval");
      expect(changes.map((c) => [c.ref, c.op])).toEqual([
        [approvalId, "created"],
        [approvalId, "updated"],
      ]);
      expect(JSON.stringify(changes)).not.toContain("hello");
    });
  });

  describe("rules", () => {
    it("creates, lists in creation order, updates and deletes", async () => {
      const bot = await botFor(ctx.db);
      const a = await createRule(ctx.db, {
        tool: "shell",
        effect: "allow",
        botId: bot.id,
        matchers: [{ field: "command", value: "git status" }],
        note: "git is fine",
      });
      const b = await createRule(ctx.db, { tool: "*", effect: "deny" });
      expect(a).toMatchObject({ botId: bot.id, createdBy: "user", note: "git is fine" });
      expect(b).toMatchObject({ botId: null, matchers: [] });
      const all = await listRules(ctx.db);
      expect(all.map((r) => r.id).filter((id) => [a.id, b.id].includes(id))).toEqual([a.id, b.id]);
      const updated = await updateRule(ctx.db, a.id, { effect: "deny", note: null });
      expect(updated).toMatchObject({ effect: "deny", note: null });
      expect(updated?.matchers).toEqual(a.matchers);
      expect(await updateRule(ctx.db, crypto.randomUUID(), { effect: "allow" })).toBeNull();
      expect(await deleteRule(ctx.db, a.id)).toBe(true);
      expect(await deleteRule(ctx.db, a.id)).toBe(false);
    });

    it("gives a bot its own rules and the global ones, in the shape the policy uses", async () => {
      const mine = await createBot(ctx.db, { name: "mine", modelProvider: "p", modelId: "m" });
      const other = await createBot(ctx.db, { name: "other", modelProvider: "p", modelId: "m" });
      const own = await createRule(ctx.db, { tool: "t1", effect: "allow", botId: mine.id });
      const theirs = await createRule(ctx.db, { tool: "t2", effect: "allow", botId: other.id });
      const global = await createRule(ctx.db, { tool: "t3", effect: "deny", note: "n" });
      const rules = await rulesForBot(ctx.db, mine.id);
      const ids = rules.map((r) => r.id);
      expect(ids).toContain(own.id);
      expect(ids).toContain(global.id);
      expect(ids).not.toContain(theirs.id);
      expect(rules.find((r) => r.id === global.id)).toEqual({
        id: global.id,
        botId: null,
        tool: "t3",
        effect: "deny",
        matchers: [],
        note: "n",
      });
    });

    it("rejects what the policy could not read", async () => {
      await expect(createRule(ctx.db, { tool: "", effect: "allow" })).rejects.toThrow();
      await expect(
        createRule(ctx.db, {
          tool: "t",
          effect: "allow",
          matchers: [{ field: "", value: "x" }],
        }),
      ).rejects.toThrow();
      // a comparison other than equality does not exist: it is refused, never read as equality
      for (const op of ["starts_with", "contains", "glob", "equals"]) {
        await expect(
          createRule(ctx.db, {
            tool: "t",
            effect: "allow",
            matchers: [{ field: "a", op, value: "x" } as never],
          }),
        ).rejects.toThrow();
      }
      await expect(createRule(ctx.db, { tool: "t", effect: "maybe" as never })).rejects.toThrow();
    });
  });

  it("the runs of a conversation list their cards through the conversation", async () => {
    const bot = await createBot(ctx.db, { name: "talker", modelProvider: "p", modelId: "m" });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "user",
      text: "oi",
    });
    expect(await listApprovals(ctx.db, { conversationId: conversation.id, limit: 5 })).toEqual([]);
  });
});
