import type { JsonValue as JSONValue } from "@suup/core";
import { describe, expect, it } from "vitest";
import {
  appendMessageOnce,
  appendRunEvent,
  createBot,
  createDirectConversation,
  createRun,
  insertFile,
  listMessages,
  type RunOrigin,
} from "../src/index.js";
import { partKey } from "../src/turn-parts.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// KOD-64: the words the bot writes in a turn that also calls tools are messages of their own,
// written in the transaction of the `model_response` event (one per text block, keyed by the run,
// the event and the block), so the chat shows them in the order of the log.

describe.skipIf(!DATABASE_URL)(dbSuiteName("turn parts"), () => {
  const ctx = useIsolatedDb();

  const setup = async (origin: RunOrigin = "user") => {
    const bot = await createBot(ctx.db, { name: "b", modelProvider: "fake", modelId: "fake-1" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const run = await createRun(ctx.db, {
      botId: bot.id,
      origin,
      objective: "x",
      conversationId: conv.id,
    });
    return { bot, conv, run };
  };
  const text = (t: string) => ({ type: "text", text: t });
  const call = (id: string, name: string) => ({ type: "tool_call", id, name, args: {} });
  const response = (
    blocks: Record<string, JSONValue>[],
    extra: Record<string, JSONValue> = {},
  ) => ({
    blocks,
    stopReason: "tool_use",
    ...extra,
  });
  const botMessages = async (conversationId: string) =>
    (await listMessages(ctx.db, conversationId, { limit: 50 })).filter(
      (m) => m.authorKind === "bot",
    );

  it("a turn with text and a call writes one message per text block, keyed by run, event and block", async () => {
    const { conv, run } = await setup();
    const event = await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Vou conferir."), call("c1", "web_fetch"), text("  E depois te conto.  ")]),
    );
    const messages = await botMessages(conv.id);
    expect(messages.map((m) => m.text)).toEqual(["Vou conferir.", "E depois te conto."]);
    expect(messages.map((m) => m.dedupeKey)).toEqual([
      partKey(run.id, event.seq, 0),
      partKey(run.id, event.seq, 2),
    ]);
    expect(messages.map((m) => m.eventSeq)).toEqual([event.seq, event.seq]);
    expect(messages.every((m) => m.runId === run.id)).toBe(true);
  });

  it("the same part written again (redelivery) is not written twice", async () => {
    const { conv, bot, run } = await setup();
    const event = await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Já volto."), call("c1", "web_fetch")]),
    );
    const key = partKey(run.id, event.seq, 0);
    const again = await appendMessageOnce(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Já volto.",
      runId: run.id,
      dedupeKey: key,
      eventSeq: event.seq,
      attachFiles: false,
    });
    expect(again.created).toBe(false);
    expect(await botMessages(conv.id)).toHaveLength(1);
  });

  it("writes nothing for a text-only turn, a turn that calls finish, or a call that is not the bot's", async () => {
    const { conv, run } = await setup();
    await appendRunEvent(ctx.db, run.id, "model_response", response([text("Resposta direta.")]));
    await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Resumo repetido."), call("f1", "finish")]),
    );
    await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Veredito."), call("r1", "web_fetch")], { purpose: "review" }),
    );
    await appendRunEvent(ctx.db, run.id, "model_response", response([call("c1", "web_fetch")]));
    expect(await botMessages(conv.id)).toHaveLength(0);
  });

  it("only a run that answers a conversation posts parts, by its declared origin", async () => {
    for (const [origin, count] of [
      ["user", 1],
      ["reception", 1],
      ["routine", 0],
      ["delegation", 0],
      ["proactive", 0],
    ] as const) {
      const { conv, run } = await setup(origin);
      await appendRunEvent(
        ctx.db,
        run.id,
        "model_response",
        response([text("Falando."), call("c1", "web_fetch")]),
      );
      expect(await botMessages(conv.id), origin).toHaveLength(count);
    }
  });

  it("keeps the order of the log: two turns give two parts with increasing event seq, and a part never takes the files", async () => {
    const { bot, conv, run } = await setup();
    await insertFile(ctx.db, {
      botId: bot.id,
      runId: run.id,
      callId: "send-1",
      name: "a.pdf",
      mime: "application/pdf",
      content: new Uint8Array([1, 2, 3]),
    });
    const first = await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Primeiro."), call("c1", "web_fetch")]),
    );
    await appendRunEvent(ctx.db, run.id, "tool_call", { callId: "c1", name: "web_fetch" });
    const second = await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Segundo."), call("c2", "web_fetch")]),
    );
    const parts = await botMessages(conv.id);
    expect(parts.map((m) => m.text)).toEqual(["Primeiro.", "Segundo."]);
    expect(parts.map((m) => m.eventSeq)).toEqual([first.seq, second.seq]);
    expect(first.seq).toBeLessThan(second.seq);
    expect(parts.every((m) => m.attachments === undefined)).toBe(true);
    // The message that ends the run takes the file, as before.
    const end = await appendMessageOnce(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Pronto.",
      runId: run.id,
      dedupeKey: `run:${run.id}:done`,
    });
    expect(end.message.attachments?.map((f) => f.name)).toEqual(["a.pdf"]);
  });

  it("an archived conversation never keeps the event from being logged", async () => {
    const { conv, run } = await setup();
    await ctx.db.sql`update conversations set archived_at = now() where id = ${conv.id}`;
    const event = await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Oi."), call("c1", "web_fetch")]),
    );
    expect(event.seq).toBe(1);
    expect(await botMessages(conv.id)).toHaveLength(0);
  });

  it("a part is not news by itself: the unread count waits for the message that ends the turn", async () => {
    const { bot, conv, run } = await setup();
    await appendRunEvent(
      ctx.db,
      run.id,
      "model_response",
      response([text("Vou conferir."), call("c1", "web_fetch")]),
    );
    const unread = async () =>
      (
        await ctx.db.sql<{ n: string }[]>`
          select count(*) as n from messages m join conversations c on c.id = m.conversation_id
          where m.conversation_id = ${conv.id}
            and m.author_kind <> 'user' and m.event_seq is null and m.seq > c.last_read_seq`
      )[0]?.n;
    expect(await unread()).toBe("0");
    await appendMessageOnce(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Pronto.",
      runId: run.id,
      dedupeKey: `run:${run.id}:done`,
    });
    expect(await unread()).toBe("1");
  });
});
