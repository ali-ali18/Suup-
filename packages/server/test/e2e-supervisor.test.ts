import { TEAM_REVIEW_TOOL_NAME } from "@suup/core";
import {
  addJournalMemory,
  addMemory,
  createBot,
  createDirectConversation,
  createRun,
  listMessages,
  setDefaultBot,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// The supervisor through the API and the worker: the settings with the owner's defaults, the
// nightly review run by the worker (once, with two workers), its history, and the morning message.
// The model is the scripted provider.

const usage = { inputTokens: 1000, outputTokens: 100 };
const SCRIPTS = {
  roteiro: {
    agent: [{ text: "ok", usage }],
    teamReview: [
      {
        calls: [
          {
            name: TEAM_REVIEW_TOOL_NAME,
            args: {
              notes: [{ text: "O Tutor montou o resumo de física.", summary: "Tutor: física" }],
              morning_message: "O Tutor espera sua resposta sobre o cronograma de sexta.",
            },
          },
        ],
        usage,
      },
    ],
  },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("supervisor through the API"),
  { timeout: 90_000 },
  () => {
    const w = useWorld({
      scripts: SCRIPTS,
      config: { defaults: { timeZone: "America/Sao_Paulo" } },
      supervisorEveryMs: 100,
    });

    it("starts at the owner's defaults: review on at 03:00, morning at 08:00, no cost cap; with no main bot it is quiet", async () => {
      const { api } = w.started;
      // The supervisor is optional: the server starts with no bots, so nobody is the main one.
      expect(await api.supervisor.settings.get()).toMatchObject({
        reviewEnabled: true,
        reviewTime: "03:00",
        morningTime: "08:00",
        costCapUsd: null,
        timeZone: "America/Sao_Paulo",
        model: { available: false, id: null },
      });
      expect(await api.bots.list()).toEqual([]);
      expect(await api.supervisor.reviews()).toEqual([]);
    });

    it("changes only what is sent, accepts null for no cap and no morning message, and refuses the rest in Portuguese", async () => {
      const { api } = w.started;
      const a = await api.supervisor.settings.update({
        reviewTime: "04:15",
        costCapUsd: 0.5,
        morningTime: null,
      });
      expect(a).toMatchObject({
        reviewTime: "04:15",
        costCapUsd: 0.5,
        morningTime: null,
        reviewEnabled: true,
      });
      const b = await api.supervisor.settings.update({ costCapUsd: null, morningTime: "07:30" });
      expect(b).toMatchObject({ reviewTime: "04:15", costCapUsd: null, morningTime: "07:30" });
      const message = (promise: Promise<unknown>) =>
        promise.then(
          () => "no error",
          (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
        );
      expect(await message(api.supervisor.settings.update({ reviewTime: "25:00" }))).toContain(
        "HH:MM",
      );
      expect(await message(api.supervisor.settings.update({ costCapUsd: 0 }))).toContain("0,01");
      expect(await message(api.supervisor.settings.update({ nope: 1 } as never))).toContain(
        "invalid_request",
      );
      await api.supervisor.settings.update({ reviewTime: "03:00", morningTime: "08:00" });
    });

    it("the worker reviews the team once, writes the Principal's own note, keeps the history and posts the morning message", async () => {
      const { api, runtime } = w.started;
      const db = w.db;
      const mk = (name: string) =>
        createBot(db, { name, modelProvider: "roteiro", modelId: "model-x" });
      const principal = await mk("Principal");
      await setDefaultBot(db, principal.id);
      const tutor = await mk("Tutor");
      const run = await createRun(db, { botId: tutor.id, origin: "user", objective: "x" });
      await addJournalMemory(db, {
        botId: tutor.id,
        text: "2026-11-20 · concluída: resumo de física",
        sourceRunId: run.id,
      });
      await addMemory(db, {
        layer: "note",
        botId: tutor.id,
        text: "A prova é na sexta.",
        createdBy: "bot",
      });
      const conversation = await createDirectConversation(db, principal.id);
      await db.sql`update conversations set reception = 'done' where id = ${conversation.id}`;

      await api.supervisor.settings.update({ reviewTime: "00:00", morningTime: "00:00" });
      // The test runs at any hour, so the worker already recorded a silent night before the team was
      // there (an empty team has nothing to review): forget it, and the next pass reviews the team.
      await db.sql`delete from team_reviews`;
      const reviews = await until(async () => {
        const list = await api.supervisor.reviews();
        return list.some((r) => r.status === "done") ? list : undefined;
      }, "the review");
      expect(reviews).toHaveLength(1); // once, with a second runtime asking too
      expect(reviews[0]).toMatchObject({
        status: "done",
        botsRead: [{ name: "Tutor", journal: 1, notes: 1 }],
        noted: [{ text: "O Tutor montou o resumo de física." }],
        leftOver: [],
        capReached: false,
        costCapUsd: null,
        morningText: "O Tutor espera sua resposta sobre o cronograma de sexta.",
        model: "model-x",
      });
      expect(reviews[0]?.costUsd).not.toBeNull();

      const posted = await until(async () => {
        const messages = await listMessages(db, conversation.id, { limit: 10 });
        return messages.length > 0 ? messages : undefined;
      }, "the morning message");
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        authorKind: "bot",
        authorBotId: principal.id,
        text: "O Tutor espera sua resposta sobre o cronograma de sexta.",
      });
      expect((await api.supervisor.reviews())[0]?.morningPostedAt).not.toBeNull();
      // the memory of the Tutor is untouched; the note is the Principal's
      const notes = await api.memories.list({ layer: "note", botId: principal.id, limit: 10 });
      expect(notes.map((m) => m.text)).toEqual(["O Tutor montou o resumo de física."]);
      void runtime;
    });
  },
);
