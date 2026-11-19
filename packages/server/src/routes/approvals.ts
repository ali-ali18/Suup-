import {
  createRuleBodySchema,
  decideApprovalBodySchema,
  listApprovalsQuerySchema,
  listRulesQuerySchema,
  updateRuleBodySchema,
} from "@suup/api";
import {
  createRule,
  decideApproval,
  deleteRule,
  getApproval,
  getBot,
  getConversation,
  getRule,
  listApprovals,
  listRules,
  updateRule,
} from "@suup/db";
import { z } from "zod";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toApprovalDto, toRuleDto } from "../mappers.js";

const nestedQuerySchema = listApprovalsQuerySchema.omit({ conversationId: true });

export const approvalRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/approvals",
    async handler(ctx) {
      const query = ctx.query(listApprovalsQuerySchema);
      const rows = await listApprovals(ctx.runtime.db, {
        limit: query.limit,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.botId === undefined ? {} : { botId: query.botId }),
        ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
        ...(query.runId === undefined ? {} : { runId: query.runId }),
      });
      return { body: { items: rows.map(toApprovalDto) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/conversations/:id/approvals",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const query = ctx.query(nestedQuerySchema);
      if ((await getConversation(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Conversa não encontrada.");
      }
      const rows = await listApprovals(ctx.runtime.db, {
        limit: query.limit,
        conversationId: id,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.botId === undefined ? {} : { botId: query.botId }),
        ...(query.runId === undefined ? {} : { runId: query.runId }),
      });
      return { body: { items: rows.map(toApprovalDto) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/approvals/:id",
    async handler(ctx) {
      const approval = await getApproval(ctx.runtime.db, ctx.uuid("id"));
      if (approval === null) throw new HttpError("not_found", "Aprovação não encontrada.");
      return { body: toApprovalDto(approval) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/approvals/:id/decision",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(decideApprovalBodySchema);
      const { db } = ctx.runtime;
      const { approval, ruleId } = await decideApproval(
        db,
        id,
        body.decision === "approve"
          ? {
              decision: "approved",
              ...(body.allowRecipient === true ? { allowRecipient: true } : {}),
            }
          : { decision: "denied", reason: body.reason },
      );
      const rule = ruleId === null ? null : await getRule(db, ruleId);
      return { body: { approval: toApprovalDto(approval), rule: rule && toRuleDto(rule) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/approval-rules",
    async handler(ctx) {
      const query = ctx.query(listRulesQuerySchema);
      const rules = await listRules(ctx.runtime.db, {
        ...(query.botId === undefined ? {} : { botId: query.botId }),
      });
      return { body: { items: rules.map(toRuleDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/approval-rules",
    async handler(ctx) {
      const body = ctx.body(createRuleBodySchema);
      const { db } = ctx.runtime;
      if (
        body.botId !== undefined &&
        body.botId !== null &&
        (await getBot(db, body.botId)) === null
      ) {
        throw new HttpError("invalid_request", "botId: bot não encontrado.");
      }
      const rule = await createRule(db, {
        tool: body.tool,
        effect: body.effect,
        botId: body.botId ?? null,
        ...(body.matchers === undefined ? {} : { matchers: body.matchers }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return { status: 201, body: toRuleDto(rule) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/approval-rules/:id",
    async handler(ctx) {
      const body = ctx.body(updateRuleBodySchema);
      const rule = await updateRule(ctx.runtime.db, ctx.uuid("id"), {
        ...(body.effect === undefined ? {} : { effect: body.effect }),
        ...(body.matchers === undefined ? {} : { matchers: body.matchers }),
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      if (rule === null) throw new HttpError("not_found", "Regra não encontrada.");
      return { body: toRuleDto(rule) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/approval-rules/:id",
    async handler(ctx) {
      const gone = await deleteRule(ctx.runtime.db, ctx.uuid("id"));
      if (!gone) throw new HttpError("not_found", "Regra não encontrada.");
      return { body: z.object({ deleted: z.literal(true) }).parse({ deleted: true }) };
    },
  },
];
