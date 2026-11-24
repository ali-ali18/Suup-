import type { ApiError } from "@suup/api";
import { DISMISSED_QUESTION_ANSWER } from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// The X of a question card (`POST /v1/messages/{id}/dismiss`): the card stays, marked `dismissed`;
// the run waiting for it is told and goes on (it never waits forever); a second X changes nothing.

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const ask = {
  name: "escalate",
  args: { question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] },
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("the server, end to end: closing a question"), () => {
  const w = useWorld({
    scripts: {
      roteiro: {
        cases: [
          {
            whenObjectiveContains: "CASE-DISMISS",
            agent: [s({ calls: [ask] }), s({ text: "Tudo bem, sigo sem a escolha." })],
          },
          {
            whenObjectiveContains: "CASE-ANSWER",
            agent: [s({ calls: [ask] }), s({ text: "Azul, então." })],
          },
        ],
      },
      outro: { cases: [] },
    },
  });

  const open = async (name: string, text: string) => {
    const { api } = w.started;
    const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
    const conversation = await api.bots.openConversation(bot.id);
    const sent = await api.conversations.send(conversation.id, text);
    const question = await until(async () => {
      const page = await api.conversations.messages(conversation.id, { limit: 50 });
      return page.items.find((m) => m.question !== undefined);
    }, "the question");
    return { conversation, run: sent.run, question };
  };

  it("closing marks the question, tells the run, and the run goes on to its answer", async () => {
    const { api } = w.started;
    const { conversation, run, question } = await open("Fecha", "CASE-DISMISS escolha");
    const closed = await api.conversations.dismissQuestion(question.id);
    expect(closed.question).toMatchObject({
      questions: [{ question: "Qual cor?" }],
      dismissed: true,
    });
    // No user message is written: the chat shows the locked card, not words the user never typed.
    await until(async () => (await api.runs.get(run.id)).status === "done", "the run to end");
    const page = await api.conversations.messages(conversation.id, { limit: 50 });
    expect(page.items.map((m) => [m.authorKind, m.text])).toEqual([
      ["user", "CASE-DISMISS escolha"],
      ["bot", "Qual cor?"],
      ["bot", "Tudo bem, sigo sem a escolha."],
    ]);
    // The model got the harness's note as the answer to its question.
    const events = (await api.runs.events(run.id, { limit: 500 })).items;
    expect(JSON.stringify(events)).toContain("closed this question without choosing an option");
    expect(DISMISSED_QUESTION_ANSWER).toContain("Do not ask the same question again now");
    // Closing again changes nothing.
    expect((await api.conversations.dismissQuestion(question.id)).question?.dismissed).toBe(true);
  });

  it("a question already answered cannot be closed; an unknown one is not found", async () => {
    const { api } = w.started;
    const { conversation, run, question } = await open("Responde", "CASE-ANSWER escolha");
    await api.conversations.send(conversation.id, "Azul");
    await until(async () => (await api.runs.get(run.id)).status === "done", "the run to end");
    const late = await api.conversations.dismissQuestion(question.id).catch((e: unknown) => e);
    expect((late as ApiError).code).toBe("conflict");
    const unknown = await api.conversations
      .dismissQuestion("00000000-0000-4000-8000-000000000000")
      .catch((e: unknown) => e);
    expect((unknown as ApiError).code).toBe("not_found");
  });
});
