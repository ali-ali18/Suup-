import { z } from "zod";
import { boolQuery, jsonRecord, uuid } from "./common.js";

/** `GET /v1/runs/{id}/requests/{seq}`: what the model saw in one call, and what it answered. */
export const modelRequestSchema = z.object({
  runId: uuid,
  seq: z.number().int(),
  purpose: z.enum(["agent", "review", "compaction"]),
  /** For the agent's own calls: which turn (1, 2, ...). */
  turn: z.number().int().nullable(),
  /** The request exactly as sent: `provider`, `model`, `system`, `messages`, `tools`, ... */
  request: jsonRecord,
  /** The recorded answer (`blocks`, `stopReason`, `usage`, `modelVersion`, `durationMs`...), if any. */
  response: jsonRecord.nullable(),
});
export type ModelRequest = z.infer<typeof modelRequestSchema>;

/** `POST /v1/runs/{id}/replay`: does the current loop reproduce the recorded run? */
export const replaySchema = z.object({
  runId: uuid,
  identical: z.boolean(),
  finalStatus: z.object({
    recorded: z.string().nullable(),
    replayed: z.string().nullable(),
  }),
  firstDivergence: jsonRecord.nullable(),
  requestDiffs: z.array(jsonRecord),
  stoppedBecause: z.string().nullable(),
  /** The reading of the report, in plain Portuguese. */
  reading: z.string(),
});
export type Replay = z.infer<typeof replaySchema>;

export const MAX_RESEND_TIMES = 20;
export const resendBodySchema = z.object({
  /** The `seq` of the `model_request` event to send again. */
  seq: z.number().int().min(1),
  /** How many times. Default 1. */
  times: z.number().int().min(1).max(MAX_RESEND_TIMES).optional(),
  /** Another model of the configuration, instead of the recorded one. */
  model: z.string().min(1).optional(),
});
export type ResendBody = z.input<typeof resendBodySchema>;

const attemptSchema = z.union([
  z.object({
    attempt: z.number().int(),
    ok: z.literal(true),
    latencyMs: z.number(),
    stopReason: z.string(),
    toolCalls: z.array(z.object({ name: z.string(), args: z.unknown() })),
    text: z.string(),
    usage: jsonRecord,
    modelVersion: z.string(),
  }),
  z.object({
    attempt: z.number().int(),
    ok: z.literal(false),
    latencyMs: z.number(),
    error: z.object({ kind: z.string(), message: z.string(), retryable: z.boolean() }),
  }),
]);
export const resendSchema = z.object({
  runId: uuid,
  requestSeq: z.number().int(),
  purpose: z.enum(["agent", "review", "compaction"]),
  recordedModel: z.string(),
  sentTo: z.object({ provider: z.string(), model: z.string() }),
  times: z.number().int(),
  attempts: z.array(attemptSchema),
  recorded: attemptSchema.nullable(),
  summary: z.object({
    attempts: z.number().int(),
    distinct: z.array(
      z.object({ outcome: z.string(), description: z.string(), count: z.number().int() }),
    ),
    sameArguments: z.boolean(),
    recorded: z.object({ outcome: z.string(), description: z.string() }).nullable(),
    recordedRepeated: z.number().int().nullable(),
    reading: z.string(),
  }),
  savedAt: z.string(),
});
export type Resend = z.infer<typeof resendSchema>;

export const doctorQuerySchema = z.object({
  /** Makes a tiny real call to each model (costs a few tokens). Default off. */
  live: boolQuery.optional(),
});
export const doctorSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ component: z.string(), ok: z.boolean(), detail: z.string() })),
});
export type Doctor = z.infer<typeof doctorSchema>;
