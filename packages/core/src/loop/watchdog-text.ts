// Owns what the progress watchdog says to people, in Portuguese (the owner reads it in the chat or
// in the routine's result) and what it asks the cheap judge, in English (docs/VIGIA.md). The words
// of the owner's card are fixed here and read back by exact comparison (resume.ts); nothing here
// is matched against free text.
import type { PlanStep } from "../events.js";

export type ProgressCause = "limit" | "repeat" | "error_loop" | "no_tool" | "alternation";

/** The one friendly line that says what happened. */
export function headline(cause: ProgressCause): string {
  switch (cause) {
    case "limit":
      return "Cheguei no limite de passos desta tarefa.";
    case "no_tool":
      return "Parei sem conseguir dar o próximo passo.";
    default:
      return "Estou repetindo a mesma coisa.";
  }
}

const clip = (text: string, max: number): string => {
  const flat = text.split("\n").join(" ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A short account of what is done and what is left, from the plan (or the count of actions). */
export function summaryLine(plan: readonly PlanStep[], actions: number): string {
  if (plan.length === 0) {
    return actions === 0
      ? "Ainda não fiz nenhuma ação."
      : `Até aqui fiz ${actions} ${actions === 1 ? "ação" : "ações"}.`;
  }
  const titles = (steps: readonly PlanStep[]) =>
    steps
      .slice(0, 3)
      .map((s) => clip(s.title, 80))
      .join("; ") + (steps.length > 3 ? `; e mais ${steps.length - 3}` : "");
  const done = plan.filter((s) => s.status === "done");
  const left = plan.filter((s) => s.status === "pending" || s.status === "in_progress");
  const parts: string[] = [];
  if (done.length > 0) parts.push(`Já fiz: ${titles(done)}.`);
  if (left.length > 0) parts.push(`Falta: ${titles(left)}.`);
  if (parts.length === 0)
    parts.push(`Até aqui fiz ${actions} ${actions === 1 ? "ação" : "ações"}.`);
  return parts.join(" ");
}

/** The card's labels. The loop reads the answer by comparing the text with these exactly. */
export const continueLabel = (grant: number): string => `Continuar (+${grant} passos)`;
export const STOP_LABEL = "Parar por aqui";
export const progressQuestion = (grant: number): string =>
  `Quer que eu continue por mais ${grant} passos?`;

/** The bubble above the card: what happened, and what is done and left. */
export function askLead(cause: ProgressCause, summary: string): string {
  return `${headline(cause)} ${summary}`;
}

/** What the owner reads when they chose to stop. */
export function ownerStoppedText(summary: string): string {
  return `Parei por aqui, como você pediu. ${summary} Se quiser que eu continue depois, é só me chamar.`;
}

/** What a routine leaves in the chat when it is stopped (nobody was there to ask). */
export function routineStoppedText(cause: ProgressCause, summary: string): string {
  return `${headline(cause)} Parei por aqui para não gastar sem ninguém acompanhando. ${summary} Quando puder, me diga se devo continuar ou mudar o que pedi.`;
}

export const PROGRESS_JUDGE_TOOL = "progress_verdict";

export const PROGRESS_JUDGE_SYSTEM = `You judge whether an AI assistant's run is still making progress or is going in circles. You do not see the conversation: you see the objective, the plan, some counters the harness measured by exact comparison, and the last tool calls with a short digest of each result (never the arguments; "args#" is a fingerprint, equal fingerprints mean equal arguments).

Decide one of:
- "avanca": the recent calls move the work forward (new files written or changed, new results that matter, steps of the plan closing), even if slowly. A long job that is waited on by checking the same status while the result changes is progress, not a loop.
- "circulo": the assistant repeats itself or alternates between the same steps without learning anything new, or keeps failing the same way, or tries variations that lead nowhere.
- "incerto": you cannot tell from what you see. Prefer this over a guess.

The counters are facts; do not argue with them. A change or a new result in the last calls is evidence of progress; many equal calls with equal results is evidence of a loop. Answer by calling the ${PROGRESS_JUDGE_TOOL} tool exactly once, with a reason of one short sentence. Do not answer in any other way.`;

export const PROGRESS_JUDGE_TOOL_DESCRIPTION =
  'Give your judgement on the run. Call it exactly once. `verdict` is "avanca" (moving forward), "circulo" (going in circles) or "incerto" (cannot tell). `reason` is one short sentence.';
