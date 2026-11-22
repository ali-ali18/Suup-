// `/v1/routines` (docs/ROTINAS.md) and `/v1/user-settings` (the user's time zone). The schedule is
// structured fields, validated by the shared schema; the server computes the next run in the
// routine's own zone.
import {
  createRoutineBodySchema,
  listRoutineFiresQuerySchema,
  listRoutinesQuerySchema,
  type Routine as RoutineDto,
  type RoutineFire as RoutineFireDto,
  updateRoutineBodySchema,
  updateUserSettingsBodySchema,
} from "@suup/api";
import {
  createRoutine,
  deleteRoutine,
  getBot,
  getRoutine,
  listRoutineFires,
  listRoutines,
  type Routine,
  RoutineError,
  type RoutineFire,
  runRoutineNow,
  setUserTimeZone,
  UserSettingsError,
  updateRoutine,
} from "@suup/db";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toRoutineFireDto(fire: RoutineFire): RoutineFireDto {
  return {
    id: fire.id,
    routineId: fire.routineId,
    scheduledFor: fire.scheduledFor.toISOString(),
    kind: fire.kind,
    status: fire.status,
    skipReason: fire.skipReason,
    missedCount: fire.missedCount,
    runId: fire.runId,
    resultText: fire.resultText,
    messageId: fire.messageId,
    createdAt: fire.createdAt.toISOString(),
    finishedAt: iso(fire.finishedAt),
  };
}

export function toRoutineDto(routine: Routine): RoutineDto {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    instruction: routine.instruction,
    triggerKind: routine.triggerKind,
    schedule: routine.schedule,
    timeZone: routine.timeZone,
    status: routine.status,
    nextRunAt: iso(routine.nextRunAt),
    state: routine.state,
    costCapUsd: routine.costCapUsd,
    createdBy: routine.createdBy,
    createdAt: routine.createdAt.toISOString(),
    updatedAt: routine.updatedAt.toISOString(),
    endedAt: iso(routine.endedAt),
    lastFire: routine.lastFire === null ? null : toRoutineFireDto(routine.lastFire),
  };
}

function routineHttpError(error: unknown): unknown {
  if (error instanceof RoutineError) {
    const code =
      error.code === "not_found"
        ? "not_found"
        : error.code === "invalid" || error.code === "never_fires"
          ? "invalid_request"
          : "conflict";
    return new HttpError(code, error.message, { cause: error });
  }
  if (error instanceof UserSettingsError) {
    return new HttpError("invalid_request", error.message, { cause: error });
  }
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw routineHttpError(error);
  }
}

export const routineRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/user-settings",
    async handler(ctx) {
      const zone = await ctx.runtime.userTimeZone();
      return { body: { timeZone: zone.timeZone, timeZoneSource: zone.source } };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/user-settings",
    async handler(ctx) {
      const body = ctx.body(updateUserSettingsBodySchema);
      await guarded(() =>
        setUserTimeZone(ctx.runtime.db, { timeZone: body.timeZone, source: body.source }),
      );
      const zone = await ctx.runtime.userTimeZone();
      return { body: { timeZone: zone.timeZone, timeZoneSource: zone.source } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/routines",
    async handler(ctx) {
      const query = ctx.query(listRoutinesQuerySchema);
      const rows = await listRoutines(
        ctx.runtime.db,
        query.botId === undefined ? {} : { botId: query.botId },
      );
      return { body: { items: rows.map(toRoutineDto) } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/routines",
    async handler(ctx) {
      const body = ctx.body(createRoutineBodySchema);
      const bot = await getBot(ctx.runtime.db, body.botId);
      if (bot === null) throw new HttpError("not_found", "Bot não encontrado.");
      const zone = body.timeZone ?? (await ctx.runtime.userTimeZone()).timeZone;
      if (zone === null) {
        throw new HttpError(
          "invalid_request",
          "timeZone: o fuso do usuário ainda não é conhecido; informe timeZone ou escolha o fuso em Configurações > Geral.",
        );
      }
      const routine = await guarded(() =>
        createRoutine(ctx.runtime.db, {
          botId: body.botId,
          name: body.name,
          instruction: body.instruction,
          schedule: body.schedule,
          timeZone: zone,
          ...(body.costCapUsd === undefined || body.costCapUsd === null
            ? {}
            : { costCapUsd: String(body.costCapUsd) }),
          createdBy: "user",
        }),
      );
      return { status: 201, body: toRoutineDto(routine) };
    },
  },
  {
    method: "GET",
    pattern: "/v1/routines/:id",
    async handler(ctx) {
      const routine = await getRoutine(ctx.runtime.db, ctx.uuid("id"));
      if (routine === null) throw new HttpError("not_found", "Rotina não encontrada.");
      return { body: toRoutineDto(routine) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/routines/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(updateRoutineBodySchema);
      const routine = await guarded(() =>
        updateRoutine(ctx.runtime.db, id, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
          ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
          ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
          ...(body.paused === undefined ? {} : { paused: body.paused }),
          ...(body.costCapUsd === undefined
            ? {}
            : { costCapUsd: body.costCapUsd === null ? null : String(body.costCapUsd) }),
        }),
      );
      return { body: toRoutineDto(routine) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/routines/:id",
    async handler(ctx) {
      const deleted = await deleteRoutine(ctx.runtime.db, ctx.uuid("id"));
      if (!deleted) throw new HttpError("not_found", "Rotina não encontrada.");
      return { body: { deleted: true } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/routines/:id/run",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const fired = await guarded(() => runRoutineNow(ctx.runtime.db, id));
      return { status: 202, body: { fire: toRoutineFireDto(fired.fire) } };
    },
  },
  {
    method: "GET",
    pattern: "/v1/routines/:id/fires",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const query = ctx.query(listRoutineFiresQuerySchema);
      if ((await getRoutine(ctx.runtime.db, id)) === null) {
        throw new HttpError("not_found", "Rotina não encontrada.");
      }
      const fires = await listRoutineFires(
        ctx.runtime.db,
        id,
        query.limit === undefined ? {} : { limit: query.limit },
      );
      return { body: { items: fires.map(toRoutineFireDto) } };
    },
  },
];
