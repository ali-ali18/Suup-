// `/v1/routines` (docs/ROTINAS.md) and `/v1/user-settings` (the user's time zone). The schedule is
// structured fields, validated by the shared schema; the server computes the next run in the
// routine's own zone.
import {
  createRoutineBodySchema,
  listRoutineFiresQuerySchema,
  listRoutinesQuerySchema,
  type Routine as RoutineDto,
  type RoutineFire as RoutineFireDto,
  type RoutineSource,
  updateRoutineBodySchema,
  updateUserSettingsBodySchema,
} from "@suup/api";
import {
  costCapText,
  createRoutine,
  deleteRoutine,
  getBot,
  getRoutine,
  listRoutineFires,
  listRoutines,
  listRunSources,
  type Routine,
  RoutineError,
  type RoutineFire,
  type RunSources,
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
    problem: routine.problem,
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

/** The most sources one fire shows (pages and connectors together). */
export const FIRE_SOURCES_MAX = 8;

/**
 * The sources of a fire's run: each page a tool declared it read, then each connector whose tool
 * answered. A tool is a connector's by the EXACT registered name the connector lists for it
 * (`connectorOfTool`), never by how the name looks.
 */
export function fireSources(
  used: RunSources | undefined,
  connectorOfTool: ReadonlyMap<string, string>,
): RoutineSource[] {
  if (used === undefined) return [];
  const out: RoutineSource[] = used.pages.map((p) => ({
    kind: "web" as const,
    url: p.url,
    title: p.title ?? null,
  }));
  for (const tool of used.tools) {
    const connector = connectorOfTool.get(tool);
    if (connector === undefined) continue;
    if (out.some((s) => s.kind === "connector" && s.connector === connector)) continue;
    out.push({ kind: "connector", connector });
  }
  return out.slice(0, FIRE_SOURCES_MAX);
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

/**
 * A routine the API shows: a one-time reminder of a bot is internal (docs/ROTINAS.md, "Lembrete de
 * uma vez"), never listed and never reachable by id, so the app cannot draw or change it.
 */
async function visibleRoutine(db: Parameters<typeof getRoutine>[0], id: string) {
  const routine = await getRoutine(db, id);
  if (routine === null || routine.reminder) {
    throw new HttpError("not_found", "Rotina não encontrada.");
  }
  return routine;
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
            : { costCapUsd: costCapText(body.costCapUsd) ?? String(body.costCapUsd) }),
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
      const routine = await visibleRoutine(ctx.runtime.db, ctx.uuid("id"));
      return { body: toRoutineDto(routine) };
    },
  },
  {
    method: "PATCH",
    pattern: "/v1/routines/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      const body = ctx.body(updateRoutineBodySchema);
      await visibleRoutine(ctx.runtime.db, id);
      const routine = await guarded(() =>
        updateRoutine(ctx.runtime.db, id, {
          actor: "owner",
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
          ...(body.schedule === undefined ? {} : { schedule: body.schedule }),
          ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
          ...(body.paused === undefined ? {} : { paused: body.paused }),
          ...(body.costCapUsd === undefined
            ? {}
            : {
                costCapUsd:
                  body.costCapUsd === null
                    ? null
                    : (costCapText(body.costCapUsd) ?? String(body.costCapUsd)),
              }),
        }),
      );
      return { body: toRoutineDto(routine) };
    },
  },
  {
    method: "DELETE",
    pattern: "/v1/routines/:id",
    async handler(ctx) {
      const id = ctx.uuid("id");
      await visibleRoutine(ctx.runtime.db, id);
      const deleted = await deleteRoutine(ctx.runtime.db, id, "owner");
      if (!deleted) throw new HttpError("not_found", "Rotina não encontrada.");
      return { body: { deleted: true } };
    },
  },
  {
    method: "POST",
    pattern: "/v1/routines/:id/run",
    async handler(ctx) {
      const id = ctx.uuid("id");
      await visibleRoutine(ctx.runtime.db, id);
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
      await visibleRoutine(ctx.runtime.db, id);
      const fires = await listRoutineFires(
        ctx.runtime.db,
        id,
        query.limit === undefined ? {} : { limit: query.limit },
      );
      const runIds = fires.flatMap((f) => (f.runId === null ? [] : [f.runId]));
      const used = await listRunSources(ctx.runtime.db, runIds);
      // Which connector each registered tool name belongs to, as the connectors list them.
      const connectorOfTool = new Map<string, string>();
      if (used.size > 0) {
        for (const connector of await ctx.runtime.connectors.list()) {
          for (const tool of connector.tools ?? []) connectorOfTool.set(tool.name, connector.name);
        }
      }
      return {
        body: {
          items: fires.map((f) => ({
            ...toRoutineFireDto(f),
            sources: fireSources(f.runId === null ? undefined : used.get(f.runId), connectorOfTool),
          })),
        },
      };
    },
  },
];
