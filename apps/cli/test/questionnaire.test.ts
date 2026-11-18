import { describe, expect, it } from "vitest";
import { parseCliAnswer, Questionnaire } from "../src/questionnaire.js";
import { primedRenderState, renderEvent } from "../src/render.js";

const q = {
  question: "Qual banco?",
  options: [{ label: "Postgres", description: "robusto" }, { label: "SQLite" }],
};
const many = {
  question: "Quais extras?",
  options: [{ label: "Cache" }, { label: "Fila" }, { label: "Busca" }],
  multiple: true,
};

describe("answering a question in the terminal", () => {
  it("a number picks an option; several only when the question allows", () => {
    expect(parseCliAnswer(q, "2", false)).toEqual({ ok: true, answer: { chosen: ["SQLite"] } });
    expect(parseCliAnswer(q, "1, 2", false)).toMatchObject({ ok: false });
    expect(parseCliAnswer(many, "1, 3", true)).toEqual({
      ok: true,
      answer: { chosen: ["Cache", "Busca"] },
    });
    expect(parseCliAnswer(many, "3,3", true)).toEqual({ ok: true, answer: { chosen: ["Busca"] } });
    expect(parseCliAnswer(q, "9", false)).toMatchObject({
      ok: false,
      error: expect.stringContaining("1 a 2"),
    });
  });

  it("anything else is a free answer; Enter skips only inside a questionnaire", () => {
    expect(parseCliAnswer(q, "Outro banco", false)).toEqual({
      ok: true,
      answer: { chosen: ["Outro banco"] },
    });
    expect(parseCliAnswer(q, "", true)).toEqual({
      ok: true,
      answer: { chosen: [], skipped: true },
    });
    expect(parseCliAnswer(q, "", false)).toMatchObject({ ok: false });
  });

  it("a questionnaire asks one question per line and ends with the plain answer text", () => {
    const run = new Questionnaire([q, many, { question: "Algo mais?" }]);
    expect(run.prompt()).toBe("Pergunta 1 de 3> ");
    expect(run.answer("1")).toMatchObject({ done: false, prompt: "Pergunta 2 de 3> " });
    expect(run.answer("7")).toMatchObject({
      done: false,
      message: expect.stringContaining("Não existe"),
      prompt: "Pergunta 2 de 3> ",
    });
    expect(run.answer("")).toMatchObject({ done: false, prompt: "Pergunta 3 de 3> " });
    expect(run.answer("nada")).toEqual({
      done: true,
      text: "1. Qual banco? → Postgres\n2. Quais extras? → (pulou)\n3. Algo mais? → nada",
    });
  });

  it("one question with options answers with the label alone", () => {
    const run = new Questionnaire([q]);
    expect(run.prompt()).toBe("Resposta> ");
    expect(run.answer("1")).toEqual({ done: true, text: "Postgres" });
  });
});

describe("rendering what the bot asked", () => {
  const event = (payload: Record<string, unknown>) => ({
    seq: 1,
    type: "escalated",
    payload,
    createdAt: new Date(),
  });
  const text = (payload: Record<string, unknown>) =>
    renderEvent(event(payload), primedRenderState([])).join("\n");

  it("a plain question stays as it was", () => {
    expect(text({ question: "Posso?", callId: "c" })).toContain("Posso?");
    expect(text({ question: "Posso?", callId: "c" })).not.toContain("1)");
  });

  it("numbers the options, and the questions of a questionnaire", () => {
    const one = text({ question: "Qual banco?", questions: [q], callId: "c" });
    expect(one).toContain("1) Postgres — robusto");
    expect(one).toContain("2) SQLite");
    const several = text({
      question: "1. Qual banco?\n2. Quais extras?",
      questions: [q, many],
      callId: "c",
    });
    expect(several).toContain("1. Qual banco?");
    expect(several).toContain("2. Quais extras?");
    expect(several).toContain("pode escolher vários");
    expect(several).toContain("Enter pula");
  });
});
