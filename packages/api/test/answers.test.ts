import { describe, expect, it } from "vitest";
import {
  buildAnswerText,
  isStructuredAnswer,
  parseAnswerText,
  type Question,
  resolveOptionAnswer,
} from "../src/index.js";

const one: Question[] = [
  { question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] },
];
const many: Question[] = [
  {
    question: "Em que você quer foco esta semana?",
    options: [{ label: "Faculdade" }, { label: "Curso de AWS" }],
    multiple: true,
  },
  {
    question: "Qual a tarefa mais importante?",
    options: [{ label: "Entrega" }, { label: "Prova" }],
    allowOther: true,
  },
  { question: "Algo mais?" },
];

describe("the text of an answer", () => {
  it("one question: just the choices, joined; skipped is explicit", () => {
    expect(buildAnswerText(one, [{ chosen: ["Verde"] }])).toBe("Verde");
    expect(buildAnswerText(many.slice(0, 1), [{ chosen: ["Faculdade", "Curso de AWS"] }])).toBe(
      "Faculdade; Curso de AWS",
    );
    expect(buildAnswerText(one, [{ chosen: [], skipped: true }])).toBe("(pulou)");
    expect(buildAnswerText(one, [])).toBe("(pulou)");
  });

  it("a questionnaire: one numbered line per question, with → and (pulou)", () => {
    expect(
      buildAnswerText(many, [
        { chosen: ["Faculdade", "Curso de AWS"] },
        { chosen: [], skipped: true },
        { chosen: ["  nada  "] },
      ]),
    ).toBe(
      "1. Em que você quer foco esta semana? → Faculdade; Curso de AWS\n2. Qual a tarefa mais importante? → (pulou)\n3. Algo mais? → nada",
    );
  });

  it("an 'other' answer (free text) is a choice like any other", () => {
    expect(
      buildAnswerText(many, [
        { chosen: ["Faculdade"] },
        { chosen: ["Revisar o contrato"] },
        { chosen: [], skipped: true },
      ]),
    ).toContain("2. Qual a tarefa mais importante? → Revisar o contrato");
  });

  it("collapses whitespace in the question and ignores blank choices", () => {
    expect(
      buildAnswerText(
        [{ question: "a\n  b" }, { question: "c" }],
        [{ chosen: ["", "x"] }, { chosen: ["  "] }],
      ),
    ).toBe("1. a b → x\n2. c → (pulou)");
  });
});

describe("reading an answer back", () => {
  it("round-trips what was built, skipped and other included", () => {
    const answers = [
      { chosen: ["Faculdade", "Curso de AWS"] },
      { chosen: ["Revisar o contrato"] },
      { chosen: [], skipped: true },
    ];
    expect(parseAnswerText(many, buildAnswerText(many, answers))).toEqual([
      { chosen: ["Faculdade", "Curso de AWS"] },
      { chosen: ["Revisar o contrato"] },
      { chosen: [], skipped: true },
    ]);
  });

  it("a questionnaire answered by typing something else is not in the format", () => {
    expect(parseAnswerText(many, "um de escrita também")).toBeNull();
    expect(parseAnswerText(many, "1. Em que você quer foco esta semana? → Faculdade")).toBeNull();
    expect(isStructuredAnswer(many, "um de escrita também")).toBe(false);
  });

  it("one question: the whole text is the answer", () => {
    expect(parseAnswerText(one, "Verde")).toEqual([{ chosen: ["Verde"] }]);
    expect(parseAnswerText(one, "(pulou)")).toEqual([{ chosen: [], skipped: true }]);
    expect(parseAnswerText(one, "outra coisa qualquer")).toEqual([
      { chosen: ["outra coisa qualquer"] },
    ]);
  });
});

describe("an option given by its number or letter", () => {
  it("resolves exactly an index as shown, and nothing else", () => {
    const q = one[0] as Question;
    expect(resolveOptionAnswer(q, "2")).toBe("Verde");
    expect(resolveOptionAnswer(q, "a")).toBe("Azul");
    expect(resolveOptionAnswer(q, "3")).toBe("3");
    expect(resolveOptionAnswer(q, "1 por favor")).toBe("1 por favor");
    expect(resolveOptionAnswer({ question: "Quantos?" }, "2")).toBe("2");
  });
});
