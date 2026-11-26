import { z } from "zod";
import { approvalSchema } from "./approvals.js";
import { botSchema } from "./bots.js";
import { uuid } from "./common.js";
import { conversationSchema, messageSchema } from "./conversations.js";
import { memorySchema } from "./memory.js";
import { runEventSchema, runSchema } from "./runs.js";
import { taskSchema } from "./tasks.js";

/**
 * The realtime stream (`GET /v1/stream`, Server-Sent Events). Each frame is
 *
 * ```
 * id: 1234
 * event: run.event
 * data: { ...the `data` below... }
 * ```
 *
 * `id` increases with every change in the database and is the same on every server process, so
 * `Last-Event-ID` resumes from any of them. `ready`, `resync`, `live.text` and `live.end` have no `id`
 * (the first two are about the connection, the others are the answer being typed: ephemeral, never
 * stored, and a frame without `id` leaves the last event id as it was).
 */
export const STREAM_EVENT_TYPES = [
  "ready",
  "resync",
  "run.event",
  "run.updated",
  "message.created",
  "message.updated",
  "conversation.updated",
  "memory.changed",
  "bot.updated",
  "approval.changed",
  "task.changed",
  "live.text",
  "live.end",
] as const;

/**
 * Why a client must reload everything instead of resuming:
 * - `too_old`: the changes it missed are no longer kept;
 * - `unknown_id`: the id it sent comes from another database or the future;
 * - `too_many`: it missed more than the server is willing to replay;
 * - `slow_consumer` is NOT sent (the server just closes the connection of a client that cannot
 *   keep up; reconnecting with `Last-Event-ID` resumes).
 */
export const RESYNC_REASONS = ["too_old", "unknown_id", "too_many"] as const;

const frames = {
  /** First frame of every connection. `head` is the id of the latest change at that moment. */
  ready: z.object({
    head: z.number().int(),
    /** The server will not replay: the client must reload (a `resync` frame follows). */
    resync: z.boolean(),
    /** The runs whose events this connection carries. */
    runs: z.array(uuid),
  }),
  resync: z.object({ reason: z.enum(RESYNC_REASONS) }),
  "run.event": z.object({ runId: uuid, event: runEventSchema }),
  /** A run changed: its status, pause, plan, usage or result. The whole run is sent. */
  "run.updated": z.object({ run: runSchema }),
  "message.created": z.object({ message: messageSchema }),
  /** A message changed (its delivery status). The whole message is sent. */
  "message.updated": z.object({ message: messageSchema }),
  /** A conversation changed (a new message, read, archived). The whole conversation is sent. */
  "conversation.updated": z.object({ conversation: conversationSchema }),
  "memory.changed": z.object({
    /**
     * `pending`: a bot or the consolidation proposed a rule or a fact that waits for you (show a
     * card; `memory.status` is `pending`). The later decision arrives as `updated` with
     * `memory.status` `active` (confirmed) or `rejected`.
     */
    change: z.enum(["created", "pending", "updated", "archived", "restored"]),
    memory: memorySchema,
  }),
  "bot.updated": z.object({ bot: botSchema }),
  /** An approval card appeared or changed (pending, decided, cancelled). The whole card is sent. */
  "approval.changed": z.object({
    change: z.enum(["created", "updated"]),
    approval: approvalSchema,
  }),
  /** A task appeared, or its result was handed to the chat (KOD-68). The whole task is sent. */
  "task.changed": z.object({ change: z.enum(["created", "updated"]), task: taskSchema }),
  /**
   * The bot's answer being written (KOD-34): ephemeral, never recorded, already scrubbed of known
   * secret values. `call` is the `seq` of the call's `model_request` event; `block` the position of
   * the text among the call's blocks that show; `offset` where `text` starts in the block (a frame
   * with `offset` 0 replaces the block: it is also the snapshot a reconnecting client gets).
   */
  "live.text": z.object({
    runId: uuid,
    call: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    block: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  /** The typed text ended: of one block (`block`, dropped) or of the whole call. */
  "live.end": z.object({
    runId: uuid,
    call: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    block: z.number().int().nonnegative().optional(),
    outcome: z.enum(["recorded", "dropped", "aborted", "failed", "retry"]),
  }),
} as const;

export const streamFrameSchemas = frames;

/** One frame of the stream: its event name, its id (when it has one) and its data, validated. */
export const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), id: z.undefined().optional(), data: frames.ready }),
  z.object({ type: z.literal("resync"), id: z.undefined().optional(), data: frames.resync }),
  z.object({ type: z.literal("run.event"), id: z.number().int(), data: frames["run.event"] }),
  z.object({ type: z.literal("run.updated"), id: z.number().int(), data: frames["run.updated"] }),
  z.object({
    type: z.literal("message.created"),
    id: z.number().int(),
    data: frames["message.created"],
  }),
  z.object({
    type: z.literal("message.updated"),
    id: z.number().int(),
    data: frames["message.updated"],
  }),
  z.object({
    type: z.literal("conversation.updated"),
    id: z.number().int(),
    data: frames["conversation.updated"],
  }),
  z.object({
    type: z.literal("memory.changed"),
    id: z.number().int(),
    data: frames["memory.changed"],
  }),
  z.object({ type: z.literal("bot.updated"), id: z.number().int(), data: frames["bot.updated"] }),
  z.object({
    type: z.literal("approval.changed"),
    id: z.number().int(),
    data: frames["approval.changed"],
  }),
  z.object({
    type: z.literal("task.changed"),
    id: z.number().int(),
    data: frames["task.changed"],
  }),
  z.object({
    type: z.literal("live.text"),
    id: z.undefined().optional(),
    data: frames["live.text"],
  }),
  z.object({ type: z.literal("live.end"), id: z.undefined().optional(), data: frames["live.end"] }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type StreamEventType = StreamEvent["type"];

/** The query of `GET /v1/stream`. */
export const streamQuerySchema = z.object({
  /** The runs whose events (`run.event`) to carry, comma separated, at most 50. */
  runs: z
    .string()
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    )
    .pipe(z.array(uuid).max(50))
    .optional(),
  /** `Last-Event-ID` for a client that cannot set the header. */
  lastEventId: z.coerce.number().int().min(0).optional(),
});
export const MAX_STREAM_RUNS = 50;
