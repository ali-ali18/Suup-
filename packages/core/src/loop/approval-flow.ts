// Owns what happens to a tool call before it runs, when a gate is configured (section 4.8): asking
// the policy, recording its verdict, asking the user (the approval card), and delivering the
// user's decision into the log. The decision of a call is made ONCE and written down; a resumed
// loop reads the log and never decides again, so a changed rule cannot rewrite what already
// happened.

import type { GateVerdict } from "../approvals/gate.js";
import { approvalIdFor } from "../approvals/id.js";
import type { ApprovalDecision } from "../events.js";
import type { JsonValue } from "../messages.js";
import { renderStaleApprovalNotice, sameCall } from "./grants.js";
import { renderNotice } from "./prompts.js";
import { type ControlCall, record } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import type { ApprovalDecisionItem } from "./store.js";
import { webUrlsSeen } from "./web-seen.js";

/** What the gate (and the user) said about one call. */
export type CallClearance =
  /** Run it with exactly these arguments. */
  | { kind: "run"; args: JsonValue }
  /** Do not run it; this is the result for the model. */
  | { kind: "denied"; text: string }
  /** It waits for the user: the loop pauses at the next safe point. */
  | { kind: "wait" };

export const SKIPPED_AFTER_DENIAL =
  "was not run: an earlier call of this same turn was denied, so the rest of the turn was held back (the calls may depend on each other). Send it again, in a new turn, if it is still needed.";

function userDenial(name: string, reason: string | undefined): string {
  const why = reason === undefined || reason.trim() === "" ? "" : ` Reason given: ${reason.trim()}`;
  return `The user denied this call to "${name}", so it was NOT run.${why} This is not a failure of the task: do not try the same thing again or work around the denial; take another approach, or ask the user (escalate) what they would accept.`;
}

function ruleDenial(name: string, reason: string | undefined): string {
  return `Call to "${name}" was NOT run: ${reason ?? "it is not allowed"}. Do not retry it unchanged; choose another approach or ask the user.`;
}

function denialText(name: string, decision: ApprovalDecision, reason: string | undefined): string {
  switch (decision) {
    case "approved":
      return "";
    case "denied":
      return userDenial(name, reason);
    case "expired":
      return `The approval for "${name}" expired before the user answered, so the call was NOT run. Ask again only if it is still needed.`;
    case "cancelled":
      return `The approval for "${name}" was cancelled, so the call was NOT run.`;
  }
}

/**
 * What the log already says about a call: the user's decision, or the policy's verdict. A decision
 * is made once and written down; a resumed loop reads it here and never decides again, so a rule
 * changed in the meantime cannot rewrite what already happened. `undefined`: nothing yet.
 */
export function clearanceFromLog(ctx: LoopContext, call: ControlCall): CallClearance | undefined {
  const given = ctx.state.approvals.get(call.id);
  if (given !== undefined) {
    const decided = given.decided;
    if (decided === undefined) return { kind: "wait" };
    const stale = ctx.state.staleApprovals.get(call.id);
    if (decided.decision === "approved" && stale !== undefined) {
      // Approved after a long wait: the call does NOT run now. The model is told, and the approval
      // stays as a one-time grant for the identical call (see `grantFor`).
      return {
        kind: "denied",
        text: renderNotice(
          renderStaleApprovalNotice({ tool: call.name, waitedMs: stale.waitedMs }),
        ),
      };
    }
    return decided.decision === "approved"
      ? // Exactly what was shown on the card, never what the model might say now.
        { kind: "run", args: given.requested.args }
      : { kind: "denied", text: denialText(call.name, decided.decision, decided.reason) };
  }
  const earlier = ctx.state.policies.get(call.id);
  if (earlier !== undefined) {
    return earlier.outcome === "allow"
      ? { kind: "run", args: call.args as JsonValue }
      : { kind: "denied", text: ruleDenial(call.name, earlier.reason) };
  }
  return undefined;
}

/**
 * The grant a late approval left for exactly this call, if it is still unused: same tool, same
 * arguments (canonical JSON equality; nothing fuzzy). A call that already ran on a grant (the log
 * says so) is its own answer.
 */
export function grantFor(
  ctx: LoopContext,
  call: ControlCall,
): { approvalId: string; consumed: boolean } | undefined {
  const used = ctx.state.grantUses.get(call.id);
  if (used !== undefined) return { approvalId: used, consumed: true };
  const grant = ctx.state.grants.find((g) => !g.used && sameCall(g, call));
  return grant === undefined ? undefined : { approvalId: grant.approvalId, consumed: false };
}

/** Records that the call consumes the grant (once: a resumed loop finds it in the log). */
export async function consumeGrant(
  ctx: LoopContext,
  call: ControlCall,
  grant: { approvalId: string; consumed: boolean },
): Promise<void> {
  if (grant.consumed) return;
  await record(ctx, {
    type: "approval_grant_used",
    payload: { approvalId: grant.approvalId, callId: call.id, tool: call.name },
  });
}

/**
 * Asks the gate about a call nothing was decided about yet, and records its verdict before
 * anything else happens. An allow-all gate (`allowAllGate`) answers `null` for every call.
 */
export async function askGate(
  ctx: LoopContext,
  call: ControlCall,
  grant?: { approvalId: string; consumed: boolean },
): Promise<CallClearance> {
  const { gate, bot, executor } = ctx.deps;
  const verdict = await gate.check({
    runId: ctx.runId,
    callId: call.id,
    botId: bot.id,
    name: call.name,
    args: call.args as JsonValue,
    allowed: bot.allowedTools,
    executor,
    userMessages: ctx.state.userSaid,
    ...(ctx.state.routineInstruction === null
      ? {}
      : { trigger: { kind: "routine" as const, instruction: ctx.state.routineInstruction } }),
    webSeen: webUrlsSeen(ctx.state),
    routineNames: ctx.state.routineNames,
    sessionGrants: ctx.state.sessionGrants,
    reviewBlocks: ctx.state.reviewBlocks,
    ...(ctx.state.reviews.has(call.id) ? { recordedReview: ctx.state.reviews.get(call.id) } : {}),
    signal: ctx.signal,
  });
  if (verdict === null) return { kind: "run", args: call.args as JsonValue };
  if (verdict.review !== undefined) {
    // The review is paid for and written down BEFORE anything is decided on it.
    const { usage, costUsd } = verdict.review;
    if (usage !== undefined) {
      await ctx.deps.store.addUsage(ctx.runId, {
        turns: 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costUsd ?? 0,
      });
    }
    await record(ctx, { type: "approval_review", payload: verdict.review });
  }

  switch (verdict.outcome) {
    case "allow":
      if (verdict.sessionGrant !== undefined) {
        // The user's approval of the same action earlier in this run stands in for the card.
        if (grant?.consumed !== true) {
          await record(ctx, {
            type: "approval_grant_used",
            payload: {
              approvalId: verdict.sessionGrant.approvalId,
              callId: call.id,
              tool: call.name,
              kind: "session",
            },
          });
        }
        return { kind: "run", args: call.args as JsonValue };
      }
      // A plain read leaves no trace of its own (its call and result say it all).
      if (verdict.level !== "read" || verdict.source !== "default") {
        await recordPolicy(ctx, call, verdict, "allow");
      }
      return { kind: "run", args: call.args as JsonValue };
    case "deny":
      await recordPolicy(ctx, call, verdict, "deny");
      return { kind: "denied", text: ruleDenial(call.name, verdict.reason) };
    case "ask":
      // The user already answered this exact call (a late approval): the grant stands in for the card.
      if (grant !== undefined) {
        await consumeGrant(ctx, call, grant);
        return { kind: "run", args: call.args as JsonValue };
      }
      await record(ctx, {
        type: "approval_requested",
        payload: {
          approvalId: verdict.approvalId ?? approvalIdFor(ctx.runId, call.id),
          callId: call.id,
          tool: call.name,
          args: verdict.args,
          level: verdict.level,
          summary: verdict.summary,
          secrets: verdict.secrets,
          ...(verdict.secretHost === undefined ? {} : { secretHost: verdict.secretHost }),
          source: verdict.source,
          ...(verdict.outbound === undefined ? {} : { outbound: verdict.outbound }),
          ...(verdict.expiresAt === undefined ? {} : { expiresAt: verdict.expiresAt }),
          ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
          ...(verdict.writtenRuleId === undefined ? {} : { writtenRuleId: verdict.writtenRuleId }),
          ...(verdict.grantKey === undefined ? {} : { grantKey: verdict.grantKey }),
        },
      });
      return { kind: "wait" };
  }
}

async function recordPolicy(
  ctx: LoopContext,
  call: ControlCall,
  verdict: GateVerdict,
  outcome: "allow" | "deny",
): Promise<void> {
  await record(ctx, {
    type: "policy_checked",
    payload: {
      callId: call.id,
      tool: call.name,
      level: verdict.level,
      outcome,
      source: verdict.source,
      ...(verdict.ruleId === undefined ? {} : { ruleId: verdict.ruleId }),
      ...(verdict.writtenRuleId === undefined ? {} : { writtenRuleId: verdict.writtenRuleId }),
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    },
  });
}

/**
 * Writes into the log the decisions the user made since the loop last looked, and then
 * acknowledges them in the store. Returns whether the call the run waits for was decided.
 */
export async function deliverApprovalDecisions(ctx: LoopContext): Promise<boolean> {
  const { store } = ctx.deps;
  const decisions = await store.peekApprovalDecisions(ctx.runId);
  const fresh = decisions.filter((d) => {
    const known = ctx.state.approvals.get(d.callId);
    return known !== undefined && known.decided === undefined;
  });
  const stale = decisions.filter((d) => !fresh.includes(d));
  for (const d of fresh) {
    if (d.chatReview !== undefined) {
      // What the reviewer cost is part of the run's cost, paid before anything runs on it.
      await ctx.deps.store.addUsage(ctx.runId, {
        turns: 0,
        inputTokens: d.chatReview.usage.inputTokens,
        outputTokens: d.chatReview.usage.outputTokens,
        costUsd: d.chatReview.costUsd,
      });
    }
    await record(ctx, {
      type: "approval_decided",
      payload: {
        approvalId: d.approvalId,
        callId: d.callId,
        decision: d.decision,
        ...(d.reason === undefined ? {} : { reason: d.reason }),
        ...(d.ruleId === undefined ? {} : { ruleId: d.ruleId }),
        ...(d.via === undefined ? {} : { via: d.via }),
        ...(d.messageId === undefined ? {} : { messageId: d.messageId }),
        ...(d.chatReview === undefined ? {} : { chatReview: d.chatReview }),
      },
    });
    await recordStale(ctx, d);
    await recordSessionGrant(ctx, d);
  }
  // A process that died between the decision and its stale note finishes the note now.
  for (const d of stale) await recordStale(ctx, d);
  const done = [...fresh, ...stale].map((d) => d.approvalId);
  if (done.length > 0) await store.ackApprovalDecisions(ctx.runId, done);
  return fresh.length > 0;
}

/**
 * An approved card whose call the reviewer judged reversible leaves a grant for the rest of the
 * run (once per card): the key and the review that backs it are already in the log. A card that was
 * approved too late left no run behind it, so no grant.
 */
async function recordSessionGrant(ctx: LoopContext, d: ApprovalDecisionItem): Promise<void> {
  if (d.decision !== "approved" || d.stale !== undefined) return;
  if (ctx.state.sessionGrants.some((g) => g.approvalId === d.approvalId)) return;
  const known = ctx.state.approvals.get(d.callId);
  const key = known?.requested.grantKey;
  if (known === undefined || key === undefined || known.decided?.approvalId !== d.approvalId)
    return;
  await record(ctx, {
    type: "approval_session_grant",
    payload: { approvalId: d.approvalId, callId: d.callId, tool: known.requested.tool, key },
  });
}

/** Writes `approval_stale` for an approval that waited too long (once per card). */
async function recordStale(ctx: LoopContext, d: ApprovalDecisionItem): Promise<void> {
  if (d.decision !== "approved" || d.stale === undefined) return;
  if (ctx.state.staleApprovals.has(d.callId)) return;
  if (ctx.state.approvals.get(d.callId)?.decided?.approvalId !== d.approvalId) return;
  await record(ctx, {
    type: "approval_stale",
    payload: {
      approvalId: d.approvalId,
      callId: d.callId,
      waitedMs: d.stale.waitedMs,
      thresholdMs: d.stale.thresholdMs,
    },
  });
}
