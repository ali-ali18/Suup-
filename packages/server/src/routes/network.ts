import type { BotNetwork } from "@suup/api";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { iso } from "../mappers.js";

async function viewOf(
  ctx: Parameters<Route["handler"]>[0],
  botId: string,
): Promise<{ body: BotNetwork }> {
  const view = await ctx.runtime.network.forBot(botId);
  return {
    body: {
      defaults: view.defaults,
      hosts: view.hosts.map((h) => ({
        host: h.host,
        createdBy: h.createdBy,
        createdAt: iso(h.createdAt),
      })),
      refusals: view.refusals.map((r) => ({
        host: r.host,
        port: r.port,
        reason: r.reason,
        message: r.message,
        createdAt: iso(r.createdAt),
      })),
    },
  };
}

/**
 * The network allowlist of the bots' machines (docs/REDE.md). Adding a host is the user acting
 * (a rule that lives until removed); a host a bot asks for on a card only lasts for that run.
 */
export const networkRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/bots/:botId/network",
    handler: (ctx) => viewOf(ctx, ctx.uuid("botId")),
  },
  {
    method: "PUT",
    pattern: "/v1/bots/:botId/network/hosts/:host",
    async handler(ctx) {
      const botId = ctx.uuid("botId");
      await ctx.runtime.network.allow(botId, ctx.params.host ?? "");
      return viewOf(ctx, botId);
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/bots/:botId/network/hosts/:host",
    async handler(ctx) {
      const botId = ctx.uuid("botId");
      const gone = await ctx.runtime.network.remove(botId, ctx.params.host ?? "");
      if (!gone) throw new HttpError("not_found", "Esse host não está na lista deste bot.");
      return viewOf(ctx, botId);
    },
  },
];
