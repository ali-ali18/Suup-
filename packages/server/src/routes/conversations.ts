import {
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  markReadBodySchema,
  sendMessageBodySchema,
} from "@suup/api";
import {
  getConversation,
  listActiveConversationRuns,
  listConversations,
  listMessages,
  markConversationRead,
} from "@suup/db";
import { sendMessage } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toConversationDto, toMessageDto, toRunDto } from "../mappers.js";

export const conversationRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/conversations",
    async handler(ctx) {
      const query = ctx.query(listConversationsQuerySchema);
      const { db } = ctx.runtime;
      const views = await listConversations(db, {
        includeArchived: query.includeArchived === true,
        limit: query.limit,
      });
      const active = await listActiveConversationRuns(
        db,
        views.map((v) => v.id),
      );
      return { body: { items: views.map((v) => toConversationDto(v, active.get(v.id) ?? null)) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/conversations/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const { db } = ctx.runtime;
      const view = await getConversation(db, id);
      if (view === null) throw new HttpError("not_found", "Conversa não encontrada.");
      const active = (await listActiveConversationRuns(db, [id])).get(id) ?? null;
      return { body: toConversationDto(view, active) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/conversations/:id/messages",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const query = ctx.query(listMessagesQuerySchema);
      const { db } = ctx.runtime;
      if ((await getConversation(db, id)) === null) {
        throw new HttpError("not_found", "Conversa não encontrada.");
      }
      // One more than asked for tells whether there is another page.
      const rows = await listMessages(db, id, {
        limit: query.limit + 1,
        ...(query.before === undefined ? {} : { beforeSeq: query.before }),
        ...(query.after === undefined ? {} : { afterSeq: query.after }),
      });
      const forward = query.after !== undefined && query.before === undefined;
      const hasMore = rows.length > query.limit;
      // Ascending order either way; the extra row is the farthest one from the cursor.
      const items = hasMore ? (forward ? rows.slice(0, query.limit) : rows.slice(1)) : rows;
      return { body: { items: items.map(toMessageDto), hasMore } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/conversations/:id/messages",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(sendMessageBodySchema);
      const sent = await sendMessage(ctx.runtime, { conversationId: id, text: body.text });
      return {
        status: 201,
        body: {
          message: toMessageDto(sent.message),
          run: toRunDto(sent.run),
          queuedForRun: sent.queuedForRun === true,
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/v1/conversations/:id/read",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(markReadBodySchema);
      const { db } = ctx.runtime;
      const view = await markConversationRead(db, id, body.upToSeq);
      if (view === null) throw new HttpError("not_found", "Conversa não encontrada.");
      const active = (await listActiveConversationRuns(db, [id])).get(id) ?? null;
      return { body: toConversationDto(view, active) };
    },
  },
];
