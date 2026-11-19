import type { WrittenRule } from "@suup/api";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// Auto-review through the API: the mode, the rules the user writes, and a worker whose model
// reviewer (scripted) runs, asks or blocks a call. Only the harness's own checks are exercised:
// what the reviewer MEANS is the model's, and is measured by the planted battery in `evals/`.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const shell = (command: string) => ({ name: "shell", args: { command } });
const verdict = (decision: string, ruleId: string | null, reason: string) =>
  s({ calls: [{ name: "review_call", args: { decision, ruleId, reason } }] });

const NEVER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-RUN",
        agent: [s({ calls: [shell("echo rodou-1")] }), s({ text: "Feito." })],
        autoReview: [verdict("run", null, "Está dentro do que você pediu.")],
      },
      {
        whenObjectiveContains: "CASE-BLOCK",
        agent: [s({ calls: [shell("echo nao-rode")] }), s({ text: "Entendi, não vou." })],
        autoReview: [verdict("block", NEVER_ID, "A regra proíbe isto.")],
      },
      {
        whenObjectiveContains: "CASE-ASK",
        agent: [s({ calls: [shell("echo talvez")] }), s({ text: "Pronto." })],
        autoReview: [verdict("ask", null, "Não está claro se você quer isto.")],
      },
      {
        whenObjectiveContains: "CASE-ALL",
        agent: [s({ calls: [shell("echo tudo")] }), s({ text: "Pronto." })],
        autoReview: [verdict("run", null, "Não devia ser usado.")],
      },
      {
        whenObjectiveContains: "CASE-BADRULE",
        agent: [s({ calls: [shell("echo inventada")] }), s({ text: "Pronto." })],
        autoReview: [verdict("block", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Regra inventada.")],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("auto-review through the API"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({
      scripts: SCRIPTS,
      config: {
        approvals: {
          levels: { shell: "write_reversible" },
          autoReview: { model: "model-x" },
        },
      },
    });
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "no error",
        (error: { code?: string }) => error.code ?? String(error),
      );
    const setup = async (name: string) => {
      const { api } = w.started;
      const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
      const conversation = await api.bots.openConversation(bot.id);
      return { api, bot, conversation };
    };
    const eventsOf = async (runId: string) =>
      (await w.started.api.runs.events(runId, { limit: 1000 })).items;
    const finished = (runId: string) =>
      until(async () => {
        const run = await w.started.api.runs.get(runId);
        return run.status === "done" || run.status === "failed" ? run : undefined;
      }, "the run to end");

    it("starts in Auto-review, says the reviewer is available, and keeps the mode on the server", async () => {
      const { api } = w.started;
      expect(await api.approvalSettings.get()).toEqual({
        mode: "auto_review",
        reviewer: { available: true, model: "model-x", reason: null },
      });
      expect((await api.approvalSettings.update({ mode: "ask_all" })).mode).toBe("ask_all");
      expect((await api.approvalSettings.get()).mode).toBe("ask_all");
      expect(await code(api.approvalSettings.update({ mode: "tudo" as never }))).toBe(
        "invalid_request",
      );
      expect((await api.approvalSettings.update({ mode: "auto_review" })).mode).toBe("auto_review");
    });

    it("writes, lists, edits and deletes rules; text is trimmed and bounded; nothing else is accepted", async () => {
      const { api, bot } = await setup("Escritor");
      const all = await api.writtenRules.create({
        kind: "allow",
        text: "  E-mails para minha equipe em acme.com \n",
      });
      expect(all).toMatchObject({
        kind: "allow",
        text: "E-mails para minha equipe em acme.com",
        botId: null,
        enabled: true,
      });
      const mine = await api.writtenRules.create({
        kind: "never",
        text: "Apagar a pasta notas",
        botId: bot.id,
      });
      const other = await api.bots.create({ name: "Outro", modelId: "model-x" });
      const forOther = await api.writtenRules.list({ botId: other.id });
      expect(forOther.map((r: WrittenRule) => r.id)).toContain(all.id);
      expect(forOther.map((r: WrittenRule) => r.id)).not.toContain(mine.id);
      expect((await api.writtenRules.list({ botId: bot.id })).map((r) => r.id)).toEqual(
        expect.arrayContaining([all.id, mine.id]),
      );

      const edited = await api.writtenRules.update(mine.id, {
        kind: "ask",
        text: "Apagar qualquer arquivo",
        enabled: false,
      });
      expect(edited).toMatchObject({
        kind: "ask",
        text: "Apagar qualquer arquivo",
        enabled: false,
      });

      expect(await code(api.writtenRules.create({ kind: "allow", text: "   " }))).toBe(
        "invalid_request",
      );
      expect(await code(api.writtenRules.create({ kind: "allow", text: "x".repeat(501) }))).toBe(
        "invalid_request",
      );
      expect(await code(api.writtenRules.create({ kind: "talvez" as never, text: "a" }))).toBe(
        "invalid_request",
      );
      expect(
        await code(
          api.writtenRules.create({
            kind: "allow",
            text: "a",
            tool: "shell",
          } as never),
        ),
      ).toBe("invalid_request");
      expect(
        await code(
          api.writtenRules.create({
            kind: "allow",
            text: "a",
            botId: "11111111-1111-4111-8111-111111111111",
          }),
        ),
      ).toBe("invalid_request");
      expect(await code(api.writtenRules.update("11111111-1111-4111-8111-111111111111", {}))).toBe(
        "not_found",
      );

      await api.writtenRules.remove(mine.id);
      await api.writtenRules.remove(all.id);
      expect(await code(api.writtenRules.remove(all.id))).toBe("not_found");
    });

    it("a call the reviewer lets run runs, and the review is in the log with its cost", async () => {
      const { api, conversation } = await setup("Corredor");
      const sent = await api.conversations.send(conversation.id, "CASE-RUN");
      const run = await finished(sent.run.id);
      expect(run.status).toBe("done");
      const events = await eventsOf(run.id);
      const review = events.find((e) => e.type === "approval_review")?.payload;
      expect(review).toMatchObject({
        decision: "run",
        outcome: "allow",
        model: "model-x",
        promptVersion: "auto-review-v1",
        usage,
      });
      expect(events.find((e) => e.type === "tool_result")?.payload).toMatchObject({
        content: expect.stringContaining("rodou-1"),
      });
      expect((await api.approvals.list({ runId: run.id })).length).toBe(0);
      // the review is part of the run's bill
      expect(Number(run.costUsd)).toBeGreaterThan(0);
    });

    it("a block that names a never rule refuses the call, tells the bot the rule, opens no card", async () => {
      const { api, bot, conversation } = await setup("Bloqueador");
      await w.db.sql`
        insert into written_rules (id, kind, text, bot_id)
        values (${NEVER_ID}, 'never', 'rodar echo nao-rode', ${bot.id})`;
      const sent = await api.conversations.send(conversation.id, "CASE-BLOCK");
      const run = await finished(sent.run.id);
      expect(run.status).toBe("done");
      const events = await eventsOf(run.id);
      expect(events.find((e) => e.type === "policy_checked")?.payload).toMatchObject({
        outcome: "deny",
        source: "reviewer",
        writtenRuleId: NEVER_ID,
        reason: 'Bloqueado pela regra "rodar echo nao-rode"',
      });
      expect(events.find((e) => e.type === "tool_result")?.payload).toMatchObject({
        isError: true,
        content: expect.stringContaining('Bloqueado pela regra "rodar echo nao-rode"'),
      });
      expect((await api.approvals.list({ runId: run.id })).length).toBe(0);
    });

    it("a block that names no rule that exists is only an ask: a card that says why", async () => {
      const { api, conversation } = await setup("Inventor");
      const sent = await api.conversations.send(conversation.id, "CASE-BADRULE");
      const card = await until(async () => {
        const [c] = await api.approvals.list({ status: "pending", runId: sent.run.id });
        return c;
      }, "the card");
      expect(card).toMatchObject({ source: "reviewer", status: "pending" });
      expect(card.reviewReason).toBe("Regra inventada.");
      expect(card.writtenRuleId).toBeNull();
      await api.approvals.decide(card.id, { decision: "deny" });
      await finished(sent.run.id);
    });

    it("an ask is a card with the reviewer's sentence; approving it runs exactly that call", async () => {
      const { api, conversation } = await setup("Perguntador");
      const sent = await api.conversations.send(conversation.id, "CASE-ASK");
      const card = await until(async () => {
        const [c] = await api.approvals.list({ status: "pending", runId: sent.run.id });
        return c;
      }, "the card");
      expect(card).toMatchObject({
        source: "reviewer",
        reviewReason: "Não está claro se você quer isto.",
        writtenRuleId: null,
        args: { command: "echo talvez" },
      });
      await api.approvals.decide(card.id, { decision: "approve" });
      const run = await finished(sent.run.id);
      expect(run.status).toBe("done");
      const types = (await eventsOf(run.id)).map((e) => e.type);
      expect(types.indexOf("approval_review")).toBeLessThan(types.indexOf("approval_requested"));
    });

    it("Perguntar tudo: every call that is not a read asks, and no model is consulted", async () => {
      const { api, conversation } = await setup("Desconfiado");
      await api.approvalSettings.update({ mode: "ask_all" });
      try {
        const sent = await api.conversations.send(conversation.id, "CASE-ALL");
        const card = await until(async () => {
          const [c] = await api.approvals.list({ status: "pending", runId: sent.run.id });
          return c;
        }, "the card");
        expect(card.source).toBe("default");
        expect(card.reviewReason).toBe('Modo "Perguntar tudo".');
        await api.approvals.decide(card.id, { decision: "deny" });
        await finished(sent.run.id);
        expect((await eventsOf(sent.run.id)).some((e) => e.type === "approval_review")).toBe(false);
      } finally {
        await api.approvalSettings.update({ mode: "auto_review" });
      }
    });
  },
);

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("auto-review without a reviewer model"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS, config: { approvals: { levels: {} } } });

    it("says the truth: the mode exists, the reviewer is not available, and why", async () => {
      expect(await w.started.api.approvalSettings.get()).toEqual({
        mode: "auto_review",
        reviewer: {
          available: false,
          model: null,
          reason: expect.stringContaining("Nenhum modelo de revisão"),
        },
      });
    });
  },
);
