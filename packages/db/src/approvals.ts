// Owns the approval cards (table `approvals`, migration 0010): the projection of the run's
// `approval_requested` events, the user's decision on them, and the hand-off of that decision back
// to the loop. The run's event log stays the truth: a row here is created in the same transaction
// as its event, and a decision is recorded in the log by the loop (which then marks the row
// delivered).
import {
  type ApprovalDecision,
  type ApprovalDecisionItem,
  type ArgMatcher,
  argMatcherSchema,
  exactMatchers,
  type JsonValue,
  type PolicySource,
  type RiskLevel,
} from "@suup/core";
import { z } from "zod";
import { createRuleRow } from "./approval-rules.js";
import { type Db, withTransaction } from "./client.js";

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "cancelled", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Approval {
  id: string;
  runId: string;
  botId: string;
  /** The conversation of the run, when it has one. */
  conversationId: string | null;
  callId: string;
  tool: string;
  /** What will run if approved: exactly this (secret placeholders, never values). */
  args: JsonValue;
  level: RiskLevel;
  summary: string;
  secrets: string[];
  source: PolicySource;
  status: ApprovalStatus;
  reason: string | null;
  /** The rule an "approve and always allow" created. */
  ruleId: string | null;
  expiresAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  bot_id: string;
  conversation_id: string | null;
  call_id: string;
  tool: string;
  args: JsonValue;
  level: RiskLevel;
  summary: string;
  secrets: string[];
  source: PolicySource;
  status: ApprovalStatus;
  reason: string | null;
  rule_id: string | null;
  expires_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    callId: row.call_id,
    tool: row.tool,
    args: row.args,
    level: row.level,
    summary: row.summary,
    secrets: row.secrets,
    source: row.source,
    status: row.status,
    reason: row.reason,
    ruleId: row.rule_id,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

const SELECT = (db: Db) => db.sql`
  select a.id, a.run_id, a.bot_id, r.conversation_id, a.call_id, a.tool, a.args, a.level,
         a.summary, a.secrets, a.source, a.status, a.reason, a.rule_id, a.expires_at,
         a.decided_at, a.created_at
  from approvals a join runs r on r.id = a.run_id`;

export type ApprovalErrorCode = "not_found" | "conflict";

/** What the user asked of an approval cannot be done in the state it is in. */
export class ApprovalError extends Error {
  override readonly name = "ApprovalError";
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Creates the card for an `approval_requested` event, in the transaction that appends the event.
 * Idempotent: the id is derived from the run and the call, so a retry changes nothing.
 */
export async function projectApprovalRequested(
  tx: Db,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const p = payload as {
    approvalId: string;
    callId: string;
    tool: string;
    args: JsonValue;
    level: RiskLevel;
    summary: string;
    secrets: string[];
    source: PolicySource;
    expiresAt?: string;
  };
  await tx.sql`
    insert into approvals (id, run_id, bot_id, call_id, tool, args, level, summary, secrets, source, expires_at)
    select ${p.approvalId}, r.id, r.bot_id, ${p.callId}, ${p.tool}, ${tx.sql.json(p.args)},
           ${p.level}, ${p.summary}, ${p.secrets}::text[], ${p.source}, ${p.expiresAt ?? null}
    from runs r where r.id = ${runId}
    on conflict (run_id, call_id) do nothing`;
}

export async function getApproval(db: Db, id: string): Promise<Approval | null> {
  const [row] = await db.sql<ApprovalRow[]>`${SELECT(db)} where a.id = ${z.uuid().parse(id)}`;
  return row === undefined ? null : mapApproval(row);
}

export interface ListApprovalsOptions {
  status?: ApprovalStatus;
  botId?: string;
  conversationId?: string;
  runId?: string;
  limit: number;
}

/** Newest first; a pending card list is the usual use (`status: "pending"`). */
export async function listApprovals(db: Db, opts: ListApprovalsOptions): Promise<Approval[]> {
  const { sql } = db;
  const limit = z.number().int().positive().parse(opts.limit);
  const rows = await sql<ApprovalRow[]>`
    ${SELECT(db)}
    where ${opts.status !== undefined ? sql`a.status = ${z.enum(APPROVAL_STATUSES).parse(opts.status)}` : sql`true`}
      and ${opts.botId !== undefined ? sql`a.bot_id = ${opts.botId}` : sql`true`}
      and ${opts.conversationId !== undefined ? sql`r.conversation_id = ${opts.conversationId}` : sql`true`}
      and ${opts.runId !== undefined ? sql`a.run_id = ${opts.runId}` : sql`true`}
    order by a.created_at desc, a.id
    limit ${limit}`;
  return rows.map(mapApproval);
}

/** How the user wants a rule created from a card ("approve and always allow"). */
export interface AlwaysAllow {
  /** `bot`: only this bot. `global`: every bot. */
  scope: "bot" | "global";
  /** Omitted: exactly this call (every text argument equal). `[]`: any call of the tool. */
  matchers?: ArgMatcher[] | undefined;
}

export interface DecideApprovalInput {
  decision: "approved" | "denied";
  reason?: string | undefined;
  /** Only with `approved`: also create an allow rule. */
  always?: AlwaysAllow | undefined;
}

const decideSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().max(2000).optional(),
  always: z
    .object({
      scope: z.enum(["bot", "global"]),
      matchers: z.array(argMatcherSchema).max(20).optional(),
    })
    .optional(),
});

/** Marks the run claimable again when it was waiting on this decision. */
async function wakeRun(tx: Db, runId: string): Promise<void> {
  await tx.sql`
    update runs set status = 'queued', locked_by = null, locked_at = null,
      interrupt_requested_at = null
    where id = ${runId} and status = 'waiting_approval'`;
}

async function lockPending(tx: Db, id: string): Promise<ApprovalRow & { run_status: string }> {
  // The run row first (the order the loop's event append uses), then the card.
  const [owner] = await tx.sql<{ run_id: string }[]>`select run_id from approvals where id = ${id}`;
  if (owner === undefined) throw new ApprovalError("not_found", "Aprovação não encontrada.");
  const [run] = await tx.sql<{ status: string }[]>`
    select status from runs where id = ${owner.run_id} for no key update`;
  const [row] = await tx.sql<(ApprovalRow & { run_status: string })[]>`
    ${SELECT(tx)} where a.id = ${id} for update of a`;
  if (row === undefined || run === undefined) {
    throw new ApprovalError("not_found", "Aprovação não encontrada.");
  }
  return { ...row, run_status: run.status };
}

/**
 * Records the user's decision on a pending card, in one transaction: the card, the rule an
 * "always allow" creates, and the wake-up of the run (a run waiting for this decision becomes
 * claimable again; a run that has not paused yet reads the decision at its next safe point).
 * Throws `ApprovalError`: `not_found`, or `conflict` when the card was already decided, cancelled
 * or expired.
 */
export async function decideApproval(
  db: Db,
  id: string,
  input: DecideApprovalInput,
): Promise<{ approval: Approval; ruleId: string | null }> {
  const body = decideSchema.parse(input);
  if (body.always !== undefined && body.decision !== "approved") {
    throw new ApprovalError("conflict", "Só se pode sempre permitir ao aprovar.");
  }
  const result = await withTransaction(db, async (tx) => {
    const row = await lockPending(tx, z.uuid().parse(id));
    if (row.status !== "pending") {
      throw new ApprovalError(
        "conflict",
        `Esta aprovação já foi resolvida (${STATUS_PT[row.status]}).`,
      );
    }
    if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
      // The limit passed before anybody swept it: it ends here (and the run is told), and the
      // answer is refused after the transaction commits, so the expiry is not rolled back.
      await tx.sql`
        update approvals set status = 'expired', decided_at = now() where id = ${row.id}`;
      await wakeRun(tx, row.run_id);
      return "expired" as const;
    }
    let ruleId: string | null = null;
    if (body.always !== undefined) {
      const rule = await createRuleRow(tx, {
        botId: body.always.scope === "global" ? null : row.bot_id,
        tool: row.tool,
        effect: "allow",
        matchers: body.always.matchers ?? exactMatchers(row.args),
        note: `Criada ao aprovar: ${row.summary}`.slice(0, 500),
        createdBy: "approval",
        sourceApprovalId: row.id,
      });
      ruleId = rule.id;
    }
    await tx.sql`
      update approvals set status = ${body.decision}, reason = ${body.reason ?? null},
        rule_id = ${ruleId}, decided_at = now()
      where id = ${row.id}`;
    await wakeRun(tx, row.run_id);
    const [done] = await tx.sql<ApprovalRow[]>`${SELECT(tx)} where a.id = ${row.id}`;
    return { approval: mapApproval(done as ApprovalRow), ruleId };
  });
  if (result === "expired") throw new ApprovalError("conflict", "Esta aprovação expirou.");
  return result;
}

const STATUS_PT: Record<ApprovalStatus, string> = {
  pending: "pendente",
  approved: "aprovada",
  denied: "negada",
  cancelled: "cancelada",
  expired: "expirada",
};

/** Decisions the loop has not recorded in the run's log yet, oldest first. */
export async function peekApprovalDecisionRows(
  db: Db,
  runId: string,
): Promise<ApprovalDecisionItem[]> {
  const rows = await db.sql<
    {
      id: string;
      call_id: string;
      status: ApprovalDecision;
      reason: string | null;
      rule_id: string | null;
    }[]
  >`
    select id, call_id, status, reason, rule_id from approvals
    where run_id = ${runId} and status <> 'pending' and delivered_at is null
    order by decided_at, id`;
  return rows.map((r) => ({
    approvalId: r.id,
    callId: r.call_id,
    decision: r.status,
    ...(r.reason === null ? {} : { reason: r.reason }),
    ...(r.rule_id === null ? {} : { ruleId: r.rule_id }),
  }));
}

export async function ackApprovalDecisionRows(
  db: Db,
  runId: string,
  ids: readonly string[],
): Promise<void> {
  const parsed = z.array(z.uuid()).parse([...ids]);
  if (parsed.length === 0) return;
  await db.sql`
    update approvals set delivered_at = now()
    where run_id = ${runId} and id = any(${parsed}::uuid[]) and delivered_at is null`;
}

/** Whether a decision of the run still waits to be recorded in the log. */
export async function hasUndeliveredDecision(db: Db, runId: string): Promise<boolean> {
  const [row] = await db.sql<{ pending: boolean }[]>`
    select exists (
      select 1 from approvals
      where run_id = ${runId} and status <> 'pending' and delivered_at is null
    ) as pending`;
  return row?.pending === true;
}

/**
 * Cancels the pending cards of a run that is being cancelled. Returns what was cancelled, so the
 * caller can write the matching `approval_decided` events in the same transaction.
 */
export async function cancelPendingApprovals(
  tx: Db,
  runId: string,
): Promise<{ id: string; callId: string }[]> {
  const rows = await tx.sql<{ id: string; call_id: string }[]>`
    update approvals set status = 'cancelled', decided_at = now(), delivered_at = now()
    where run_id = ${runId} and status = 'pending'
    returning id, call_id`;
  return rows.map((r) => ({ id: r.id, callId: r.call_id }));
}

/**
 * Expires the cards whose limit (`expires_at`, set only when the configuration says requests
 * expire) has passed: each becomes `expired` and its run is woken to tell the model. Without a
 * limit nothing ever expires. Returns how many it expired. Safe to call from every process.
 */
export async function expireOverdueApprovals(db: Db): Promise<number> {
  const due = await db.sql<{ id: string }[]>`
    select id from approvals where status = 'pending' and expires_at is not null and expires_at <= now()`;
  let expired = 0;
  for (const { id } of due) {
    await withTransaction(db, async (tx) => {
      const row = await lockPending(tx, id);
      if (row.status !== "pending") return;
      await tx.sql`update approvals set status = 'expired', decided_at = now() where id = ${id}`;
      await wakeRun(tx, row.run_id);
      expired += 1;
    });
  }
  return expired;
}
