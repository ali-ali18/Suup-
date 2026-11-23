import { listRunsQuerySchema, runEventsQuerySchema } from "@suup/api";
import { cancelRun, getRun, listRunEvents, listRuns, pauseRun, resumeRun } from "@suup/db";
import { applyStatusEffects, finishRun } from "@suup/runtime";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";
import { toRunDto, toRunEventDto } from "../mappers.js";

export const runRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/runs",
    async handler(ctx) {
      const query = ctx.query(listRunsQuerySchema);
      const rows = await listRuns(ctx.runtime.db, {
        limit: query.limit + 1,
        ...(query.botId === undefined ? {} : { botId: query.botId }),
        ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.before === undefined ? {} : { before: new Date(query.before) }),
      });
      const hasMore = rows.length > query.limit;
      return { body: { items: rows.slice(0, query.limit).map(toRunDto), hasMore } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/runs/:id",
    async handler(ctx) {
      const run = await getRun(ctx.runtime.db, ctx.uuid("id"));
      if (run === null) throw new HttpError("not_found", "Execução não encontrada.");
      return { body: toRunDto(run) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/runs/:id/events",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const query = ctx.query(runEventsQuerySchema);
      const { db } = ctx.runtime;
      if ((await getRun(db, id)) === null) {
        throw new HttpError("not_found", "Execução não encontrada.");
      }
      const rows = await listRunEvents(db, id, {
        afterSeq: query.afterSeq,
        limit: query.limit + 1,
        slim: query.view === "chat",
        ...(query.types === undefined ? {} : { types: query.types }),
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit).map(toRunEventDto);
      return { body: { items, hasMore, lastSeq: items.at(-1)?.seq ?? query.afterSeq } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/pause",
    async handler(ctx) {
      return { body: toRunDto(await pauseRun(ctx.runtime.db, ctx.uuid("id"))) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/interrupt",
    async handler(ctx) {
      return { body: toRunDto(await pauseRun(ctx.runtime.db, ctx.uuid("id"), { hard: true })) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/resume",
    async handler(ctx) {
      return { body: toRunDto(await resumeRun(ctx.runtime.db, ctx.uuid("id"))) };
    },
  },
  {
    method: "POST",
    pattern: "/v1/runs/:id/cancel",
    async handler(ctx) {
      const { db } = ctx.runtime;
      const run = await cancelRun(db, ctx.uuid("id"), {
        onStatusSet: async (tx, done) => {
          await applyStatusEffects(tx, done);
        },
      });
      // A run nobody holds (waiting for an approval) is cancelled right here: the conversation
      // gets its notice now. Any other is cancelled by the worker, which writes the notice itself.
      if (run.status === "cancelled")
        await finishRun(db, run.id, { redact: (value) => ctx.runtime.redactJson(value) });
      return { body: toRunDto(run) };
    },
  },
];
