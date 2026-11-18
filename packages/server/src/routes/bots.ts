import {
  botDraftSchema,
  createBotBodySchema,
  draftBotBodySchema,
  listBotsQuerySchema,
  updateBotBodySchema,
} from "@suup/api";
import {
  archiveBot,
  ConversationRuleError,
  createBot,
  createDirectConversation,
  getBot,
  getBotSummary,
  getConversation,
  listActiveConversationRuns,
  listBotSummaries,
  setDefaultBot,
  updateBot,
} from "@suup/db";
import { draftBot, type Runtime, RuntimeError } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toBotDto, toConversationDto } from "../mappers.js";

/** The model and provider of a bot from an `id` of the configuration (`invalid_request` if unknown). */
function modelOf(runtime: Runtime, modelId: string) {
  try {
    return runtime.resolveModel(modelId);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === "unknown_model") {
      throw new HttpError("invalid_request", `modelId: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function checkTools(runtime: Runtime, names: readonly string[]): string[] {
  const known = runtime.tools.list().map((t) => t.name);
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length > 0) {
    throw new HttpError(
      "invalid_request",
      `allowedTools: ferramenta${unknown.length > 1 ? "s" : ""} desconhecida${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (disponíveis: ${known.join(", ")}).`,
    );
  }
  return [...new Set(names)];
}

export const botRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/bots",
    async handler(ctx) {
      const query = ctx.query(listBotsQuerySchema);
      const items = await listBotSummaries(ctx.runtime.db, {
        includeArchived: query.includeArchived === true,
      });
      return { body: { items: items.map(toBotDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/bots/draft",
    timeoutMs: 180_000,
    async handler(ctx) {
      const body = ctx.body(draftBotBodySchema);
      const { runtime } = ctx;
      let modelId = body.modelId;
      if (modelId === undefined) {
        const main = (await listBotSummaries(runtime.db)).find((s) => s.bot.isDefault === true);
        modelId = main?.bot.modelId ?? runtime.config.models[0]?.id;
      }
      if (modelId === undefined)
        throw new HttpError("invalid_request", "Nenhum modelo configurado.");
      modelOf(runtime, modelId);
      const draft = await draftBot(runtime, { description: body.description, modelId });
      return { body: botDraftSchema.parse(draft) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/bots/:id",
    async handler(ctx) {
      const summary = await getBotSummary(ctx.runtime.db, ctx.uuid("id"));
      if (summary === null) throw new HttpError("not_found", "Bot não encontrado.");
      return { body: toBotDto(summary) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/bots",
    async handler(ctx) {
      const body = ctx.body(createBotBodySchema);
      const { runtime } = ctx;
      const { model, provider } = modelOf(runtime, body.modelId);
      const bot = await createBot(runtime.db, {
        name: body.name,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.personality === undefined ? {} : { personality: body.personality }),
        modelProvider: provider.id,
        modelId: model.id,
        allowedTools: checkTools(runtime, body.allowedTools ?? []),
        ...(body.limits === undefined ? {} : { limits: body.limits }),
        ...(body.avatar === undefined ? {} : { avatar: body.avatar }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned }),
        ...(body.groupName === undefined ? {} : { groupName: body.groupName }),
        ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
        ...(body.color === undefined ? {} : { color: body.color }),
      });
      const summary = await getBotSummary(runtime.db, bot.id);
      return {
        status: 201,
        body: toBotDto(summary ?? { bot, latestRun: null, conversationId: null, unreadCount: 0 }),
      };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/bots/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(updateBotBodySchema);
      const { runtime } = ctx;
      const current = await getBot(runtime.db, id);
      if (current === null) throw new HttpError("not_found", "Bot não encontrado.");
      const patch: Parameters<typeof updateBot>[2] = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.personality !== undefined) patch.personality = body.personality;
      if (body.modelId !== undefined) {
        const { model, provider } = modelOf(runtime, body.modelId);
        patch.modelId = model.id;
        patch.modelProvider = provider.id;
      }
      if (body.allowedTools !== undefined)
        patch.allowedTools = checkTools(runtime, body.allowedTools);
      if (body.limits !== undefined) patch.limits = body.limits;
      if (body.avatar !== undefined) patch.avatar = body.avatar;
      if (body.pinned !== undefined) patch.pinned = body.pinned;
      if (body.groupName !== undefined) patch.groupName = body.groupName;
      if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
      if (body.color !== undefined) patch.color = body.color;
      await updateBot(runtime.db, id, patch);
      const summary = await getBotSummary(runtime.db, id);
      if (summary === null) throw new HttpError("not_found", "Bot não encontrado.");
      return { body: toBotDto(summary) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/bots/:id/archive",
    async handler(ctx) {
      const id = ctx.uuid("id");
      if ((await archiveBot(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Bot não encontrado.");
      }
      const summary = await getBotSummary(ctx.runtime.db, id);
      return { body: toBotDto(summary as NonNullable<typeof summary>) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/bots/:id/default",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const bot = await getBot(ctx.runtime.db, id);
      if (bot === null) throw new HttpError("not_found", "Bot não encontrado.");
      if (bot.archivedAt !== null) {
        throw new HttpError("conflict", "Um bot arquivado não pode ser o principal.");
      }
      await setDefaultBot(ctx.runtime.db, id);
      const summary = await getBotSummary(ctx.runtime.db, id);
      return { body: toBotDto(summary as NonNullable<typeof summary>) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/bots/:id/conversation",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const { db } = ctx.runtime;
      if ((await getBot(db, id)) === null) throw new HttpError("not_found", "Bot não encontrado.");
      let view = null;
      try {
        view = await createDirectConversation(db, id);
      } catch (error) {
        if (error instanceof ConversationRuleError) {
          throw new HttpError("conflict", "O bot está arquivado: não abre conversa nova.", {
            cause: error,
          });
        }
        throw error;
      }
      const conversation = (await getConversation(db, view.id)) ?? view;
      const active =
        (await listActiveConversationRuns(db, [conversation.id])).get(conversation.id) ?? null;
      return { body: toConversationDto(conversation, active) };
    },
  },
];
