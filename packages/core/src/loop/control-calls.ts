// Owns the control tools that do not end the run: `plan` (validate, record, mirror to the store)
// and `escalate` (validate and pause for the user). `finish` has its own module (finish.ts).
import type { PlanStep } from "../events.js";
import {
  DEFAULT_MAX_RETURNS,
  describePlan,
  escalateInputSchema,
  formatReasons,
  normalizeEscalateInput,
  planInputSchema,
  renderArgIssues,
  scheduleReturnInputSchema,
  validatePlan,
} from "./control-tools.js";
import { type ControlCall, ensureToolCall, record, recordResult } from "./recording.js";
import { canScheduleReturn } from "./request.js";
import type { LoopContext } from "./run-context.js";
import { canonicalJson } from "./state.js";

/**
 * Nobody answers a routine's run live (docs/ROTINAS.md): a question would leave the run waiting
 * forever and every next fire of the routine skipped. The bot says what it needs in its final
 * answer, which goes to its chat with the user.
 */
export const ROUTINE_NO_QUESTIONS =
  "Nobody is watching this routine run live, so you cannot ask the user now. Do what you can, then end with your answer and say in it exactly what you need from the user (it is posted in your chat with them).";

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
  /** The text the model wrote in the turn of the call (what it says besides the question). */
  turnText = "",
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
  if (ctx.run.origin === "routine") {
    await recordResult(ctx, call.id, {
      outcome: "tool_error",
      isError: true,
      content: ROUTINE_NO_QUESTIONS,
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
  const normalized = normalizeEscalateInput(parsed.data);
  if (!normalized.ok) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: `${normalized.problem} Call escalate again with a valid question.`,
    });
    return;
  }
  const { questions, text } = normalized;
  // A plain question stays as it always was; anything richer is recorded as the questionnaire.
  const plain = questions.length === 1 && questions[0]?.options === undefined;
  // No result is recorded: the user's answer will be it. The loop pauses at the next safe point.
  const lead = turnText.trim();
  await record(ctx, {
    type: "escalated",
    payload: {
      question: text,
      ...(plain ? {} : { questions }),
      callId: call.id,
      ...(lead === "" ? {} : { lead }),
    },
  });
}

/**
 * `schedule_return`: the bot asks to come back by itself. It only records the wish (the event
 * `wait_scheduled`, with the instant fixed now); the run is parked after the turn in which the
 * bot tells the user about it (see `parkForReturn`). A second call replaces the first.
 */
export async function handleScheduleReturn(ctx: LoopContext, call: ControlCall): Promise<void> {
  await ensureToolCall(ctx, call);
  const refuse = (content: string) =>
    recordResult(ctx, call.id, { outcome: "tool_error", isError: true, content });
  if (!canScheduleReturn(ctx)) {
    await refuse(
      "schedule_return is not available in this run: only a conversation run of the user can come back by itself.",
    );
    return;
  }
  const parsed = scheduleReturnInputSchema.safeParse(call.args);
  if (!parsed.success) {
    await recordResult(ctx, call.id, {
      outcome: "invalid_args",
      isError: true,
      content: renderArgIssues("schedule_return", parsed.error),
    });
    return;
  }
  const note = parsed.data.note.trim();
  if (note === "") {
    await refuse("The note is empty: say what to check when you come back.");
    return;
  }
  if (ctx.state.waiting !== null) {
    await refuse(
      "A return cannot be scheduled while the run waits for the user (an answer or an approval).",
    );
    return;
  }
  const max = ctx.deps.bot.limits.maxReturns ?? DEFAULT_MAX_RETURNS;
  if (ctx.state.wakeCount >= max) {
    await refuse(
      `This run already came back ${ctx.state.wakeCount} times in a row (the limit is ${max}). Finish the work, or ask the user with escalate how to go on.`,
    );
    return;
  }
  const { inMinutes } = parsed.data;
  const at = new Date(ctx.deps.now().getTime() + inMinutes * 60_000).toISOString();
  const known = ctx.state.wait;
  // On resume this very call may already be recorded (its instant stays the first one); never log
  // it twice.
  const already = known !== null && known.callId === call.id;
  const replaced = known !== null && !already;
  if (!already) {
    if (replaced) await record(ctx, { type: "wait_cancelled", payload: { reason: "replaced" } });
    await record(ctx, {
      type: "wait_scheduled",
      payload: { at, note, minutes: inMinutes, callId: call.id },
    });
  }
  await recordResult(ctx, call.id, {
    outcome: "ok",
    isError: false,
    content: `Retorno agendado para daqui a ${inMinutes} minuto(s)${replaced ? " (substituiu o anterior)" : ""}. Agora escreva ao usuário uma mensagem curta dizendo o que ficou rodando, quando você volta e o que vai conferir. Não chame mais ferramentas: a sua mensagem encerra este turno e a execução fica parada até a hora.`,
  });
}
