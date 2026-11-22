import { listTeamReviewsQuerySchema, updateSupervisorSettingsBodySchema } from "@suup/api";
import {
  getDefaultBot,
  getSupervisorSettings,
  listTeamReviews,
  type SupervisorSettingsPatch,
  updateSupervisorSettings,
} from "@suup/db";
import type { Route } from "../http.js";

/** The supervisor settings as the API says them (docs/SUPERVISOR.md). */
async function settingsBody(ctx: Parameters<Route["handler"]>[0]) {
  const { runtime } = ctx;
  const settings = await getSupervisorSettings(runtime.db);
  const principal = await getDefaultBot(runtime.db);
  let model: { available: boolean; id: string | null; reason: string | null };
  if (principal === null) {
    model = { available: false, id: null, reason: "Não há um bot principal." };
  } else {
    try {
      const { provider } = runtime.resolveModel(principal.modelId);
      const key = runtime.keyStatus(provider.id);
      model = {
        available: key.ok,
        id: principal.modelId,
        reason: key.ok ? null : key.reason,
      };
    } catch (error) {
      model = {
        available: false,
        id: principal.modelId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    reviewEnabled: settings.reviewEnabled,
    reviewTime: settings.reviewTime,
    morningTime: settings.morningTime,
    costCapUsd: settings.costCapUsd,
    timeZone: (await runtime.userTimeZone()).timeZone,
    model,
  };
}

export const supervisorRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/supervisor/settings",
    async handler(ctx) {
      return { body: await settingsBody(ctx) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/supervisor/settings",
    async handler(ctx) {
      const body = ctx.body(updateSupervisorSettingsBodySchema);
      await updateSupervisorSettings(ctx.runtime.db, body as SupervisorSettingsPatch);
      return { body: await settingsBody(ctx) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/supervisor/reviews",
    async handler(ctx) {
      const query = ctx.query(listTeamReviewsQuerySchema);
      const rows = await listTeamReviews(ctx.runtime.db, query.limit);
      return {
        body: {
          items: rows.map((r) => ({
            id: r.id,
            night: r.night,
            status: r.status,
            botsRead: r.botsRead,
            leftOver: r.leftOver,
            capReached: r.capReached,
            costCapUsd: r.costCapUsd,
            noted: r.noted,
            morningText: r.morningText,
            morningPostedAt: r.morningPostedAt?.toISOString() ?? null,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: r.costUsd,
            error: r.error,
            createdAt: r.createdAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
          })),
        },
      };
    },
  },
];
