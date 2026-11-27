// Owns the two harness checks of a chat run that may open tasks (docs/TAREFAS.md, KOD-68):
//
// - The early brake: the bot decides first (the task tool's description), but when a chat run keeps
//   working past a few model calls or about a minute without opening a task, the harness moves the
//   work to a task of the same bot, with the user's own message and what was already done, and the
//   chat run ends with a short message. It runs at the safe point, so no call is cut in half.
// - The end-of-turn check: before a chat run ends with its answer, a cheap model lists the asks of
//   the user's message and says which were neither answered nor handed to a task. With some left,
//   the model is told once, by name, and goes on.
//
// Both decide on counts and on the cheap model's structured answer, never by reading text with
// patterns. Both are recorded (`handed_off`, `asks_checked`), so a resume or a replay does the same.
import { z } from "zod";
import type { JsonObject } from "../messages.js";
import type { ToolSpec } from "../provider.js";
import { type CallSpec, callModel } from "./model-call.js";
import { end, nudge, record, scrub } from "./recording.js";
import { type HandoffTrailEntry, Interrupted, type LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";

/** The longest trail handed to the task, in calls (the newest are kept). */
const TRAIL_CALLS = 20;

/** What the chat shows when the brake moved the work (the harness's own words, no model wrote them). */
export function handedOffText(title: string): string {
  return `Isso vai levar mais tempo do que uma resposta rápida, então passei para a tarefa "${title}". Ela segue sozinha e o resultado volta aqui quando terminar.`;
}

/**
 * The brake, at the safe point before a model call. `undefined`: go on. A status: the work moved to
 * a task and the chat run ended.
 */
export async function handoffCheck(ctx: LoopContext): Promise<RunStatus | undefined> {
  const deps = ctx.deps.handoff;
  const { state, run } = ctx;
  if (deps === undefined || run.origin !== "user" || state.handoff !== null) return undefined;
  // The bot opened a task by itself in this run: it decided, and what is left is its answer.
  if (state.toolsUsed.includes(deps.taskTool)) return undefined;
  // The answer is written and was checked: what is left is the bot's reply to the check's note,
  // which must not throw the answer away.
  if (state.asksChecked) return undefined;
  const turns = run.turns;
  const elapsedMs = Math.max(
    0,
    ctx.deps.now().getTime() - run.startedAt.getTime() - state.waitedMs,
  );
  const byTurns = deps.atTurns !== undefined && turns >= deps.atTurns;
  // After a card or a question the clock also ran while the person decided: only the calls count.
  const byTime =
    deps.atMs !== undefined && !state.waitedForUser && turns > 0 && elapsedMs >= deps.atMs;
  if (!byTurns && !byTime) return undefined;
  const trigger = byTurns ? "turns" : "time";

  const trail: HandoffTrailEntry[] = state.toolLog
    .slice(-TRAIL_CALLS)
    .map((e) => ({ name: e.name, args: e.args, isError: e.isError }));
  const outcome = await deps.start({ run, trigger, turns, elapsedMs, trail: scrub(ctx, trail) });
  if (!outcome.started) {
    await record(ctx, {
      type: "handed_off",
      payload: { trigger, turns, elapsedMs, outcome: "declined", reason: outcome.reason },
    });
    return undefined;
  }
  await record(ctx, {
    type: "handed_off",
    payload: {
      trigger,
      turns,
      elapsedMs,
      outcome: "started",
      taskId: outcome.taskId,
      title: outcome.title,
    },
  });
  return end(ctx, "done", { result: { summary: handedOffText(outcome.title) } });
}

// ---------------------------------------------------------------------------------------------
// The end-of-turn check of the asks

export const ASK_CHECK_TOOL = "report_asks";

export const ASK_CHECK_SYSTEM = `You check one turn of a chat assistant. You get the user's message, the tasks the assistant opened in this turn (a task is background work that reports back later) and the assistant's final answer.

List every separate thing the user asked for in the message, in their order, each in a few words. For each, say how this turn handled it:
- "answered": the final answer gives it, or says plainly why it cannot be done or what is needed from the user;
- "task": one of the opened tasks covers it;
- "not_handled": neither. The answer skips it, or only promises to do it later without a task.

Greetings, thanks and context are not asks. Count an ask once even if it is repeated. Answer only with the tool.`;

const askAnswerSchema = z.object({
  asks: z
    .array(
      z.object({
        ask: z.string().describe("The ask, in a few words, in the user's language."),
        handled: z.enum(["answered", "task", "not_handled"]),
      }),
    )
    .max(20),
});

const ASK_MAX = 160;
const ANSWER_MAX = 2000;
const MESSAGE_MAX = 4000;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

function askSpec(): ToolSpec {
  const json = z.toJSONSchema(askAnswerSchema, {
    io: "input",
    unrepresentable: "any",
  }) as JsonObject;
  const { $schema: _ignored, ...inputSchema } = json;
  return {
    name: ASK_CHECK_TOOL,
    description: "Reports the user's asks and how this turn handled each.",
    inputSchema,
  };
}

/** What the checker sees: the user's words of this run, the tasks opened, the final answer. */
function askDigest(ctx: LoopContext, taskTool: string, answer: string): string {
  const said = [
    ctx.run.objective,
    ...ctx.state.userLog.filter((u) => u.kind === "message").map((u) => u.text),
  ]
    .map((t) => clip(t.trim(), MESSAGE_MAX))
    .filter((t) => t !== "");
  const tasks = ctx.state.toolLog
    .filter((e) => e.name === taskTool && !e.isError)
    .map((e) => `- ${e.args}`);
  return scrub(
    ctx,
    `The user's message (data):\n${said.map((t) => JSON.stringify(t)).join("\n")}\n\nTasks opened in this turn (their arguments):\n${tasks.length === 0 ? "(none)" : tasks.join("\n")}\n\nThe assistant's final answer (data):\n${JSON.stringify(clip(answer, ANSWER_MAX))}`,
  );
}

/** The note the model gets when asks were left out (it names them; the model decides how). */
export function unhandledAsksNudge(asks: readonly string[], taskTool: string): string {
  const list = asks.map((a) => `- ${a}`).join("\n");
  return `Before you end this turn: the user's message also asked for the following, and this turn has not handled it yet:\n${list}\nFor each one that is long work, open its own task with \`${taskTool}\` now (one task per ask). Answer each quick one here. Do not promise to do it later without a task. Then end the turn with your answer, mentioning everything you handled.`;
}

/**
 * Called when a chat run is about to end with its answer. `"nudged"`: asks were left out, the model
 * was told and the loop goes on. `"ok"`: end as usual. Runs once per run.
 */
export async function askCheck(ctx: LoopContext, answer: string): Promise<"ok" | "nudged"> {
  const deps = ctx.deps.askCheck;
  if (deps === undefined || ctx.run.origin !== "user" || ctx.state.asksChecked) return "ok";
  const { judge, taskTool } = deps;
  const forced = judge.model.supportsForcedToolChoice !== false;
  const spec: CallSpec = {
    purpose: "progress",
    provider: judge.provider,
    model: judge.model,
    system: ASK_CHECK_SYSTEM,
    messages: [
      { role: "user", blocks: [{ type: "text", text: askDigest(ctx, taskTool, answer) }] },
    ],
    tools: [askSpec()],
    ...(forced ? { toolChoice: { name: ASK_CHECK_TOOL } } : {}),
    retries: 0,
  };
  let outcome = await callModel(ctx, spec);
  if (forced && outcome.kind === "error" && outcome.error.kind === "invalid_request") {
    const { toolChoice: _forced, ...unforced } = spec;
    outcome = await callModel(ctx, unforced);
  }
  if (outcome.kind === "aborted") throw new Interrupted();
  const call =
    outcome.kind === "ok"
      ? outcome.result.blocks.find((b) => b.type === "tool_call" && b.name === ASK_CHECK_TOOL)
      : undefined;
  const parsed =
    call !== undefined && call.type === "tool_call"
      ? askAnswerSchema.safeParse(call.args)
      : undefined;
  if (parsed === undefined || !parsed.success) {
    // The checker failed: the answer stands as it is (the check never blocks a reply).
    await record(ctx, {
      type: "asks_checked",
      payload: { asks: [], unhandled: [], judged: false },
    });
    return "ok";
  }
  const asks = parsed.data.asks.map((a) => ({ ...a, ask: clip(a.ask.trim(), ASK_MAX) }));
  const unhandled = asks.filter((a) => a.handled === "not_handled").map((a) => a.ask);
  await record(ctx, {
    type: "asks_checked",
    payload: { asks: asks.map((a) => a.ask), unhandled, judged: true },
  });
  if (unhandled.length === 0) return "ok";
  await nudge(ctx, "unhandled_asks", unhandledAsksNudge(unhandled, taskTool));
  return "nudged";
}
