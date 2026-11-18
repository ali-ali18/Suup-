import { join } from "node:path";
import { type RunEnd, runLoop } from "@suup/core";
import { CrashingStore, SimulatedCrash } from "@suup/core/testing";
import {
  type Bot,
  claimRun,
  createBot,
  getActiveConversationRun,
  getMessage,
  getRun,
  listMemories,
  listMessages,
  listRunEvents,
  postInbox,
  requeueStaleRuns,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  finishRun,
  parseConfig,
  type Runtime,
  RuntimeError,
  reconcileRunEffects,
  sendMessage,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// The conversation engine against a real Postgres, with the scripted provider and the local
// sandbox. Every script case is chosen by a token that only its own message contains.

const call = (name: string, args: unknown = {}) => ({ name, args });

describe.skipIf(!DATABASE_URL)(dbSuiteName("conversation engine"), () => {
  const ctx = useIsolatedDb();

  async function open(script: unknown, config: Record<string, unknown> = {}) {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    const runtime = createRuntime(parseConfig(rawConfig(config)), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    return runtime;
  }

  let counter = 0;
  async function newBot(runtime: Runtime, name = `bot${++counter}`): Promise<Bot> {
    return createBot(runtime.db, {
      name,
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: runtime.tools.list().map((t) => t.name),
    });
  }

  /** A worker that takes only this run; resolves when the run left it (after the post-run hook). */
  function work(runtime: Runtime, runId: string): Promise<RunEnd> {
    return new Promise((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: runId,
        idleBackoff: { minMs: 5, maxMs: 20 },
        onRunEnd: (end) => void worker.stop().then(() => resolve(end)),
      });
      worker.start();
    });
  }

  const botMessages = async (runtime: Runtime, conversationId: string) =>
    (await listMessages(runtime.db, conversationId, { limit: 100 })).filter(
      (m) => m.authorKind !== "user",
    );

  const waitFor = async (check: () => Promise<boolean>, what: string, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  describe("sendMessage", () => {
    it("opens a run for the first message, creating the direct conversation of the bot", async () => {
      const runtime = await open({ agent: [{ text: "Oi!" }] });
      const bot = await newBot(runtime);
      const sent = await sendMessage(runtime, { botId: bot.id, text: "  Olá  " });
      expect(sent.queuedForRun).toBeUndefined();
      expect(sent.message).toMatchObject({ authorKind: "user", text: "Olá", status: null });
      expect(sent.run).toMatchObject({
        botId: bot.id,
        origin: "user",
        objective: "Olá",
        status: "queued",
        acceptanceCriteria: [],
        conversationId: sent.message.conversationId,
      });
      expect(sent.message.runId).toBe(sent.run.id);

      // Same bot again resolves the same conversation.
      await work(runtime, sent.run.id);
      const again = await sendMessage(runtime, { botId: bot.id, text: "Outra" });
      expect(again.message.conversationId).toBe(sent.message.conversationId);
      await runtime.close();
    });

    it("refuses an empty text, an unknown conversation, an archived bot and a bot the configuration lacks", async () => {
      const runtime = await open({ agent: [] });
      const bot = await newBot(runtime);
      await expect(sendMessage(runtime, { botId: bot.id, text: "   " })).rejects.toMatchObject({
        code: "empty_message",
      });
      await expect(
        sendMessage(runtime, {
          conversationId: "00000000-0000-4000-8000-000000000000",
          text: "oi",
        }),
      ).rejects.toMatchObject({ code: "conversation_not_found" });
      const orphan = await createBot(runtime.db, {
        name: "orphan",
        modelProvider: "script",
        modelId: "gone",
      });
      await expect(sendMessage(runtime, { botId: orphan.id, text: "oi" })).rejects.toBeInstanceOf(
        RuntimeError,
      );
      await expect(sendMessage(runtime, { text: "oi" })).rejects.toThrow(TypeError);
      await runtime.close();
    });
  });

  describe("a message while the run works", () => {
    it("is `sent`, then `delivered` when the loop reads it at a safe point; the model sees it in its next request", async () => {
      const runtime = await open({
        agent: [
          { text: "Vou olhar.", calls: [call("shell", { command: "echo oi" })], delayMs: 400 },
          { text: "Pronto, considerei o seu aviso." },
        ],
      });
      const bot = await newBot(runtime);
      const first = await sendMessage(runtime, { botId: bot.id, text: "Faça a tarefa longa" });
      const ended = work(runtime, first.run.id);
      // Post while the model is still answering the first turn (the scripted answer takes 400 ms).
      await waitFor(
        async () =>
          (await listRunEvents(runtime.db, first.run.id)).some((e) => e.type === "model_request"),
        "the first model request",
      );

      const second = await sendMessage(runtime, {
        conversationId: first.message.conversationId,
        text: "Aliás, capriche na pontuação",
      });
      expect(second.queuedForRun).toBe(true);
      expect(second.run.id).toBe(first.run.id);
      expect(second.message.status).toBe("sent");

      expect((await ended).outcome).toBe("settled");
      expect((await getMessage(runtime.db, second.message.id))?.status).toBe("delivered");

      const events = await listRunEvents(runtime.db, first.run.id);
      const delivered = events.filter((e) => e.type === "user_message");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.payload.text).toBe("Aliás, capriche na pontuação");
      // Delivered at the safe point after the tool turn: before the second model request.
      const requests = events.filter((e) => e.type === "model_request");
      expect(requests).toHaveLength(2);
      expect(delivered[0]?.seq).toBeGreaterThan(requests[0]?.seq ?? 0);
      expect(delivered[0]?.seq).toBeLessThan(requests[1]?.seq ?? 0);
      const done = await getRun(runtime.db, first.run.id);
      expect(done?.status).toBe("done");
      await runtime.close();
    });

    it("two messages racing produce one run", async () => {
      const runtime = await open({ agent: [{ text: "ok" }] });
      const bot = await newBot(runtime);
      const { conversationId } = await (async () => {
        const first = await sendMessage(runtime, { botId: bot.id, text: "abre" });
        await work(runtime, first.run.id);
        return { conversationId: first.message.conversationId };
      })();
      const results = await Promise.all(
        ["a", "b", "c", "d"].map((text) => sendMessage(runtime, { conversationId, text })),
      );
      expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
      expect(results.filter((r) => r.queuedForRun === undefined)).toHaveLength(1);
      const runs = await runtime.db.sql`
        select id from runs where conversation_id = ${conversationId} and status <> 'done'`;
      expect(runs).toHaveLength(1);
      await runtime.close();
    });
  });

  describe("escalation", () => {
    it("the bot's question becomes its message; the user's answer resumes the run", async () => {
      const runtime = await open({
        agent: [
          { calls: [call("escalate", { question: "Qual cor você prefere?" })] },
          { text: "Então vai de azul." },
        ],
      });
      const bot = await newBot(runtime);
      const first = await sendMessage(runtime, { botId: bot.id, text: "Escolha uma cor" });
      const { conversationId } = first.message;
      expect((await work(runtime, first.run.id)).outcome).toBe("settled");
      expect((await getRun(runtime.db, first.run.id))?.status).toBe("waiting_user");
      expect(
        (await botMessages(runtime, conversationId)).map((m) => [m.authorKind, m.text]),
      ).toEqual([["bot", "Qual cor você prefere?"]]);

      const answer = await sendMessage(runtime, { conversationId, text: "Azul" });
      expect(answer.queuedForRun).toBe(true);
      expect(answer.message.status).toBe("sent");
      expect(answer.run.status).toBe("queued"); // the run was waiting; the answer requeued it
      await work(runtime, first.run.id);

      expect((await getRun(runtime.db, first.run.id))?.status).toBe("done");
      expect((await getMessage(runtime.db, answer.message.id))?.status).toBe("delivered");
      expect((await botMessages(runtime, conversationId)).map((m) => m.text)).toEqual([
        "Qual cor você prefere?",
        "Então vai de azul.",
      ]);
      await runtime.close();
    });

    it("a message while a run waits for approval is stored and posted, and approves nothing", async () => {
      const runtime = await open({ agent: [] });
      const bot = await newBot(runtime);
      const first = await sendMessage(runtime, { botId: bot.id, text: "algo" });
      await runtime.db.sql`update runs set status = 'waiting_approval' where id = ${first.run.id}`;
      const note = await sendMessage(runtime, {
        conversationId: first.message.conversationId,
        text: "pode aprovar",
      });
      expect(note.queuedForRun).toBe(true);
      expect((await getRun(runtime.db, first.run.id))?.status).toBe("waiting_approval");
      await runtime.close();
    });
  });

  describe("what the conversation receives when a run ends, exactly once", () => {
    it("done: the final answer; failed and cancelled: a system message; waiting_user: the question", async () => {
      const runtime = await open({
        cases: [
          { whenObjectiveContains: "TOKEN-DONE", agent: [{ text: "Resposta final." }] },
          {
            whenObjectiveContains: "TOKEN-FAIL",
            agent: [{ error: { kind: "invalid_request", message: "boom", retryable: false } }],
          },
          {
            whenObjectiveContains: "TOKEN-CANCEL",
            agent: [{ calls: [call("escalate", { question: "Posso?" })] }],
          },
        ],
      });
      const bot = await newBot(runtime);
      const convFor = async (token: string) => {
        const b = await newBot(runtime);
        const sent = await sendMessage(runtime, { botId: b.id, text: token });
        return { sent, b };
      };

      const done = await convFor("TOKEN-DONE");
      await work(runtime, done.sent.run.id);
      expect(
        (await botMessages(runtime, done.sent.message.conversationId)).map((m) => [
          m.authorKind,
          m.text,
          m.runId,
        ]),
      ).toEqual([["bot", "Resposta final.", done.sent.run.id]]);

      const failed = await convFor("TOKEN-FAIL");
      await work(runtime, failed.sent.run.id);
      const failure = await botMessages(runtime, failed.sent.message.conversationId);
      expect(failure).toHaveLength(1);
      expect(failure[0]?.authorKind).toBe("system");
      expect(failure[0]?.text).toContain("Não consegui concluir");
      expect(failure[0]?.text).toContain("origem: provider");

      const cancelled = await convFor("TOKEN-CANCEL");
      await work(runtime, cancelled.sent.run.id);
      await postInbox(runtime.db, cancelled.sent.run.id, { kind: "stop" });
      await work(runtime, cancelled.sent.run.id);
      expect((await getRun(runtime.db, cancelled.sent.run.id))?.status).toBe("cancelled");
      const trail = await botMessages(runtime, cancelled.sent.message.conversationId);
      expect(trail.map((m) => [m.authorKind, m.text])).toEqual([
        ["bot", "Posso?"],
        ["system", "A execução foi cancelada antes de terminar."],
      ]);

      // Redelivery: running the hook again, any number of times, adds nothing.
      for (const run of [done.sent.run, failed.sent.run, cancelled.sent.run]) {
        for (let i = 0; i < 3; i++) {
          const effects = await finishRun(runtime.db, run.id);
          expect(effects.messageWritten).toBe(false);
          expect(effects.journalWritten).toBe(false);
        }
      }
      expect(await botMessages(runtime, done.sent.message.conversationId)).toHaveLength(1);
      expect(await botMessages(runtime, failed.sent.message.conversationId)).toHaveLength(1);
      expect(await botMessages(runtime, cancelled.sent.message.conversationId)).toHaveLength(2);
      void bot;
      await runtime.close();
    });

    it("each question of a run is written once, a second one included", async () => {
      const runtime = await open({
        agent: [
          { calls: [call("escalate", { question: "Primeira pergunta?" })] },
          { calls: [call("escalate", { question: "Segunda pergunta?" })] },
          { text: "Fim." },
        ],
      });
      const bot = await newBot(runtime);
      const first = await sendMessage(runtime, { botId: bot.id, text: "Pergunte duas vezes" });
      const { conversationId } = first.message;
      await work(runtime, first.run.id);
      await finishRun(runtime.db, first.run.id);
      await sendMessage(runtime, { conversationId, text: "r1" });
      await work(runtime, first.run.id);
      await finishRun(runtime.db, first.run.id);
      await sendMessage(runtime, { conversationId, text: "r2" });
      await work(runtime, first.run.id);
      expect((await botMessages(runtime, conversationId)).map((m) => m.text)).toEqual([
        "Primeira pergunta?",
        "Segunda pergunta?",
        "Fim.",
      ]);
      await runtime.close();
    });

    it("a run finished by a second worker after the first one crashed gets its message once", async () => {
      const runtime = await open({
        agent: [
          { calls: [call("shell", { command: "echo oi" })] },
          { text: "Terminei no segundo worker." },
        ],
      });
      const bot = await newBot(runtime);
      const sent = await sendMessage(runtime, { botId: bot.id, text: "Faça e termine" });
      const { conversationId } = sent.message;

      // Worker A claims the run and dies right after logging the tool call.
      expect(await claimRun(runtime.db, sent.run.id, "worker-a")).not.toBeNull();
      const deps = await runtime.buildDeps(sent.run.id, "worker-a");
      await expect(
        runLoop({ ...deps, store: new CrashingStore(deps.store, 6) }, sent.run.id),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect((await getRun(runtime.db, sent.run.id))?.status).toBe("running");
      expect(await botMessages(runtime, conversationId)).toHaveLength(0);

      // Its lease goes stale, the run is requeued and worker B finishes it.
      await new Promise((r) => setTimeout(r, 30));
      expect(await requeueStaleRuns(runtime.db, { olderThanMs: 1 })).toEqual([sent.run.id]);
      expect((await work(runtime, sent.run.id)).outcome).toBe("settled");

      expect((await getRun(runtime.db, sent.run.id))?.status).toBe("done");
      expect((await botMessages(runtime, conversationId)).map((m) => m.text)).toEqual([
        "Terminei no segundo worker.",
      ]);
      const journal = await listMemories(runtime.db, {
        layer: "journal",
        botId: bot.id,
        limit: 10,
      });
      expect(journal).toHaveLength(1);
      await runtime.close();
    });

    it("a run that ended before the hook ran (the process died) is caught up, once, by reconcile", async () => {
      const runtime = await open({ agent: [{ text: "Fiz." }] });
      const bot = await newBot(runtime);
      const sent = await sendMessage(runtime, { botId: bot.id, text: "Faça" });
      const { conversationId } = sent.message;
      // The loop finishes the run; the worker hook never runs.
      await claimRun(runtime.db, sent.run.id, "worker-x");
      const deps = await runtime.buildDeps(sent.run.id, "worker-x");
      expect(await runLoop(deps, sent.run.id)).toBe("done");
      expect(await botMessages(runtime, conversationId)).toHaveLength(0);

      expect(await reconcileRunEffects(runtime.db)).toContain(sent.run.id);
      expect(await reconcileRunEffects(runtime.db)).not.toContain(sent.run.id);
      expect((await botMessages(runtime, conversationId)).map((m) => m.text)).toEqual(["Fiz."]);
      expect(
        await listMemories(runtime.db, { layer: "journal", botId: bot.id, limit: 10 }),
      ).toHaveLength(1);
      await runtime.close();
    });

    it("a message that arrived as the run ended is not lost: it opens the next run", async () => {
      const runtime = await open({
        cases: [
          { whenObjectiveContains: "primeira", agent: [{ text: "Respondi a primeira." }] },
          {
            // the second run's history has one assistant turn before it
            whenObjectiveContains: "retardatária",
            agent: [{ text: "(história)" }, { text: "Respondi a retardatária." }],
          },
        ],
      });
      const bot = await newBot(runtime);
      const first = await sendMessage(runtime, { botId: bot.id, text: "primeira" });
      const { conversationId } = first.message;
      // The run is running when the late message is posted, and ends without reading it.
      await claimRun(runtime.db, first.run.id, "worker-y");
      const late = await sendMessage(runtime, { conversationId, text: "retardatária" });
      expect(late.queuedForRun).toBe(true);
      // The run ends (the loop finished at the same moment) without having read the message.
      await runtime.db
        .sql`update runs set status = 'done', locked_by = null, result = ${runtime.db.sql.json({ summary: "x" })} where id = ${first.run.id}`;

      const effects = await finishRun(runtime.db, first.run.id);
      expect(effects.rolledOver).not.toBeNull();
      const next = await getActiveConversationRun(runtime.db, conversationId);
      expect(next?.id).toBe(effects.rolledOver?.id);
      expect(next?.objective).toBe("retardatária");
      expect((await getMessage(runtime.db, late.message.id))?.status).toBe("delivered");
      expect((await finishRun(runtime.db, first.run.id)).rolledOver).toBeNull();
      await runtime.close();
    });
  });

  describe("the journal", () => {
    it("one entry per finished run, written by the runtime, with date, objective and outcome", async () => {
      const runtime = await open({
        cases: [
          { whenObjectiveContains: "JOURNAL-OK", agent: [{ text: "Tudo certo." }] },
          {
            whenObjectiveContains: "JOURNAL-FAIL",
            agent: [{ error: { kind: "invalid_request", message: "kaput", retryable: false } }],
          },
        ],
      });
      const bot = await newBot(runtime);
      // A run with no conversation (suup run) is journaled too.
      const ok = await runtime.createRun({ botId: bot.id, objective: "JOURNAL-OK faça" });
      await work(runtime, ok.id);
      const bad = await runtime.createRun({ botId: bot.id, objective: "JOURNAL-FAIL faça" });
      await work(runtime, bad.id);
      await finishRun(runtime.db, ok.id);
      await finishRun(runtime.db, ok.id);

      const entries = await listMemories(runtime.db, {
        layer: "journal",
        botId: bot.id,
        limit: 10,
      });
      expect(entries).toHaveLength(2);
      const byRun = new Map(entries.map((e) => [e.sourceRunId, e]));
      expect(byRun.get(ok.id)?.text).toMatch(
        /^\d{4}-\d{2}-\d{2} · Objetivo: "JOURNAL-OK faça" · Resultado: concluída\. Resumo: Tudo certo\.$/,
      );
      expect(byRun.get(bad.id)?.text).toContain("falhou (origem: provider)");
      for (const e of entries) {
        expect(e).toMatchObject({ scope: "bot", botId: bot.id, createdBy: "bot" });
      }
      await runtime.close();
    });
  });
});
