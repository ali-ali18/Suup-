import { z } from "zod";
import { intQuery, isoDate, list, uuid } from "./common.js";

/** `HH:MM`, 24 hours, in the user's time zone. */
const clockTime = z.string().superRefine((value, ctx) => {
  const pieces = value.split(":");
  const [h, m] = pieces;
  const digits = "0123456789";
  const ok =
    pieces.length === 2 &&
    h?.length === 2 &&
    m?.length === 2 &&
    [...h, ...m].every((c) => digits.includes(c)) &&
    Number(h) <= 23 &&
    Number(m) <= 59;
  if (!ok) ctx.addIssue({ code: "custom", message: "use o formato HH:MM (de 00:00 a 23:59)" });
});

/**
 * What the user controls about the Principal as the supervisor of the team
 * (`GET`/`PATCH /v1/supervisor/settings`, docs/SUPERVISOR.md). Times are in the time zone of the
 * server's configuration (`defaults.timeZone`), which is also said here.
 */
export const supervisorSettingsSchema = z.object({
  /** The nightly review of what the other bots did. On by default. */
  reviewEnabled: z.boolean(),
  /** From this time on the night's review may start. Default `03:00`. */
  reviewTime: z.string(),
  /** The morning message is posted from this time on, if the review found something useful; `null`: never. Default `08:00`. */
  morningTime: z.string().nullable(),
  /** The most one night's review may cost, in US$; `null` (the default): no cap. */
  costCapUsd: z.number().nullable(),
  /** The time zone the times are in. */
  timeZone: z.string(),
  /** Whether the Principal's model can be used now (the review uses it). */
  model: z.object({
    available: z.boolean(),
    id: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});
export type SupervisorSettings = z.infer<typeof supervisorSettingsSchema>;

/** Only the keys you send change. Any other key is refused. */
export const updateSupervisorSettingsBodySchema = z.strictObject({
  reviewEnabled: z.boolean().optional(),
  reviewTime: clockTime.optional(),
  morningTime: clockTime.nullable().optional(),
  costCapUsd: z
    .number()
    .nullable()
    .superRefine((n, ctx) => {
      if (n !== null && (n < 0.01 || n > 1000)) {
        ctx.addIssue({
          code: "custom",
          message: "deve ser um valor entre 0,01 e 1000 (US$), ou null para sem teto",
        });
      }
    })
    .optional(),
});
export type UpdateSupervisorSettingsBody = z.input<typeof updateSupervisorSettingsBodySchema>;

/** One night of the review, for the history (read only). */
export const teamReviewSchema = z.object({
  id: uuid,
  /** The local date of the night, `YYYY-MM-DD`. */
  night: z.string(),
  /** `done`, `skipped` (nothing new in the other bots, or the cap left no room), `failed`, `running`. */
  status: z.enum(["running", "done", "skipped", "failed"]),
  /** The bots the review read, with how many entries of each kind. */
  botsRead: z.array(
    z.object({
      botId: uuid,
      name: z.string(),
      journal: z.number().int(),
      notes: z.number().int(),
      open: z.number().int(),
    }),
  ),
  /** Bots left for the next night because the cost cap was reached. */
  leftOver: z.array(z.object({ botId: uuid, name: z.string(), reason: z.literal("cost_cap") })),
  capReached: z.boolean(),
  /** The cap that was set that night (`null`: none). */
  costCapUsd: z.number().nullable(),
  /** What the review noted in the Principal's own memory. */
  noted: z.array(z.object({ memoryId: uuid, text: z.string() })),
  /** The morning message it prepared (`null`: nothing useful), and when it was posted. */
  morningText: z.string().nullable(),
  morningPostedAt: isoDate.nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  /** What the night cost, in US$. */
  costUsd: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type TeamReview = z.infer<typeof teamReviewSchema>;
export const teamReviewListSchema = list(teamReviewSchema);

export const listTeamReviewsQuerySchema = z.object({
  limit: intQuery(1, 100).default(30),
});
export type ListTeamReviewsQuery = { limit?: number };
