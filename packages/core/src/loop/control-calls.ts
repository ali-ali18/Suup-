// Owns the control tools that do not end the run: `plan` (validate, record, mirror to the store)
// and `escalate` (validate and pause for the user). `finish` has its own module (finish.ts).
import type { PlanStep } from "../events.js";
import {
  describePlan,
  escalateInputSchema,
  formatReasons,
  planInputSchema,
  renderArgIssues,
  validatePlan,
} from "./control-tools.js";
import { type ControlCall, ensureToolCall, record, recordResult } from "./recording.js";
import type { LoopContext } from "./run-context.js";
import { canonicalJson } from "./state.js";

const NOT_ALONE_ESCALATE =
  "escalate must be the only tool call of its turn. Call it alone, after you have seen the results of the other tools.";

export async function handlePlan(ctx: LoopContext, call: ControlCall): Promise<void> {
  await ensureToolCall(ctx, call);
  const parsed = planInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues("plan", parsed.error),
    });
    return;
  }
  const steps: PlanStep[] = parsed.data.steps.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    ...(s.note === undefined ? {} : { note: s.note }),
  }));
  const problems = validatePlan(steps, ctx.state.plan);
  if (problems.length > 0) {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content: `The plan was not saved:\n${formatReasons(problems)}\nSend the complete corrected plan.`,
    });
    return;
  }
  // On resume the plan may already be recorded; do not log it twice.
  if (canonicalJson(steps) !== canonicalJson(ctx.state.plan)) {
    await record(ctx, { type: "plan_updated", payload: { plan: steps } });
  }
  await ctx.deps.store.updatePlan(ctx.runId, steps);
  await recordResult(ctx, call.id, { outcome: "ok", isError: false, content: describePlan(steps) });
}

export async function handleEscalate(
  ctx: LoopContext,
  call: ControlCall,
  alone: boolean,
): Promise<void> {
  await ensureToolCall(ctx, call);
  const parsed = escalateInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues("escalate", parsed.error),
    });
    return;
  }
  if (!alone) {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content: NOT_ALONE_ESCALATE,
    });
    return;
  }
  if (parsed.data.question.trim() === "") {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: "The question is empty. Call escalate again with one precise question.",
    });
    return;
  }
  // No result is recorded: the user's answer will be it. The loop pauses at the next safe point.
  await record(ctx, {
    type: "escalated",
    payload: { question: parsed.data.question, callId: call.id },
  });
}
