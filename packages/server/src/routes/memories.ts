import {
  addMemoryBodySchema,
  editMemoryBodySchema,
  listMemoriesQuerySchema,
  searchMemoriesQuerySchema,
  searchMessagesQuerySchema,
} from "@suup/api";
import {
  addMemory,
  archiveMemory,
  getBot,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  listMemories,
  restoreMemory,
  searchMemories,
  searchMessages,
  updateMemory,
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
      });
      return { body: { items: rows.map(toMemoryDto) } };
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
];
