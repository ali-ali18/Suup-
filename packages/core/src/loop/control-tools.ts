import { z } from "zod";
import type { PlanStep } from "../events.js";
import type { JsonObject } from "../messages.js";
import type { ToolSpec } from "../provider.js";
import { openSteps, VERDICT_TOOL_DESCRIPTION } from "./prompts.js";

/**
 * Tools the loop handles itself. They are always available, never go through the registry and do
 * not need an executor: they only read and change the run's own state.
 */
export const CONTROL_TOOL_NAMES = ["plan", "finish", "escalate"] as const;
export type ControlToolName = (typeof CONTROL_TOOL_NAMES)[number];

export function isControlTool(name: string): name is ControlToolName {
  return (CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

export const PLAN_DESCRIPTION = `Create or update your plan: the list of steps needed to reach the objective. Use it BEFORE acting on any task that takes more than one step, and call it again whenever a step starts, finishes, or the approach changes. The plan is shown back to you at the end of every turn.

Each call REPLACES the whole plan, so always send every step. A step has: a short stable \`id\` (keep the same id for the same step across calls), a \`title\` saying what the step achieves, a \`status\` (pending, in_progress, done or dropped) and an optional \`note\`.

Rules:
- At most one step may be in_progress at a time.
- Mark a step done only after you verified it, not when you merely started or sent something.
- A dropped step needs a \`note\` saying why it is no longer needed.
- Steps may be added at any time, but an existing step must not disappear: mark it dropped (with a note) instead.
- The run can only be ended with \`finish\`, and \`finish\` is accepted only when no step is pending or in_progress.

You may call plan in the same turn as other tools.`;

export const FINISH_DESCRIPTION = `End the run. Call it only when the work is really finished AND verified. Call it ALONE in its turn, after you have seen the results of every other tool; a finish sent together with other tool calls is rejected.

Arguments:
- \`summary\`: what was done and what the outcome is, written for the user, in the user's language.
- \`evidence\`: one entry for EACH acceptance criterion shown in the STATE REMINDER. Set \`criterion\` to the criterion's exact text (or its number, such as "1") and \`evidence\` to what you checked and observed: the command and its output, the file content you read back, the page you fetched. A restatement of the claim ("it works") is not evidence.

The harness rejects the finish, and tells you every reason at once, if: the summary is empty, a plan step is still pending or in_progress, an acceptance criterion has no evidence, or an evidence text is empty. An independent reviewer may also reject it after comparing your evidence with what the tool results actually show. When rejected, fix what is wrong (do the missing work, update the plan, add real evidence) and call finish again; do not argue or resend it unchanged.

If the task cannot be completed as asked, do not finish: use \`escalate\`.`;

export const ESCALATE_DESCRIPTION = `Stop and ask the user ONE question. Use it when you are blocked (missing information or access), when the task is impossible or ambiguous in a way that matters, when a decision belongs to the user, or before something risky or irreversible that was not clearly authorized. Do not use it for things you can find out or decide yourself.

Make the question precise and answerable in a sentence or two: say what you need to know, what you already tried or found, the options you see, and what you would do by default. Include the context needed to answer without reading the whole history.

Call it ALONE in its turn. The run pauses until the user replies; the reply comes back as this tool's result, and you continue from there.`;

const planStepInput = z.object({
  id: z.string().describe("Short stable identifier, e.g. 's1'. Reuse it for the same step."),
  title: z.string().describe("What this step achieves."),
  status: z.enum(["pending", "in_progress", "done", "dropped"]),
  note: z
    .exactOptional(z.string())
    .describe("Required when dropped: why the step is no longer needed. Optional otherwise."),
});

export const planInputSchema = z.object({
  steps: z
    .array(planStepInput)
    .min(1)
    .describe("The complete list of steps, in order. Replaces the previous plan."),
});

export const finishInputSchema = z.object({
  summary: z.string().describe("What was done and the outcome, for the user."),
  evidence: z
    .array(
      z.object({
        criterion: z.string().describe("The criterion's exact text, or its number (e.g. '1')."),
        evidence: z.string().describe("What you checked and observed."),
      }),
    )
    .default([])
    .describe("One entry per acceptance criterion."),
});

export const escalateInputSchema = z.object({
  question: z.string().describe("The single, precise question for the user."),
});

export const verdictInputSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  notes: z.string().describe("Short explanation; when rejecting, what is wrong and how to fix it."),
});

function toolSpec(name: string, description: string, schema: z.ZodType): ToolSpec {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonObject;
  const { $schema: _ignored, ...inputSchema } = json;
  return { name, description, inputSchema };
}

/** The specs of the three control tools, in the order the model sees them. */
export function controlToolSpecs(): ToolSpec[] {
  return [
    toolSpec("plan", PLAN_DESCRIPTION, planInputSchema),
    toolSpec("finish", FINISH_DESCRIPTION, finishInputSchema),
    toolSpec("escalate", ESCALATE_DESCRIPTION, escalateInputSchema),
  ];
}

export function verdictToolSpec(): ToolSpec {
  return toolSpec("verdict", VERDICT_TOOL_DESCRIPTION, verdictInputSchema);
}

/** Renders zod issues for the model, in the same shape the registry uses for ordinary tools. */
export function renderArgIssues(toolName: string, error: z.ZodError): string {
  const maxIssues = 8;
  const lines = error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.map(String).join(".");
    return `- ${path === "" ? "(arguments)" : path}: ${issue.message}`;
  });
  const extra = error.issues.length - maxIssues;
  if (extra > 0) lines.push(`- ... and ${extra} more problem(s)`);
  return `Invalid arguments for tool "${toolName}":\n${lines.join("\n")}\nFix the arguments and call the tool again.`;
}

/** All problems with a proposed plan, given the plan it would replace. Empty means valid. */
export function validatePlan(
  proposed: readonly PlanStep[],
  previous: readonly PlanStep[],
): string[] {
  const problems: string[] = [];

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const step of proposed) {
    if (step.id.trim() === "") problems.push("a step has an empty id");
    if (seen.has(step.id)) duplicated.add(step.id);
    seen.add(step.id);
  }
  for (const id of duplicated) problems.push(`duplicate step id "${id}"; ids must be unique`);

  for (const step of proposed) {
    if (step.title.trim() === "") problems.push(`step "${step.id}" has an empty title`);
    if (step.status === "dropped" && (step.note === undefined || step.note.trim() === "")) {
      problems.push(`step "${step.id}" is dropped but has no note explaining why`);
    }
  }

  const inProgress = proposed.filter((s) => s.status === "in_progress");
  if (inProgress.length > 1) {
    problems.push(
      `${inProgress.length} steps are in_progress (${inProgress.map((s) => s.id).join(", ")}); at most one may be`,
    );
  }

  for (const old of previous) {
    // A step that was already dropped may be left out; any other step must stay.
    if (old.status === "dropped") continue;
    if (!seen.has(old.id)) {
      problems.push(
        `step "${old.id}" (${old.title}) was removed; keep it in the plan and mark it dropped with a note instead`,
      );
    }
  }
  return problems;
}

/** What the model reads after a valid plan call. Depends only on the plan itself. */
export function describePlan(plan: readonly PlanStep[]): string {
  const count = (status: PlanStep["status"]) => plan.filter((s) => s.status === status).length;
  const parts = [
    `${plan.length} step(s)`,
    `${count("done")} done`,
    `${count("in_progress")} in progress`,
    `${count("pending")} pending`,
  ];
  if (count("dropped") > 0) parts.push(`${count("dropped")} dropped`);
  const open = openSteps(plan);
  const next = open[0];
  const tail =
    next === undefined
      ? "No step is open: call finish once the work is verified."
      : `Next: ${next.id} (${next.title}).`;
  return `Plan saved: ${parts.join(", ")}. ${tail}`;
}

export interface FinishArgs {
  summary: string;
  evidence: { criterion: string; evidence: string }[];
}

/** All harness-level reasons to refuse a `finish`. Empty means it passes (review comes later). */
export function validateFinish(
  args: FinishArgs,
  criteria: readonly string[],
  plan: readonly PlanStep[],
): string[] {
  const reasons: string[] = [];
  if (args.summary.trim() === "") reasons.push("the summary is empty");

  const open = openSteps(plan);
  if (open.length > 0) {
    reasons.push(
      `plan steps are still open: ${open.map((s) => `${s.id} "${s.title}" (${s.status})`).join("; ")}. Finish them, or update the plan to mark them done or dropped (with a note)`,
    );
  }

  const matchedEntries = new Set<number>();
  criteria.forEach((criterion, index) => {
    const matches = args.evidence
      .map((entry, i) => ({ entry, i }))
      .filter(({ entry }) => {
        const key = entry.criterion.trim();
        return key === criterion.trim() || key === String(index + 1);
      });
    for (const { i } of matches) matchedEntries.add(i);
    const label = `acceptance criterion ${index + 1} ("${criterion}")`;
    if (matches.length === 0) {
      reasons.push(
        `${label} has no evidence entry; add one whose "criterion" is its exact text or its number "${index + 1}"`,
      );
    } else if (matches.every(({ entry }) => entry.evidence.trim() === "")) {
      reasons.push(`the evidence for ${label} is empty`);
    }
  });
  args.evidence.forEach((entry, i) => {
    if (!matchedEntries.has(i) && entry.evidence.trim() === "") {
      reasons.push(`the evidence entry for "${entry.criterion}" is empty`);
    }
  });
  return reasons;
}

export function formatReasons(reasons: readonly string[]): string {
  return reasons.map((r) => `- ${r}`).join("\n");
}
