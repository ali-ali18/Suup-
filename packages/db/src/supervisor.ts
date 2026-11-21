import { z } from "zod";
import { type Db, withTransaction } from "./client.js";
import { ACTIVE_RUN_STATUSES, getActiveConversationRun } from "./conversation-runs.js";
import { createDirectConversation } from "./conversations.js";
import { appendMessageOnce, type Message } from "./messages.js";
import { createRun, getRun } from "./runs.js";
import { formatClockTime, parseClockTime } from "./supervisor-time.js";
import type { Run } from "./types.js";

/**
 * What the main bot does as the supervisor of the team (docs/SUPERVISOR.md): its settings, the
 * nightly review and the delegation of work to the other bots. The database decides who does what
 * (one review per night, one return per delegation), so several workers can run the jobs, and a
 * crash in the middle leaves nothing half done.
 */

// ---------------------------------------------------------------------------------------------
// Settings

export const SUPERVISOR_DEFAULTS = {
  reviewEnabled: true,
  reviewTime: "03:00",
  morningTime: "08:00" as string | null,
  costCapUsd: null as number | null,
} as const;

export interface SupervisorSettings {
  /** Whether the nightly review runs at all. */
  reviewEnabled: boolean;
  /** `HH:MM` in the user's time zone: from then on the night's review may start. */
  reviewTime: string;
  /** `HH:MM`: the morning message is posted from then on; `null`: no morning message. */
  morningTime: string | null;
  /** The most one night's review may cost, in US$; `null` (the default): no cap. */
  costCapUsd: number | null;
  updatedAt: Date;
}

interface SettingsRow {
  review_enabled: boolean;
  review_minute: number;
  morning_minute: number | null;
  cost_cap_usd: string | null;
  updated_at: Date;
}

const mapSettings = (r: SettingsRow): SupervisorSettings => ({
  reviewEnabled: r.review_enabled,
  reviewTime: formatClockTime(r.review_minute),
  morningTime: r.morning_minute === null ? null : formatClockTime(r.morning_minute),
  costCapUsd: r.cost_cap_usd === null ? null : Number(r.cost_cap_usd),
  updatedAt: r.updated_at,
});

export async function getSupervisorSettings(db: Db): Promise<SupervisorSettings> {
  const [row] = await db.sql<SettingsRow[]>`select * from supervisor_settings`;
  if (row === undefined) throw new Error("supervisor_settings has no row (migration 0023?)");
  return mapSettings(row);
}

const clockTime = z.string().refine((v) => parseClockTime(v) !== null, "use o formato HH:MM");

export const supervisorSettingsPatchSchema = z.strictObject({
  reviewEnabled: z.exactOptional(z.boolean()),
  reviewTime: z.exactOptional(clockTime),
  morningTime: z.exactOptional(z.union([clockTime, z.null()])),
  costCapUsd: z.exactOptional(z.union([z.number().min(0.01).max(1000), z.null()])),
});
export type SupervisorSettingsPatch = z.input<typeof supervisorSettingsPatchSchema>;

/** Changes the settings the patch names (the others stay). Throws a `ZodError` outside a range. */
export async function updateSupervisorSettings(
  db: Db,
  patch: SupervisorSettingsPatch,
): Promise<SupervisorSettings> {
  const p = supervisorSettingsPatchSchema.parse(patch);
  const { sql } = db;
  const reviewMinute = p.reviewTime === undefined ? null : parseClockTime(p.reviewTime);
  const [row] = await sql<SettingsRow[]>`
    update supervisor_settings set
      review_enabled = ${p.reviewEnabled ?? sql`review_enabled`},
      review_minute = ${reviewMinute ?? sql`review_minute`},
      morning_minute = ${p.morningTime === undefined ? sql`morning_minute` : p.morningTime === null ? null : parseClockTime(p.morningTime)},
      cost_cap_usd = ${p.costCapUsd === undefined ? sql`cost_cap_usd` : p.costCapUsd}
    returning *`;
  if (row === undefined) throw new Error("supervisor_settings has no row");
  return mapSettings(row);
}

// ---------------------------------------------------------------------------------------------
// What the review may read

/** The longest a bot's window is, however long the review did not run (days). */
export const REVIEW_MAX_WINDOW_DAYS = 7;
export const REVIEW_MAX_JOURNAL = 40;
export const REVIEW_MAX_BOT_NOTES = 20;
export const REVIEW_MAX_OPEN = 15;
/** A run that is "working" and has not moved for this long is stalled. */
export const REVIEW_STALLED_AFTER_HOURS = 6;
const OBJECTIVE_MAX = 300;

export interface TeamBotActivity {
  botId: string;
  name: string;
  description: string;
  /** The start of this bot's window (its cursor, or at most `REVIEW_MAX_WINDOW_DAYS` back). */
  since: Date;
  journal: { at: Date; text: string }[];
  notes: { at: Date; text: string }[];
  open: {
    state: "waiting_user" | "waiting_approval" | "waiting_timer" | "stalled";
    objective: string;
    since: Date;
    wakeAt: Date | null;
    wakeNote: string | null;
  }[];
  /** Runs of the bot (not isolated) that changed in the window. */
  runsTouched: number;
}

/**
 * What the nightly review is allowed to read about the OTHER bots: for each active bot that is not
 * the main one, since its cursor: the journal entries (what the bot itself wrote about each run:
 * when, how it ended, a short summary), the notes it saved, and what it has open (runs waiting for
 * the user, for an approval or for a scheduled return, and runs that stalled). Everything is
 * selected by column from `memories` and `runs`: no tool call, tool result, fetched page, e-mail,
 * connector output or chat message is read here. The objective of a run is shown only for the runs
 * the user or a delegation opened.
 */
export async function teamActivity(
  db: Db,
  input: { principalBotId: string; until: Date },
): Promise<TeamBotActivity[]> {
  const principal = z.uuid().parse(input.principalBotId);
  const { sql } = db;
  const floor = new Date(input.until.getTime() - REVIEW_MAX_WINDOW_DAYS * 86_400_000);
  const bots = await sql<{ id: string; name: string; description: string; cursor: Date | null }[]>`
    select b.id, b.name, b.description, c.read_until as cursor
    from bots b left join team_review_cursors c on c.bot_id = b.id
    where b.archived_at is null and b.id <> ${principal}
    order by b.created_at, b.id`;
  const out: TeamBotActivity[] = [];
  for (const b of bots) {
    const since = b.cursor === null || b.cursor < floor ? floor : b.cursor;
    const journal = await sql<{ created_at: Date; text: string }[]>`
      select created_at, text from (
        select created_at, text, id from memories
        where layer = 'journal' and bot_id = ${b.id} and archived_at is null and status = 'active'
          and created_at > ${since} and created_at <= ${input.until}
        order by created_at desc, id desc limit ${REVIEW_MAX_JOURNAL}
      ) j order by created_at, id`;
    const notes = await sql<{ created_at: Date; text: string }[]>`
      select created_at, text from (
        select created_at, text, id from memories
        where layer = 'note' and scope = 'bot' and bot_id = ${b.id} and archived_at is null
          and status = 'active' and created_at > ${since} and created_at <= ${input.until}
        order by created_at desc, id desc limit ${REVIEW_MAX_BOT_NOTES}
      ) n order by created_at, id`;
    const open = await sql<
      {
        status: string;
        objective: string;
        updated_at: Date;
        wake_at: Date | null;
        wake_note: string | null;
      }[]
    >`
      select status, left(objective, ${OBJECTIVE_MAX}) as objective, updated_at, wake_at, wake_note
      from runs
      where bot_id = ${b.id} and not isolated and origin in ('user', 'delegation')
        and (
          status in ('waiting_user', 'waiting_approval', 'waiting_timer')
          or (status in ('queued', 'running')
              and updated_at < ${new Date(input.until.getTime() - REVIEW_STALLED_AFTER_HOURS * 3_600_000)})
        )
      order by updated_at, id limit ${REVIEW_MAX_OPEN}`;
    const [touched] = await sql<{ n: number }[]>`
      select count(*)::int as n from runs
      where bot_id = ${b.id} and not isolated
        and updated_at > ${since} and updated_at <= ${input.until}`;
    out.push({
      botId: b.id,
      name: b.name,
      description: b.description,
      since,
      journal: journal.map((r) => ({ at: r.created_at, text: r.text })),
      notes: notes.map((r) => ({ at: r.created_at, text: r.text })),
      open: open.map((r) => ({
        state: (r.status === "queued" || r.status === "running"
          ? "stalled"
          : r.status) as TeamBotActivity["open"][number]["state"],
        objective: r.objective,
        since: r.updated_at,
        wakeAt: r.wake_at,
        wakeNote: r.wake_note,
      })),
      runsTouched: touched?.n ?? 0,
    });
  }
  return out;
}

/** Whether a bot did anything in its window (a journal entry, a note, a run that moved). */
export const hadActivity = (a: TeamBotActivity): boolean =>
  a.journal.length + a.notes.length + a.runsTouched > 0;

/** The notes of the main bot about the team that the review already has (newest last). */
export async function principalNotes(
  db: Db,
  principalBotId: string,
  limit = 60,
): Promise<string[]> {
  const rows = await db.sql<{ text: string }[]>`
    select text from (
      select text, created_at, id from memories
      where layer = 'note' and scope = 'bot' and bot_id = ${z.uuid().parse(principalBotId)}
        and archived_at is null and status = 'active'
      order by created_at desc, id desc limit ${limit}
    ) n order by created_at, id`;
  return rows.map((r) => r.text);
}

// ---------------------------------------------------------------------------------------------
// The review record

export const TEAM_REVIEW_STATUSES = ["running", "done", "skipped", "failed"] as const;
export type TeamReviewStatus = (typeof TEAM_REVIEW_STATUSES)[number];

/** After a failed attempt the night is left alone for this long, and tried at most this many times. */
export const REVIEW_RETRY_AFTER_MS = 30 * 60_000;
export const REVIEW_MAX_ATTEMPTS = 3;

export interface ReviewBotRead {
  botId: string;
  name: string;
  journal: number;
  notes: number;
  open: number;
}
export interface ReviewLeftOver {
  botId: string;
  name: string;
  reason: "cost_cap";
}
export interface ReviewNoted {
  memoryId: string;
  text: string;
}

export interface TeamReview {
  id: string;
  night: string;
  botId: string;
  status: TeamReviewStatus;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  windowTo: Date;
  botsRead: ReviewBotRead[];
  leftOver: ReviewLeftOver[];
  capReached: boolean;
  costCapUsd: number | null;
  noted: ReviewNoted[];
  morningText: string | null;
  morningPostedAt: Date | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

interface ReviewRow {
  id: string;
  night: string;
  bot_id: string;
  status: TeamReviewStatus;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  window_to: Date;
  bots_read: ReviewBotRead[];
  left_over: ReviewLeftOver[];
  cap_reached: boolean;
  cost_cap_usd: string | null;
  noted: ReviewNoted[];
  morning_text: string | null;
  morning_posted_at: Date | null;
  model: string | null;
  prompt_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  latency_ms: number | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const mapReview = (r: ReviewRow): TeamReview => ({
  id: r.id,
  night: r.night,
  botId: r.bot_id,
  status: r.status,
  claimedBy: r.claimed_by,
  leaseExpiresAt: r.lease_expires_at,
  windowTo: r.window_to,
  botsRead: r.bots_read,
  leftOver: r.left_over,
  capReached: r.cap_reached,
  costCapUsd: num(r.cost_cap_usd),
  noted: r.noted,
  morningText: r.morning_text,
  morningPostedAt: r.morning_posted_at,
  model: r.model,
  promptVersion: r.prompt_version,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  costUsd: num(r.cost_usd),
  latencyMs: r.latency_ms,
  error: r.error,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

/**
 * Takes the review of `night` (the local date), or `null` when it is not to be done now: another
 * worker has it or it is done (the unique index allows one live row per night), or the night failed
 * too recently or too many times. Rows whose owner stopped (the lease ran out) are marked `failed`
 * first, so the night can be tried again after the pause.
 */
export async function claimTeamReview(
  db: Db,
  input: {
    night: string;
    principalBotId: string;
    workerId: string;
    leaseMs: number;
    windowTo: Date;
    costCapUsd: number | null;
    now?: Date;
  },
): Promise<TeamReview | null> {
  const now = input.now ?? new Date();
  const { sql } = db;
  await sql`
    update team_reviews
    set status = 'failed', error = 'a posse expirou: o worker parou antes de terminar', finished_at = ${now}
    where status = 'running' and lease_expires_at < ${now}`;
  const [failed] = await sql<{ n: number; last: Date | null }[]>`
    select count(*)::int as n, max(created_at) as last from team_reviews
    where night = ${input.night} and status = 'failed'`;
  if ((failed?.n ?? 0) >= REVIEW_MAX_ATTEMPTS) return null;
  if (failed?.last != null && failed.last.getTime() > now.getTime() - REVIEW_RETRY_AFTER_MS) {
    return null;
  }
  const [row] = await sql<ReviewRow[]>`
    insert into team_reviews (night, bot_id, status, claimed_by, lease_expires_at, window_to, cost_cap_usd, created_at)
    values (${input.night}, ${z.uuid().parse(input.principalBotId)}, 'running', ${input.workerId},
      ${new Date(now.getTime() + input.leaseMs)}, ${input.windowTo}, ${input.costCapUsd}, ${now})
    on conflict (night) where status in ('running', 'done', 'skipped') do nothing
    returning *`;
  return row ? mapReview(row) : null;
}

/** Locks the row for its owner: `true` while the worker still owns a `running` row. */
export async function lockOwnTeamReview(db: Db, id: string, workerId: string): Promise<boolean> {
  const [row] = await db.sql<{ id: string }[]>`
    select id from team_reviews
    where id = ${z.uuid().parse(id)} and status = 'running' and claimed_by = ${workerId}
    for update`;
  return row !== undefined;
}

export interface FinishTeamReviewInput {
  id: string;
  workerId: string;
  status: "done" | "skipped" | "failed";
  botsRead?: ReviewBotRead[];
  leftOver?: ReviewLeftOver[];
  capReached?: boolean;
  noted?: ReviewNoted[];
  morningText?: string | null;
  model?: string;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  error?: string;
}

/** Closes the row. Only the owner of a `running` row can; returns whether it did. */
export async function finishTeamReview(db: Db, input: FinishTeamReviewInput): Promise<boolean> {
  const { sql } = db;
  const rows = await sql<{ id: string }[]>`
    update team_reviews set
      status = ${input.status},
      bots_read = ${sql.json((input.botsRead ?? []) as never)},
      left_over = ${sql.json((input.leftOver ?? []) as never)},
      cap_reached = ${input.capReached === true},
      noted = ${sql.json((input.noted ?? []) as never)},
      morning_text = ${input.morningText ?? null},
      model = ${input.model ?? null},
      prompt_version = ${input.promptVersion ?? null},
      input_tokens = ${input.inputTokens ?? null},
      output_tokens = ${input.outputTokens ?? null},
      cost_usd = ${input.costUsd ?? null},
      latency_ms = ${input.latencyMs ?? null},
      error = ${input.error ?? null},
      lease_expires_at = null,
      finished_at = now()
    where id = ${z.uuid().parse(input.id)} and status = 'running' and claimed_by = ${input.workerId}
    returning id`;
  return rows.length === 1;
}

/** Moves the cursor of each bot to `until`: what was before it has been read. */
export async function advanceReviewCursors(
  db: Db,
  botIds: readonly string[],
  until: Date,
): Promise<void> {
  for (const id of botIds) {
    await db.sql`
      insert into team_review_cursors (bot_id, read_until) values (${z.uuid().parse(id)}, ${until})
      on conflict (bot_id) do update set read_until = greatest(team_review_cursors.read_until, excluded.read_until)`;
  }
}

export async function getTeamReview(db: Db, id: string): Promise<TeamReview | null> {
  const [row] = await db.sql<
    ReviewRow[]
  >`select * from team_reviews where id = ${z.uuid().parse(id)}`;
  return row ? mapReview(row) : null;
}

/** Newest first. */
export async function listTeamReviews(db: Db, limit = 30): Promise<TeamReview[]> {
  const rows = await db.sql<ReviewRow[]>`
    select * from team_reviews order by created_at desc, id desc limit ${limit}`;
  return rows.map(mapReview);
}

/**
 * Posts the morning message of the night's review in the main bot's own chat, once. Only when the
 * review of `night` is done, has a message, did not post it yet, and the chat exists and is past its
 * welcome (a message must never take the place of the welcome). The claim and the message are ONE
 * transaction (and the message has a key), so two workers, or a crash, never post it twice.
 * Returns the message, or `null` when nothing was posted.
 */
export async function postMorningMessage(
  db: Db,
  input: { night: string },
): Promise<{ message: Message; review: TeamReview } | null> {
  return withTransaction(db, async (tx) => {
    const [row] = await tx.sql<ReviewRow[]>`
      select * from team_reviews
      where night = ${input.night} and status = 'done' and morning_text is not null
        and morning_posted_at is null
      for update skip locked`;
    if (row === undefined) return null;
    const [conv] = await tx.sql<{ id: string; reception: string }[]>`
      select c.id, c.reception from conversations c
      join conversation_members cm on cm.conversation_id = c.id
      where cm.bot_id = ${row.bot_id} and c.kind = 'direct' and c.archived_at is null`;
    if (conv === undefined || conv.reception === "pending" || conv.reception === "started") {
      return null;
    }
    const { message } = await appendMessageOnce(tx, {
      conversationId: conv.id,
      authorKind: "bot",
      authorBotId: row.bot_id,
      text: row.morning_text as string,
      dedupeKey: `review:${row.id}:morning`,
    });
    await tx.sql`update team_reviews set morning_posted_at = now() where id = ${row.id}`;
    return { message, review: mapReview({ ...row, morning_posted_at: new Date() }) };
  });
}

// ---------------------------------------------------------------------------------------------
// Reading another bot's memory (read only)

export interface TeamMemoryEntry {
  id: string;
  layer: "note" | "journal";
  at: Date;
  text: string;
}

/**
 * What the main bot may read of another bot's memory during the day: the notes and the journal of
 * that bot (never its rules, which are the user's, and never anything of a run). There is no
 * write function here or anywhere in the supervisor's tools: the main bot's `remember` and
 * `forget` keep working on its own memory only.
 */
export async function readTeamMemory(
  db: Db,
  input: {
    botId: string;
    query?: string;
    layers?: ("note" | "journal")[];
    sinceDays?: number;
    limit: number;
  },
): Promise<TeamMemoryEntry[]> {
  const { sql } = db;
  const layers = input.layers ?? ["note", "journal"];
  const since =
    input.sinceDays === undefined ? null : new Date(Date.now() - input.sinceDays * 86_400_000);
  const rows = await sql<
    { id: string; layer: "note" | "journal"; created_at: Date; text: string }[]
  >`
    select id, layer, created_at, text from (
      select m.id, m.layer, m.created_at, m.text from memories m
      where m.bot_id = ${z.uuid().parse(input.botId)} and m.scope = 'bot'
        and m.layer = any(${layers}::text[]) and m.archived_at is null and m.status = 'active'
        and ${since === null ? sql`true` : sql`m.created_at >= ${since}`}
        and ${
          input.query === undefined || input.query.trim() === ""
            ? sql`true`
            : sql`m.search @@ suup_search_query_any(${input.query})`
        }
      order by m.created_at desc, m.id desc limit ${input.limit}
    ) t order by created_at, id`;
  return rows.map((r) => ({ id: r.id, layer: r.layer, at: r.created_at, text: r.text }));
}

/** What a bot has open and has been doing lately, in counts (for "o que eu fiz com o Tutor"). */
export async function teamBotOverview(
  db: Db,
  botId: string,
  sinceDays: number,
): Promise<{ done: number; failed: number; open: TeamBotActivity["open"] }> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [counts] = await db.sql<{ done: number; failed: number }[]>`
    select count(*) filter (where status = 'done')::int as done,
           count(*) filter (where status = 'failed')::int as failed
    from runs where bot_id = ${z.uuid().parse(botId)} and not isolated and finished_at >= ${since}`;
  const rows = await db.sql<
    {
      status: string;
      objective: string;
      updated_at: Date;
      wake_at: Date | null;
      wake_note: string | null;
    }[]
  >`
    select status, left(objective, ${OBJECTIVE_MAX}) as objective, updated_at, wake_at, wake_note
    from runs
    where bot_id = ${botId} and not isolated and origin in ('user', 'delegation')
      and status in ('waiting_user', 'waiting_approval', 'waiting_timer')
    order by updated_at, id limit ${REVIEW_MAX_OPEN}`;
  return {
    done: counts?.done ?? 0,
    failed: counts?.failed ?? 0,
    open: rows.map((r) => ({
      state: r.status as "waiting_user" | "waiting_approval" | "waiting_timer",
      objective: r.objective,
      since: r.updated_at,
      wakeAt: r.wake_at,
      wakeNote: r.wake_note,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Delegation

/** Most delegations open at once (a delegated run that has not ended). */
export const MAX_OPEN_DELEGATIONS = 3;

export class DelegationError extends Error {
  override name = "DelegationError";
  constructor(
    readonly code: "not_found" | "archived" | "self" | "busy" | "limit" | "depth",
    message: string,
  ) {
    super(message);
  }
}

export interface Delegation {
  id: string;
  fromBotId: string;
  fromRunId: string;
  fromConversationId: string | null;
  toBotId: string;
  toRunId: string;
  toConversationId: string;
  objective: string;
  returnedAt: Date | null;
  createdAt: Date;
}

interface DelegationRow {
  id: string;
  from_bot_id: string;
  from_run_id: string;
  from_conversation_id: string | null;
  to_bot_id: string;
  to_run_id: string;
  to_conversation_id: string;
  objective: string;
  returned_at: Date | null;
  created_at: Date;
}

const mapDelegation = (r: DelegationRow): Delegation => ({
  id: r.id,
  fromBotId: r.from_bot_id,
  fromRunId: r.from_run_id,
  fromConversationId: r.from_conversation_id,
  toBotId: r.to_bot_id,
  toRunId: r.to_run_id,
  toConversationId: r.to_conversation_id,
  objective: r.objective,
  returnedAt: r.returned_at,
  createdAt: r.created_at,
});

export interface CreateDelegationInput {
  fromRunId: string;
  toBotId: string;
  /** What the delegated run is asked to do (already composed: objective plus context). */
  objective: string;
  /** The text the target's chat shows the user. */
  notice: string;
  acceptanceCriteria: string[];
  /** Default `MAX_OPEN_DELEGATIONS`. */
  maxOpen?: number;
}

/**
 * Delegates a task from a run to another bot, atomically: a run of origin `delegation` is created
 * in the target's own direct conversation (it becomes that chat's foreground run, so a question it
 * asks is answered there) with a notice for the user in that chat, and the link is recorded so the
 * result can come back. Refused (`DelegationError`) when:
 * - the delegating run is itself a delegated run (depth 1: a delegated run delegates to no one);
 * - the target is unknown, archived or the delegating bot itself;
 * - the target is in the middle of a conversation (its chat already has a run working or waiting);
 * - too many delegations are open (`maxOpen`).
 * The same delegation (same run, same target, same objective) twice is one: the second call returns
 * the first with `created: false`.
 */
export async function createDelegation(
  db: Db,
  input: CreateDelegationInput,
): Promise<{ delegation: Delegation; run: Run; created: boolean }> {
  const fromRunId = z.uuid().parse(input.fromRunId);
  const toBotId = z.uuid().parse(input.toBotId);
  const from = await getRun(db, fromRunId);
  if (from === null) throw new DelegationError("not_found", "A execução que delega não existe.");
  if (from.origin === "delegation") {
    throw new DelegationError("depth", "Uma execução delegada não delega para outro bot.");
  }
  if (from.botId === toBotId) {
    throw new DelegationError("self", "Um bot não delega para si mesmo.");
  }
  const [target] = await db.sql<{ archived_at: Date | null }[]>`
    select archived_at from bots where id = ${toBotId}`;
  if (target === undefined) throw new DelegationError("not_found", "O bot de destino não existe.");
  if (target.archived_at !== null) {
    throw new DelegationError("archived", "O bot de destino está arquivado.");
  }
  const conversation = await createDirectConversation(db, toBotId);
  const objectiveKey = (
    await db.sql<{ k: string }[]>`select md5(suup_text_key(${input.objective})) as k`
  )[0]?.k as string;
  return withTransaction(db, async (tx) => {
    // The same lock `sendConversationMessage` takes: one writer at a time in the target's chat.
    await tx.sql`select 1 from conversations where id = ${conversation.id} for no key update`;
    const [same] = await tx.sql<DelegationRow[]>`
      select * from delegations
      where from_run_id = ${fromRunId} and to_bot_id = ${toBotId} and objective_key = ${objectiveKey}`;
    if (same !== undefined) {
      const run = (await getRun(tx, same.to_run_id)) as Run;
      return { delegation: mapDelegation(same), run, created: false };
    }
    if ((await getActiveConversationRun(tx, conversation.id)) !== null) {
      throw new DelegationError(
        "busy",
        "O bot está no meio de uma conversa com o usuário agora (ou esperando uma resposta dele).",
      );
    }
    const [open] = await tx.sql<{ n: number }[]>`
      select count(*)::int as n from delegations d join runs r on r.id = d.to_run_id
      where r.status = any(${ACTIVE_RUN_STATUSES as unknown as string[]}::text[])`;
    if ((open?.n ?? 0) >= (input.maxOpen ?? MAX_OPEN_DELEGATIONS)) {
      throw new DelegationError(
        "limit",
        `Já há ${open?.n} delegações em andamento: espere alguma terminar.`,
      );
    }
    // A delegated task is the user's wish: the welcome of that chat does not start on top of it.
    await tx.sql`update conversations set reception = 'done' where id = ${conversation.id} and reception = 'pending'`;
    const run = await createRun(tx, {
      botId: toBotId,
      parentRunId: fromRunId,
      conversationId: conversation.id,
      origin: "delegation",
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
    });
    const [row] = await tx.sql<DelegationRow[]>`
      insert into delegations (from_bot_id, from_run_id, from_conversation_id, to_bot_id, to_run_id,
        to_conversation_id, objective, objective_key)
      values (${from.botId}, ${fromRunId}, ${from.conversationId ?? null}, ${toBotId}, ${run.id},
        ${conversation.id}, ${input.objective}, ${objectiveKey})
      returning *`;
    await appendMessageOnce(tx, {
      conversationId: conversation.id,
      authorKind: "system",
      text: input.notice,
      runId: run.id,
      dedupeKey: `delegation:${(row as DelegationRow).id}:request`,
    });
    return { delegation: mapDelegation(row as DelegationRow), run, created: true };
  });
}

export async function getDelegationByRun(db: Db, toRunId: string): Promise<Delegation | null> {
  const [row] = await db.sql<DelegationRow[]>`
    select * from delegations where to_run_id = ${z.uuid().parse(toRunId)}`;
  return row ? mapDelegation(row) : null;
}

/** Marks the result as delivered to the delegating bot's chat (the message has its own key). */
export async function markDelegationReturned(db: Db, id: string): Promise<void> {
  await db.sql`update delegations set returned_at = now() where id = ${z.uuid().parse(id)} and returned_at is null`;
}

/** Delegations of a run (the delegating side). */
export async function listDelegationsFrom(db: Db, fromRunId: string): Promise<Delegation[]> {
  const rows = await db.sql<DelegationRow[]>`
    select * from delegations where from_run_id = ${z.uuid().parse(fromRunId)} order by created_at, id`;
  return rows.map(mapDelegation);
}
