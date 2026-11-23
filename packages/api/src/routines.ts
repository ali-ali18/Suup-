// Routines (docs/ROTINAS.md): the contract of `/v1/routines` and `/v1/user-settings`. The schedule
// is structured fields (`schedule.ts`, the same module the server computes the next run with and the
// app describes it in words with): no cron text anywhere.
import { z } from "zod";
import { isoDate, list, uuid } from "./common.js";
import { isKnownTimeZone, scheduleSchema } from "./schedule.js";

export const ROUTINE_STATUSES = ["active", "paused", "ended"] as const;
export const ROUTINE_FIRE_KINDS = ["scheduled", "catch_up", "manual"] as const;
export const ROUTINE_FIRE_STATUSES = ["running", "done", "failed", "cancelled", "skipped"] as const;

/**
 * What a fire's run used, from its recorded tool calls (structured fields of the log, never its
 * text): a page a tool declared it read (`web_read`), or a connector whose tool answered.
 */
export const routineSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), url: z.string(), title: z.string().nullable() }),
  z.object({ kind: z.literal("connector"), connector: z.string() }),
]);
export type RoutineSource = z.infer<typeof routineSourceSchema>;

/** One fire of a routine, for the history. */
export const routineFireSchema = z.object({
  id: uuid,
  routineId: uuid,
  /** The time the schedule asked for (a "run now": the moment it was asked). */
  scheduledFor: isoDate,
  /** `scheduled` on time, `catch_up` late or after missed times, `manual` "Rodar agora". */
  kind: z.enum(ROUTINE_FIRE_KINDS),
  status: z.enum(ROUTINE_FIRE_STATUSES),
  /** `overlap`: the previous run of the routine was still going, so this one did not run. */
  skipReason: z.enum(["overlap"]).nullable(),
  /** Older scheduled times missed while nothing ran (the computer was off), folded into this one. */
  missedCount: z.number().int().nonnegative(),
  /** The run (open it to see what the bot did). */
  runId: uuid.nullable(),
  /** The routine's result: the bot's answer, or why it failed (`routine_result`). */
  resultText: z.string().nullable(),
  /** The message in the bot's chat with the result. */
  messageId: uuid.nullable(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
  /**
   * Only in `GET /v1/routines/{id}/fires`: the pages and connectors the run used, in the order it
   * used them, each once (empty: none, or the run did not use tools).
   */
  sources: z.exactOptional(z.array(routineSourceSchema)),
});
export type RoutineFire = z.infer<typeof routineFireSchema>;
export const routineFireListSchema = list(routineFireSchema);

export const routineSchema = z.object({
  id: uuid,
  botId: uuid,
  name: z.string(),
  instruction: z.string(),
  /** Today `schedule`; a monitor and a webhook are later kinds. */
  triggerKind: z.enum(["schedule"]),
  /** `null` when the stored schedule is not valid any more: see `problem`. */
  schedule: scheduleSchema.nullable(),
  /** Why the routine cannot run as it is (Portuguese, for the user); `null` when it can. */
  problem: z.string().nullable(),
  /** The IANA zone the schedule is read in. */
  timeZone: z.string(),
  status: z.enum(ROUTINE_STATUSES),
  /** `null` when paused or ended. */
  nextRunAt: isoDate.nullable(),
  /** The note the routine keeps between runs (written by its runs). */
  state: z.string(),
  /** The most one run may cost (US$, decimal text); `null`: no cap of its own. */
  costCapUsd: z.string().nullable(),
  /** `bot`: the bot created it in a conversation; `user`: created through the API. */
  createdBy: z.enum(["bot", "user"]),
  createdAt: isoDate,
  updatedAt: isoDate,
  endedAt: isoDate.nullable(),
  lastFire: routineFireSchema.nullable(),
});
export type Routine = z.infer<typeof routineSchema>;
export const routineListSchema = list(routineSchema);

export const listRoutinesQuerySchema = z.object({ botId: uuid.optional() });
export type ListRoutinesQuery = z.input<typeof listRoutinesQuerySchema>;

/** US$ 0.01 to 100, with at most 4 decimals (what the database column keeps). */
const costCap = z
  .number()
  .min(0.01)
  .max(100)
  .refine((n) => Number(n.toFixed(4)) === n, "no máximo 4 casas decimais");

export const createRoutineBodySchema = z.strictObject({
  botId: uuid,
  name: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(2000),
  schedule: scheduleSchema,
  /** Default: the user's time zone. */
  timeZone: z.string().optional(),
  costCapUsd: costCap.nullable().optional(),
});
export type CreateRoutineBody = z.input<typeof createRoutineBodySchema>;

/** Only the keys you send change. */
export const updateRoutineBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  instruction: z.string().trim().min(1).max(2000).optional(),
  schedule: scheduleSchema.optional(),
  timeZone: z.string().optional(),
  paused: z.boolean().optional(),
  costCapUsd: costCap.nullable().optional(),
});
export type UpdateRoutineBody = z.input<typeof updateRoutineBodySchema>;

export const listRoutineFiresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListRoutineFiresQuery = z.input<typeof listRoutineFiresQuerySchema>;

/** `POST /v1/routines/{id}/run`: the fire it opened. */
export const runRoutineResultSchema = z.object({ fire: routineFireSchema });

// ---------------------------------------------------------------------------------------------
// The user's settings

/**
 * `GET`/`PATCH /v1/user-settings`. The user's time zone is what routines and "now" mean, never the
 * server's: the app sends the zone of the user's computer (`source: "device"`), which fills the
 * blank but never replaces one the user chose in Configurações (`source: "user"`).
 */
export const userSettingsSchema = z.object({
  timeZone: z.string().nullable(),
  timeZoneSource: z.enum(["device", "user", "config"]).nullable(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateUserSettingsBodySchema = z.strictObject({
  timeZone: z
    .string()
    .refine(isKnownTimeZone, "não é um fuso horário IANA (por exemplo America/Sao_Paulo)"),
  source: z.enum(["device", "user"]),
});
export type UpdateUserSettingsBody = z.input<typeof updateUserSettingsBodySchema>;
