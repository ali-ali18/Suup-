import type { EscalateQuestion as Question } from "./events.js";

// The answer to a question of the bot is PLAIN TEXT, sent as the user's message: the model reads it
// as the result of its `escalate` call, and the chat shows the same text as the user's bubble. These
// functions build that text from the choices, and read it back (to show which options were chosen
// in a card that was answered, also after a reload). The app, the CLI, the server and the loop share
// them (they live in `core` so the loop, which is the one place every answer passes through, can
// resolve an option typed by its number or letter).

/** What the user did with one question. */
export interface QuestionAnswer {
  /** The labels of the options picked, and the free text typed ("other"), in order. */
  chosen: string[];
  /** The question was skipped on purpose. */
  skipped?: boolean;
}

export const SKIPPED = "(pulou)";

/**
 * What the run receives as the answer to its question when the user closes the card with the X:
 * written by the harness, for the model (never shown in the chat as the user's words). It lives
 * here, with the other answers, so the loop can tell a closed card from a typed answer by exact
 * comparison.
 */
export const DISMISSED_QUESTION_ANSWER =
  "(The user closed this question without choosing an option. They may still answer in the chat. Do not ask the same question again now: go on with what you can do without it, or end your turn and wait for their message.)";

/** Flattens runs of white space (including line breaks) into single spaces, without a pattern. */
export function oneLine(text: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of text) {
    if (ch.trim() === "") {
      if (word !== "") words.push(word);
      word = "";
    } else word += ch;
  }
  if (word !== "") words.push(word);
  return words.join(" ");
}
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
    .map((q, i) => `${i + 1}. ${oneLine(q.question)}${ARROW}${part(answers[i])}`)
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
    const head = `${index + 1}. ${oneLine(question.question)}${ARROW}`;
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

// ---------------------------------------------------------------------------------------------
// An option answered by its number or letter

/** The letter the app's card shows on the chip of option `index` (0 is "A"). */
export const optionLetter = (index: number): string => String.fromCharCode(65 + index);

/**
 * The label an answer stands for when the WHOLE answer is exactly one option's index as shown to
 * the user: the number the terminal prints ("1" to "N") or the letter of the app's card ("A" to
 * "F", either case). Exact comparison, nothing else: an answer that is an option's label stays as
 * typed, and so does a number outside the range or any text around it. `undefined` when it is none.
 */
function labelOfIndex(question: Question, text: string): string | undefined {
  const options = question.options;
  if (options === undefined) return undefined;
  const typed = text.trim();
  if (options.some((o) => o.label === typed)) return undefined;
  for (const [index, option] of options.entries()) {
    if (typed === String(index + 1) || typed.toUpperCase() === optionLetter(index)) {
      return option.label;
    }
  }
  return undefined;
}

/**
 * What one question's answer means: the label of the option, when the answer is exactly an index;
 * several labels (joined as the answer text does) when the question allows several and EVERY item
 * of the list ("1,3" or "1; 3") is an index; otherwise the text, untouched.
 */
export function resolveOptionAnswer(question: Question, text: string): string {
  if (question.options === undefined) return text;
  const one = labelOfIndex(question, text);
  if (one !== undefined) return one;
  if (question.multiple !== true) return text;
  for (const separator of [",", SEPARATOR]) {
    const parts = text.split(separator);
    if (parts.length < 2) continue;
    const labels = parts.map((part) => labelOfIndex(question, part));
    if (labels.every((label) => label !== undefined)) {
      return [...new Set(labels as string[])].join(SEPARATOR);
    }
  }
  return text;
}

/**
 * The text the model receives as the result of its `escalate` call. Anything the user typed stays
 * exactly as typed, except an option given by its number or letter (what the terminal and the
 * card show): that is resolved to the option's label, and the answer then names the question,
 * because a bare "1" says nothing to the model. One question:
 * `Answer to your question "<q>" (option 1): <label>`. A questionnaire in the documented format
 * (`1. <question> → <choices>`, one line each) keeps that format, with each index resolved (its
 * lines already name the questions); text in any other format is left alone.
 */
export function answerForModel(questions: readonly Question[], text: string): string {
  const first = questions[0];
  if (first === undefined) return text;
  if (questions.length === 1) {
    const label = resolveOptionAnswer(first, text);
    if (label === text) return text;
    return `Answer to your question "${oneLine(first.question)}" (option ${text.trim()}): ${label}`;
  }
  const answers = parseAnswerText(questions, text);
  if (answers === null) return text;
  let changed = false;
  const resolved = answers.map((answer, i) => {
    const question = questions[i] as Question;
    if (answer.skipped === true) return answer;
    const joined = answer.chosen.join(SEPARATOR);
    let chosen = [joined];
    const whole = resolveOptionAnswer(question, joined);
    if (whole !== joined) chosen = whole.split(SEPARATOR);
    // Several choices are documented as separate items: each one is compared on its own.
    else if (question.multiple === true)
      chosen = answer.chosen.map((c) => labelOfIndex(question, c) ?? c);
    else return answer;
    if (chosen.join(SEPARATOR) !== joined) changed = true;
    return { chosen };
  });
  return changed ? buildAnswerText(questions, resolved) : text;
}
