// Owns the `finish` control tool: argument validation, the harness checks, the independent
// reviewer hand-off (a forced `verdict` tool call, with one unforced retry, and up to two rounds in
// which the reviewer asks for evidence it could not see), the tie-break that escalates to the user
// (the reviewer kept rejecting, or could not verify), and recording the finish attempt.

import type { Message } from "../messages.js";
import {
  finishInputSchema,
  formatReasons,
  renderArgIssues,
  validateFinish,
  verdictToolSpec,
} from "./control-tools.js";
import {
  EVIDENCE_MAX_ROUNDS,
  gatherEvidence,
  renderEvidence,
  toolResultContents,
} from "./evidence.js";
import { type CallSpec, callModel } from "./model-call.js";
import { REVIEWER_SYSTEM } from "./prompts.js";
import {
  type ControlCall,
  ensureToolCall,
  INTERRUPTED_RESULT,
  record,
  recordResult,
} from "./recording.js";
import {
  buildReviewDigest,
  buildReviewMessage,
  DEFAULT_MAX_REJECTIONS,
  parseVerdict,
} from "./reviewer.js";
import { Interrupted, type LoopContext } from "./run-context.js";
import { checkLimits } from "./safe-point.js";

const NOT_ALONE_FINISH =
  "call finish alone, after you have seen the results of the other tools; it was rejected because other tool calls were in the same turn";

interface FinishArgs {
  summary: string;
  evidence: { criterion: string; evidence: string }[];
}

export async function handleFinish(
  ctx: LoopContext,
  call: ControlCall,
  alone: boolean,
): Promise<void> {
  await ensureToolCall(ctx, call);
  const parsed = finishInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues("finish", parsed.error),
    });
    return;
  }
  const args = parsed.data;

  let attempt = ctx.state.finishAttempts.get(call.id);
  if (attempt === undefined) attempt = await decideFinish(ctx, call, args, alone);

  if (attempt.accepted) {
    await recordResult(ctx, call.id, {
      outcome: "ok",
      isError: false,
      content: "Finish accepted. The run is complete.",
    });
    return;
  }
  if (attempt.handedToUser && ctx.state.waiting === null && !ctx.state.reviewWaived) {
    // Died between logging the attempt and logging the question.
    await recordTieBreak(ctx, args.summary);
  }
  await recordResult(ctx, call.id, {
    outcome: "tool_error",
    isError: true,
    content: `Finish was not accepted:\n${formatReasons(attempt.reasons)}`,
  });
}

async function decideFinish(
  ctx: LoopContext,
  call: ControlCall,
  args: FinishArgs,
  alone: boolean,
): Promise<{ accepted: boolean; reasons: string[]; handedToUser: boolean }> {
  const { reviewer } = ctx.deps;
  const state = ctx.state;
  const reject = async (reasons: string[], handedToUser = false) => {
    await record(ctx, {
      type: "finish_attempt",
      payload: {
        callId: call.id,
        summary: args.summary,
        evidence: args.evidence,
        accepted: false,
        rejectionReasons: reasons,
        ...(handedToUser ? { handedToUser: true } : {}),
      },
    });
    return { accepted: false, reasons, handedToUser };
  };

  const reasons = alone
    ? validateFinish(args, ctx.run.acceptanceCriteria, state.plan)
    : [NOT_ALONE_FINISH];
  if (reasons.length > 0) return reject(reasons);

  if (reviewer !== undefined && !state.reviewWaived) {
    let review = state.currentReview;
    if (review === null) {
      if (state.reviewRejections >= (reviewer.maxRejections ?? DEFAULT_MAX_REJECTIONS)) {
        const outcome = await reject(
          [
            `An independent reviewer rejected this work ${state.reviewRejections} times and still disagrees (its last objection: ${state.lastRejectionNotes}). The decision has been handed to the user. Wait for their reply; do not call finish again before it.`,
          ],
          true,
        );
        await recordTieBreak(ctx, args.summary);
        return outcome;
      }
      review = await requestReview(ctx, call, args);
    }
    if (review.verdict === "unverified") {
      const outcome = await reject(
        [
          `An independent reviewer could not verify this work (could not verify: ${review.notes}). This is not a rejection of the work: the decision has been handed to the user. Wait for their reply; do not call finish again before it.`,
        ],
        true,
      );
      await recordTieBreak(ctx, args.summary);
      return outcome;
    }
    if (review.verdict === "reject") {
      return reject([`An independent reviewer rejected the finish: ${review.notes}`]);
    }
  }

  await record(ctx, {
    type: "finish_attempt",
    payload: {
      callId: call.id,
      summary: args.summary,
      evidence: args.evidence,
      accepted: true,
      rejectionReasons: [],
    },
  });
  return { accepted: true, reasons: [], handedToUser: false };
}

async function recordTieBreak(ctx: LoopContext, summary: string): Promise<void> {
  const review = ctx.state.currentReview;
  const question =
    review?.verdict === "unverified"
      ? `I believe the task is complete, but the automated review could not verify part of it, so I need you to decide.\n\nMy summary:\n${summary}\n\nWhat the reviewer could not verify:\n${review.notes}\n\nShould I accept the work as it is, or should something be checked or changed?`
      : `I believe the task is complete, but an automated review keeps disagreeing, so I need you to decide.\n\nMy summary:\n${summary}\n\nThe reviewer's last objection:\n${ctx.state.lastRejectionNotes}\n\nShould I accept the work as it is, or what should change?`;
  await record(ctx, { type: "escalated", payload: { reason: "review_tie_break", question } });
}

interface ReviewOutcome {
  verdict: "approve" | "reject" | "unverified";
  notes: string;
  warning?: string;
}

/** The conversation with the reviewer: the review message, then each evidence round it asked for. */
async function reviewMessages(ctx: LoopContext, first: string): Promise<Message[]> {
  const messages: Message[] = [{ role: "user", blocks: [{ type: "text", text: first }] }];
  const rounds = ctx.state.reviewRounds;
  if (rounds.length === 0) return messages;
  const results = rounds.some((r) => r.supplied.some((i) => i.kind === "tool_result"))
    ? await toolResultContents(ctx)
    : new Map<string, string>();
  for (const round of rounds) {
    const { results: asked, files } = round.requested;
    messages.push({
      role: "assistant",
      blocks: [
        {
          type: "tool_call",
          id: round.callId,
          name: "verdict",
          args: {
            verdict: "need_evidence",
            notes: round.notes,
            ...(asked.length === 0 ? {} : { results: asked }),
            ...(files.length === 0 ? {} : { files }),
          },
        },
      ],
    });
    messages.push({
      role: "user",
      blocks: [
        {
          type: "tool_result",
          callId: round.callId,
          content: renderEvidence(round, ctx.state.toolLog, results),
        },
      ],
    });
  }
  return messages;
}

/** Asks the reviewer. Never fails the run: a broken review is an approval with a warning. */
async function requestReview(
  ctx: LoopContext,
  call: ControlCall,
  args: FinishArgs,
): Promise<ReviewOutcome> {
  const reviewer = ctx.deps.reviewer;
  if (reviewer === undefined) throw new Error("review requested without a reviewer");
  const forced = reviewer.model.supportsForcedToolChoice !== false;
  const first = buildReviewMessage({
    objective: ctx.run.objective,
    acceptanceCriteria: ctx.run.acceptanceCriteria,
    plan: ctx.state.plan,
    summary: args.summary,
    evidence: args.evidence,
    digest: buildReviewDigest(ctx.state.toolLog),
    userExchanges: ctx.state.userLog,
  });

  for (;;) {
    const rounds = ctx.state.reviewRounds.length;
    if (rounds > 0) {
      // Another call costs like any other: the limits of the run apply to it too.
      ctx.run = await ctx.deps.store.getRun(ctx.runId);
      const limit = checkLimits(ctx);
      if (limit !== undefined) {
        return recordReview(ctx, {
          verdict: "unverified",
          notes: `the review was cut short (${limit}) before the reviewer could finish checking`,
        });
      }
    }
    const final = rounds >= EVIDENCE_MAX_ROUNDS;
    const reviewSpec: CallSpec = {
      purpose: "review",
      provider: reviewer.provider,
      model: reviewer.model,
      system: REVIEWER_SYSTEM,
      messages: await reviewMessages(ctx, first),
      tools: [verdictToolSpec(!final)],
      ...(forced ? { toolChoice: { name: "verdict" } } : {}),
      retries: 0,
      countsAsTurn: rounds > 0,
    };
    let outcome = await callModel(ctx, reviewSpec);
    if (forced && outcome.kind === "error" && outcome.error.kind === "invalid_request") {
      // The model may refuse a forced tool choice without the configuration saying so. Ask once
      // more by instruction only instead of failing the review (the failure stays in the log).
      const { toolChoice: _forced, ...unforced } = reviewSpec;
      outcome = await callModel(ctx, unforced);
    }

    if (outcome.kind === "aborted") {
      await recordResult(ctx, call.id, {
        outcome: "aborted",
        isError: true,
        content: `Tool "finish": ${INTERRUPTED_RESULT}.`,
      });
      throw new Interrupted();
    }
    if (outcome.kind === "error") {
      return recordReview(ctx, {
        verdict: "approve",
        notes: "",
        warning: `the review was skipped because the reviewer failed (${outcome.error.kind}: ${outcome.error.message})`,
      });
    }
    const parsed = parseVerdict(outcome.result.blocks);
    if (parsed.verdict === "need_evidence" && !final && parsed.callId !== undefined) {
      const payload = await gatherEvidence(
        ctx,
        {
          callId: parsed.callId,
          notes: parsed.notes,
          results: parsed.results,
          files: parsed.files,
        },
        rounds + 1,
      );
      await record(ctx, { type: "review_evidence", payload });
      continue;
    }
    if (parsed.verdict === "need_evidence" || parsed.verdict === "cannot_verify") {
      // No more rounds (or none possible): what it could not check is told, not guessed.
      return recordReview(ctx, {
        verdict: "unverified",
        notes:
          parsed.verdict === "need_evidence"
            ? `still asking for evidence after ${EVIDENCE_MAX_ROUNDS} rounds: ${parsed.notes}`
            : parsed.notes,
      });
    }
    return recordReview(ctx, {
      verdict: parsed.verdict,
      notes: parsed.notes,
      ...(parsed.warning === undefined ? {} : { warning: parsed.warning }),
    });
  }
}

async function recordReview(ctx: LoopContext, outcome: ReviewOutcome): Promise<ReviewOutcome> {
  await record(ctx, {
    type: "review",
    payload: {
      verdict: outcome.verdict,
      notes: outcome.notes,
      ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
    },
  });
  return outcome;
}
