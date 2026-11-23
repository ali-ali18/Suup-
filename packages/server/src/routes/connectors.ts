import {
  approveToolBodySchema,
  connectorNameSchema,
  createConnectorBodySchema,
  grantConnectorBodySchema,
  setToolOutboundBodySchema,
  setToolRiskBodySchema,
  updateConnectorBodySchema,
} from "@suup/api";
import { getBot } from "@suup/db";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import {
  toCatalogItemDto,
  toConnectorDto,
  toConnectorEventDto,
  toConnectorReviewDto,
  toConnectorTestDto,
  toOAuthStatusDto,
} from "../mappers.js";

function nameOf(raw: string): string {
  const parsed = connectorNameSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError("not_found", "Conector não encontrado.");
  return parsed.data;
}

/**
 * MCP connectors (plan 4.11). Creating, changing or enabling one is the user acting: the token of
 * the server is the user. (A bot can only PROPOSE a gallery entry, on an approval card: the tool
 * `propose_connector`.) No response holds a credential: a connector only names vault secrets, and
 * an OAuth login answers only where it stands.
 */
export const connectorRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/connectors",
    async handler(ctx) {
      const items = await ctx.runtime.connectors.list();
      return { body: { items: items.map(toConnectorDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/connectors",
    async handler(ctx) {
      const body = ctx.body(createConnectorBodySchema);
      const { connectors } = ctx.runtime;
      for (const { botId } of body.grants ?? []) {
        if ((await getBot(ctx.runtime.db, botId)) === null) {
          throw new HttpError("invalid_request", `grants: bot ${botId} não encontrado.`);
        }
      }
      await connectors.create({
        name: body.name,
        description: body.description,
        transport: body.transport,
        scope: body.scope,
        tools: body.tools,
        trustAnnotations: body.trustAnnotations,
        timeoutMs: body.timeoutMs,
        enabled: body.enabled,
      });
      for (const g of body.grants ?? []) await connectors.grant(body.name, g.botId, g.tools);
      const created = await connectors.get(body.name);
      if (created === null) throw new HttpError("internal_error", "Erro interno do servidor.");
      return { status: 201, body: toConnectorDto(created) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/connectors/:name",
    async handler(ctx) {
      const found = await ctx.runtime.connectors.get(nameOf(ctx.params.name ?? ""));
      if (found === null) throw new HttpError("not_found", "Conector não encontrado.");
      return { body: toConnectorDto(found) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/connectors/:name",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(updateConnectorBodySchema);
      return { body: toConnectorDto(await ctx.runtime.connectors.update(name, body)) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/connectors/:name",
    async handler(ctx) {
      const gone = await ctx.runtime.connectors.remove(nameOf(ctx.params.name ?? ""));
      if (!gone) throw new HttpError("not_found", "Conector não encontrado.");
      return { body: { deleted: true } };
    },
  },
  {
    method: "PUT",
    pattern: "/v1/connectors/:name/grants/:botId",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(grantConnectorBodySchema);
      return {
        body: toConnectorDto(
          await ctx.runtime.connectors.grant(name, ctx.uuid("botId"), body.tools),
        ),
      };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/connectors/:name/grants/:botId",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      return { body: toConnectorDto(await ctx.runtime.connectors.revoke(name, ctx.uuid("botId"))) };
    },
  },
  {
    method: "PUT",
    pattern: "/v1/connectors/:name/tools/:tool/risk",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(setToolRiskBodySchema);
      return {
        body: toConnectorDto(
          await ctx.runtime.connectors.setToolRisk(name, ctx.params.tool ?? "", body.risk),
        ),
      };
    },
  },
  {
    method: "PUT",
    pattern: "/v1/connectors/:name/tools/:tool/outbound",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(setToolOutboundBodySchema);
      return {
        body: toConnectorDto(
          await ctx.runtime.connectors.setToolOutbound(name, ctx.params.tool ?? "", body.outbound),
        ),
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/connectors/:name/review",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const items = await ctx.runtime.connectors.review(name);
      return { body: { items: items.map(toConnectorReviewDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/connectors/:name/tools/:tool/review",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const body = ctx.body(approveToolBodySchema);
      return {
        body: toConnectorDto(
          await ctx.runtime.connectors.approveTool(name, ctx.params.tool ?? "", body.fingerprint),
        ),
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/connectors/:name/events",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const items = await ctx.runtime.connectors.events(name);
      return { body: { items: items.map(toConnectorEventDto) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/connector-catalog",
    async handler(ctx) {
      const items = await ctx.runtime.connectors.gallery.list();
      return { body: { items: items.map(toCatalogItemDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/connector-catalog/:id/install",
    async handler(ctx) {
      const parsed = connectorNameSchema.safeParse(ctx.params.id ?? "");
      if (!parsed.success) throw new HttpError("not_found", "A galeria não tem este conector.");
      const result = await ctx.runtime.connectors.gallery.install(parsed.data);
      const connector =
        result.item.connector === null
          ? null
          : await ctx.runtime.connectors.get(result.item.connector);
      if (connector === null) throw new HttpError("internal_error", "Erro interno do servidor.");
      return {
        body: {
          item: toCatalogItemDto(result.item),
          next: result.next,
          connector: toConnectorDto(connector),
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/v1/connectors/:name/oauth/start",
    timeoutMs: 60_000,
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      const started = await ctx.runtime.connectors.gallery.oauthStart(name);
      return {
        body: {
          authorizationUrl: started.authorizationUrl,
          flowId: started.flowId,
          redirectUri: started.redirectUri,
          expiresAt: started.expiresAt.toISOString(),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/v1/connectors/:name/oauth/status",
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      return { body: toOAuthStatusDto(await ctx.runtime.connectors.gallery.oauthStatus(name)) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/connectors/:name/oauth",
    timeoutMs: 30_000,
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      return { body: toConnectorDto(await ctx.runtime.connectors.gallery.oauthDisconnect(name)) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/connectors/:name/test",
    timeoutMs: 60_000,
    async handler(ctx) {
      const name = nameOf(ctx.params.name ?? "");
      return { body: toConnectorTestDto(await ctx.runtime.connectors.test(name)) };
    },
  },
];
