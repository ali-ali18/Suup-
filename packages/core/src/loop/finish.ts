// Owns the `finish` control tool: argument validation, the harness checks, the independent
// reviewer hand-off (a forced `verdict` tool call, with one unforced retry, a reject with no
// real mismatch, or a cannot_verify that names nothing it lacks, asked once more, and a few rounds in which the reviewer asks for evidence it could
// not see), the tie-break that escalates to the user
// (the reviewer kept rejecting, or could not verify), and recording the finish attempt.

import type { Discrepancy, FailureOrigin, UncheckedItem } from "../events.js";
import type { Message } from "../messages.js";
import {
  finishInputSchema,
  formatDiscrepancies,
  formatReasons,
  renderArgIssues,
  validateFinish,
  verdictToolSpec,
} from "./control-tools.js";
import { alreadySentInFull, EVIDENCE_MAX_ROUNDS, gatherEvidence, loadLogged } from "./evidence.js";
import { renderEvidence } from "./evidence-render.js";
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
  const reject = async (
    reasons: string[],
    handedToUser = false,
    endsRun?: { origin: FailureOrigin; detail: string },
  ) => {
    await record(ctx, {
      type: "finish_attempt",
      payload: {
        callId: call.id,
        summary: args.summary,
        evidence: args.evidence,
        accepted: false,
        rejectionReasons: reasons,
        ...(handedToUser ? { handedToUser: true } : {}),
        ...(endsRun === undefined ? {} : { endsRun }),
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
    if (review.verdict === "unverified" && ctx.run.origin === "routine") {
      // Nobody answers a routine's run live (docs/ROTINAS.md): handing the decision to the owner
      // would park the run forever and skip every next fire. It ends not concluded, saying why.
      return reject(
        [
          `An independent reviewer could not verify this work (${describeUnverified(review)}). In a routine run nobody can decide now, so the run ends as not concluded.`,
        ],
        false,
        routineUnverified(review),
      );
    }
    if (review.verdict === "unverified") {
      const outcome = await reject(
        [
          `An independent reviewer could not verify this work (could not verify: ${describeUnverified(review)}). This is not a rejection of the work: the decision has been handed to the user. Wait for their reply; do not call finish again before it.`,
        ],
        true,
      );
      await recordTieBreak(ctx, args.summary);
      return outcome;
    }
    if (review.verdict === "reject") {
      const found =
        review.discrepancies === undefined
          ? ""
          : `\nThe discrepancies it found:\n${formatDiscrepancies(review.discrepancies)}`;
      return reject([`An independent reviewer rejected the finish: ${review.notes}${found}`]);
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

/** How a routine's run ends when its finish could not be verified (in Portuguese, for the chat). */
function routineUnverified(review: ReviewOutcome): { origin: FailureOrigin; detail: string } {
  if (review.failed !== undefined) {
    return {
      origin: review.failed,
      detail:
        "a revisão falhou (o revisor não respondeu), então o resultado não foi confirmado. A rotina roda de novo no próximo horário.",
    };
  }
  return {
    origin: "model",
    detail: `o revisor não conseguiu confirmar o resultado, e numa rotina ninguém decide na hora. O que faltou: ${review.notes}`,
  };
}

async function recordTieBreak(ctx: LoopContext, summary: string): Promise<void> {
  const review = ctx.state.currentReview;
  const question =
    review?.verdict === "unverified"
      ? `I believe the task is complete, but the automated review could not verify part of it, so I need you to decide.\n\nMy summary:\n${summary}\n\nWhat the reviewer could not verify:\n${describeUnverified(review)}\n\nShould I accept the work as it is, or should something be checked or changed?`
      : `I believe the task is complete, but an automated review keeps disagreeing, so I need you to decide.\n\nMy summary:\n${summary}\n\nThe reviewer's last objection:\n${ctx.state.lastRejectionNotes}\n\nShould I accept the work as it is, or what should change?`;
  await record(ctx, {
    type: "escalated",
    payload: {
      reason: "review_tie_break",
      reviewVerdict: review?.verdict === "unverified" ? "unverified" : "reject",
      question,
    },
  });
}

interface ReviewOutcome {
  verdict: "approve" | "reject" | "unverified";
  notes: string;
  warning?: string;
  discrepancies?: Discrepancy[];
  unchecked?: UncheckedItem[];
  namedNothing?: boolean;
  /** The review did not happen (the reviewer failed): who failed. */
  failed?: "provider" | "model";
}

const KIND_TEXT = {
  result: "tool result",
  call: "tool call",
  file: "file",
  other: "other",
} as const;

/**
 * What the owner reads about an `unverified` review: the reviewer's words, what it listed as
 * lacking, and, when it named nothing the harness had not already sent in full, that said plainly.
 */
function describeUnverified(review: {
  notes: string;
  unchecked?: readonly UncheckedItem[] | undefined;
  namedNothing?: boolean | undefined;
}): string {
  const items = review.unchecked ?? [];
  const list = items
    .map((u) => `- ${u.what}${u.ref === "" ? "" : ` (needs: ${KIND_TEXT[u.kind]} ${u.ref})`}`)
    .join("\n");
  if (review.namedNothing === true) {
    const listed =
      items.length === 0
        ? "It listed nothing it lacked."
        : `Everything it listed had already been sent to it in full:\n${list}`;
    return `${review.notes}\n(Note: the reviewer did not name anything it lacked that it had not already been given. ${listed} Treat this as a doubt without a concrete gap, not as a verified problem.)`;
  }
  return list === "" ? review.notes : `${review.notes}\nWhat it lacked:\n${list}`;
}

/** What the reviewer is told when its answer was not usable (a reject with no real mismatch, a cannot_verify naming nothing it lacks). */
const REPROMPT_TEXT = (reason: string) =>
  `Your answer was not accepted: ${reason}. Answer again with the \`verdict\` tool: "approve" if you found no real mismatch and nothing is missing; "reject" with at least one real mismatch in \`discrepancies\` (what the work claims, what the evidence shows, where, \`real_mismatch\` true; what matched goes in \`notes\`); or "cannot_verify" listing in \`unchecked\` what you could not check and what you would need. A reject with no real mismatch is not a rejection, and a cannot_verify that names nothing you lack is not a gap.`;

/** The conversation with the reviewer: the review message, then each step taken since, in order. */
async function reviewMessages(ctx: LoopContext, first: string): Promise<Message[]> {
  const messages: Message[] = [{ role: "user", blocks: [{ type: "text", text: first }] }];
  const steps = ctx.state.reviewSteps;
  if (steps.length === 0) return messages;
  const logged = steps.some((s) => s.kind === "evidence")
    ? await loadLogged(ctx)
    : { results: new Map<string, string>(), args: new Map() };
  for (const step of steps) {
    if (step.kind === "reprompt") {
      const { callId, args, reason } = step.payload;
      messages.push(
        { role: "assistant", blocks: [{ type: "tool_call", id: callId, name: "verdict", args }] },
        {
          role: "user",
          blocks: [{ type: "tool_result", callId, content: REPROMPT_TEXT(reason), isError: true }],
        },
      );
      continue;
    }
    const round = step.payload;
    const { results: asked, files } = round.requested;
    const calls = round.requested.calls ?? [];
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
            ...(calls.length === 0 ? {} : { calls }),
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
          content: renderEvidence(round, ctx.state.toolLog, logged),
        },
      ],
    });
  }
  return messages;
}

/**
 * Asks the reviewer. A review that could not happen is never an approval (fail closed): a provider
 * error is retried once, and if the reviewer still fails, or answers without a usable verdict, the
 * outcome is `unverified` with `failed` set ("a revisão falhou"). A user's run hands that to the
 * owner like any unverified; a routine's run, which nobody answers live, ends not concluded.
 */
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
    const steps = ctx.state.reviewSteps.length;
    if (steps > 0) {
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
      countsAsTurn: steps > 0,
    };
    const ask = async () => {
      const answer = await callModel(ctx, reviewSpec);
      if (forced && answer.kind === "error" && answer.error.kind === "invalid_request") {
        // The model may refuse a forced tool choice without the configuration saying so. Ask once
        // more by instruction only instead of failing the review (the failure stays in the log).
        const { toolChoice: _forced, ...unforced } = reviewSpec;
        return callModel(ctx, unforced);
      }
      return answer;
    };
    let outcome = await ask();
    // A provider error may be passing: the reviewer is asked once more before the review fails.
    if (outcome.kind === "error") outcome = await ask();

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
        verdict: "unverified",
        notes: `a revisão falhou: the reviewer could not be reached twice (${outcome.error.kind}: ${outcome.error.message})`,
        failed: "provider",
      });
    }
    const parsed = parseVerdict(outcome.result.blocks);
    if (parsed.warning !== undefined) {
      // No verdict tool call, or one whose arguments do not parse: no review happened.
      return recordReview(ctx, {
        verdict: "unverified",
        notes: `a revisão falhou: ${parsed.warning}`,
        failed: "model",
      });
    }
    if (parsed.verdict === "need_evidence" && !final && parsed.callId !== undefined) {
      const payload = await gatherEvidence(
        ctx,
        {
          callId: parsed.callId,
          notes: parsed.notes,
          results: parsed.results,
          calls: parsed.calls,
          files: parsed.files,
        },
        rounds + 1,
      );
      await record(ctx, { type: "review_evidence", payload });
      continue;
    }
    if (parsed.verdict === "need_evidence") {
      // No more rounds (or none possible): what it could not check is told, not guessed.
      return recordReview(ctx, {
        verdict: "unverified",
        notes: `still asking for evidence after ${EVIDENCE_MAX_ROUNDS} rounds: ${parsed.notes}`,
      });
    }
    const reprompted = ctx.state.reviewSteps.some((step) => step.kind === "reprompt");
    if (parsed.verdict === "cannot_verify") {
      // Something it really lacks stays unverified. If it names nothing, or only what the harness
      // already sent whole, it is asked once more; the same answer again is kept as unverified,
      // and the owner is told that the reviewer named nothing it lacked.
      const lacking = parsed.unchecked.filter(
        (u) => !alreadySentInFull(ctx.state.reviewRounds, ctx.state.toolLog, u),
      );
      if (lacking.length > 0) {
        return recordReview(ctx, {
          verdict: "unverified",
          notes: parsed.notes,
          unchecked: lacking,
        });
      }
      if (reprompted || parsed.callId === undefined) {
        return recordReview(ctx, {
          verdict: "unverified",
          notes: parsed.notes,
          ...(parsed.unchecked.length === 0 ? {} : { unchecked: parsed.unchecked }),
          namedNothing: true,
        });
      }
      await record(ctx, {
        type: "review_reprompt",
        payload: {
          callId: parsed.callId,
          args: parsed.rawArgs ?? null,
          reason:
            parsed.unchecked.length === 0
              ? "a cannot_verify must list in `unchecked` what you could not check and what you would need; you listed nothing"
              : `everything you listed in \`unchecked\` was already sent to you in full in this review (${parsed.unchecked.map((u) => `${u.kind} ${u.ref === "" ? u.what : u.ref}`).join(", ")}), so none of it is a gap`,
        },
      });
      continue;
    }
    if (parsed.invalidReject !== undefined && parsed.callId !== undefined) {
      if (reprompted) {
        // Twice without a discrepancy: not a rejection. What it could not show is not a defect.
        return recordReview(ctx, {
          verdict: "unverified",
          notes: `the reviewer answered reject twice without naming a concrete discrepancy, so it is not treated as a rejection (its words: ${parsed.notes})`,
        });
      }
      await record(ctx, {
        type: "review_reprompt",
        payload: {
          callId: parsed.callId,
          args: parsed.rawArgs ?? null,
          reason: parsed.invalidReject,
        },
      });
      continue;
    }
    return recordReview(ctx, {
      verdict: parsed.verdict,
      notes: parsed.notes,
      ...(parsed.verdict === "reject" ? { discrepancies: parsed.discrepancies } : {}),
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
      ...(outcome.discrepancies === undefined ? {} : { discrepancies: outcome.discrepancies }),
      ...(outcome.unchecked === undefined ? {} : { unchecked: outcome.unchecked }),
      ...(outcome.namedNothing === true ? { namedNothing: true } : {}),
      ...(outcome.failed === undefined ? {} : { failed: outcome.failed }),
    },
  });
  return outcome;
}
