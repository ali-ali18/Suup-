import type { Message } from "@suup/api";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// The bot comes back by itself: it schedules a return (`schedule_return`), tells the user in its own
// message, and the SAME run is parked until the time. The tests never wait a minute: the instant is
// moved into the past in the database (`wake_at`), and the job of the worker (another runtime on
// the same database) wakes the run. Waits are on conditions.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const schedule = (note: string, inMinutes = 1) => ({
  name: "schedule_return",
  args: { inMinutes, note },
});

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-VOLTO",
        agent: [
          s({ calls: [schedule("Conferir o status do deploy e contar ao usuário.")] }),
          s({ text: "Disparei o deploy. Volto em 1 minuto para conferir." }),
          s({ text: "O deploy terminou: tudo certo." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-MENSAGEM",
        agent: [
          s({ calls: [schedule("Conferir o deploy.")] }),
          s({ text: "Disparei o deploy. Volto em 1 minuto." }),
          s({ text: "Combinado: não confiro mais o deploy." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-PARAR",
        agent: [
          s({ calls: [schedule("Conferir o deploy.")] }),
          s({ text: "Disparei o deploy. Volto em 1 minuto." }),
          s({ text: "Isto nunca deve ser dito." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-ENCADEADO",
        agent: [
          s({ calls: [schedule("Primeira conferência.")] }),
          s({ text: "Volto em 1 minuto." }),
          s({ calls: [schedule("Segunda conferência.")] }),
          s({ text: "Ainda rodando; volto em 1 minuto." }),
          s({ text: "Agora sim, terminou." }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the bot comes back by itself, through the API and a worker in another process"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS, wakeEveryMs: 50 });

    const setup = async (name: string) => {
      const { api } = w.started;
      const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
      const conversation = await api.bots.openConversation(bot.id);
      return { api, bot, conversation };
    };
    const messagesOf = async (conversationId: string): Promise<Message[]> =>
      (await w.started.api.conversations.messages(conversationId, { limit: 50 })).items;
    const eventTypes = async (runId: string) =>
      (await w.started.api.runs.events(runId, { limit: 1000 })).items.map((e) => e.type);
    /** What the loop and the world do, as the test forces time: the return is due now. */
    const makeDue = async (runId: string) => {
      await w.db
        .sql`update runs set wake_at = now() - interval '1 minute' where id = ${runId} and status = 'waiting_timer'`;
    };
    const parked = async (runId: string) =>
      until(async () => {
        const run = await w.started.api.runs.get(runId);
        return run.status === "waiting_timer" ? run : undefined;
      }, "the run to be parked for its return");

    it("parks the same run, says so in its own message, wakes at the time and answers in the same conversation", async () => {
      const { api, conversation } = await setup("Volta");
      const sent = await api.conversations.send(conversation.id, "CASE-VOLTO faça o deploy");
      const runId = sent.run.id;

      const run = await parked(runId);
      expect(run.wakeNote).toBe("Conferir o status do deploy e contar ao usuário.");
      expect(new Date(run.wakeAt as string).getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(run.paused).toBe(false);

      // The only thing the user sees is the bot's message: no system message, no marker.
      const said = await until(async () => {
        const all = await messagesOf(conversation.id);
        return all.some((m) => m.authorKind === "bot") ? all : undefined;
      }, "the bot's message about the return");
      expect(said.map((m) => [m.authorKind, m.text])).toEqual([
        ["user", "CASE-VOLTO faça o deploy"],
        ["bot", "Disparei o deploy. Volto em 1 minuto para conferir."],
      ]);
      expect(said[1]?.runId).toBe(runId);
      // Nothing wakes it before the time.
      await new Promise((r) => setTimeout(r, 300));
      expect((await api.runs.get(runId)).status).toBe("waiting_timer");

      await makeDue(runId);
      const done = await until(async () => {
        const r = await api.runs.get(runId);
        return r.status === "done" ? r : undefined;
      }, "the run to come back and finish");
      expect(done.id).toBe(runId);
      expect(done.wakeAt ?? null).toBeNull();

      // The final message is written when the run's end is processed, just after the status
      // changes: wait for it as for the first one.
      const after = await until(async () => {
        const all = await messagesOf(conversation.id);
        return all.filter((m) => m.authorKind === "bot").length >= 2 ? all : undefined;
      }, "the bot's answer after the return");
      expect(after.map((m) => [m.authorKind, m.text])).toEqual([
        ["user", "CASE-VOLTO faça o deploy"],
        ["bot", "Disparei o deploy. Volto em 1 minuto para conferir."],
        ["bot", "O deploy terminou: tudo certo."],
      ]);
      expect(after.every((m) => m.runId === runId)).toBe(true);
      expect((await eventTypes(runId)).filter((t) => t.startsWith("wait_"))).toEqual([
        "wait_scheduled",
        "wait_fired",
      ]);
      // The bot read its own note, as a notice of the system.
      const events = (await api.runs.events(runId, { limit: 1000, types: ["model_request"] }))
        .items;
      expect(JSON.stringify(events.at(-1)?.payload)).toContain(
        "Retorno agendado: Conferir o status do deploy e contar ao usuário.",
      );
    });

    it("a user message during the wait cancels the return and the run goes on with the message", async () => {
      const { api, conversation } = await setup("Mensagem");
      const sent = await api.conversations.send(conversation.id, "CASE-MENSAGEM faça o deploy");
      const runId = sent.run.id;
      await parked(runId);

      const second = await api.conversations.send(conversation.id, "Esquece o deploy.");
      expect(second.queuedForRun).toBe(true);
      expect(second.run.id).toBe(runId);
      const done = await until(async () => {
        const r = await api.runs.get(runId);
        return r.status === "done" ? r : undefined;
      }, "the run to answer the message");
      expect(done.wakeAt ?? null).toBeNull();
      const types = await eventTypes(runId);
      expect(types.filter((t) => t.startsWith("wait_") || t === "user_message")).toEqual([
        "wait_scheduled",
        "wait_cancelled",
        "user_message",
      ]);
      const cancelled = (await api.runs.events(runId, { limit: 1000, types: ["wait_cancelled"] }))
        .items;
      expect(cancelled[0]?.payload).toEqual({ reason: "user_message" });
      // The final message is written just after the status changes: wait for it.
      const texts = (
        await until(async () => {
          const all = await messagesOf(conversation.id);
          return all.filter((m) => m.authorKind === "bot").length >= 2 ? all : undefined;
        }, "the bot's answer to the message")
      ).map((m) => [m.authorKind, m.text]);
      expect(texts).toEqual([
        ["user", "CASE-MENSAGEM faça o deploy"],
        ["bot", "Disparei o deploy. Volto em 1 minuto."],
        ["user", "Esquece o deploy."],
        ["bot", "Combinado: não confiro mais o deploy."],
      ]);
      // Whatever the clock says now, nothing fires for a run that went on.
      await makeDue(runId);
      expect((await eventTypes(runId)).filter((t) => t === "wait_fired")).toEqual([]);
    });

    it("stopping the run cancels the return too, and the user is told", async () => {
      const { api, conversation } = await setup("Parar");
      const sent = await api.conversations.send(conversation.id, "CASE-PARAR faça o deploy");
      const runId = sent.run.id;
      await parked(runId);

      const stopped = await api.runs.cancel(runId);
      expect(stopped.status).toBe("cancelled");
      expect(stopped.wakeAt ?? null).toBeNull();
      expect((await eventTypes(runId)).filter((t) => t.startsWith("wait_"))).toEqual([
        "wait_scheduled",
        "wait_cancelled",
      ]);
      const cancelled = (await api.runs.events(runId, { limit: 1000, types: ["wait_cancelled"] }))
        .items;
      expect(cancelled[0]?.payload).toEqual({ reason: "cancelled" });
      const after = await until(async () => {
        const all = await messagesOf(conversation.id);
        return all.some((m) => m.authorKind === "system") ? all : undefined;
      }, "the notice of the cancellation");
      expect(after.map((m) => m.authorKind)).toEqual(["user", "bot", "system"]);
      await new Promise((r) => setTimeout(r, 300));
      expect((await api.runs.get(runId)).status).toBe("cancelled");
      expect((await eventTypes(runId)).filter((t) => t === "wait_fired")).toEqual([]);
    });

    it("the next message after a cancelled return opens a new run", async () => {
      const { api, conversation } = await setup("Depois");
      const sent = await api.conversations.send(conversation.id, "CASE-PARAR de novo");
      await parked(sent.run.id);
      await api.runs.cancel(sent.run.id);
      const next = await api.conversations.send(conversation.id, "CASE-VOLTO agora sim");
      expect(next.queuedForRun).toBe(false);
      expect(next.run.id).not.toBe(sent.run.id);
    });

    it("returns can follow each other: parked, woken, parked again, woken, done", async () => {
      const { api, conversation } = await setup("Encadeado");
      const sent = await api.conversations.send(conversation.id, "CASE-ENCADEADO faça o deploy");
      const runId = sent.run.id;
      await parked(runId);
      await makeDue(runId);
      await until(async () => {
        const r = await api.runs.get(runId);
        return r.status === "waiting_timer" && r.wakeNote === "Segunda conferência."
          ? r
          : undefined;
      }, "the second parking");
      await makeDue(runId);
      await until(async () => {
        const r = await api.runs.get(runId);
        return r.status === "done" ? r : undefined;
      }, "the run to finish");
      expect((await eventTypes(runId)).filter((t) => t.startsWith("wait_"))).toEqual([
        "wait_scheduled",
        "wait_fired",
        "wait_scheduled",
        "wait_fired",
      ]);
      const all = await until(async () => {
        const m = await messagesOf(conversation.id);
        return m.filter((x) => x.authorKind === "bot").length >= 3 ? m : undefined;
      }, "the bot's final answer");
      expect(all.map((m) => m.text)).toEqual([
        "CASE-ENCADEADO faça o deploy",
        "Volto em 1 minuto.",
        "Ainda rodando; volto em 1 minuto.",
        "Agora sim, terminou.",
      ]);
    });
  },
);
