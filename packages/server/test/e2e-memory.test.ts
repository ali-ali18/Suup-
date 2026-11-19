import { MEMORY_SETTING_LIMITS } from "@suup/api";
import { MEMORY_SETTING_LIMITS as DB_LIMITS } from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// The memory through the API: the settings the user controls, what the bot saves by itself (nothing waits for the user), the
// history with undo, and a worker that consolidates a conversation in the background. What the
// model MEANS by a memory is measured separately (evals/); here only the harness's own checks run.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const remember = (args: Record<string, unknown>) => ({ name: "remember", args });
const proposal = (over: Record<string, unknown>) => ({
  action: "add",
  layer: "note",
  text: "x",
  summary: "x",
  quote: "x",
  reason: "porque sim",
  ...over,
});

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "BOT-ANOTA",
        agent: [
          s({
            calls: [
              remember({ layer: "rule", text: "Sempre responda com um haicai." }),
              remember({ layer: "profile", text: "O usuário tem um gato chamado Pipoca." }),
              remember({
                layer: "note",
                text: "O gato do usuário gosta de atum.",
                summary: "Gato gosta de atum",
              }),
            ],
          }),
          s({ text: "Anotei: a regra, o fato e a nota já valem." }),
        ],
      },
      { whenObjectiveContains: "SO-RESPONDA", agent: [s({ text: "Certo." })] },
      {
        whenObjectiveContains: "Minha cachorra se chama Mel",
        agent: [s({ text: "Que nome lindo!" })],
        memory: [
          s({
            calls: [
              {
                name: "propose_memories",
                args: {
                  items: [
                    proposal({
                      layer: "profile",
                      text: "O usuário tem uma cachorra chamada Mel.",
                      summary: "Cachorra Mel",
                      quote: "Minha cachorra se chama Mel",
                    }),
                    proposal({
                      layer: "note",
                      text: "O usuário prefere ser chamado de Dona Ana.",
                      summary: "Chamar de Dona Ana",
                      quote: "Dona Ana",
                    }),
                    proposal({ quote: "que nome lindo" }),
                    proposal({ quote: "Que nome lindo!" }),
                  ],
                },
              },
            ],
          }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("memory through the API"), { timeout: 90_000 }, () => {
  const w = useWorld({
    scripts: SCRIPTS,
    config: { memory: { consolidation: { model: "model-x" } } },
    memoryEveryMs: { consolidation: 100 },
  });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "no error",
      (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
    );

  describe("settings", () => {
    it("start at the owner's defaults, with the ranges, the model and the usage warning", async () => {
      const { api } = w.started;
      const settings = await api.memorySettings.get();
      expect(settings).toEqual({
        consolidation: { enabled: true, idleMinutes: 5, maxTurns: 15 },
        promptLimitChars: 6000,
        expiryDays: 90,
        compactionThreshold: 0.8,
        reviewer: { available: true, model: "model-x", reason: null },
        promptUsage: { limitChars: 6000, sharedChars: 0, overLimit: [] },
      });
    });

    it("changes only what is sent, keeps it on the server, and `expiryDays: null` means never", async () => {
      const { api } = w.started;
      const a = await api.memorySettings.update({
        consolidation: { maxTurns: 20 },
        compactionThreshold: 0.9,
      });
      expect(a.consolidation).toEqual({ enabled: true, idleMinutes: 5, maxTurns: 20 });
      expect(a.compactionThreshold).toBe(0.9);
      const b = await api.memorySettings.update({
        expiryDays: null,
        consolidation: { enabled: false },
      });
      expect(b.expiryDays).toBeNull();
      expect(b.consolidation).toEqual({ enabled: false, idleMinutes: 5, maxTurns: 20 });
      // another server process sees it
      const other = await w.startServer();
      expect((await other.api.memorySettings.get()).expiryDays).toBeNull();
      const back = await api.memorySettings.update({
        consolidation: { enabled: true, maxTurns: 15 },
        compactionThreshold: 0.8,
        expiryDays: 90,
        promptLimitChars: 6000,
      });
      expect(back).toMatchObject({ expiryDays: 90, promptLimitChars: 6000 });
    });

    it("refuses what is out of range, the wrong type or unknown, in Portuguese", async () => {
      const { api } = w.started;
      const cases: [unknown, string][] = [
        [
          { consolidation: { idleMinutes: 0 } },
          "consolidation.idleMinutes: deve ser um número inteiro entre 1 e 120",
        ],
        [{ consolidation: { idleMinutes: 121 } }, "consolidation.idleMinutes"],
        [{ consolidation: { maxTurns: 2 } }, "consolidation.maxTurns"],
        [{ consolidation: { maxTurns: 101 } }, "consolidation.maxTurns"],
        [{ consolidation: { maxTurns: 7.5 } }, "entre 3 e 100"],
        [
          { consolidation: { enabled: "sim" } },
          "consolidation.enabled: esperado verdadeiro ou falso",
        ],
        [{ promptLimitChars: 999 }, "promptLimitChars"],
        [{ promptLimitChars: 50_001 }, "promptLimitChars"],
        [{ expiryDays: 6 }, "expiryDays"],
        [{ expiryDays: 3651 }, "expiryDays"],
        [{ expiryDays: "nunca" }, "expiryDays: esperado número"],
        [{ expiryDays: 6 }, "null para nunca expirar"],
        [{ compactionThreshold: 0.49 }, "compactionThreshold: deve ser um número entre 0.5 e 0.95"],
        [{ compactionThreshold: 0.96 }, "compactionThreshold"],
        [{ compactionThreshold: "alto" }, "compactionThreshold"],
        [{ surpresa: 1 }, "surpresa"],
        [{ consolidation: { surpresa: 1 } }, "surpresa"],
      ];
      for (const [body, mention] of cases) {
        const result = await code(api.memorySettings.update(body as never));
        expect(result, JSON.stringify(body)).toContain("invalid_request");
        expect(result, JSON.stringify(body)).toContain(mention);
      }
      // nothing changed
      expect((await api.memorySettings.get()).consolidation).toEqual({
        enabled: true,
        idleMinutes: 5,
        maxTurns: 15,
      });
    });

    it("the ranges of the API are the ranges of the database", () => {
      expect(MEMORY_SETTING_LIMITS).toEqual(DB_LIMITS);
    });
  });

  describe("what the bot saves by itself", () => {
    it("a rule, a fact and a note the bot saves are active at once and in the next prompt; the history shows who did what and the undo works", async () => {
      const { api } = w.started;
      const bot = await api.bots.create({
        name: "Anotadora",
        modelId: "model-x",
        allowedTools: ["remember", "recall"],
      });
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      const sent = await api.conversations.send(conversation.id, "BOT-ANOTA por favor");
      await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the answer",
      );

      // The stream never said that something waits: nothing is pending.
      expect(
        f.events.filter((e) => e.type === "memory.changed" && e.data.change === "pending"),
      ).toEqual([]);
      f.close();
      expect((await api.memories.pending()).filter((m) => m.sourceRunId === sent.run.id)).toEqual(
        [],
      );

      const active = await api.memories.list({ botId: bot.id });
      const shared = await api.memories.list();
      const mine = [...active, ...shared].filter(
        (m) => m.createdBy === "bot" && m.sourceRunId === sent.run.id,
      );
      const byLayer = (layer: string) => mine.find((m) => m.layer === layer);
      expect(byLayer("rule")).toMatchObject({
        status: "active",
        text: "Sempre responda com um haicai.",
      });
      expect(byLayer("profile")).toMatchObject({
        status: "active",
        text: "O usuário tem um gato chamado Pipoca.",
      });
      expect(byLayer("note")).toMatchObject({
        status: "active",
        summary: "Gato gosta de atum",
      });
      expect(byLayer("rule")?.sourceConversationId).toBe(conversation.id);

      // It is in the next run's prompt, with no confirmation.
      const other = await api.bots.create({ name: "Leitora", modelId: "model-x" });
      const c = await api.bots.openConversation(other.id);
      const run = await api.conversations.send(c.id, "SO-RESPONDA um");
      await until(
        async () => ((await api.runs.get(run.run.id)).status === "done" ? true : undefined),
        "the run",
      );
      const [request] = (await api.runs.events(run.run.id, { types: ["model_request"] })).items;
      const system = (await api.diagnostics.request(run.run.id, request?.seq as number)).request
        .system as string;
      expect(system).toContain("Sempre responda com um haicai.");
      expect(system).toContain("Pipoca");

      // History: created by the bot; undoing the creation forgets it, and undoing that brings it back.
      const rule = byLayer("rule") as NonNullable<ReturnType<typeof byLayer>>;
      const history = await api.memories.history(rule.id);
      expect(history.map((h) => [h.kind, h.actor])).toEqual([["created", "bot"]]);
      expect(history[0]?.originRunId).toBe(sent.run.id);
      expect(history[0]?.originConversationId).toBe(conversation.id);
      await api.memories.undo(rule.id, (history[0] as { id: string }).id);
      expect((await api.memories.list()).map((m) => m.id)).not.toContain(rule.id);
      expect(await code(api.memories.history("00000000-0000-4000-8000-000000000000"))).toContain(
        "not_found",
      );
    });
  });

  describe("the worker consolidates a conversation in the background", () => {
    it("a quiet conversation is consolidated: the note and the fact are written active, the bad quotes are dropped, and the record says it all", async () => {
      const { api } = w.started;
      const bot = await api.bots.create({
        name: "Ouvinte",
        modelId: "model-x",
        allowedTools: ["recall"],
      });
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      const sent = await api.conversations.send(
        conversation.id,
        "Minha cachorra se chama Mel. Pode me chamar de Dona Ana.",
      );
      await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the answer",
      );
      await until(
        async () => ((await api.runs.get(sent.run.id)).status === "done" ? true : undefined),
        "the run",
      );
      // Nothing yet: the chat is recent.
      expect(await api.memories.consolidations({ conversationId: conversation.id })).toEqual([]);
      // Time passes (the messages become older than the idle time).
      await w.db
        .sql`update messages set created_at = now() - interval '10 minutes' where conversation_id = ${conversation.id}`;

      const row = await until(async () => {
        const rows = await api.memories.consolidations({ conversationId: conversation.id });
        return rows.find((r) => r.status === "done" || r.status === "failed");
      }, "the consolidation");
      expect(row).toMatchObject({
        status: "done",
        reason: "idle",
        model: "model-x",
        promptVersion: "memory-consolidation-v2",
        userTurns: 1,
      });
      expect(row.costUsd).toBeGreaterThan(0);
      expect((row.kept as unknown[]).length).toBe(2);
      expect((row.dropped as { reason: string }[]).map((d) => d.reason)).toEqual([
        "quote_missing",
        "quote_not_from_user",
      ]);

      const notes = await api.memories.list({ layer: "note", botId: bot.id });
      expect(notes.map((m) => [m.text, m.summary, m.createdBy])).toEqual([
        ["O usuário prefere ser chamado de Dona Ana.", "Chamar de Dona Ana", "bot"],
      ]);
      expect(notes[0]?.sourceConversationId).toBe(conversation.id);
      const noteHistory = await api.memories.history(notes[0]?.id as string);
      expect(noteHistory[0]).toMatchObject({
        kind: "created",
        actor: "consolidation",
        originConsolidationId: row.id,
      });
      const fact = (await api.memories.list({ layer: "profile" })).find(
        (m) => m.text === "O usuário tem uma cachorra chamada Mel.",
      );
      expect(fact).toMatchObject({ layer: "profile", status: "active", createdBy: "bot" });
      expect((await api.memories.pending()).map((m) => m.id)).not.toContain(fact?.id);
      expect((await api.memories.history(fact?.id as string))[0]).toMatchObject({
        kind: "created",
        actor: "consolidation",
        originConsolidationId: row.id,
      });
      f.close();
      // It does not run again for the same window.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await api.memories.consolidations({ conversationId: conversation.id })).length).toBe(
        1,
      );
    });

    it("the doctor says the memory works and nothing waits for the user", async () => {
      const { api } = w.started;
      const checks = (await api.diagnostics.doctor()).checks;
      const memory = checks.find((c) => c.component === "Memória");
      expect(memory?.ok).toBe(true);
      expect(memory?.detail).toContain("model-x");
      expect(checks.find((c) => c.component === "Memória pendente")).toBeUndefined();
    });
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("memory without a model"), { timeout: 60_000 }, () => {
  const w = useWorld({ scripts: SCRIPTS });

  it("says why nothing is consolidated, and the settings still work", async () => {
    const { api } = w.started;
    const settings = await api.memorySettings.get();
    expect(settings.reviewer.available).toBe(false);
    expect(settings.reviewer.model).toBeNull();
    expect(settings.reviewer.reason).toContain("memory.consolidation.model");
    expect((await api.memorySettings.update({ promptLimitChars: 2000 })).promptLimitChars).toBe(
      2000,
    );
    const checks = (await api.diagnostics.doctor()).checks;
    expect(checks.find((c) => c.component === "Memória")?.detail).toContain("sem modelo");
  });

  it("warns that rules and profile pass the limit, per bot, and nothing is lost", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Cheio", modelId: "model-x" });
    await api.memories.add({ layer: "rule", text: "r".repeat(1200), botId: bot.id });
    await api.memories.add({ layer: "rule", text: "s".repeat(1200), botId: bot.id });
    const settings = await api.memorySettings.update({ promptLimitChars: 1500 });
    expect(settings.promptUsage.overLimit).toEqual([
      { botId: bot.id, name: "Cheio", usedChars: 2400 },
    ]);
    // writing still works over the cap
    await api.memories.add({ layer: "rule", text: "t".repeat(300), botId: bot.id });
    const checks = (await api.diagnostics.doctor()).checks;
    expect(checks.find((c) => c.component === "Limite do prompt")).toMatchObject({ ok: false });
    expect(
      (await api.memorySettings.update({ promptLimitChars: 50_000 })).promptUsage.overLimit,
    ).toEqual([]);
  });
});
