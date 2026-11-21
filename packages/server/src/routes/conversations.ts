import {
  decideTeamBodySchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  markReadBodySchema,
  sendMessageBodySchema,
} from "@suup/api";
import {
  decideTeamProposal,
  getBotSummary,
  getConversation,
  listActiveConversationRuns,
  listBotSummaries,
  listConversations,
  listMessages,
  markConversationRead,
  TeamProposalError,
} from "@suup/db";
import { sendMessage } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toBotDto, toConversationDto, toMessageDto, toRunDto } from "../mappers.js";

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
  {
    // The user's decision on a team card (the main bot's welcome). The ONLY way a proposal becomes
    // bots: through `createBot`, the same call as `POST /v1/bots`, with what the "Criar novo Bot"
    // form gives a new bot (the main bot's model and tools).
    method: "POST",
    pattern: "/v1/messages/:id/team",
    async handler(ctx) {
      const messageId = ctx.uuid("id");
      const body = ctx.body(decideTeamBodySchema);
      const { runtime } = ctx;
      const { db } = runtime;
      const main = (await listBotSummaries(db)).find((s) => s.bot.isDefault === true)?.bot;
      const fallbackModel = runtime.config.models[0]?.id;
      const modelId = main?.modelId ?? fallbackModel;
      if (modelId === undefined) throw new HttpError("conflict", "Nenhum modelo configurado.");
      const { provider } = runtime.resolveModel(modelId);
      try {
        const decided = await decideTeamProposal(
          db,
          messageId,
          "dismiss" in body
            ? { kind: "dismiss" }
            : {
                kind: "create",
                picks: body.create.map((p) => ({
                  index: p.index,
                  ...(p.avatar === undefined ? {} : { avatar: p.avatar }),
                  ...(p.color === undefined ? {} : { color: p.color }),
                })),
              },
          {
            modelProvider: provider.id,
            modelId,
            allowedTools: main?.allowedTools ?? runtime.tools.list().map((t) => t.name),
          },
        );
        const bots = [];
        for (const bot of decided.created) {
          const summary = await getBotSummary(db, bot.id);
          if (summary !== null) bots.push(toBotDto(summary));
        }
        return { body: { message: toMessageDto(decided.message), bots } };
      } catch (error) {
        if (error instanceof TeamProposalError) {
          throw new HttpError(
            error.code === "not_found"
              ? "not_found"
              : error.code === "invalid_pick"
                ? "invalid_request"
                : "conflict",
            error.message,
            { cause: error },
          );
        }
        throw error;
      }
    },
  },
];
