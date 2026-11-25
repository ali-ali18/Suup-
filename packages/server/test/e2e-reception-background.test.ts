import { createBot } from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("background reception"), { timeout: 90_000 }, () => {
  const world = useWorld({
    reception: true,
    scripts: {
      roteiro: {
        cases: [{ whenObjectiveContains: "first-conversation welcome", agent: [{ text: "Olá!" }] }],
      },
    },
  });

  it("starts once without opening chat and uses the principal context from creation", async () => {
    const { api } = world.started;
    const bot = await api.bots.create({ name: "Principal", modelId: "model-x", makeDefault: true });
    expect(bot.isDefault).toBe(true);
    const run = await until(async () => {
      const items = (await api.runs.list({ botId: bot.id, limit: 20 })).items;
      return items.find((item) => item.origin === "reception");
    }, "automatic reception");
    const loaded = await until(async () => {
      const events = (await api.runs.events(run.id, { types: ["context_loaded"], limit: 100 }))
        .items;
      return events[0];
    }, "reception context");
    expect(loaded.payload).toMatchObject({ reception: "general" });
    const conversationId = await until(
      async () => (await api.bots.get(bot.id)).conversationId ?? undefined,
      "direct conversation",
    );
    await until(async () => {
      const messages = (await api.conversations.messages(conversationId, { limit: 100 })).items;
      return messages.some((message) => message.authorKind === "bot") || undefined;
    }, "first message");
    await Promise.all(Array.from({ length: 4 }, () => api.bots.startReception(bot.id)));
    expect(
      (await api.runs.list({ botId: bot.id, limit: 20 })).items.filter(
        (r) => r.origin === "reception",
      ),
    ).toHaveLength(1);
    await until(
      async () => (await api.runs.get(run.id)).status === "done" || undefined,
      "first welcome to finish",
    );
    await api.bots.resetReception(bot.id);
    const redo = await until(async () => {
      const items = (await api.runs.list({ botId: bot.id, limit: 20 })).items;
      return items.find((item) => item.origin === "reception" && item.id !== run.id);
    }, "automatic redo");
    expect(redo.id).not.toBe(run.id);
  });

  it("keeps unavailable bots pending while other bots progress", async () => {
    const missing = await createBot(world.db, {
      name: "Indisponível",
      modelId: "missing",
      modelProvider: "missing",
    });
    const noKey = await world.started.api.bots.create({
      name: "Sem credencial",
      modelId: "model-k",
    });
    const bot = await world.started.api.bots.create({ name: "Disponível", modelId: "model-x" });
    await until(
      async () =>
        (await world.started.api.runs.list({ botId: bot.id, limit: 20 })).items.some(
          (r) => r.origin === "reception",
        ) || undefined,
      "available bot reception",
    );
    expect(
      (await world.started.api.runs.list({ botId: missing.id, limit: 20 })).items,
    ).toHaveLength(0);
    expect((await world.started.api.bots.get(missing.id)).conversationId).toBeNull();
    expect((await world.started.api.runs.list({ botId: noKey.id, limit: 20 })).items).toHaveLength(
      0,
    );
    expect((await world.started.api.bots.get(noKey.id)).conversationId).toBeNull();
  });
});
