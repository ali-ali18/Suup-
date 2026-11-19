import type { Question } from "./conversations.js";

// The answer to a question of the bot is PLAIN TEXT, sent as the user's message: the model reads it
// as the result of its `escalate` call, and the chat shows the same text as the user's bubble. These
// functions build that text from the choices, and read it back (to show which options were chosen
// in a card that was answered, also after a reload). The app and the CLI share them.

/** What the user did with one question. */
export interface QuestionAnswer {
  /** The labels of the options picked, and the free text typed ("other"), in order. */
  chosen: string[];
  /** The question was skipped on purpose. */
  skipped?: boolean;
}

export const SKIPPED = "(pulou)";
const SEPARATOR = "; ";
const ARROW = " → ";

/**
 * The text of the answer. One question: just the choices (labels joined by "; ", or what was
 * typed), `(pulou)` if skipped. Several: one line per question,
 * `1. <question> → <choices>` (or `→ (pulou)`), so the model reads it without ambiguity.
 */
export function buildAnswerText(
  questions: readonly Question[],
  answers: readonly QuestionAnswer[],
): string {
  const part = (answer: QuestionAnswer | undefined): string => {
    const chosen = (answer?.chosen ?? []).map((c) => c.trim()).filter((c) => c !== "");
    return answer?.skipped === true || chosen.length === 0 ? SKIPPED : chosen.join(SEPARATOR);
  };
  if (questions.length === 1) return part(answers[0]);
  return questions
    .map((q, i) => `${i + 1}. ${q.question.replace(/\s+/g, " ").trim()}${ARROW}${part(answers[i])}`)
    .join("\n");
}

/**
 * Reads an answer back. For a questionnaire it finds the line of each question and returns what
 * was chosen; `null` when the text is not in the format (the user typed something else instead).
 * For a single question the whole text is the answer.
 */
export function parseAnswerText(
  questions: readonly Question[],
  text: string,
): QuestionAnswer[] | null {
  const split = (value: string): QuestionAnswer =>
    value.trim() === SKIPPED || value.trim() === ""
      ? { chosen: [], skipped: true }
      : {
          chosen: value
            .split(SEPARATOR)
            .map((c) => c.trim())
            .filter((c) => c !== ""),
        };
  // One question: the whole text is the answer (a typed answer that is none of the options is "other").
  if (questions.length === 1) return [split(text)];
  const answers: QuestionAnswer[] = [];
  const lines = text.split("\n");
  for (const [index, question] of questions.entries()) {
    const line = lines.find((l) => l.startsWith(`${index + 1}. `));
    if (line === undefined) return null;
    const head = `${index + 1}. ${question.question.replace(/\s+/g, " ").trim()}${ARROW}`;
    if (!line.startsWith(head)) return null;
    answers.push(split(line.slice(head.length)));
  }
  return answers;
}

/**
 * Whether the user's reply to a question is one of the app's cards' answers: used to tell a reply
 * typed by hand from one built by the card (both are plain text and both answer the question).
 */
export function isStructuredAnswer(questions: readonly Question[], text: string): boolean {
  return questions.length > 1 && parseAnswerText(questions, text) !== null;
}
