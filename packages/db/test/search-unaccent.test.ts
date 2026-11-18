import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  addMemory,
  appendMessage,
  createBot,
  createDb,
  createDirectConversation,
  migrate,
  searchMemories,
  searchMessages,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("accent-insensitive search (migration 0007)"), () => {
  const ctx = useIsolatedDb();

  const setup = async () => {
    const bot = await createBot(ctx.db, {
      name: `s${Math.random()}`,
      modelProvider: "p",
      modelId: "m",
    });
    return { bot, conv: await createDirectConversation(ctx.db, bot.id) };
  };
  const say = (conversationId: string, text: string) =>
    appendMessage(ctx.db, { conversationId, authorKind: "user", text });

  it("finds accented text with an unaccented query and the other way round, messages and memories", async () => {
    const { bot, conv } = await setup();
    await say(conv.id, "A avaliação de português é amanhã, não esqueça.");
    await say(conv.id, "Comprei pão e açúcar.");
    await say(conv.id, "Nada a ver.");
    await say(conv.id, "Reuniao sem acento nenhuma");
    await addMemory(ctx.db, {
      layer: "profile",
      text: "Moro em São Paulo e estudo matemática",
      createdBy: "user",
    });
    const find = async (q: string) =>
      (await searchMessages(ctx.db, { query: q, conversationId: conv.id, limit: 10 })).map(
        (h) => h.message.text,
      );
    expect(await find("avaliacao")).toEqual(["A avaliação de português é amanhã, não esqueça."]);
    expect(await find("avaliações")).toHaveLength(1); // accented plural: stemming as before
    expect(await find("PORTUGUES")).toHaveLength(1);
    expect(await find("acucar pao")).toEqual(["Comprei pão e açúcar."]);
    expect(await find("avaliação")).toHaveLength(1); // the accented query still works
    expect(await find("reunião")).toEqual(["Reuniao sem acento nenhuma"]); // accented query, unaccented text
    // The memory, too.
    const mem = await searchMemories(ctx.db, {
      query: "sao paulo matematica",
      botId: bot.id,
      limit: 5,
    });
    expect(mem.map((h) => h.memory.text)).toEqual(["Moro em São Paulo e estudo matemática"]);
    // Stop words with accents are still ignored ("não", "você"), not turned into required terms.
    expect(await find("você não esqueça avaliação")).toHaveLength(1);
  });

  it("never errors on hostile queries and keeps returning [] without searchable terms", async () => {
    const { conv } = await setup();
    await say(conv.id, "café sem açúcar");
    for (const query of ["", '"', "-café", "café & | ! (", "a e o de", "\u0000café"]) {
      await expect(
        searchMessages(ctx.db, { query, conversationId: conv.id, limit: 5 }),
      ).resolves.toBeInstanceOf(Array);
    }
    expect(
      await searchMessages(ctx.db, { query: "a e o de", conversationId: conv.id, limit: 5 }),
    ).toEqual([]);
    expect(
      (await searchMessages(ctx.db, { query: "cafe -acucar", conversationId: conv.id, limit: 5 }))
        .length,
    ).toBe(0);
  });

  it("does not install the extension inside the schema, so dropping a schema leaves it for the others", async () => {
    const [row] = await ctx.db.sql<{ schema: string }[]>`
      select n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'unaccent'`;
    expect(row?.schema).toBeDefined();
    expect(row?.schema).not.toBe(ctx.schema);
  });

  it("falls back to plain search, with the same migration, where the extension is unavailable", async () => {
    const url = DATABASE_URL as string;
    const schema = `t_fallback_${Math.random().toString(16).slice(2, 10)}`;
    const admin = postgres(url, { max: 1, onnotice: false });
    await admin.unsafe(`create schema ${schema}`);
    // `suup.disable_unaccent` stands for a PostgreSQL without the contrib package.
    const db = createDb(url, { schema });
    try {
      await db.sql.unsafe("set suup.disable_unaccent = 'on'"); // session of one connection...
      const plain = postgres(url, {
        max: 1,
        onnotice: false,
        connection: { search_path: schema, "suup.disable_unaccent": "on" },
      });
      const plainDb = { sql: plain, close: () => plain.end() };
      await migrate(plainDb);
      const [fold] = await plain<{ v: string }[]>`select suup_unaccent('avaliação') as v`;
      expect(fold?.v).toBe("avaliação"); // identity: nothing is folded
      const bot = await createBot(plainDb, { name: "fb", modelProvider: "p", modelId: "m" });
      const conv = await createDirectConversation(plainDb, bot.id);
      await appendMessage(plainDb, {
        conversationId: conv.id,
        authorKind: "user",
        text: "A avaliação é amanhã",
      });
      const hit = (q: string) =>
        searchMessages(plainDb, { query: q, conversationId: conv.id, limit: 5 });
      expect(await hit("avaliação")).toHaveLength(1);
      expect(await hit("avaliações")).toHaveLength(1); // stemming and accents work as before
      expect(await hit("avaliacao")).toHaveLength(0); // ...but there is no folding
      await plain.end();
    } finally {
      await db.close();
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
});
