import { ApiError, type Bot, type Run, type StreamEvent } from "@suup/api";
import { inspectModelRequest, replayRecordedRun, runDoctorChecks } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// The server end to end: real Postgres (one schema for this file), the real `@suup/api` client
// over HTTP, the real runtime on the `scripted` provider and the `local` sandbox, and a worker in a
// runtime of its own (so what the API does and what the loop does never share a process-local
// object). Nothing waits for a fixed time: every wait is on a condition.

const usage = { inputTokens: 1000, outputTokens: 100 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const plan = (status: string) => ({
  name: "plan",
  args: { steps: [{ id: "s1", title: "Fazer o que foi pedido", status }] },
});
const shell = (command: string) => ({ name: "shell", args: { command } });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-FLOW",
        agent: [
          s({ text: "Vou planejar.", calls: [plan("in_progress")] }),
          s({ calls: [shell("echo feito")] }),
          s({ calls: [plan("done")] }),
          s({
            calls: [{ name: "finish", args: { summary: "Fiz o que você pediu.", evidence: [] } }],
          }),
        ],
      },
      {
        // Long in its first turn: a second message arrives while the bot works.
        whenObjectiveContains: "CASE-BUSY",
        agent: [
          s({ text: "Trabalhando.", calls: [shell("echo ocupado")], delayMs: 1500 }),
          s({ text: "Li a sua segunda mensagem e terminei." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-ASK",
        agent: [
          s({ calls: [{ name: "escalate", args: { question: "Qual cor você prefere?" } }] }),
          s({ text: "Azul, então." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-LONG",
        agent: [1, 2, 3, 4, 5]
          .map((n) => s({ calls: [shell(`echo passo ${n}`)], delayMs: 120 }))
          .concat([s({ text: "Terminei os cinco passos." }) as never]),
      },
      {
        // Three messages in one conversation: the n-th run starts at step n (the history counts).
        whenObjectiveContains: "PAGE",
        agent: [s({ text: "Um." }), s({ text: "Dois." }), s({ text: "Três." })],
      },
      ...["MEM-A", "MEM-B", "MEM-C", "MEM-D"].map((key) => ({
        whenObjectiveContains: key,
        agent: [s({ text: "Anotado." })],
      })),
      {
        whenObjectiveContains: "DRAFT-ME",
        agent: [
          s({
            calls: [
              {
                name: "propose_bot",
                args: {
                  name: "Pepê",
                  description: "Ajuda a estudar inglês com paciência.",
                  personality:
                    "Você é o Pepê, um professor de inglês paciente que corrige com gentileza e explica o motivo de cada correção.",
                },
              },
            ],
          }),
        ],
      },
    ],
  },
  outro: {
    cases: [
      { whenObjectiveContains: "CASE-FLOW", agent: [s({ text: "Resposta do outro modelo." })] },
    ],
  },
};

const isRunEvent = (e: StreamEvent, runId: string, type?: string) =>
  e.type === "run.event" &&
  e.data.runId === runId &&
  (type === undefined || e.data.event.type === type);

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the server, end to end: chat, stream, memory, diagnostics"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS });
    let main: Bot;

    const newBot = (name: string) =>
      w.started.api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
    const eventsOf = async (runId: string) => {
      const page = await w.started.api.runs.events(runId, { limit: 1000 });
      return page.items;
    };

    it("starts with the main bot, and lists the models and tools for the create form", async () => {
      const { api } = w.started;
      const bots = await api.bots.list();
      expect(bots).toHaveLength(1);
      main = bots[0] as Bot;
      expect(main).toMatchObject({
        name: "Principal",
        isDefault: true,
        latestRun: null,
        conversationId: null,
        unreadCount: 0,
        modelId: "model-x",
      });
      expect(main.allowedTools).toEqual(expect.arrayContaining(["shell", "remember", "recall"]));

      const models = await api.models.list();
      expect(models.map((m) => m.id)).toEqual(["model-x", "model-y", "model-k"]);
      expect(models.find((m) => m.id === "model-x")).toMatchObject({
        provider: "roteiro",
        providerKind: "scripted",
        priced: true,
        available: true,
        unavailableReason: null,
      });
      expect(models.find((m) => m.id === "model-k")).toMatchObject({
        available: false,
        unavailableReason: expect.stringContaining("SUUP_TEST_MISSING_KEY"),
      });
      const tools = await api.tools.list();
      expect(tools.control).toEqual(["plan", "finish", "escalate"]);
      expect(tools.items.map((t) => t.name)).toEqual(
        expect.arrayContaining(["shell", "read_file", "remember", "search_conversations"]),
      );
      expect(tools.items.find((t) => t.name === "remember")).toMatchObject({ memory: true });
      expect(tools.items.find((t) => t.name === "shell")).toMatchObject({
        memory: false,
        risk: "write",
      });
      expect(tools.items.every((t) => t.summary.length > 0 && t.summary.length <= 200)).toBe(true);
    });

    it("creates, edits, archives and marks bots, validating what it is given", async () => {
      const { api } = w.started;
      const bot = await api.bots.create({
        name: "Ajudante",
        description: "Ajuda com tarefas.",
        personality: "Seja direto.",
        modelId: "model-x",
        allowedTools: ["shell", "shell", "read_file"],
        limits: { maxTurns: 7 },
        avatar: "🤖",
      });
      expect(bot).toMatchObject({
        name: "Ajudante",
        modelProvider: "roteiro",
        modelId: "model-x",
        allowedTools: ["shell", "read_file"],
        limits: { maxTurns: 7 },
        avatar: "🤖",
        isDefault: false,
        archivedAt: null,
      });
      expect(await api.bots.get(bot.id)).toEqual(bot);

      const edited = await api.bots.update(bot.id, {
        name: "Ajudante 2",
        modelId: "model-y",
        limits: { maxTurns: 9 },
      });
      expect(edited).toMatchObject({
        name: "Ajudante 2",
        modelId: "model-y",
        modelProvider: "outro",
        limits: { maxTurns: 9 },
      });

      const code = (promise: Promise<unknown>) =>
        promise.then(
          () => "no error",
          (error: unknown) =>
            error instanceof ApiError ? `${error.code}:${error.status}` : String(error),
        );
      expect(await code(api.bots.create({ name: "x", modelId: "model-z" }))).toBe(
        "invalid_request:400",
      );
      expect(
        await code(api.bots.create({ name: "x", modelId: "model-x", allowedTools: ["nope"] })),
      ).toBe("invalid_request:400");
      expect(await code(api.bots.create({ name: "   ", modelId: "model-x" }))).toBe(
        "invalid_request:400",
      );
      expect(await code(api.bots.update(bot.id, {}))).toBe("invalid_request:400");
      expect(await code(api.bots.get("11111111-1111-4111-8111-111111111111"))).toBe(
        "not_found:404",
      );
      expect(await code(api.bots.get("not-a-uuid"))).toBe("not_found:404");

      const main2 = await api.bots.setDefault(bot.id);
      expect(main2.isDefault).toBe(true);
      expect((await api.bots.get(main.id)).isDefault).toBe(false);
      await api.bots.setDefault(main.id);

      const archived = await api.bots.archive(bot.id);
      expect(archived.archivedAt).not.toBeNull();
      expect((await api.bots.list()).map((b) => b.id)).not.toContain(bot.id);
      expect((await api.bots.list({ includeArchived: true })).map((b) => b.id)).toContain(bot.id);
      expect(await code(api.bots.setDefault(bot.id))).toBe("conflict:409");
      expect(await code(api.bots.openConversation(bot.id))).toBe("conflict:409");
      expect(await code(api.bots.archive("11111111-1111-4111-8111-111111111111"))).toBe(
        "not_found:404",
      );
    });

    it("drafts a bot from a description and creates it", async () => {
      const { api } = w.started;
      const draft = await api.bots.draft({
        description: "DRAFT-ME um professor de inglês paciente",
      });
      expect(draft).toMatchObject({ name: "Pepê", description: expect.stringContaining("inglês") });
      const bot = await api.bots.create({ ...draft, modelId: "model-x", allowedTools: ["shell"] });
      expect(bot.name).toBe("Pepê");
    });

    it("chat: opens a conversation, sends a message, and the stream carries messages, run events and plan updates in order", async () => {
      const { api } = w.started;
      const bot = await newBot("Fluxo");
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "the stream to open");

      const conversation = await api.bots.openConversation(bot.id);
      expect(conversation).toMatchObject({
        kind: "direct",
        unreadCount: 0,
        lastMessage: null,
        activeRun: null,
      });
      expect((await api.bots.openConversation(bot.id)).id).toBe(conversation.id); // idempotent

      const sent = await api.conversations.send(conversation.id, "CASE-FLOW faça o fluxo completo");
      expect(sent.queuedForRun).toBe(false);
      expect(sent.message).toMatchObject({
        authorKind: "user",
        status: null,
        seq: 1,
        runId: sent.run.id,
      });
      expect(sent.run).toMatchObject({
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        paused: false,
      });
      // The run of the conversation is "active" at once.
      expect((await api.conversations.get(conversation.id)).activeRun?.id).toBe(sent.run.id);

      // Follow the run: the connection is reopened with the run's id and resumes where it was.
      f.sub.setRuns([sent.run.id]);
      const botMessage = await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the bot's message",
      );
      expect(botMessage.event).toMatchObject({
        data: { message: { text: "Fiz o que você pediu.", runId: sent.run.id } },
      });

      // Everything arrives in the order it happened: ids only go up...
      const ids = f.events.flatMap((e) => (e.id === undefined ? [] : [e.id]));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
      // ...the events of the run come in seq order, with no gaps and no repeats...
      const runEvents = f.events.filter((e) => isRunEvent(e, sent.run.id));
      const seqs = runEvents.map((e) => (e.type === "run.event" ? e.data.event.seq : -1));
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      const types = runEvents.map((e) => (e.type === "run.event" ? e.data.event.type : ""));
      expect(types.slice(0, 3)).toEqual(["run_started", "context_loaded", "model_request"]);
      expect(types).toContain("tool_result");
      // ...the plan updates among them, first in progress, then done...
      const plans = runEvents.flatMap((e) =>
        e.type === "run.event" && e.data.event.type === "plan_updated"
          ? [(e.data.event.payload.plan as { status: string }[])[0]?.status]
          : [],
      );
      expect(plans).toEqual(["in_progress", "done"]);
      // ...and the bot's message comes after the run's last event (the status change to done).
      const at = (check: (e: StreamEvent) => boolean) => f.events.findIndex(check);
      const done = at(
        (e) =>
          e.type === "run.event" &&
          e.data.event.type === "status_changed" &&
          e.data.event.payload.to === "done",
      );
      expect(done).toBeGreaterThan(-1);
      expect(botMessage.index).toBeGreaterThan(done);
      expect(
        at((e) => e.type === "message.created" && e.data.message.authorKind === "user"),
      ).toBeLessThan(at((e) => isRunEvent(e, sent.run.id, "run_started")));
      // The heavy payload of model requests does not travel on the stream.
      const request = runEvents.find((e) => isRunEvent(e, sent.run.id, "model_request"));
      expect(request).toMatchObject({
        data: {
          event: {
            payload: { omitted: true, provider: "roteiro", model: "model-x", messageCount: 1 },
          },
        },
      });
      // Run status changes for ALL runs come without a subscription, ending in done.
      const statuses = f.events.flatMap((e) =>
        e.type === "run.updated" && e.data.run.id === sent.run.id ? [e.data.run.status] : [],
      );
      expect(statuses[0]).toBe("queued");
      expect(statuses.at(-1)).toBe("done");
      expect(statuses).toContain("running");
      // The conversation list changed too.
      expect(
        f.events.some(
          (e) => e.type === "conversation.updated" && e.data.conversation.id === conversation.id,
        ),
      ).toBe(true);
      f.close();

      const run = await api.runs.get(sent.run.id);
      expect(run).toMatchObject({
        status: "done",
        result: { summary: "Fiz o que você pediu." },
        turns: 4,
        costUsd: expect.stringMatching(/^\d+\.\d+$/),
      });
      expect(run.plan).toEqual([{ id: "s1", title: "Fazer o que foi pedido", status: "done" }]);
      expect(await api.runs.list({ conversationId: conversation.id })).toMatchObject({
        items: [{ id: sent.run.id }],
        hasMore: false,
      });
      expect((await api.runs.list({ botId: bot.id, status: "done" })).items).toHaveLength(1);
      expect((await api.runs.list({ botId: bot.id, status: "failed" })).items).toHaveLength(0);
    });

    it("unread counts: the bot's answer is unread until the conversation is marked read", async () => {
      const { api } = w.started;
      const bot = (await api.bots.list()).find((b) => b.name === "Fluxo") as Bot;
      expect(bot).toMatchObject({ unreadCount: 1, latestRun: { status: "done", paused: false } });
      const conversation = await api.conversations.get(bot.conversationId as string);
      expect(conversation).toMatchObject({ unreadCount: 1, lastReadSeq: 0 });
      expect(conversation.lastMessage).toMatchObject({
        authorKind: "bot",
        text: "Fiz o que você pediu.",
      });

      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      const read = await api.conversations.markRead(conversation.id);
      expect(read).toMatchObject({ unreadCount: 0, lastReadSeq: 2 });
      await f.waitFor(
        (e) =>
          e.type === "conversation.updated" &&
          e.data.conversation.id === conversation.id &&
          e.data.conversation.unreadCount === 0,
        "the conversation update",
      );
      f.close();
      expect((await api.bots.get(bot.id)).unreadCount).toBe(0);
      // Reading up to an older message never unreads, and a number past the end is clamped.
      expect((await api.conversations.markRead(conversation.id, { upToSeq: 1 })).lastReadSeq).toBe(
        2,
      );
      expect((await api.conversations.markRead(conversation.id, { upToSeq: 99 })).lastReadSeq).toBe(
        2,
      );
    });

    it("pages messages: newest first, by cursor in both directions", async () => {
      const { api } = w.started;
      const bot = await newBot("Paginação");
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      for (const word of ["um", "dois", "três"]) {
        const before = f.events.length;
        const sent = await api.conversations.send(conversation.id, `PAGE ${word}`);
        await f.waitFor(
          (e) =>
            e.type === "message.created" &&
            e.data.message.runId === sent.run.id &&
            e.data.message.authorKind === "bot",
          `the reply to ${word}`,
          before,
        );
      }
      f.close();

      const all = await api.conversations.messages(conversation.id, { limit: 50 });
      expect(all.items.map((m) => m.seq)).toEqual(all.items.map((_, i) => i + 1));
      expect(all.hasMore).toBe(false);
      expect(all.items.map((m) => m.text)).toEqual([
        "PAGE um",
        "Um.",
        "PAGE dois",
        "Dois.",
        "PAGE três",
        "Três.",
      ]);
      const newest = await api.conversations.messages(conversation.id, { limit: 2 });
      expect(newest.items.map((m) => m.seq)).toEqual([all.items.length - 1, all.items.length]);
      expect(newest.hasMore).toBe(true);
      const older = await api.conversations.messages(conversation.id, {
        before: newest.items[0]?.seq as number,
        limit: 1,
      });
      expect(older.items.map((m) => m.seq)).toEqual([(newest.items[0]?.seq as number) - 1]);
      expect(older.hasMore).toBe(true);
      const newer = await api.conversations.messages(conversation.id, { after: 1, limit: 2 });
      expect(newer.items.map((m) => m.seq)).toEqual([2, 3]);
      expect(newer.hasMore).toBe(true);
      const none = await api.conversations.messages(conversation.id, { after: all.items.length });
      expect(none).toEqual({ items: [], hasMore: false });
      await expect(api.conversations.send(conversation.id, "   ")).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("a second message while the bot works is stored as sent, then delivered when the bot reads it", async () => {
      const { api } = w.started;
      const bot = await newBot("Ocupado");
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");

      const first = await api.conversations.send(conversation.id, "CASE-BUSY comece");
      await until(
        async () => (await api.runs.get(first.run.id)).status === "running" || undefined,
        "the run to start",
      );
      const second = await api.conversations.send(conversation.id, "e mais uma coisa");
      expect(second.queuedForRun).toBe(true);
      expect(second.run.id).toBe(first.run.id);
      expect(second.message).toMatchObject({
        status: "sent",
        authorKind: "user",
        runId: first.run.id,
      });

      const delivered = await f.waitFor(
        (e) =>
          e.type === "message.updated" &&
          e.data.message.id === second.message.id &&
          e.data.message.status === "delivered",
        "the delivery status change",
      );
      const created = f.events.findIndex(
        (e) => e.type === "message.created" && e.data.message.id === second.message.id,
      );
      expect(created).toBeGreaterThan(-1);
      expect(created).toBeLessThan(delivered.index);
      f.sub.setRuns([first.run.id]);
      await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the bot's answer",
      );

      const events = await eventsOf(first.run.id);
      const delivery = events.find((e) => e.type === "user_message");
      expect(delivery?.payload.text).toBe("e mais uma coisa");
      expect(
        (await api.conversations.messages(conversation.id)).items.find(
          (m) => m.id === second.message.id,
        )?.status,
      ).toBe("delivered");
      f.close();
    });

    it("an escalation question arrives as a bot message, and the answer resumes the run", async () => {
      const { api } = w.started;
      const bot = await newBot("Pergunta");
      const conversation = await api.bots.openConversation(bot.id);
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");

      const first = await api.conversations.send(conversation.id, "CASE-ASK escolha uma cor");
      const question = await f.waitFor(
        (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
        "the question as a bot message",
      );
      expect(question.event).toMatchObject({
        data: { message: { text: "Qual cor você prefere?", runId: first.run.id } },
      });
      const waiting = await api.runs.get(first.run.id);
      expect(waiting.status).toBe("waiting_user");
      expect((await api.conversations.get(conversation.id)).activeRun).toMatchObject({
        id: first.run.id,
        status: "waiting_user",
      });

      // The user's next message is the answer.
      const answer = await api.conversations.send(conversation.id, "Azul");
      expect(answer.queuedForRun).toBe(true);
      const final = await f.waitFor(
        (e) =>
          e.type === "message.created" &&
          e.data.message.authorKind === "bot" &&
          e.data.message.text === "Azul, então.",
        "the final answer",
        question.index + 1,
      );
      expect(final.index).toBeGreaterThan(question.index);
      await until(
        async () => (await api.runs.get(first.run.id)).status === "done" || undefined,
        "the run to finish",
      );
      expect((await api.conversations.get(conversation.id)).activeRun).toBeNull();
      f.close();
    });

    it("memory: add, edit, forget, restore and search through the API, reflected in the next run's first request", async () => {
      const { api } = w.started;
      const systemOfFirstRequest = async (
        botName: string,
        key: string,
      ): Promise<{ system: string; runId: string }> => {
        const bot = await newBot(botName);
        const conversation = await api.bots.openConversation(bot.id);
        const f = follow(api);
        await f.waitFor((e) => e.type === "ready", "ready");
        const sent = await api.conversations.send(conversation.id, `${key} oi`);
        await f.waitFor(
          (e) => e.type === "message.created" && e.data.message.authorKind === "bot",
          "the answer",
        );
        f.close();
        const [request] = (await api.runs.events(sent.run.id, { types: ["model_request"] })).items;
        const view = await api.diagnostics.request(sent.run.id, request?.seq as number);
        return { system: view.request.system as string, runId: sent.run.id };
      };

      const rule = await api.memories.add({ layer: "rule", text: "Responda sempre em inglês." });
      expect(rule).toMatchObject({
        layer: "rule",
        scope: "shared",
        botId: null,
        createdBy: "user",
        archivedAt: null,
      });
      const fact = await api.memories.add({ layer: "profile", text: "Moro em São Paulo." });
      const note = await api.memories.add({
        layer: "note",
        text: "O deploy fica em tools/deploy.sh",
        botId: main.id,
      });
      expect(note).toMatchObject({ scope: "bot", botId: main.id });

      expect((await api.memories.list()).map((m) => m.id)).toEqual(
        expect.arrayContaining([rule.id, fact.id, note.id]),
      );
      expect((await api.memories.list({ layer: "rule" })).map((m) => m.id)).toEqual([rule.id]);
      expect((await api.memories.list({ botId: main.id })).map((m) => m.id)).toEqual([note.id]);

      // In the next run: the rule and the fact are in the system prompt and in `context_loaded`.
      const withRule = await systemOfFirstRequest("Mem A", "MEM-A");
      expect(withRule.system).toContain("Standing rules from the user");
      expect(withRule.system).toContain("Responda sempre em inglês.");
      expect(withRule.system).toContain("Moro em São Paulo.");
      const loaded = (await api.runs.events(withRule.runId, { types: ["context_loaded"] }))
        .items[0];
      expect(loaded?.payload).toMatchObject({
        rules: [{ id: rule.id, text: "Responda sempre em inglês." }],
        profile: [{ id: fact.id, text: "Moro em São Paulo." }],
      });

      // Search: by words, and without the accents.
      expect((await api.memories.search({ q: "ingles" })).map((h) => h.memory.id)).toEqual([
        rule.id,
      ]);
      const hits = await api.memories.search({ q: "inglês" });
      expect(hits.map((h) => h.memory.id)).toEqual([rule.id]);
      const first = hits[0];
      expect(first?.excerpt).toContain("inglês");
      expect(first?.excerpt.includes("\u0002") || first?.excerpt.includes("\u0003")).toBe(false);
      expect(first?.matches.length).toBeGreaterThan(0);
      expect(first?.excerpt.slice(first.matches[0]?.start, first.matches[0]?.end)).toBe("inglês");
      expect((await api.memories.search({ q: "deploy" })).map((h) => h.memory.id)).toEqual([]); // main's note is not shared
      expect(
        (await api.memories.search({ q: "deploy", botId: main.id })).map((h) => h.memory.id),
      ).toEqual([note.id]);
      expect(
        (await api.memories.search({ q: "sao paulo", layers: ["profile"] })).map(
          (h) => h.memory.id,
        ),
      ).toEqual([fact.id]);

      // Forget: archived, gone from the next run, still listed with includeArchived, restorable.
      const f = follow(api);
      await f.waitFor((e) => e.type === "ready", "ready");
      const archived = await api.memories.archive(rule.id);
      expect(archived.archivedAt).not.toBeNull();
      await f.waitFor(
        (e) =>
          e.type === "memory.changed" &&
          e.data.memory.id === rule.id &&
          e.data.change === "archived",
        "the memory change on the stream",
      );
      expect((await api.memories.list({ layer: "rule" })).map((m) => m.id)).toEqual([]);
      expect(
        (await api.memories.list({ layer: "rule", includeArchived: true })).map((m) => m.id),
      ).toEqual([rule.id]);
      expect(await api.memories.search({ q: "inglês" })).toEqual([]);
      const without = await systemOfFirstRequest("Mem B", "MEM-B");
      expect(without.system).not.toContain("Responda sempre em inglês.");
      expect(without.system).not.toContain("Standing rules from the user");
      expect(without.system).toContain("Moro em São Paulo."); // the profile fact is still there

      const restored = await api.memories.restore(rule.id);
      expect(restored.archivedAt).toBeNull();
      await f.waitFor(
        (e) =>
          e.type === "memory.changed" &&
          e.data.memory.id === rule.id &&
          e.data.change === "restored",
        "the restore on the stream",
      );
      const edited = await api.memories.edit(rule.id, "Responda sempre em espanhol.");
      expect(edited.text).toBe("Responda sempre em espanhol.");
      await f.waitFor(
        (e) =>
          e.type === "memory.changed" &&
          e.data.memory.id === rule.id &&
          e.data.change === "updated",
        "the edit on the stream",
      );
      // The diary is written by the system, never through the API.
      await expect(
        api.memories.add({ layer: "journal" as never, text: "x", botId: main.id }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      const withEdit = await systemOfFirstRequest("Mem C", "MEM-C");
      expect(withEdit.system).toContain("Responda sempre em espanhol.");
      expect(withEdit.system).not.toContain("em inglês");
      f.close();

      // Rules of the layers are enforced, and the answers are the documented ones.
      await expect(
        api.memories.add({ layer: "profile", text: "x", scope: "bot", botId: main.id }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(api.memories.add({ layer: "note", text: "sem bot" })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(
        api.memories.add({
          layer: "rule",
          text: "x",
          botId: "11111111-1111-4111-8111-111111111111",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        api.memories.edit("11111111-1111-4111-8111-111111111111", "x"),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(api.memories.edit(rule.id, "   ")).rejects.toMatchObject({
        code: "invalid_request",
      });
      // The conversations are searchable too.
      const messageHits = await api.search.messages({ q: "MEM-C oi" });
      expect(messageHits.length).toBeGreaterThan(0);
    });

    it("reconnecting with Last-Event-ID in the middle of a run receives exactly the events that were missed", async () => {
      const { api } = w.started;
      const bot = await newBot("Reconexão");
      const conversation = await api.bots.openConversation(bot.id);
      const probe = follow(api);
      await probe.waitFor((e) => e.type === "ready", "ready");
      const sent = await api.conversations.send(conversation.id, "CASE-LONG vá devagar");
      const runId = sent.run.id;

      // The first connection sees the run from its start and is cut after a few events.
      const a = follow(api, { runs: [runId] });
      await a.waitFor((e) => isRunEvent(e, runId, "tool_result"), "the first tool result");
      a.close();
      const seenByA = a.events.filter((e) => isRunEvent(e, runId));
      const lastId = a.sub.lastEventId as number;
      expect(lastId).toBeGreaterThan(0);

      // The second resumes from the last id A saw, while the run goes on (or after it ended).
      const b = follow(api, { runs: [runId], lastEventId: lastId });
      await b.waitFor((e) => isRunEvent(e, runId, "status_changed"), "the end of the run");
      await b.waitFor(
        (e) =>
          e.type === "message.created" &&
          e.data.message.runId === runId &&
          e.data.message.authorKind === "bot",
        "the bot's message",
      );
      b.close();
      probe.close();

      const seqsOf = (events: StreamEvent[]) =>
        events.flatMap((e) =>
          e.type === "run.event" && e.data.runId === runId ? [e.data.event.seq] : [],
        );
      const fromA = seqsOf(a.events);
      const fromB = seqsOf(b.events);
      const all = (await eventsOf(runId)).map((e) => e.seq);
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      // No repeats between the two, no holes, and together exactly the log.
      expect(fromA.filter((seq) => fromB.includes(seq))).toEqual([]);
      expect([...fromA, ...fromB].sort((x, y) => x - y)).toEqual(all);
      expect(fromB).toEqual([...fromB].sort((x, y) => x - y));
      // Every id B got is newer than the one it resumed from, and the ids only go up.
      const idsB = b.events.flatMap((e) => (e.id === undefined ? [] : [e.id]));
      expect(idsB.every((id) => id > lastId)).toBe(true);
      expect(idsB).toEqual([...idsB].sort((x, y) => x - y));
      expect(seenByA.length).toBe(fromA.length);
      // The resumed stream says it is resuming, not reloading.
      expect(b.events[0]).toMatchObject({ type: "ready", data: { resync: false, runs: [runId] } });
      expect(b.events.some((e) => e.type === "resync")).toBe(false);
    });

    it("view=chat leaves out the model_request payloads and keeps everything else; types filter and pagination work", async () => {
      const { api } = w.started;
      const bot = (await api.bots.list()).find((b) => b.name === "Fluxo") as Bot;
      const run = (await api.runs.list({ botId: bot.id })).items[0] as Run;
      const full = await api.runs.events(run.id, { limit: 1000 });
      const chat = await api.runs.events(run.id, { limit: 1000, view: "chat" });
      expect(chat.items.map((e) => [e.seq, e.type])).toEqual(
        full.items.map((e) => [e.seq, e.type]),
      );
      const fullRequest = full.items.find((e) => e.type === "model_request");
      const chatRequest = chat.items.find((e) => e.type === "model_request");
      expect(JSON.stringify(fullRequest?.payload).length).toBeGreaterThan(2000);
      expect(chatRequest?.payload).toEqual({
        omitted: true,
        provider: "roteiro",
        model: "model-x",
        messageCount: expect.any(Number),
        toolCount: expect.any(Number),
      });
      // Everything FRONTEND.md section 5 lists as drawn keeps its payload.
      for (const type of [
        "run_started",
        "context_loaded",
        "model_response",
        "tool_call",
        "tool_result",
        "plan_updated",
        "status_changed",
      ]) {
        const a = full.items.find((e) => e.type === type);
        const b = chat.items.find((e) => e.type === type);
        expect(a, type).toBeDefined();
        expect(b?.payload, type).toEqual(a?.payload);
      }
      expect(full.hasMore).toBe(false);
      expect(full.lastSeq).toBe(full.items.at(-1)?.seq);

      const onlyTools = await api.runs.events(run.id, {
        types: ["tool_call", "tool_result"],
        view: "chat",
      });
      expect(onlyTools.items).toHaveLength(8); // four calls (plan, shell, plan, finish) and their results
      expect(new Set(onlyTools.items.map((e) => e.type))).toEqual(
        new Set(["tool_call", "tool_result"]),
      );
      const page1 = await api.runs.events(run.id, { limit: 3 });
      expect(page1.items.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(page1).toMatchObject({ hasMore: true, lastSeq: 3 });
      const page2 = await api.runs.events(run.id, { afterSeq: page1.lastSeq, limit: 1000 });
      expect(page2.items[0]?.seq).toBe(4);
      expect(page2.hasMore).toBe(false);
      await expect(api.runs.events(run.id, { types: ["nope" as never] })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(api.runs.events("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("diagnostics: the exact request, the replay, the resend and the doctor return what the CLI commands print", async () => {
      const { api } = w.started;
      const bot = (await api.bots.list()).find((b) => b.name === "Fluxo") as Bot;
      const run = (await api.runs.list({ botId: bot.id })).items[0] as Run;
      const requests = (await api.runs.events(run.id, { types: ["model_request"] })).items;
      expect(requests).toHaveLength(4);
      const seq = requests[0]?.seq as number;
      const eventsBefore = (await api.runs.events(run.id, { limit: 1000 })).items.length;

      // `inspect --request`: the same view the CLI renders from.
      const view = await api.diagnostics.request(run.id, seq);
      expect(view).toEqual(
        JSON.parse(JSON.stringify(await inspectModelRequest(w.db, run.id, seq))),
      );
      expect(view).toMatchObject({ runId: run.id, seq, purpose: "agent", turn: 1 });
      expect(view.request.system).toEqual(expect.stringContaining("You are Fluxo"));
      expect((view.request.tools as { name: string }[]).map((t) => t.name)).toEqual(
        expect.arrayContaining(["plan", "finish", "escalate", "shell"]),
      );
      expect(view.response).toMatchObject({
        stopReason: expect.any(String),
        modelVersion: "scripted-1",
      });
      const second = await api.diagnostics.request(run.id, requests[1]?.seq as number);
      expect(second.turn).toBe(2);
      await expect(api.diagnostics.request(run.id, 999)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(api.diagnostics.request(run.id, 1)).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("não um model_request"),
      });

      // `replay`: the current loop reproduces the recording.
      const replay = await api.diagnostics.replay(run.id);
      expect(replay).toEqual(
        JSON.parse(JSON.stringify((await replayRecordedRun(w.serverRuntime, run.id)).view)),
      );
      expect(replay).toMatchObject({
        runId: run.id,
        identical: true,
        firstDivergence: null,
        stoppedBecause: null,
      });
      expect(replay.reading).toContain("reproduz a execução");

      // `resend`: the same request again, three times, then to another model.
      const resent = await api.diagnostics.resend(run.id, { seq, times: 3 });
      expect(resent).toMatchObject({
        runId: run.id,
        requestSeq: seq,
        times: 3,
        recordedModel: "model-x",
        sentTo: { model: "model-x" },
      });
      expect(resent.attempts).toHaveLength(3);
      expect(resent.attempts.every((a) => a.ok)).toBe(true);
      expect(resent.summary).toMatchObject({ attempts: 3, recordedRepeated: 3 });
      expect(resent.summary.distinct).toHaveLength(1);
      expect(resent.summary.reading).toContain("3 de 3");
      const other = await api.diagnostics.resend(run.id, { seq, model: "model-y" });
      expect(other.sentTo).toEqual({ provider: "outro", model: "model-y" });
      const answer = other.attempts[0];
      expect(answer).toMatchObject({ ok: true, text: "Resposta do outro modelo." });
      expect(other.summary.reading).toContain("model-y");
      await expect(api.diagnostics.resend(run.id, { seq, model: "model-z" })).rejects.toMatchObject(
        { code: "invalid_request" },
      );
      await expect(api.diagnostics.resend(run.id, { seq: 1 })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(api.diagnostics.resend(run.id, { seq, times: 21 })).rejects.toMatchObject({
        code: "invalid_request",
      });
      // The run itself was not touched (no new events, no extra cost).
      expect((await api.runs.get(run.id)).turns).toBe(4);
      expect((await api.runs.events(run.id, { limit: 1000 })).items).toHaveLength(eventsBefore);

      // `doctor`: a line per component, the failing provider named.
      const doctor = await api.diagnostics.doctor();
      expect(doctor.checks).toEqual(
        JSON.parse(JSON.stringify(await runDoctorChecks(w.serverRuntime))),
      );
      expect(doctor.ok).toBe(false); // the cloud provider has no key in this environment
      const by = new Map(doctor.checks.map((c) => [c.component, c]));
      expect(by.get("Banco de dados")).toMatchObject({ ok: true });
      expect(by.get("Sandbox")).toMatchObject({ ok: true });
      expect(by.get("Busca")).toMatchObject({
        ok: true,
        detail: expect.stringContaining("ignora acentos"),
      });
      expect(by.get("Provedor nuvem")).toMatchObject({ ok: false });
      expect(by.get("Provedor roteiro")).toMatchObject({ ok: true });
    });
  },
);
