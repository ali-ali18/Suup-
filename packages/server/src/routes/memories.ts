import {
  addMemoryBodySchema,
  editMemoryBodySchema,
  listMemoriesQuerySchema,
  listMemoryConsolidationsQuerySchema,
  searchMemoriesQuerySchema,
  searchMessagesQuerySchema,
  updateMemorySettingsBodySchema,
} from "@suup/api";
import {
  addMemory,
  archiveMemory,
  confirmMemory,
  getBot,
  getMemory,
  getMemorySettings,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  latestMemoryReviews,
  listConsolidations,
  listMemories,
  listMemoryRevisions,
  memoryPromptUsage,
  RevisionError,
  rejectMemory,
  restoreMemory,
  searchMemories,
  searchMessages,
  undoMemoryRevision,
  updateMemory,
  updateMemorySettings,
} from "@suup/db";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toMemoryDto, toMessageDto } from "../mappers.js";

/** An excerpt with the database's highlight markers, as plain text plus where the matches are. */
export function splitExcerpt(excerpt: string): {
  excerpt: string;
  matches: { start: number; end: number }[];
} {
  const matches: { start: number; end: number }[] = [];
  let text = "";
  let start = -1;
  for (const char of excerpt) {
    if (char === HIGHLIGHT_START) start = text.length;
    else if (char === HIGHLIGHT_END) {
      if (start !== -1) matches.push({ start, end: text.length });
      start = -1;
    } else text += char;
  }
  return { excerpt: text, matches };
}

/** The rules of the layers, said in Portuguese before the database says them in English. */
function checkLayerRules(body: {
  layer: string;
  scope?: string | undefined;
  botId?: string | undefined;
}): void {
  const scope =
    body.scope ??
    (body.layer === "profile"
      ? "shared"
      : body.layer === "rule"
        ? body.botId === undefined
          ? "shared"
          : "bot"
        : "bot");
  if (body.layer === "profile" && scope !== "shared") {
    throw new HttpError("invalid_request", "scope: o perfil é sempre compartilhado entre os bots.");
  }
  if (body.layer === "note" && scope !== "bot") {
    throw new HttpError("invalid_request", "scope: uma nota é sempre de um bot (informe botId).");
  }
  if (scope === "bot" && body.botId === undefined) {
    throw new HttpError("invalid_request", "botId: obrigatório quando a memória é de um bot.");
  }
  if (scope === "shared" && body.botId !== undefined) {
    throw new HttpError("invalid_request", "botId: não se usa em memória compartilhada.");
  }
}

/** The memory settings as the API says them, with what the app needs to warn about. */
async function memorySettingsBody(ctx: Parameters<Route["handler"]>[0]) {
  const { db } = ctx.runtime;
  const settings = await getMemorySettings(db);
  const { available, model, reason } = ctx.runtime.memoryReviewerStatus();
  const usage = await memoryPromptUsage(db, settings.promptLimitItems);
  return {
    consolidation: {
      enabled: settings.consolidationEnabled,
      idleMinutes: settings.idleMinutes,
      maxTurns: settings.maxTurns,
    },
    promptLimitItems: settings.promptLimitItems,
    expiryDays: settings.expiryDays,
    compactionThreshold: settings.compactionThreshold,
    reviewer: { available, model, reason },
    promptUsage: {
      limitItems: usage.limitItems,
      ceilingChars: usage.ceilingChars,
      sharedItems: usage.sharedItems,
      sharedChars: usage.sharedChars,
      overLimit: usage.overBots,
    },
  };
}

/** A pending memory is shown with what the reviewer said about it, when it was asked. */
async function withReviews(
  db: Parameters<typeof latestMemoryReviews>[0],
  rows: Parameters<typeof toMemoryDto>[0][],
) {
  const pending = rows.filter((m) => m.status === "pending").map((m) => m.id);
  const reviews = await latestMemoryReviews(db, pending);
  return rows.map((m) =>
    toMemoryDto(m, m.status === "pending" ? (reviews.get(m.id) ?? null) : undefined),
  );
}

export const memoryRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/memories",
    async handler(ctx) {
      const query = ctx.query(listMemoriesQuerySchema);
      const rows = await listMemories(ctx.runtime.db, {
        limit: query.limit,
        includeArchived: query.includeArchived === true,
        ...(query.layer === undefined ? {} : { layer: query.layer }),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        ...(query.botId === undefined ? {} : { botId: query.botId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      });
      return { body: { items: await withReviews(ctx.runtime.db, rows) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/memory-settings",
    async handler(ctx) {
      return { body: await memorySettingsBody(ctx) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/memory-settings",
    async handler(ctx) {
      const body = ctx.body(updateMemorySettingsBodySchema);
      await updateMemorySettings(ctx.runtime.db, {
        ...(body.consolidation?.enabled === undefined
          ? {}
          : { consolidationEnabled: body.consolidation.enabled }),
        ...(body.consolidation?.idleMinutes === undefined
          ? {}
          : { idleMinutes: body.consolidation.idleMinutes }),
        ...(body.consolidation?.maxTurns === undefined
          ? {}
          : { maxTurns: body.consolidation.maxTurns }),
        ...(body.promptLimitItems === undefined ? {} : { promptLimitItems: body.promptLimitItems }),
        ...(body.expiryDays === undefined ? {} : { expiryDays: body.expiryDays }),
        ...(body.compactionThreshold === undefined
          ? {}
          : { compactionThreshold: body.compactionThreshold }),
      });
      return { body: await memorySettingsBody(ctx) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/memory-consolidations",
    async handler(ctx) {
      const query = ctx.query(listMemoryConsolidationsQuerySchema);
      const rows = await listConsolidations(ctx.runtime.db, {
        limit: query.limit,
        ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
      });
      return {
        body: {
          items: rows.map((r) => ({
            id: r.id,
            conversationId: r.conversationId,
            botId: r.botId,
            reason: r.reason,
            status: r.status,
            fromSeq: r.fromSeq,
            toSeq: r.toSeq,
            userTurns: r.userTurns,
            model: r.model,
            promptVersion: r.promptVersion,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: r.costUsd,
            latencyMs: r.latencyMs,
            proposed: r.proposed,
            kept: r.kept,
            dropped: r.dropped,
            error: r.error,
            createdAt: r.createdAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
          })),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/memories/search",
    async handler(ctx) {
      const query = ctx.query(searchMemoriesQuerySchema);
      const hits = await searchMemories(ctx.runtime.db, {
        query: query.q,
        limit: query.limit,
        ...(query.botId === undefined ? {} : { botId: query.botId }),
        ...(query.layers === undefined ? {} : { layers: query.layers }),
      });
      return {
        body: {
          items: hits.map((h) => ({
            memory: toMemoryDto(h.memory),
            ...splitExcerpt(h.excerpt),
            rank: h.rank,
          })),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/messages/search",
    async handler(ctx) {
      const query = ctx.query(searchMessagesQuerySchema);
      const hits = await searchMessages(ctx.runtime.db, {
        query: query.q,
        limit: query.limit,
        ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
        ...(query.botId === undefined ? {} : { botId: query.botId }),
      });
      return {
        body: {
          items: hits.map((h) => ({
            message: toMessageDto(h.message),
            ...splitExcerpt(h.excerpt),
            rank: h.rank,
          })),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories",
    async handler(ctx) {
      const body = ctx.body(addMemoryBodySchema);
      const { db } = ctx.runtime;
      checkLayerRules(body);
      if (body.botId !== undefined && (await getBot(db, body.botId)) === null) {
        throw new HttpError("invalid_request", "botId: bot não encontrado.");
      }
      const memory = await addMemory(db, {
        layer: body.layer,
        text: body.text.trim(),
        createdBy: "user",
        ...(body.scope === undefined ? {} : { scope: body.scope }),
        ...(body.botId === undefined ? {} : { botId: body.botId }),
      });
      return { status: 201, body: toMemoryDto(memory) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/memories/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(editMemoryBodySchema);
      const memory = await updateMemory(ctx.runtime.db, id, body.text.trim());
      if (memory === null) throw new HttpError("not_found", "Memória não encontrada.");
      return { body: toMemoryDto(memory) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories/:id/archive",
    async handler(ctx) {
      const memory = await archiveMemory(ctx.runtime.db, ctx.uuid("id"));
      if (memory === null) throw new HttpError("not_found", "Memória não encontrada.");
      return { body: toMemoryDto(memory) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories/:id/restore",
    async handler(ctx) {
      const memory = await restoreMemory(ctx.runtime.db, ctx.uuid("id"));
      if (memory === null) throw new HttpError("not_found", "Memória não encontrada.");
      return { body: toMemoryDto(memory) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories/:id/confirm",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const found = await getMemory(ctx.runtime.db, id);
      if (found === null) throw new HttpError("not_found", "Memória não encontrada.");
      if (found.status !== "pending") {
        throw new HttpError("conflict", "Esta memória não está esperando confirmação.");
      }
      const memory = await confirmMemory(ctx.runtime.db, id);
      if (memory === null) throw new HttpError("not_found", "Memória não encontrada.");
      return { body: toMemoryDto(memory) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories/:id/reject",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const found = await getMemory(ctx.runtime.db, id);
      if (found === null) throw new HttpError("not_found", "Memória não encontrada.");
      if (found.status !== "pending") {
        throw new HttpError("conflict", "Esta memória não está esperando confirmação.");
      }
      const memory = await rejectMemory(ctx.runtime.db, id);
      if (memory === null) throw new HttpError("not_found", "Memória não encontrada.");
      return { body: toMemoryDto(memory) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/memories/:id/revisions",
    async handler(ctx) {
      const id = ctx.uuid("id");
      if ((await getMemory(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Memória não encontrada.");
      }
      const items = await listMemoryRevisions(ctx.runtime.db, id);
      return {
        body: {
          items: items.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
          })),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/v1/memories/:id/revisions/:revisionId/undo",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const revisionId = ctx.uuid("revisionId");
      const { db } = ctx.runtime;
      const revisions = await listMemoryRevisions(db, id, 1000);
      if (!revisions.some((r) => r.id === revisionId)) {
        throw new HttpError("not_found", "Mudança não encontrada nesta memória.");
      }
      try {
        return { body: toMemoryDto(await undoMemoryRevision(db, revisionId)) };
      } catch (error) {
        if (error instanceof RevisionError) {
          throw new HttpError(error.code === "not_found" ? "not_found" : "conflict", error.message);
        }
        throw error;
      }
    },
  },
];
