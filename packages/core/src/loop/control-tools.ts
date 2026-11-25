import { z } from "zod";
import {
  type Discrepancy,
  type EscalateQuestion,
  escalateOptionSchema,
  escalateQuestionSchema,
  type PlanStep,
  type ToolSearchMode,
  type UncheckedItem,
} from "../events.js";
import type { JsonObject } from "../messages.js";
import type { ToolSpec } from "../provider.js";
import {
  FINAL_VERDICT_TOOL_DESCRIPTION,
  MAX_RETURN_MINUTES,
  openSteps,
  VERDICT_TOOL_DESCRIPTION,
} from "./prompts.js";
import { toolSearchControlSpecs } from "./tool-search.js";

/**
 * Tools the loop handles itself. They are always available, never go through the registry and do
 * not need an executor: they only read and change the run's own state.
 */
export const CONTROL_TOOL_NAMES = [
  "plan",
  "finish",
  "escalate",
  "request_secret",
  "schedule_return",
  "search_tools",
  "use_tool",
] as const;
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

export const FINISH_DESCRIPTION = `End the run. Call it only when the work is really finished AND verified. Call it ALONE in its turn, after you have seen the results of every other tool; a finish sent together with other tool calls is rejected (only a \`plan\` update placed BEFORE it in the same turn is allowed, e.g. marking the last step done).

Arguments:
- \`summary\`: what was done and what the outcome is, in the user's language. Give a string for a short answer or one continuous idea. Optionally give an array of self-contained messages for distinct intentions or topics (for example an answer followed by a useful qualification). Keep each list, table, or code block whole. Never repeat content already shown by a card. Do not split by paragraph count.
- \`evidence\`: one entry for EACH acceptance criterion shown in the STATE REMINDER. Set \`criterion\` to the criterion's exact text (or its number, such as "1") and \`evidence\` to what you checked and observed: the command and its output, the file content you read back, the page you fetched. A restatement of the claim ("it works") is not evidence.

The harness rejects the finish, and tells you every reason at once, if: the summary is empty, a plan step is still pending or in_progress, an acceptance criterion has no evidence, or an evidence text is empty. An independent reviewer may also reject it after comparing your evidence with what the tool results actually show. When rejected, fix what is wrong (do the missing work, update the plan, add real evidence) and call finish again; do not argue or resend it unchanged.

If the task cannot be completed as asked, do not finish: use \`escalate\`.`;

export const ESCALATE_DESCRIPTION = `Stop and ask the user a question (or, rarely, a short questionnaire). Use it when you are blocked (missing information or access), when the task is impossible or ambiguous in a way that matters, when a decision belongs to the user, or before something risky or irreversible that was not clearly authorized. Do not use it for things you can find out or decide yourself.

How the user sees it: the question is the TITLE of a card in the chat, with the options under it. So keep each question short and precise (one sentence), and never repeat it in your message text. Write text in the same turn only when you have something to add (what you tried or found, a short reason, what you would do by default): it shows as your message above the card. With nothing to add, write no text at all and only call this tool. Together, your text and the question must be answerable on their own, without scrolling back.

Two forms (use exactly one):
- \`question\` (plus optional \`options\`): ONE question. This is the usual form.
- \`questions\`: a questionnaire of 1 to 5 questions, each with its own \`question\`, optional \`options\`, \`multiple\` (the user may pick several) and \`allowOther\`. Use it ONLY when you need several independent answers at once and the choices are genuinely discrete; never ask more questions than you need, and never split one decision into several.

Pass \`options\` (2 to 5 items for \`question\`, 2 to 6 per entry of \`questions\`; each a short \`label\` and an optional one-line \`description\`) ONLY when the possible answers are genuinely discrete, such as choosing between two approaches or confirming one of a few named alternatives. The user sees them as choices, but may always answer with free text, and may skip a question of a questionnaire. Leave \`options\` out for open questions, for missing information, and when you would have to invent choices.

The reply comes back as plain text. For one question it is the chosen label(s) (separated by "; ") or what the user typed. For a questionnaire it is one line per question, \`1. <question> → <chosen labels, separated by "; ">\`, with \`→ (pulou)\` for a question the user skipped.

Call it ALONE in its turn. The run pauses until the user replies; the reply comes back as this tool's result, and you continue from there.`;

export const REQUEST_SECRET_DESCRIPTION = `Ask the user for a credential you need (an API token, a password) that is not in your list of secrets. The user types it into a secure form that stores it in the vault: you NEVER see the value, now or later. When the user answers, you are told only that the secret is now available (or that they declined).

To USE a secret, write the placeholder \`{{secret:NAME}}\` where the value belongs, in a field of a tool that accepts it (for example inside a shell command or a request header). The harness puts the real value in at the moment of the action. Never try to read, print, store or repeat a secret value. A call that uses a secret may need the user's approval.

Arguments: \`name\` (capital letters, digits and underscores, e.g. GITHUB_TOKEN) and \`reason\` (one sentence the user reads: what it is for). Call it ALONE in its turn; the run pauses until the user answers.`;

/** Largest wait a return may ask for, in minutes (defined with the guidance in prompts.ts). */
export { MAX_RETURN_MINUTES };
/** Longest note a return may carry, in characters. */
export const MAX_RETURN_NOTE_CHARS = 500;
/** Consecutive returns one run may have, unless `limits.maxReturns` says otherwise. */
export const DEFAULT_MAX_RETURNS = 6;

export const SCHEDULE_RETURN_DESCRIPTION = `Agenda um retorno seu, sozinho, daqui a alguns minutos, na mesma conversa. Use quando você disparou algo que demora (um deploy, um pipeline de CI, um build, uma migração, uma fila) e o resultado só existe depois de um tempo: em vez de ficar em laço de espera, agende e termine o turno. Use também para um lembrete único que o usuário pede para daqui a até ${MAX_RETURN_MINUTES} minutos ("me lembra daqui 20 minutos de enviar meu RG"): agende, diga na mensagem quando vai lembrar e, ao voltar, lembre o usuário na sua mensagem. Não use para esperar a resposta do usuário (para isso há \`escalate\`), para um lembrete mais longe que isso (\`create_reminder\`) nem para o que se repete (isso é uma rotina, \`create_routine\`, quando o usuário pede).

Argumentos:
- \`inMinutes\`: inteiro de 1 a ${MAX_RETURN_MINUTES}. Se o que você espera demora mais que isso, agende ${MAX_RETURN_MINUTES} e, ao voltar, confira e agende de novo.
- \`note\`: até ${MAX_RETURN_NOTE_CHARS} caracteres, escrita por você para você mesmo: o que conferir quando voltar e o que fazer com o resultado. É a única coisa que você recebe ao voltar além do plano, então inclua o que for preciso (ids, comandos, endereços).

Como funciona: depois desta chamada, escreva ao usuário, em texto, uma mensagem curta dizendo o que você deixou rodando, quando você volta e o que vai conferir (é assim que ele fica sabendo; não há aviso nenhum além da sua mensagem). Não chame outras ferramentas depois disso: o turno termina com a sua mensagem e a execução fica parada, sem custo, até a hora. Ao voltar você retoma a mesma execução, com o mesmo plano e o mesmo histórico, e recebe a sua nota. Se o usuário escrever antes da hora, o retorno é cancelado e você responde a ele; se ainda precisar conferir depois, agende de novo.

Limites: um retorno pendente por vez (uma nova chamada substitui a anterior) e no máximo ${DEFAULT_MAX_RETURNS} retornos seguidos; passado isso, termine o trabalho ou pergunte ao usuário. Os limites de turnos e de custo da execução continuam valendo através dos retornos. Uma ação que pede aprovação continua pedindo depois que você volta.`;

export const scheduleReturnInputSchema = z.object({
  inMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_RETURN_MINUTES)
    .describe(`Minutos até voltar, inteiro de 1 a ${MAX_RETURN_MINUTES}.`),
  note: z
    .string()
    .max(MAX_RETURN_NOTE_CHARS)
    .describe(`O que conferir ao voltar (até ${MAX_RETURN_NOTE_CHARS} caracteres).`),
});

export const requestSecretInputSchema = z.object({
  name: z.string().describe("The secret's name, e.g. GITHUB_TOKEN."),
  reason: z.exactOptional(z.string()).describe("What it is for, in one sentence, for the user."),
});

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
  summary: z
    .union([
      z.string(),
      z
        .array(
          z
            .string()
            .min(1)
            .refine((part) => part.trim() !== "", "part must not be blank"),
        )
        .min(1)
        .max(20),
    ])
    .describe("The answer for the user: one string, or an ordered array of complete parts."),
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
  question: z
    .exactOptional(z.string())
    .describe("A single, precise question for the user. Use this OR `questions`."),
  options: z
    .exactOptional(z.array(escalateOptionSchema).min(2).max(5))
    .describe(
      "Only with `question`: 2 to 5 choices, only when the answers are genuinely discrete. The user may still answer in free text.",
    ),
  questions: z
    .exactOptional(z.array(escalateQuestionSchema).min(1).max(5))
    .describe(
      "A questionnaire of 1 to 5 questions, only when you need several independent answers at once. Use this OR `question`.",
    ),
});

export type EscalateInput = z.infer<typeof escalateInputSchema>;

/**
 * Checks and normalises what the model asked: ONE questionnaire, or the reason it is not valid.
 * Whitespace is trimmed; labels must be non-empty and distinct inside a question.
 */
export function normalizeEscalateInput(
  input: EscalateInput,
): { ok: true; questions: EscalateQuestion[]; text: string } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem });
  if (input.question !== undefined && input.questions !== undefined) {
    return bad(
      "Use either `question` (one question, with optional `options`) or `questions` (a questionnaire), not both.",
    );
  }
  if (input.question === undefined && input.questions === undefined) {
    return bad("Provide `question` (one question) or `questions` (a questionnaire).");
  }
  if (input.questions !== undefined && input.options !== undefined) {
    return bad(
      "`options` goes with `question`. In a questionnaire, put the options inside each entry of `questions`.",
    );
  }
  const raw: EscalateQuestion[] = input.questions ?? [
    {
      question: input.question as string,
      ...(input.options === undefined ? {} : { options: input.options }),
    },
  ];
  const questions: EscalateQuestion[] = [];
  for (const [index, q] of raw.entries()) {
    const label = raw.length === 1 ? "The question" : `Question ${index + 1}`;
    const text = q.question.trim();
    if (text === "") {
      return bad(`${label} is empty. Ask one precise question, or leave it out.`);
    }
    const options = q.options?.map((o) => ({
      label: o.label.trim(),
      ...(o.description === undefined || o.description.trim() === ""
        ? {}
        : { description: o.description.trim() }),
    }));
    if (options?.some((o) => o.label === "") === true) {
      return bad(
        `${label} has an option with an empty label. Give every option a short label, or leave options out.`,
      );
    }
    if (new Set(options?.map((o) => o.label.toLowerCase())).size !== (options?.length ?? 0)) {
      return bad(
        `${label} has two options with the same label. Make the labels distinct, or leave options out.`,
      );
    }
    if (options === undefined && (q.multiple === true || q.allowOther === true)) {
      return bad(
        `${label} sets \`multiple\` or \`allowOther\` without \`options\`. They only make sense with options.`,
      );
    }
    questions.push({
      question: text,
      ...(options === undefined ? {} : { options }),
      ...(q.multiple === true ? { multiple: true } : {}),
      ...(q.allowOther === true ? { allowOther: true } : {}),
    });
  }
  const text =
    questions.length === 1
      ? (questions[0] as EscalateQuestion).question
      : questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
  return { ok: true, questions, text };
}

/**
 * The discrepancies the reviewer lists. `real_mismatch` is the reviewer's own statement that the
 * entry is a real difference between the claim and the evidence; one it marks `false` is dropped
 * (a thing it checked and found matching). It is required for the model; reading it is lenient (see
 * `verdictParseSchema`), so a missing flag costs a re-ask and not an approval by default.
 */
function discrepanciesField(flagRequired: boolean) {
  const flag = z
    .boolean()
    .describe(
      "true ONLY if what the evidence shows really DIFFERS from what the work claims. false if you checked and they match, or you found no real difference: such an entry is discarded. Things that match do not belong here (put them in `notes`).",
    );
  return z
    .array(
      z.object({
        claimed: z.string().describe("What the assistant's work or evidence claims."),
        shows: z
          .string()
          .describe("What the tool results or files actually show instead (a real difference)."),
        where: z
          .string()
          .describe(
            'Where to see it: a digest id ("#3"), a file path, or an acceptance criterion.',
          ),
        real_mismatch: flagRequired ? flag : flag.optional(),
      }),
    )
    .optional()
    .describe(
      "Only for a reject: the REAL mismatches between the claim and the evidence, at least one, each with real_mismatch true. This is not a list of what you checked and found correct (that goes in `notes`). A reject with no real mismatch is not accepted: if you found none, answer approve or cannot_verify.",
    );
}

/** What the reviewer says it could not check: what, and the reference it would need. */
function uncheckedField(flagRequired: boolean) {
  const item = z.object({
    what: z.string().describe("The claim or fact you could not check."),
    kind: flagRequired
      ? z
          .enum(["result", "call", "file", "other"])
          .describe(
            'What you would need: "result" (a tool result), "call" (the arguments of a tool call), "file" (a workspace file) or "other".',
          )
      : z.enum(["result", "call", "file", "other"]).optional(),
    ref: flagRequired
      ? z
          .string()
          .describe('The digest id ("#3"), the file path, or the reference of what you would need.')
      : z.string().optional(),
  });
  const list = z
    .array(item)
    .describe(
      "Only for cannot_verify, at least one: each thing you could NOT check, with what you would need to check it. Do not list what the digest or the evidence already showed you in full.",
    );
  return flagRequired ? list.optional() : list.optional().catch(undefined);
}

/** The discrepancies of a reject that are usable: all three parts written and marked as a real mismatch. */
export function validDiscrepancies(
  list: readonly (Discrepancy & { real_mismatch?: boolean | undefined })[] | undefined,
): Discrepancy[] {
  return (list ?? [])
    .filter((d) => d.real_mismatch === true)
    .map((d) => ({
      claimed: d.claimed.trim(),
      shows: d.shows.trim(),
      where: d.where.trim(),
    }))
    .filter((d) => d.claimed !== "" && d.shows !== "" && d.where !== "");
}

/** The unchecked items that name something (`what` written); kind and reference default to `other` / "". */
export function validUnchecked(
  list:
    | readonly {
        what: string;
        kind?: UncheckedItem["kind"] | undefined;
        ref?: string | undefined;
      }[]
    | undefined,
): UncheckedItem[] {
  return (list ?? [])
    .map((u) => ({ what: u.what.trim(), kind: u.kind ?? "other", ref: (u.ref ?? "").trim() }))
    .filter((u) => u.what !== "");
}

/** The discrepancies as a numbered list, for the assistant (and the user) to act on. */
export function formatDiscrepancies(list: readonly Discrepancy[]): string {
  return list
    .map(
      (d, i) =>
        `${i + 1}. Claimed: ${d.claimed}\n   Evidence shows: ${d.shows}\n   Where: ${d.where}`,
    )
    .join("\n");
}

/**
 * What the reviewer may answer. `need_evidence` asks the harness for items the digest only shows
 * in part (`results`: digest entries like "#3" or call ids; `calls`: the full ARGUMENTS of tool
 * calls, such as a script written inside a shell command; `files`: workspace paths);
 * `cannot_verify` says that something stayed unchecked even with the evidence, and lists it in
 * `unchecked`. A `reject` must carry `discrepancies` with at least one `real_mismatch: true`, and a
 * `cannot_verify` an `unchecked` that names something the harness had not already sent in full. Both
 * are checked by `parseVerdict` and `finish.ts`, not by the schema, so the reviewer can be asked
 * again instead of failing the call. `strict` is the schema the model sees (the flags required);
 * reading uses the lenient one (`verdictParseSchema`).
 */
function verdictShape(strict: boolean) {
  return z.object({
    verdict: z.enum(["approve", "reject", "need_evidence", "cannot_verify"]),
    notes: z
      .string()
      .describe(
        "Short explanation. Reject: what the assistant should fix. need_evidence: what you will check. cannot_verify: what could not be verified. Put here what you checked and found correct, if useful.",
      ),
    discrepancies: discrepanciesField(strict),
    unchecked: uncheckedField(strict),
    results: z
      .array(z.string())
      .optional()
      .describe(
        'need_evidence: tool RESULTS (what the tool returned) to see in full, as in the digest ("#3") or by call id.',
      ),
    calls: z
      .array(z.string())
      .optional()
      .describe(
        'need_evidence: tool CALLS whose full ARGUMENTS (the whole command, the content written to a file) you want to see, as in the digest ("#3"). Use it when the digest marks ARGUMENTS SHORTENED. Different from `results`.',
      ),
    files: z
      .array(z.string())
      .optional()
      .describe("need_evidence: workspace files to read in full, by relative path."),
  });
}

export const verdictInputSchema = verdictShape(true);
export const verdictParseSchema = verdictShape(false);

function toolSpec(name: string, description: string, schema: z.ZodType): ToolSpec {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonObject;
  const { $schema: _ignored, ...inputSchema } = json;
  return { name, description, inputSchema };
}

/**
 * The specs of the control tools, in the order the model sees them. `request_secret` is offered
 * only to a run that has a vault, `schedule_return` only to a run that may come back by itself.
 */
export function controlToolSpecs(
  options: {
    secrets?: boolean;
    /** The run may come back by itself (a conversation run): see `schedule_return`. */
    scheduleReturn?: boolean;
    toolSearch?: ToolSearchMode | undefined;
  } = {},
): ToolSpec[] {
  return [
    toolSpec("plan", PLAN_DESCRIPTION, planInputSchema),
    toolSpec("finish", FINISH_DESCRIPTION, finishInputSchema),
    toolSpec("escalate", ESCALATE_DESCRIPTION, escalateInputSchema),
    ...(options.secrets === true
      ? [toolSpec("request_secret", REQUEST_SECRET_DESCRIPTION, requestSecretInputSchema)]
      : []),
    ...(options.scheduleReturn === true
      ? [toolSpec("schedule_return", SCHEDULE_RETURN_DESCRIPTION, scheduleReturnInputSchema)]
      : []),
    ...toolSearchControlSpecs(options.toolSearch),
  ];
}

/** The last round no longer lets the reviewer ask for evidence: it must decide or say what it could not check. */
const finalVerdictInputSchema = z.object({
  verdict: z.enum(["approve", "reject", "cannot_verify"]),
  notes: z
    .string()
    .describe(
      "Short explanation. Reject: what the assistant should fix. cannot_verify: what could not be verified. Put here what you checked and found correct, if useful.",
    ),
  discrepancies: verdictInputSchema.shape.discrepancies,
  unchecked: verdictInputSchema.shape.unchecked,
});

export function verdictToolSpec(canAskEvidence = true): ToolSpec {
  return canAskEvidence
    ? toolSpec("verdict", VERDICT_TOOL_DESCRIPTION, verdictInputSchema)
    : toolSpec("verdict", FINAL_VERDICT_TOOL_DESCRIPTION, finalVerdictInputSchema);
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
