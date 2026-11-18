import { buildAnswerText, type Question, type QuestionAnswer } from "@suup/api";

/** What a line typed for one question means: its choices, or why it was not understood. */
export type ParsedAnswer = { ok: true; answer: QuestionAnswer } | { ok: false; error: string };

/**
 * One line, one question: `Enter` skips (only in a questionnaire), `2` or `1,3` pick options by
 * number (several only if the question allows), anything else is a free answer.
 */
export function parseCliAnswer(question: Question, line: string, allowSkip: boolean): ParsedAnswer {
  const text = line.trim();
  if (text === "") {
    return allowSkip
      ? { ok: true, answer: { chosen: [], skipped: true } }
      : { ok: false, error: "Escolha uma opção, ou escreva a sua resposta." };
  }
  const options = question.options;
  if (options !== undefined) {
    const tokens = text.split(",").map((t) => t.trim());
    if (tokens.every((t) => /^\d+$/.test(t))) {
      const numbers = [...new Set(tokens.map(Number))];
      const outside = numbers.find((n) => n < 1 || n > options.length);
      if (outside !== undefined) {
        return {
          ok: false,
          error: `Não existe a opção ${outside}. Escolha de 1 a ${options.length}.`,
        };
      }
      if (question.multiple !== true && numbers.length > 1) {
        return { ok: false, error: "Esta pergunta aceita só uma opção." };
      }
      return {
        ok: true,
        answer: { chosen: numbers.map((n) => (options[n - 1] as { label: string }).label) },
      };
    }
  }
  return { ok: true, answer: { chosen: [text] } };
}

export type QuestionnaireStep =
  | { done: false; message: string | undefined; prompt: string }
  | { done: true; text: string };

/** Walks a questionnaire in the terminal, one line per question, and ends with the answer text. */
export class Questionnaire {
  readonly #answers: QuestionAnswer[] = [];
  constructor(readonly questions: readonly Question[]) {}

  get #index(): number {
    return this.#answers.length;
  }

  get #allowSkip(): boolean {
    return this.questions.length > 1;
  }

  /** The prompt for the question being asked. */
  prompt(): string {
    return this.questions.length > 1
      ? `Pergunta ${this.#index + 1} de ${this.questions.length}> `
      : "Resposta> ";
  }

  answer(line: string): QuestionnaireStep {
    const question = this.questions[this.#index] as Question;
    const parsed = parseCliAnswer(question, line, this.#allowSkip);
    if (!parsed.ok) return { done: false, message: parsed.error, prompt: this.prompt() };
    this.#answers.push(parsed.answer);
    if (this.#index < this.questions.length)
      return { done: false, message: undefined, prompt: this.prompt() };
    return { done: true, text: buildAnswerText(this.questions, this.#answers) };
  }
}

/** A question with choices is answered through the questionnaire; an open one, with a plain line. */
export const needsQuestionnaire = (questions: readonly Question[]): boolean =>
  questions.some((q) => q.options !== undefined);
