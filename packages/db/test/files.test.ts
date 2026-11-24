import { describe, expect, it } from "vitest";
import {
  appendMessage,
  appendMessageOnce,
  createBot,
  createDirectConversation,
  createRun,
  getFile,
  insertFile,
  listMessages,
  MAX_FILE_BYTES,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// The files a bot hands to the chat (`send_file`, migration 0030): kept in the database, attached
// to the next message of their run in the same transaction, once per tool call.

describe.skipIf(!DATABASE_URL)(dbSuiteName("files"), () => {
  const ctx = useIsolatedDb();
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x7f]);

  const setup = async () => {
    const bot = await createBot(ctx.db, { name: "b", modelProvider: "fake", modelId: "fake-1" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const run = await createRun(ctx.db, {
      botId: bot.id,
      origin: "user",
      objective: "x",
      conversationId: conv.id,
    });
    return { bot, conv, run };
  };
  const store = (botId: string, runId: string, callId: string, name = "historia.pdf") =>
    insertFile(ctx.db, { botId, runId, callId, name, mime: "application/pdf", content: PDF });

  it("keeps the exact bytes, and the same call stores the file once", async () => {
    const { bot, run } = await setup();
    const first = await store(bot.id, run.id, "call-1");
    expect(first.created).toBe(true);
    expect(first.file).toMatchObject({ name: "historia.pdf", size: PDF.length, messageId: null });
    const again = await store(bot.id, run.id, "call-1", "outro.pdf");
    expect(again).toMatchObject({
      created: false,
      file: { id: first.file.id, name: "historia.pdf" },
    });
    const read = await getFile(ctx.db, first.file.id);
    expect([...(read?.content ?? [])]).toEqual([...PDF]);
    expect(read?.mime).toBe("application/pdf");
    expect(await getFile(ctx.db, "nao-e-uuid")).toBeNull();
    expect(await getFile(ctx.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("refuses a file over 25 MB", async () => {
    const { bot, run } = await setup();
    await expect(
      insertFile(ctx.db, {
        botId: bot.id,
        runId: run.id,
        callId: "big",
        name: "big.bin",
        mime: "application/octet-stream",
        content: new Uint8Array(MAX_FILE_BYTES + 1),
      }),
    ).rejects.toThrow();
  });

  it("the next bot message of the run carries the files, oldest first; later ones go to the next", async () => {
    const { bot, conv, run } = await setup();
    const a = await store(bot.id, run.id, "c1", "a.pdf");
    const b = await store(bot.id, run.id, "c2", "b.pdf");
    // A user message of the run takes nothing.
    await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "user",
      text: "oi",
      runId: run.id,
    });
    const first = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "Aqui estão.",
      runId: run.id,
    });
    expect(first.attachments?.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(first.attachments?.[0]).toEqual({
      id: a.file.id,
      name: "a.pdf",
      mime: "application/pdf",
      size: PDF.length,
    });
    expect((await getFile(ctx.db, b.file.id))?.messageId).toBe(first.id);
    const c = await store(bot.id, run.id, "c3", "c.pdf");
    const second = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "system",
      text: "fim",
      runId: run.id,
    });
    expect(second.attachments).toEqual([
      { id: c.file.id, name: "c.pdf", mime: "application/pdf", size: PDF.length },
    ]);
    // Listing carries them too; a message without files has no field.
    const listed = await listMessages(ctx.db, conv.id, { limit: 10 });
    expect(listed.map((m) => m.attachments?.length ?? 0)).toEqual([0, 2, 1]);
    expect(listed[0]).not.toHaveProperty("attachments");
  });

  it("a deduplicated message takes no files twice; another run's files stay apart", async () => {
    const { bot, conv, run } = await setup();
    // A run outside the conversation (one active user run per conversation).
    const other = await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "y" });
    await store(bot.id, other.id, "x1", "outra.pdf");
    await store(bot.id, run.id, "c1", "minha.pdf");
    const once = {
      conversationId: conv.id,
      authorKind: "bot" as const,
      authorBotId: bot.id,
      text: "ok",
      runId: run.id,
      dedupeKey: "k",
    };
    const w1 = await appendMessageOnce(ctx.db, once);
    const w2 = await appendMessageOnce(ctx.db, once);
    expect(w1.message.attachments?.map((f) => f.name)).toEqual(["minha.pdf"]);
    expect(w2.created).toBe(false);
    expect(w2.message.attachments?.map((f) => f.name)).toEqual(["minha.pdf"]);
  });

  it("deleting the message deletes its files", async () => {
    const { bot, conv, run } = await setup();
    const f = await store(bot.id, run.id, "c1");
    const m = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: bot.id,
      text: "pronto",
      runId: run.id,
    });
    await ctx.db.sql`delete from messages where id = ${m.id}`;
    expect(await getFile(ctx.db, f.file.id)).toBeNull();
  });
});
