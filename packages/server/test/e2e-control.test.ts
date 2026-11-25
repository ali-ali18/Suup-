import type { Message, Run } from "@suup/api";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// Pause, interrupt, cancel and resume asked for through the API, obeyed by a worker that lives in
// ANOTHER runtime object (another "process") on the same database: the only channel between them
// is Postgres. Waits are on conditions, never on fixed times; the long steps of the script (a
// minute-long model call, a minute-long `sleep`) are only ever ended by the action under test.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const shell = (command: string) => ({ name: "shell", args: { command } });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-PAUSE",
        agent: [
          s({ text: "Passo 1.", calls: [shell("echo um")], delayMs: 800 }),
          s({ text: "Passo 2.", calls: [shell("echo dois")] }),
          s({ text: "Terminei os dois passos." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-INTERRUPT",
        agent: [
          s({ text: "Vou esperar.", calls: [shell("sleep 100")] }),
          s({ text: "Retomei depois da interrupção e terminei." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-CANCEL",
        agent: [s({ text: "Pensando muito...", delayMs: 120_000 })],
      },
      {
        whenObjectiveContains: "CASE-ASK",
        agent: [
          s({ calls: [{ name: "escalate", args: { question: "Posso continuar?" } }] }),
          s({ text: "Certo." }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("run control through the API, with the worker in another process"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS });

    /** A bot with its conversation, and a stream following everything. */
    const setup = async (name: string) => {
      const { api } = w.started;
      const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      return { api, bot, conversation, f };
    };
    const eventsOf = async (runId: string, types?: string[]) =>
      (
        await w.started.api.runs.events(runId, {
          limit: 1000,
          ...(types === undefined ? {} : { types: types as never }),
        })
      ).items;
    const statusOf = async (runId: string) => w.started.api.runs.get(runId);
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "no error",
        (error: { code?: string }) => error.code ?? String(error),
      );

    it("pause is soft: the turn in progress finishes, nothing new starts, and resume goes on from the log", async () => {
      const { api, conversation, f } = await setup("Pausa");
      const sent = await api.conversations.send(conversation.id, "CASE-PAUSE devagar");
      const runId = sent.run.id;
      await until(
        async () => (await eventsOf(runId, ["model_request"])).length >= 1 || undefined,
        "the first model call",
      );

      const paused = await api.runs.pause(runId);
      expect(paused.paused).toBe(true);
      expect(["running", "queued"]).toContain(paused.status);
      // The worker (another runtime) stops at the next safe point and hands the run back, paused.
      const stopped = await until(async () => {
        const run = await statusOf(runId);
        return run.status === "queued" && run.paused ? run : undefined;
      }, "the run to stop, queued and paused");
      expect(stopped.turns).toBe(1);
      // The turn in progress finished completely (the tool ran and its result is logged)...
      expect((await eventsOf(runId, ["tool_result"])).map((e) => e.payload.outcome)).toEqual([
        "ok",
      ]);
      // ...and no second model call starts while it is paused (watched over a good while).
      const watchUntil = Date.now() + 1000;
      while (Date.now() < watchUntil) {
        expect((await eventsOf(runId, ["model_request"])).length).toBe(1);
        expect((await statusOf(runId)).status).toBe("queued");
        await new Promise((r) => setTimeout(r, 50));
      }
      await f.waitFor(
        (e) => e.type === "run.updated" && e.data.run.id === runId && e.data.run.paused,
        "the paused run on the stream",
      );

      // A message to a paused run is kept, and read once the run goes on.
      const message = await api.conversations.send(conversation.id, "e mais isto");
      expect(message).toMatchObject({ queuedForRun: true, message: { status: "sent" } });
      expect(await code(api.runs.pause(runId))).toBe("no error"); // idempotent
      expect(await code(api.runs.resume("11111111-1111-4111-8111-111111111111"))).toBe("not_found");

      const resumed = await api.runs.resume(runId);
      expect(resumed.paused).toBe(false);
      expect(await code(api.runs.resume(runId))).toBe("conflict"); // not paused any more
      await f.waitFor(
        (e) =>
          e.type === "message.created" &&
          e.data.message.authorKind === "bot" &&
          e.data.message.eventSeq === undefined &&
          e.data.message.runId === runId,
        "the bot's final message",
      );
      const done = await statusOf(runId);
      expect(done).toMatchObject({ status: "done", paused: false, turns: 3 });
      expect((await eventsOf(runId, ["user_message"])).map((e) => e.payload.text)).toEqual([
        "e mais isto",
      ]);
      expect(
        (await api.conversations.messages(conversation.id)).items.find(
          (m: Message) => m.id === message.message.id,
        )?.status,
      ).toBe("delivered");
      // A finished run cannot be paused, interrupted, resumed or cancelled.
      expect(await code(api.runs.pause(runId))).toBe("conflict");
      expect(await code(api.runs.interrupt(runId))).toBe("conflict");
      expect(await code(api.runs.cancel(runId))).toBe("conflict");
      f.close();
    });

    it("interrupt is hard: it cuts the tool in flight at once, the run stays paused, and resume finishes it", async () => {
      const { api, conversation, f } = await setup("Interrupção");
      const sent = await api.conversations.send(conversation.id, "CASE-INTERRUPT espere");
      const runId = sent.run.id;
      // The model asked for `sleep 100`: the tool is running and will not end by itself for a while.
      await until(async () => {
        const calls = await eventsOf(runId, ["tool_call"]);
        return calls.length === 1 || undefined;
      }, "the tool call");
      expect(await eventsOf(runId, ["tool_result"])).toEqual([]);

      const interrupted = await api.runs.interrupt(runId);
      expect(interrupted.paused).toBe(true);
      const stopped = await until(async () => {
        const run = await statusOf(runId);
        return run.status === "queued" && run.paused ? run : undefined;
      }, "the interrupted run to stop");
      expect(stopped.status).toBe("queued");
      // The tool's result is logged as interrupted (an unknown outcome the model is told about).
      const results = await eventsOf(runId, ["tool_result"]);
      expect(results).toHaveLength(1);
      expect(results[0]?.payload.outcome).toBe("aborted");
      expect(await eventsOf(runId, ["model_request"])).toHaveLength(1); // no new model call

      await api.runs.resume(runId);
      await f.waitFor(
        (e) =>
          e.type === "message.created" &&
          e.data.message.authorKind === "bot" &&
          e.data.message.eventSeq === undefined &&
          e.data.message.runId === runId,
        "the final message after the resume",
      );
      expect(await statusOf(runId)).toMatchObject({ status: "done", paused: false });
      expect((await api.conversations.messages(conversation.id)).items.at(-1)?.text).toBe(
        "Retomei depois da interrupção e terminei.",
      );
      f.close();
    });

    it("cancel ends a run that is in the middle of a model call, and the conversation says so", async () => {
      const { api, conversation, f } = await setup("Cancelamento");
      const sent = await api.conversations.send(conversation.id, "CASE-CANCEL pense");
      const runId = sent.run.id;
      await until(
        async () => (await eventsOf(runId, ["model_request"])).length === 1 || undefined,
        "the model call",
      );

      const asked = await api.runs.cancel(runId);
      expect(["running", "queued"]).toContain(asked.status);
      const cancelled = await until(async () => {
        const run = await statusOf(runId);
        return run.status === "cancelled" ? run : undefined;
      }, "the run to be cancelled");
      expect(cancelled).toMatchObject({ paused: false, finishedAt: expect.any(String) });
      const notice = await f.waitFor(
        (e) =>
          e.type === "message.created" &&
          e.data.message.runId === runId &&
          e.data.message.authorKind === "system",
        "the cancellation notice",
      );
      expect(notice.event).toMatchObject({
        data: { message: { text: "A execução foi cancelada antes de terminar." } },
      });
      const last = (await eventsOf(runId, ["status_changed"])).at(-1);
      expect(last?.payload).toMatchObject({ to: "cancelled" });
      expect((await api.conversations.get(conversation.id)).activeRun).toBeNull();
      // The conversation is free again: the next message opens a new run.
      expect(
        (await api.conversations.send(conversation.id, "CASE-CANCEL outra")).queuedForRun,
      ).toBe(false);
      expect(await code(api.runs.cancel(runId))).toBe("conflict");
      f.close();
    });

    it("a paused run can be cancelled: the pause is lifted so a worker can apply the stop", async () => {
      const { api, conversation, f } = await setup("Pausa e cancela");
      const sent = await api.conversations.send(conversation.id, "CASE-CANCEL pense de novo");
      const runId = sent.run.id;
      await until(
        async () => (await eventsOf(runId, ["model_request"])).length === 1 || undefined,
        "the model call",
      );
      await api.runs.interrupt(runId);
      await until(async () => {
        const run = await statusOf(runId);
        return run.status === "queued" && run.paused ? run : undefined;
      }, "the run to stop paused");
      await api.runs.cancel(runId);
      await until(
        async () => (await statusOf(runId)).status === "cancelled" || undefined,
        "the cancellation",
      );
      expect(await eventsOf(runId, ["model_request"])).toHaveLength(1); // the model was never called again
      f.close();
    });

    it("a run that waits for the user cannot be paused; a stop is applied to it", async () => {
      const { api, conversation, f } = await setup("Espera");
      const sent = await api.conversations.send(conversation.id, "CASE-ASK pergunte");
      const runId = sent.run.id;
      await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the question",
      );
      const waiting: Run = await statusOf(runId);
      expect(waiting.status).toBe("waiting_user");
      expect(await code(api.runs.pause(runId))).toBe("conflict");
      expect(await code(api.runs.interrupt(runId))).toBe("conflict");
      expect(await code(api.runs.resume(runId))).toBe("conflict");

      await api.runs.cancel(runId);
      await until(
        async () => (await statusOf(runId)).status === "cancelled" || undefined,
        "the cancellation of a waiting run",
      );
      f.close();
    });
  },
);
