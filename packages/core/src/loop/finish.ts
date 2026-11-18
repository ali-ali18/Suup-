// Owns the `finish` control tool: argument validation, the harness checks, the independent
// reviewer hand-off (a forced `verdict` tool call, with one unforced retry), the rejection
// tie-break that escalates to the user, and recording the finish attempt.

import {
  finishInputSchema,
  formatReasons,
  renderArgIssues,
  validateFinish,
  verdictToolSpec,
} from "./control-tools.js";
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
  await record(ctx, {
    type: "escalated",
    payload: {
      reason: "review_tie_break",
      question: `I believe the task is complete, but an automated review keeps disagreeing, so I need you to decide.\n\nMy summary:\n${summary}\n\nThe reviewer's last objection:\n${ctx.state.lastRejectionNotes}\n\nShould I accept the work as it is, or what should change?`,
    },
  });
}

/** Asks the reviewer. Never fails the run: a broken review is an approval with a warning. */
async function requestReview(
  ctx: LoopContext,
  call: ControlCall,
  args: FinishArgs,
): Promise<{ verdict: "approve" | "reject"; notes: string; warning?: string }> {
  const reviewer = ctx.deps.reviewer;
  if (reviewer === undefined) throw new Error("review requested without a reviewer");
  const forced = reviewer.model.supportsForcedToolChoice !== false;
  const reviewSpec: CallSpec = {
    purpose: "review",
    provider: reviewer.provider,
    model: reviewer.model,
    system: REVIEWER_SYSTEM,
    messages: [
      {
        role: "user",
        blocks: [
          {
            type: "text",
            text: buildReviewMessage({
              objective: ctx.run.objective,
              acceptanceCriteria: ctx.run.acceptanceCriteria,
              plan: ctx.state.plan,
              summary: args.summary,
              evidence: args.evidence,
              digest: buildReviewDigest(ctx.state.toolLog),
              userExchanges: ctx.state.userLog,
            }),
          },
        ],
      },
    ],
    tools: [verdictToolSpec()],
    ...(forced ? { toolChoice: { name: "verdict" } } : {}),
    retries: 0,
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
  const verdict =
    outcome.kind === "ok"
      ? parseVerdict(outcome.result.blocks)
      : {
          verdict: "approve" as const,
          notes: "",
          warning: `the review was skipped because the reviewer failed (${outcome.error.kind}: ${outcome.error.message})`,
        };
  await record(ctx, {
    type: "review",
    payload: {
      verdict: verdict.verdict,
      notes: verdict.notes,
      ...(verdict.warning === undefined ? {} : { warning: verdict.warning }),
    },
  });
  return verdict;
}
