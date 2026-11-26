import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMessage, getMessage, MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// KOD-15: the user's answer given by clicking a question card is bound to the question it answers
// (`messages.question_ref`), so the app shows it only on the card, with no bubble of its own.
describe.skipIf(!DATABASE_URL)(
  dbSuiteName("migration 0038: the question card a user message answers"),
  () => {
    const ctx = useIsolatedDb({ migrate: false });

    it("applies on a database at 0037, keeps the messages, and holds a reference only on a user message", async () => {
      const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
      await cp(MIGRATIONS_DIR, dir, { recursive: true });
      const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0038" && f.endsWith(".sql"));
      expect(held).toEqual(["0038_message_question_ref.sql"]);
      for (const file of held) await rm(join(dir, file));
      await migrate(ctx.db, dir);
      const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
      const [conversation] = await ctx.db.sql<{ id: string }[]>`
      insert into conversations (kind) values ('direct') returning id`;
      const conversationId = conversation?.id as string;
      await ctx.db.sql`
      insert into conversation_members (conversation_id, conversation_kind, bot_id)
      values (${conversationId}, 'direct', ${bot?.id as string})`;
      await ctx.db.sql`
      insert into messages (conversation_id, seq, author_kind, text) values
      (${conversationId}, 1, 'user', 'oi')`;
      expect(await migrate(ctx.db)).toEqual(held);
      const [old] = await ctx.db.sql<{ question_ref: string | null }[]>`
      select question_ref from messages`;
      expect(old?.question_ref).toBeNull();

      const asked = await appendMessage(ctx.db, {
        conversationId,
        authorKind: "bot",
        authorBotId: bot?.id as string,
        text: "Qual cor?",
        question: {
          questions: [{ question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] }],
        },
      });
      const answer = await appendMessage(ctx.db, {
        conversationId,
        authorKind: "user",
        text: "Azul",
        questionRef: asked.id,
      });
      expect(answer.questionRef).toBe(asked.id);
      expect(answer.text).toBe("Azul");
      expect((await getMessage(ctx.db, answer.id))?.questionRef).toBe(asked.id);
      // A typed message has none.
      const typed = await appendMessage(ctx.db, { conversationId, authorKind: "user", text: "oi" });
      expect(typed.questionRef).toBeUndefined();
      // Only on a message of the user.
      await expect(
        appendMessage(ctx.db, {
          conversationId,
          authorKind: "system",
          text: "x",
          questionRef: asked.id,
        }),
      ).rejects.toThrow();
      await expect(ctx.db.sql`
      insert into messages (conversation_id, seq, author_kind, text, question_ref) values
      (${conversationId}, 99, 'system', 'x', ${asked.id})`).rejects.toThrow();
      // The question goes, the answer stays, without the reference.
      await ctx.db.sql`delete from messages where id = ${asked.id}`;
      const [after] = await ctx.db.sql<{ text: string; question_ref: string | null }[]>`
      select text, question_ref from messages where id = ${answer.id}`;
      expect(after).toEqual({ text: "Azul", question_ref: null });
    });
  },
);
