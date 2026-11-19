import {
  MemoryRuleError,
  type MemoryService,
  type MemoryWriteReviewer,
  type RememberResult,
  type RunFacts,
} from "@suup/core";
import {
  addMemory,
  archiveMemory,
  type Db,
  findMemoriesWithText,
  getMemory,
  getRun,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type MemoryLayer,
  recordMemoryReview,
  searchMemoriesBroadening,
  searchMessagesBroadening,
  touchMemories,
} from "@suup/db";
import { z } from "zod";

const uuid = z.uuid();

/** Removes the highlight markers the database puts around matched words. */
function plain(excerpt: string): string {
  return excerpt.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");
}

/** What the memory service needs besides the database (the runtime provides it per run). */
export interface MemoryServiceDeps {
  /**
   * Whether a tool may have brought content from outside into the run. Decided by what the tool
   * DECLARES (never by its text); an unknown tool counts as yes.
   */
  isExternalTool?(name: string): boolean;
  /** Reviews a write made after the run read content from outside. Absent: such a write waits. */
  reviewer?: MemoryWriteReviewer;
}

/**
 * The memory of one run: `MemoryService` over `@suup/db` with the bot, the run and its
 * conversation bound in.
 *
 * - Visibility: a bot sees the shared memories and its own, nothing else (`searchMemories`,
 *   `memoryContextFor` and `forget` all apply that rule).
 * - Audit: whatever the bot saves is marked `created_by = 'bot'`, records the run, the
 *   conversation of the run and the message that opened it, and enters the history of changes.
 * - What the bot saves is ACTIVE at once (rule, profile or note): nothing waits for the user. If the
 *   run had already read content from outside, the reviewer decides: only `run` saves it; anything
 *   else (or no reviewer) does NOT save it, the bot is told why and the review is recorded.
 * - Saving the same text twice returns the existing memory instead of piling up duplicates.
 *   (Same text: ignoring only case and white space; nothing fuzzy.)
 */
export function createMemoryService(
  db: Db,
  bound: { botId: string; runId: string },
  deps: MemoryServiceDeps = {},
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

  const readExternal = (facts: RunFacts | undefined): boolean =>
    facts?.toolsUsed.some((name) => deps.isExternalTool?.(name) ?? true) === true;

  return {
    async remember({ layer, text, summary, scope }, facts): Promise<RememberResult> {
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

      // The same text, already remembered where this bot would see it (a note is also "already
      // remembered" by a shared profile fact): nothing new to save. A fact the user refused is not
      // saved again either, and the bot is told. Exact comparison (case and white space only).
      const lookup: MemoryLayer[] = layer === "note" ? ["note", "profile"] : [layer];
      const same = (await findMemoriesWithText(db, text, { layers: lookup, botId })).filter((m) =>
        m.layer === layer
          ? m.scope === effective && (effective === "shared" || m.botId === botId)
          : true,
      );
      const known = same.find((m) => m.status !== "rejected");
      if (known !== undefined) {
        return {
          id: known.id,
          status: known.status === "pending" ? "pending" : "active",
          reason: "Already saved; nothing new was written.",
        };
      }
      if (same.some((m) => m.status === "rejected")) {
        throw new MemoryRuleError(
          "The user already refused this exact memory. Do not save it again; if they now want it, they will tell you.",
        );
      }

      // Nothing waits for the user. After the run read content from outside, the reviewer DECIDES:
      // `run` saves it; anything else (ask, block, error, no reviewer) does NOT save it.
      let review: Awaited<ReturnType<MemoryWriteReviewer["review"]>> | undefined;
      const external = readExternal(facts);
      let notSaved: string | undefined;
      if (external) {
        if (deps.reviewer === undefined) {
          notSaved =
            "Nesta execução você leu conteúdo de fora e não há revisor disponível: a memória NÃO foi salva.";
        } else {
          review = await deps.reviewer.review({
            layer,
            scope: effective,
            text,
            userMessages: facts?.userMessages ?? [],
          });
          if (review.decision !== "run") {
            notSaved = `Nesta execução você leu conteúdo de fora e a revisão não liberou esta memória (${review.reason}): ela NÃO foi salva.`;
          }
        }
      }
      const recordReview = (memoryId: string | null, outcome: "active" | "not_saved") =>
        recordMemoryReview(db, {
          runId,
          botId,
          memoryId,
          layer,
          decision:
            review === undefined
              ? "error"
              : review.failure === undefined
                ? review.decision
                : "error",
          reason: review?.reason ?? "Não há revisor disponível: a memória não foi salva.",
          outcome,
          ...(review === undefined
            ? {}
            : {
                model: review.model,
                promptVersion: review.promptVersion,
                inputTokens: review.usage.inputTokens,
                outputTokens: review.usage.outputTokens,
                costUsd: review.costUsd,
                latencyMs: review.latencyMs,
              }),
        });
      if (notSaved !== undefined) {
        await recordReview(null, "not_saved");
        throw new MemoryRuleError(notSaved);
      }

      const from = await sourceOf();
      const saved = await addMemory(db, {
        layer,
        scope: effective,
        ...(effective === "bot" ? { botId } : {}),
        text: text.trim(),
        ...(summary === undefined ? {} : { summary }),
        createdBy: "bot",
        actor: "bot",
        status: "active",
        sourceRunId: runId,
        ...(from.conversationId === undefined ? {} : { sourceConversationId: from.conversationId }),
        ...(from.messageId === undefined ? {} : { sourceMessageId: from.messageId }),
      });
      if (external) await recordReview(saved.id, "active");
      return { id: saved.id, status: "active" };
    },

    async recall({ query, layers, limit }) {
      const { hits, broader } = await searchMemoriesBroadening(db, {
        query,
        botId,
        ...(layers === undefined ? {} : { layers: layers as MemoryLayer[] }),
        limit: limit ?? 5,
      });
      await touchMemories(
        db,
        hits.map((h) => h.memory.id),
      );
      return {
        broader,
        hits: hits.map(({ memory, excerpt }) => ({
          id: memory.id,
          layer: memory.layer,
          text: memory.text,
          excerpt: plain(excerpt),
          createdAt: memory.createdAt,
        })),
      };
    },

    async forget({ id }) {
      if (!uuid.safeParse(id).success) return false;
      const memory = await getMemory(db, id);
      if (memory === null || memory.archivedAt !== null) return false;
      if (memory.scope === "bot" && memory.botId !== botId) return false;
      const from = await sourceOf();
      await archiveMemory(db, id, {
        actor: "bot",
        origin: {
          runId,
          ...(from.conversationId === undefined ? {} : { conversationId: from.conversationId }),
          ...(from.messageId === undefined ? {} : { messageId: from.messageId }),
        },
      });
      return true;
    },

    async searchConversations({ query, limit }) {
      const { hits, broader } = await searchMessagesBroadening(db, {
        query,
        botId,
        limit: limit ?? 5,
      });
      return {
        broader,
        hits: hits.map(({ message, excerpt }) => ({
          conversationId: message.conversationId,
          messageId: message.id,
          author: message.authorKind,
          excerpt: plain(excerpt),
          createdAt: message.createdAt,
        })),
      };
    },
  };
}
