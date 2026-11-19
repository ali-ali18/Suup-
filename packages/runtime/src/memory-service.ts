import { MemoryRuleError, type MemoryService } from "@suup/core";
import {
  addMemory,
  archiveMemory,
  type Db,
  getMemory,
  getRun,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  listMemories,
  type MemoryLayer,
  memoryContextFor,
  searchMemories,
  searchMessages,
} from "@suup/db";
import { z } from "zod";

const uuid = z.uuid();

/** Removes the highlight markers the database puts around matched words. */
function plain(excerpt: string): string {
  return excerpt.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The memory of one run: `MemoryService` over `@suup/db` with the bot, the run and its
 * conversation bound in.
 *
 * - Visibility: a bot sees the shared memories and its own, nothing else (`searchMemories`,
 *   `memoryContextFor` and `forget` all apply that rule).
 * - Audit: whatever the bot saves is marked `created_by = 'bot'` and records the run, the
 *   conversation of the run and the message that opened it, so the user can see where it came from.
 * - Saving the same text twice returns the existing memory instead of piling up duplicates.
 */
export function createMemoryService(
  db: Db,
  bound: { botId: string; runId: string },
): MemoryService {
  const { botId, runId } = bound;

  let source: Promise<{ conversationId?: string; messageId?: string }> | undefined;
  const sourceOf = () => {
    source ??= (async () => {
      const run = await getRun(db, runId);
      const conversationId = run?.conversationId ?? undefined;
      if (conversationId === undefined) return {};
      const [opening] = await db.sql<{ id: string }[]>`
        select id from messages
        where conversation_id = ${conversationId} and run_id = ${runId} and author_kind = 'user'
        order by seq limit 1`;
      return { conversationId, ...(opening === undefined ? {} : { messageId: opening.id }) };
    })();
    return source;
  };

  return {
    async remember({ layer, text, scope }) {
      if (layer === "profile" && scope === "bot") {
        throw new MemoryRuleError(
          "A profile fact is shared by every assistant of the user; leave scope out (or use shared).",
        );
      }
      if (layer === "note" && scope === "shared") {
        throw new MemoryRuleError(
          "A note always belongs to you alone; leave scope out. For something every assistant should know, save a profile fact (about the user) or a rule (an instruction from the user).",
        );
      }
      const effective =
        layer === "rule" ? (scope ?? "shared") : layer === "profile" ? "shared" : "bot";

      // The same text, already remembered where this bot would see it: nothing new to save.
      const wanted = normalize(text);
      const known =
        layer === "note"
          ? await listMemories(db, { layer: "note", botId, limit: 1000 })
          : (await memoryContextFor(db, botId))[layer === "rule" ? "rules" : "profile"];
      const same = known.find((m) => normalize(m.text) === wanted && m.scope === effective);
      if (same !== undefined) return { id: same.id };

      const from = await sourceOf();
      const saved = await addMemory(db, {
        layer,
        scope: effective,
        ...(effective === "bot" ? { botId } : {}),
        text: text.trim(),
        createdBy: "bot",
        sourceRunId: runId,
        ...(from.conversationId === undefined ? {} : { sourceConversationId: from.conversationId }),
        ...(from.messageId === undefined ? {} : { sourceMessageId: from.messageId }),
      });
      return { id: saved.id };
    },

    async recall({ query, layers, limit }) {
      const hits = await searchMemories(db, {
        query,
        botId,
        ...(layers === undefined ? {} : { layers: layers as MemoryLayer[] }),
        limit: limit ?? 5,
      });
      return hits.map(({ memory, excerpt }) => ({
        id: memory.id,
        layer: memory.layer,
        text: memory.text,
        excerpt: plain(excerpt),
        createdAt: memory.createdAt,
      }));
    },

    async forget({ id }) {
      if (!uuid.safeParse(id).success) return false;
      const memory = await getMemory(db, id);
      if (memory === null || memory.archivedAt !== null) return false;
      if (memory.scope === "bot" && memory.botId !== botId) return false;
      await archiveMemory(db, id);
      return true;
    },

    async searchConversations({ query, limit }) {
      const hits = await searchMessages(db, { query, botId, limit: limit ?? 5 });
      return hits.map(({ message, excerpt }) => ({
        conversationId: message.conversationId,
        messageId: message.id,
        author: message.authorKind,
        excerpt: plain(excerpt),
        createdAt: message.createdAt,
      }));
    },
  };
}
