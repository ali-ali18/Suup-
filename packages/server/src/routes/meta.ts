import { doctorQuerySchema, type ModelInfo, type ToolInfo } from "@suup/api";
import { MEMORY_TOOL_NAMES } from "@suup/core";
import { runDoctorChecks } from "@suup/runtime";
import type { Route } from "../http.js";

const CONTROL_TOOLS = ["plan", "finish", "escalate"];

/** The first sentence of a tool's description (what it is told to the model, cut for a form). */
function summaryOf(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length <= 200 ? sentence : `${sentence.slice(0, 199)}…`;
}

export const metaRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/models",
    async handler(ctx) {
      const { runtime } = ctx;
      const items: ModelInfo[] = runtime.config.models.map((model) => {
        const provider = runtime.config.providers.find((p) => p.id === model.provider);
        const status = runtime.keyStatus(model.provider);
        return {
          id: model.id,
          provider: model.provider,
          providerKind: provider?.kind ?? "openai-compatible",
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          priced: model.pricing !== undefined,
          available: status.ok,
          unavailableReason: status.ok ? null : status.reason,
        };
      });
      return { body: { items } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/info",
    async handler(ctx) {
      const zone = await ctx.runtime.userTimeZone();
      return { body: { timeZone: zone.timeZone, timeZoneSource: zone.source } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/tools",
    async handler(ctx) {
      const items: ToolInfo[] = ctx.runtime.tools.list().map((tool) => ({
        name: tool.name,
        summary: summaryOf(tool.description),
        risk: tool.risk,
        dynamicRisk: tool.classify !== undefined,
        acceptsSecrets: (tool.secretFields?.length ?? 0) > 0,
        externalOutput: tool.externalOutput === true,
        memory: (MEMORY_TOOL_NAMES as readonly string[]).includes(tool.name),
      }));
      // `request_secret` exists only where there is a vault to put the answer in.
      const control =
        ctx.runtime.vault.settings === undefined
          ? CONTROL_TOOLS
          : [...CONTROL_TOOLS, "request_secret"];
      return { body: { items, control } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/doctor",
    timeoutMs: 180_000,
    async handler(ctx) {
      const query = ctx.query(doctorQuerySchema);
      const checks = await runDoctorChecks(ctx.runtime, {
        live: query.live === true,
        sandbox: ctx.doctorSandbox,
        // A stdio connector runs where the worker runs: an API-only server cannot vouch for it.
        connectors: ctx.doctorSandbox,
      });
      return { body: { ok: checks.every((c) => c.ok), checks } };
    },
  },
];
