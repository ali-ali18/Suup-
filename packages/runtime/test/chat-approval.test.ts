import { join } from "node:path";
import type { ChatApprovalJudge, ChatApprovalJudgement } from "@suup/core";
import {
  appendRunEvent,
  createBot,
  decideApproval,
  getApproval,
  listRunEvents,
  peekApprovalDecisionRows,
  postInbox,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import { createRuntime, parseConfig, type Runtime, sendMessage } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const verdict = (answer: ChatApprovalJudgement["answer"], over = {}): ChatApprovalJudgement => ({
  answer,
  reason: "Resposta do teste.",
  model: "judge-model",
  promptVersion: "chat-approval-v1",
  usage: { inputTokens: 300, outputTokens: 20 },
  costUsd: 0.0001,
  latencyMs: 5,
  ...over,
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("approval through the chat"), () => {
  const ctx = useIsolatedDb();

  async function setup(answer: ChatApprovalJudgement | "none") {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [] });
    const real = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    const seen: string[] = [];
    const judge: ChatApprovalJudge = {
      judge: async (_card, text) => {
        seen.push(text);
        return answer === "none" ? verdict("unclear") : answer;
      },
    };
    const runtime: Runtime = {
      ...real,
      chatApprovalJudge: () => (answer === "none" ? undefined : judge),
    };
    const bot = await createBot(runtime.db, {
      name: "bot",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["shell"],
    });
    const first = await sendMessage(runtime, { botId: bot.id, text: "faça isso" });
    await runtime.db.sql`
      update runs set status = 'running', locked_by = 'w1', locked_at = now() where id = ${first.run.id}`;
    return { runtime, run: first.run, conversationId: first.message.conversationId, seen };
  }

  async function card(
    runtime: Runtime,
    runId: string,
    callId: string,
    over: Record<string, unknown> = {},
  ) {
    const approvalId = crypto.randomUUID();
    await appendRunEvent(
      runtime.db,
      runId,
      "approval_requested",
      {
        approvalId,
        callId,
        tool: "shell",
        args: { command: "pip install requests" },
        level: "external_irreversible",
        summary: "Shell: pip install requests",
        secrets: [],
        source: "reviewer",
        ...over,
      },
      { leaseHolder: "w1" },
    );
    return approvalId;
  }

  async function park(runtime: Runtime, runId: string) {
    await runtime.db.sql`
      update runs set status = 'waiting_approval', locked_by = null, locked_at = null where id = ${runId}`;
  }

  const say = (s: Awaited<ReturnType<typeof setup>>, text: string) =>
    sendMessage(s.runtime, { conversationId: s.conversationId, text });

  it("a clear yes to the only card approves it like a click, with the message and the review", async () => {
    const s = await setup(verdict("yes"));
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    const sent = await say(s, "pode instalar");
    expect(sent.chatApproval).toEqual({ outcome: "approved", approvalId: id });
    const approval = await getApproval(s.runtime.db, id);
    expect(approval).toMatchObject({
      status: "approved",
      decidedVia: "chat",
      decidedMessageId: sent.message.id,
    });
    const [item] = await peekApprovalDecisionRows(s.runtime.db, s.run.id);
    expect(item).toMatchObject({ via: "chat", messageId: sent.message.id });
    expect(item?.chatReview).toMatchObject({ answer: "yes", model: "judge-model" });
    const [run] = await s.runtime.db.sql<
      { status: string }[]
    >`select status from runs where id = ${s.run.id}`;
    expect(run?.status).toBe("queued");
    expect(s.seen).toEqual(["pode instalar"]);
  });

  it("a click records via click and no chat fields", async () => {
    const s = await setup(verdict("yes"));
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    await decideApproval(s.runtime.db, id, { decision: "approved" });
    expect(await getApproval(s.runtime.db, id)).toMatchObject({
      decidedVia: "click",
      decidedMessageId: null,
    });
    const [item] = await peekApprovalDecisionRows(s.runtime.db, s.run.id);
    expect(item?.via).toBeUndefined();
  });

  it("a message that is not a yes leaves the card and goes on as a message", async () => {
    for (const answer of [
      verdict("no"),
      verdict("unclear"),
      verdict("unclear", { failure: "error" }),
    ]) {
      const s = await setup(answer);
      const id = await card(s.runtime, s.run.id, "c1");
      await park(s.runtime, s.run.id);
      const sent = await say(s, "e se eu usar outro pacote?");
      expect(sent.chatApproval?.outcome).toBe("not_a_yes");
      expect((await getApproval(s.runtime.db, id))?.status).toBe("pending");
      expect(sent.message.status).toBe("sent");
    }
  });

  it("a yes that carries a failure flag is not a yes", async () => {
    const s = await setup(verdict("yes", { failure: "invalid_output" }));
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    expect((await say(s, "sim")).chatApproval?.outcome).toBe("not_a_yes");
    expect((await getApproval(s.runtime.db, id))?.status).toBe("pending");
  });

  it("cards the chat never decides: a secret, a message to another person, the network, a connector", async () => {
    const variants: Record<string, unknown>[] = [
      { secrets: ["TOKEN"] },
      { secrets: ["TOKEN"], secretHost: "api.example.com" },
      { outbound: { kind: "message", recipientFields: ["to"] } },
      { tool: "request_network_access" },
      { tool: "propose_connector" },
    ];
    for (const over of variants) {
      const s = await setup(verdict("yes"));
      const id = await card(s.runtime, s.run.id, "c1", over);
      await park(s.runtime, s.run.id);
      const sent = await say(s, "sim, pode");
      expect(sent.chatApproval?.outcome).toBe("click_only");
      expect((await getApproval(s.runtime.db, id))?.status).toBe("pending");
      expect(s.seen).toEqual([]);
    }
  });

  it("a stop request that is waiting wins: nothing is approved", async () => {
    const s = await setup(verdict("yes"));
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    await postInbox(s.runtime.db, s.run.id, { kind: "stop" });
    expect((await say(s, "sim, pode")).chatApproval?.outcome).toBe("stopping");
    expect((await getApproval(s.runtime.db, id))?.status).toBe("pending");
  });

  it("without a model the chat approves nothing", async () => {
    const s = await setup("none");
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    expect((await say(s, "sim")).chatApproval?.outcome).toBe("unavailable");
    expect((await getApproval(s.runtime.db, id))?.status).toBe("pending");
  });

  it("a click that got there first wins; the late chat yes changes nothing", async () => {
    const s = await setup(verdict("yes"));
    const id = await card(s.runtime, s.run.id, "c1");
    await park(s.runtime, s.run.id);
    // the click lands while the judge reads the message
    const slow: Runtime = {
      ...s.runtime,
      chatApprovalJudge: () => ({
        judge: async () => {
          await decideApproval(s.runtime.db, id, { decision: "denied", reason: "não" });
          return verdict("yes");
        },
      }),
    };
    const sent = await sendMessage(slow, { conversationId: s.conversationId, text: "sim" });
    expect(sent.chatApproval?.outcome).toBe("already_decided");
    expect(await getApproval(s.runtime.db, id)).toMatchObject({
      status: "denied",
      decidedVia: "click",
    });
  });

  it("a run that is not waiting for approval is untouched", async () => {
    const s = await setup(verdict("yes"));
    const sent = await say(s, "sim");
    expect(sent.chatApproval).toBeUndefined();
    expect(await listRunEvents(s.runtime.db, s.run.id, {})).toBeDefined();
  });
});
