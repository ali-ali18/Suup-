import { describe, expect, it } from "vitest";
import {
  appendMessage,
  createBot,
  createDirectConversation,
  decideTeamProposal,
  finishReception,
  getConversation,
  getMessage,
  listBots,
  resetReception,
  sendConversationMessage,
  setRunStatus,
  startReception,
  TeamProposalError,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

const objective = (redo: boolean): string => (redo ? "redo" : "first");

describe.skipIf(!DATABASE_URL)(dbSuiteName("the welcome of a bot"), () => {
  const ctx = useIsolatedDb();

  const newBot = () =>
    createBot(ctx.db, { name: `b${Math.random()}`, modelProvider: "f", modelId: "m" });
  const endRun = async (id: string) => {
    await setRunStatus(ctx.db, id, { from: "queued", to: "running" });
    await setRunStatus(ctx.db, id, { from: "running", to: "done" });
  };
  const stateOf = async (conversationId: string) =>
    (await getConversation(ctx.db, conversationId))?.reception;

  it("a new conversation is born waiting for its welcome", async () => {
    const bot = await newBot();
    const conversation = await createDirectConversation(ctx.db, bot.id);
    expect(conversation.reception).toBe("pending");
  });

  it("starts exactly once: a run of origin reception, and the state `started`", async () => {
    const bot = await newBot();
    const first = await startReception(ctx.db, bot.id, objective);
    expect(first.started).toBe(true);
    expect(first.run).toMatchObject({
      botId: bot.id,
      conversationId: first.conversationId,
      origin: "reception",
      objective: "first",
      status: "queued",
    });
    expect(await stateOf(first.conversationId)).toBe("started");
    const again = await startReception(ctx.db, bot.id, objective);
    expect(again).toMatchObject({
      started: false,
      run: null,
      conversationId: first.conversationId,
    });
  });

  it("two opens at the same instant (two windows, two workers) make one run", async () => {
    const bot = await newBot();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => startReception(ctx.db, bot.id, objective)),
    );
    expect(results.filter((r) => r.started)).toHaveLength(1);
    const runs = await ctx.db.sql`
      select id from runs where bot_id = ${bot.id} and origin = 'reception'`;
    expect(runs).toHaveLength(1);
  });

  it("is atomic: the state and the run are written together, so a failure in the middle leaves neither", async () => {
    const bot = await newBot();
    await expect(
      startReception(ctx.db, bot.id, () => {
        throw new Error("crash before the run is written");
      }),
    ).rejects.toThrow("crash");
    const conversation = await createDirectConversation(ctx.db, bot.id);
    expect(conversation.reception).toBe("pending");
    expect(await ctx.db.sql`select id from runs where bot_id = ${bot.id}`).toHaveLength(0);
    // and a later open starts it
    expect((await startReception(ctx.db, bot.id, objective)).started).toBe(true);
  });

  it("is the foreground run: the user's message goes to its inbox, not to a second run", async () => {
    const bot = await newBot();
    const { conversationId, run } = await startReception(ctx.db, bot.id, objective);
    const sent = await sendConversationMessage(ctx.db, {
      conversationId,
      text: "Preciso de outra coisa",
    });
    expect(sent.queuedForRun).toBe(true);
    expect(sent.run.id).toBe(run?.id);
    expect(sent.message.status).toBe("sent");
  });

  it("yields to the user: a first message before the welcome dismisses it", async () => {
    const bot = await newBot();
    const conversation = await createDirectConversation(ctx.db, bot.id);
    await sendConversationMessage(ctx.db, { conversationId: conversation.id, text: "Oi" });
    expect(await stateOf(conversation.id)).toBe("done");
    expect((await startReception(ctx.db, bot.id, objective)).started).toBe(false);
  });

  it("does not welcome a conversation that already has a history", async () => {
    const bot = await newBot();
    const conversation = await createDirectConversation(ctx.db, bot.id);
    await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "user",
      text: "mensagem antiga",
    });
    expect((await startReception(ctx.db, bot.id, objective)).started).toBe(false);
    expect(await stateOf(conversation.id)).toBe("done");
  });

  it("is over when its run ends, and never comes back by itself", async () => {
    const bot = await newBot();
    const { conversationId, run } = await startReception(ctx.db, bot.id, objective);
    await endRun(run?.id as string);
    await finishReception(ctx.db, conversationId);
    expect(await stateOf(conversationId)).toBe("done");
    expect((await startReception(ctx.db, bot.id, objective)).started).toBe(false);
  });

  describe("redo", () => {
    it("starts again at the next open, even with a history, and says it is a redo", async () => {
      const bot = await newBot();
      const first = await startReception(ctx.db, bot.id, objective);
      await endRun(first.run?.id as string);
      await finishReception(ctx.db, first.conversationId);
      await appendMessage(ctx.db, {
        conversationId: first.conversationId,
        authorKind: "user",
        text: "uma conversa",
      });
      expect(await resetReception(ctx.db, bot.id)).toBe(true);
      expect(await stateOf(first.conversationId)).toBe("redo");
      const second = await startReception(ctx.db, bot.id, objective);
      expect(second.started).toBe(true);
      expect(second.run?.objective).toBe("redo");
      expect(await stateOf(first.conversationId)).toBe("started");
    });

    it("is refused while a run of the conversation is active", async () => {
      const bot = await newBot();
      await startReception(ctx.db, bot.id, objective);
      expect(await resetReception(ctx.db, bot.id)).toBe(false);
    });

    it("is idempotent, and a bot never opened has nothing to reset", async () => {
      const bot = await newBot();
      expect(await resetReception(ctx.db, bot.id)).toBe(true);
      const { conversationId, run } = await startReception(ctx.db, bot.id, objective);
      await endRun(run?.id as string);
      await finishReception(ctx.db, conversationId);
      expect(await resetReception(ctx.db, bot.id)).toBe(true);
      expect(await resetReception(ctx.db, bot.id)).toBe(true);
      expect(await stateOf(conversationId)).toBe("redo");
    });
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("the team card"), () => {
  const ctx = useIsolatedDb();
  const defaults = { modelProvider: "f", modelId: "m", allowedTools: ["read_file"] };
  const items = [
    { name: "Tutor faculdade", description: "Estudo e prazos.", personality: "Você é um tutor." },
    { name: "Finanças", description: "Contas e gastos.", personality: "Você cuida das finanças." },
    { name: "Casa", description: "Rotina de casa.", personality: "Você organiza a casa." },
  ];

  const card = async () => {
    const bot = await createBot(ctx.db, {
      name: `p${Math.random()}`,
      modelProvider: "f",
      modelId: "m",
    });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const message = await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Proponho estes bots.",
      team: items,
    });
    return message;
  };

  it("stores the proposals as pending", async () => {
    const message = await card();
    expect(message.team).toEqual({ items, status: "pending", created: [] });
  });

  it("creates only the ticked proposals, with what the card showed, and records which", async () => {
    const message = await card();
    const before = (await listBots(ctx.db)).length;
    const { message: decided, created } = await decideTeamProposal(
      ctx.db,
      message.id,
      {
        kind: "create",
        picks: [{ index: 2, avatar: "mascot:leaf", color: "verde" }, { index: 0 }],
      },
      defaults,
    );
    expect(created.map((b) => b.name)).toEqual(["Tutor faculdade", "Casa"]);
    expect(created[1]).toMatchObject({
      avatar: "mascot:leaf",
      color: "verde",
      allowedTools: ["read_file"],
      modelId: "m",
    });
    expect((await listBots(ctx.db)).length).toBe(before + 2);
    expect(decided.team?.status).toBe("created");
    expect(decided.team?.created).toEqual([
      { index: 0, botId: created[0]?.id },
      { index: 2, botId: created[1]?.id },
    ]);
    expect((await getMessage(ctx.db, message.id))?.team?.status).toBe("created");
  });

  it("'Agora não' creates nothing", async () => {
    const message = await card();
    const before = (await listBots(ctx.db)).length;
    const { message: decided, created } = await decideTeamProposal(
      ctx.db,
      message.id,
      { kind: "dismiss" },
      defaults,
    );
    expect(created).toEqual([]);
    expect(decided.team?.status).toBe("dismissed");
    expect((await listBots(ctx.db)).length).toBe(before);
  });

  it("is decided once: a second decision (a double click, another window) creates nothing", async () => {
    const message = await card();
    const before = (await listBots(ctx.db)).length;
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        decideTeamProposal(ctx.db, message.id, { kind: "create", picks: [{ index: 1 }] }, defaults),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(TeamProposalError);
    }
    expect((await listBots(ctx.db)).length).toBe(before + 1);
  });

  it("refuses an empty, repeated or unknown pick, and creates nothing", async () => {
    const message = await card();
    const before = (await listBots(ctx.db)).length;
    for (const picks of [[], [{ index: 0 }, { index: 0 }], [{ index: 3 }], [{ index: -1 }]]) {
      await expect(
        decideTeamProposal(ctx.db, message.id, { kind: "create", picks }, defaults),
      ).rejects.toMatchObject({ code: "invalid_pick" });
    }
    expect((await listBots(ctx.db)).length).toBe(before);
    expect((await getMessage(ctx.db, message.id))?.team?.status).toBe("pending");
  });

  it("a message without a card cannot be decided", async () => {
    const bot = await createBot(ctx.db, {
      name: `p${Math.random()}`,
      modelProvider: "f",
      modelId: "m",
    });
    const conversation = await createDirectConversation(ctx.db, bot.id);
    const plain = await appendMessage(ctx.db, {
      conversationId: conversation.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "oi",
    });
    await expect(
      decideTeamProposal(ctx.db, plain.id, { kind: "dismiss" }, defaults),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
