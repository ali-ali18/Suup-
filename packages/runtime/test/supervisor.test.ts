import { join } from "node:path";
import { TEAM_REVIEW_TOOL_NAME } from "@suup/core";
import { call, FakeProvider, type FakeStep, use } from "@suup/core/testing";
import {
  addJournalMemory,
  addMemory,
  appendMessage,
  type Bot,
  createBot,
  createDirectConversation,
  createRun,
  decideApproval,
  getRun,
  listApprovals,
  listMemories,
  listMessages,
  listTeamReviews,
  setDefaultBot,
  setRunStatus,
  updateSupervisorSettings,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  parseConfig,
  type Runtime,
  reconcileRunEffects,
  replayRecordedRun,
  runMorningMessage,
  runNightlyReview,
  sendMessage,
  teamRecallTool,
} from "../src/index.js";
import { generateKeyText } from "../src/vault/crypto.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const model = {
  id: "principal-model",
  maxOutputTokens: 4000,
  pricing: { inputPerMTok: 1, outputPerMTok: 5 },
};
const answer = (notes: { text: string; summary: string }[], morning: string | null): FakeStep =>
  use(call("r1", TEAM_REVIEW_TOOL_NAME, { notes, morning_message: morning })) as FakeStep;
const SP = "America/Sao_Paulo";
/**
 * The next 03:30 in São Paulo (06:30 UTC): always after the data the tests create "now", so the
 * review window covers it, and the night's local date is the same as the UTC one.
 */
const NIGHT = (() => {
  const t = new Date();
  t.setUTCHours(6, 30, 0, 0);
  if (t.getTime() <= Date.now()) t.setUTCDate(t.getUTCDate() + 1);
  return t;
})();
const at = (base: Date, hours: number): Date => new Date(base.getTime() + hours * 3_600_000);
const DAY = NIGHT.toISOString().slice(0, 10);

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the supervisor: nightly review, morning message, tools"),
  () => {
    const ctx = useIsolatedDb();
    let n = 0;
    const bot = (name: string) =>
      createBot(ctx.db, { name: `${name}${++n}`, modelProvider: "p", modelId: "m" });
    const review = (
      provider: FakeProvider,
      over: { workerId?: string; now?: Date; timeZone?: string } = {},
    ) =>
      runNightlyReview({
        db: ctx.db,
        workerId: over.workerId ?? "w1",
        provider,
        model,
        timeZone: over.timeZone ?? SP,
        now: () => over.now ?? NIGHT,
      });

    /** A fresh team: the Principal (default) and two bots with a week of made-up activity. */
    async function team() {
      // each test is a separate world: the old team is archived, and the settings are the defaults
      await ctx.db
        .sql`update bots set archived_at = now(), is_default = false where archived_at is null`;
      await ctx.db.sql`delete from team_reviews`;
      await ctx.db.sql`delete from team_review_cursors`;
      await updateSupervisorSettings(ctx.db, {
        reviewEnabled: true,
        reviewTime: "03:00",
        morningTime: "08:00",
        costCapUsd: null,
      });
      const principal = await bot("Principal");
      await setDefaultBot(ctx.db, principal.id);
      const tutor = await bot("Tutor");
      const fin = await bot("Financas");
      const tConv = await createDirectConversation(ctx.db, tutor.id);
      const run = await createRun(ctx.db, {
        botId: tutor.id,
        conversationId: tConv.id,
        origin: "user",
        objective: "x",
      });
      await addJournalMemory(ctx.db, {
        botId: tutor.id,
        text: "2026-11-19 · Conversa · Resultado: concluída. Resumo: montei o resumo de física",
        sourceRunId: run.id,
      });
      await addMemory(ctx.db, {
        layer: "note",
        botId: tutor.id,
        text: "A prova de química é na sexta.",
        createdBy: "bot",
      });
      return { principal, tutor, fin, tConv, run };
    }
    const memoriesOf = async (botId: string) =>
      (await listMemories(ctx.db, { botId, limit: 100 })).map((m) => m.text);

    describe("when it runs", () => {
      it("runs once per night even with two workers at the same time", async () => {
        await team();
        const provider = new FakeProvider([
          answer([{ text: "O Tutor montou o resumo de física.", summary: "Tutor: física" }], null),
        ]);
        const outcomes = await Promise.all([
          review(provider, { workerId: "w1" }),
          review(provider, { workerId: "w2" }),
        ]);
        expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
        expect(provider.calls).toBe(1);
        expect(await review(provider)).toBeNull(); // the night is done
        expect(await listTeamReviews(ctx.db)).toMatchObject([{ night: DAY, status: "done" }]);
      });

      it("waits for the review time in the USER's time zone", async () => {
        await team();
        const provider = new FakeProvider([answer([], null), answer([], null)]);
        // 02:30 in São Paulo (one hour before): too early
        expect(await review(provider, { now: at(NIGHT, -1) })).toBeNull();
        expect(provider.calls).toBe(0);
        // the same instant is 14:30 in Tokyo: already past 03:00 there, and the night is that local date
        const tokyo = await review(provider, { now: at(NIGHT, -1), timeZone: "Asia/Tokyo" });
        expect(tokyo?.review.night).toBe(DAY);
        await ctx.db.sql`delete from team_reviews`;
        // 03:30 in São Paulo: its night is the local date
        expect((await review(provider))?.review.night).toBe(DAY);
      });

      it("skips the night when nothing happened in the other bots since the last review, and records it", async () => {
        await team();
        const provider = new FakeProvider([answer([], null)]);
        expect((await review(provider))?.status).toBe("done");
        expect(provider.calls).toBe(1);
        // the next night nothing moved: no model call, a recorded silent night
        const out = await review(provider, { now: at(NIGHT, 24) });
        expect(out?.status).toBe("skipped");
        expect(provider.calls).toBe(1);
        expect(await listTeamReviews(ctx.db)).toMatchObject([
          { status: "skipped", costUsd: null },
          { status: "done" },
        ]);
        expect(await review(provider, { now: at(NIGHT, 25) })).toBeNull();
      });

      it("does nothing when it is off, or there is no main bot", async () => {
        await team();
        await updateSupervisorSettings(ctx.db, { reviewEnabled: false });
        const provider = new FakeProvider([answer([], null)]);
        expect(await review(provider)).toBeNull();
        await updateSupervisorSettings(ctx.db, { reviewEnabled: true });
        await ctx.db.sql`update bots set is_default = false`;
        expect(await review(provider)).toBeNull();
        expect(provider.calls).toBe(0);
      });
    });

    describe("what it reads and what it writes", () => {
      it("sends the model only journal, notes and open items: no tool output, page, e-mail or chat text", async () => {
        const w = await team();
        // things that must never reach the model
        await appendMessage(ctx.db, {
          conversationId: w.tConv.id,
          authorKind: "user",
          text: "TEXTO-CRU-DO-USUARIO",
        });
        await appendMessage(ctx.db, {
          conversationId: w.tConv.id,
          authorKind: "bot",
          authorBotId: w.tutor.id,
          text: "RESPOSTA-DO-BOT-NO-CHAT",
        });
        await ctx.db.sql`
        insert into run_events (run_id, seq, type, payload)
        values (${w.run.id}, 50, 'tool_result', ${ctx.db.sql.json({ content: "SAIDA-DE-FERRAMENTA PAGINA-BUSCADA EMAIL-LIDO" })})`;
        await addMemory(ctx.db, { layer: "rule", text: "REGRA-DO-USUARIO", createdBy: "user" });
        await addMemory(ctx.db, { layer: "profile", text: "PERFIL-DO-USUARIO", createdBy: "user" });
        const provider = new FakeProvider([answer([], null)]);
        await review(provider);
        const request = provider.requests[0];
        expect(request?.tools.map((t) => t.name)).toEqual([TEAM_REVIEW_TOOL_NAME]);
        expect(request?.model).toBe("principal-model");
        const sent = JSON.stringify(request);
        expect(sent).toContain("montei o resumo de física"); // the journal entry
        expect(sent).toContain("A prova de química é na sexta."); // the note
        for (const never of [
          "TEXTO-CRU",
          "RESPOSTA-DO-BOT",
          "SAIDA-DE-FERRAMENTA",
          "PAGINA-BUSCADA",
          "EMAIL-LIDO",
          "REGRA-DO-USUARIO",
          "PERFIL-DO-USUARIO",
        ]) {
          expect(sent, never).not.toContain(never);
        }
      });

      it("writes only notes in the Principal's own memory; the other bots' memory is untouched", async () => {
        const w = await team();
        const before = {
          tutor: await memoriesOf(w.tutor.id),
          fin: await memoriesOf(w.fin.id),
        };
        const revisionsBefore = (
          await ctx.db.sql`select count(*)::int as n from memory_revisions`
        )[0]?.n;
        const provider = new FakeProvider([
          answer(
            [
              {
                text: "Em 2026-11-19 o Tutor montou o resumo de física.",
                summary: "Tutor: resumo de física",
              },
              {
                text: "A prova de química do usuário é na sexta (via Tutor).",
                summary: "Prova de química na sexta",
              },
            ],
            null,
          ),
        ]);
        const out = await review(provider);
        expect(out?.status).toBe("done");
        expect(await memoriesOf(w.tutor.id)).toEqual(before.tutor);
        expect(await memoriesOf(w.fin.id)).toEqual(before.fin);
        expect((await memoriesOf(w.principal.id)).sort()).toEqual([
          "A prova de química do usuário é na sexta (via Tutor).",
          "Em 2026-11-19 o Tutor montou o resumo de física.",
        ]);
        const created = await listMemories(ctx.db, { botId: w.principal.id, limit: 10 });
        expect(
          created.every((m) => m.layer === "note" && m.scope === "bot" && m.createdBy === "bot"),
        ).toBe(true);
        expect((await ctx.db.sql`select count(*)::int as n from memory_revisions`)[0]?.n).toBe(
          (revisionsBefore as number) + 2,
        );
        expect(out?.review.noted).toHaveLength(2);
        expect(out?.review.botsRead.map((b) => b.name).sort()).toEqual([w.tutor.name]);
        // the cost of the night is recorded
        expect(out?.review).toMatchObject({
          model: "principal-model",
          costUsd: expect.any(Number),
        });
      });

      it("does not note twice what it already knows, and the next night reads only what is new", async () => {
        const w = await team();
        const note = { text: "O Tutor monta resumos de física.", summary: "Tutor: física" };
        await review(new FakeProvider([answer([note], null)]));
        // after the first night, one new journal entry in the Tutor
        const run2 = await createRun(ctx.db, { botId: w.tutor.id, origin: "user", objective: "y" });
        const entry = await addJournalMemory(ctx.db, {
          botId: w.tutor.id,
          text: "2026-11-21 · concluída: cronograma de química",
          sourceRunId: run2.id,
        });
        await ctx.db
          .sql`update memories set created_at = ${at(NIGHT, 2)} where id = ${entry?.id as string}`;
        await ctx.db.sql`update runs set updated_at = ${at(NIGHT, 2)} where id = ${run2.id}`;
        const provider = new FakeProvider([answer([note], null)]);
        await review(provider, { now: at(NIGHT, 24) });
        const sent = JSON.stringify(provider.requests[0]);
        expect(sent).toContain("cronograma de química");
        expect(sent).not.toContain("montei o resumo de física");
        expect(await memoriesOf(w.principal.id)).toEqual(["O Tutor monta resumos de física."]);
      });

      it("a model that fails or answers badly writes nothing and the cursors stay; the night is retried later, a few times", async () => {
        const w = await team();
        const failing = new FakeProvider([new Error("boom") as unknown as FakeStep]);
        const out = await review(failing);
        expect(out?.status).toBe("failed");
        expect(await memoriesOf(w.principal.id)).toEqual([]);
        expect((await ctx.db.sql`select count(*)::int as n from team_review_cursors`)[0]?.n).toBe(
          0,
        );
        const bad = new FakeProvider([
          use(call("r1", TEAM_REVIEW_TOOL_NAME, { notes: "x", morning_message: null })) as FakeStep,
        ]);
        expect(await review(bad)).toBeNull(); // too soon after the failure
        const later = new Date(NIGHT.getTime() + 40 * 60_000);
        expect((await review(bad, { now: later }))?.status).toBe("failed");
        const good = new FakeProvider([answer([], null)]);
        const much = new Date(NIGHT.getTime() + 90 * 60_000);
        expect((await review(good, { now: much }))?.status).toBe("done");
      });
    });

    describe("the cost cap", () => {
      /** Two bots with a lot to read, so the request is big enough to see the cap. */
      async function busyTeam() {
        const w = await team();
        const other = await bot("Saude");
        for (const b of [w.tutor, other]) {
          for (let i = 0; i < 40; i++) {
            const r = await createRun(ctx.db, { botId: b.id, origin: "user", objective: "x" });
            await addJournalMemory(ctx.db, {
              botId: b.id,
              text: `2026-11-1${i % 9} · ${"concluída: trabalho longo ".repeat(18)}${i}`,
              sourceRunId: r.id,
            });
          }
        }
        return { ...w, other };
      }

      it("has none by default: the review reads everything", async () => {
        const w = await busyTeam();
        const provider = new FakeProvider([answer([], null)]);
        const out = await review(provider);
        expect(out?.review).toMatchObject({
          status: "done",
          capReached: false,
          leftOver: [],
          costCapUsd: null,
        });
        expect(out?.review.botsRead).toHaveLength(2);
        expect((await ctx.db.sql`select count(*)::int as n from team_review_cursors`)[0]?.n).toBe(
          3,
        ); // tutor, other and fin (nothing to read, but looked at)
        void w;
      });

      it("closes with what fits under the cap, records what was left, and reads it the next night", async () => {
        const w = await busyTeam();
        await updateSupervisorSettings(ctx.db, { costCapUsd: 0.02 });
        const provider = new FakeProvider([answer([], null)]);
        const out = await review(provider);
        expect(out?.review.capReached).toBe(true);
        expect(out?.review.costCapUsd).toBe(0.02);
        expect(out?.review.botsRead).toHaveLength(1);
        expect(out?.review.leftOver).toHaveLength(1);
        expect(out?.review.leftOver[0]).toMatchObject({ reason: "cost_cap" });
        const readName = out?.review.botsRead[0]?.name;
        const leftName = out?.review.leftOver[0]?.name;
        expect([readName, leftName].sort()).toEqual([w.tutor.name, w.other.name].sort());
        expect(out?.review.costUsd as number).toBeLessThan(0.02 + 1e-9);
        // the next night: the cursor of the left-over bot did not move, so it is read now
        const next = new FakeProvider([answer([], null)]);
        await updateSupervisorSettings(ctx.db, { costCapUsd: null });
        const again = await review(next, { now: at(NIGHT, 24) });
        expect(JSON.stringify(next.requests[0])).toContain(leftName as string);
        expect(again?.status).toBe("done");
      });

      it("a cap too small for even one bot makes a recorded, silent night", async () => {
        await busyTeam();
        await updateSupervisorSettings(ctx.db, { costCapUsd: 0.01 });
        const provider = new FakeProvider([answer([], null)]);
        const out = await review(provider);
        expect(provider.calls).toBe(0);
        expect(out?.review).toMatchObject({ status: "skipped", capReached: true });
        expect(out?.review.leftOver.length).toBeGreaterThan(0);
      });
    });

    describe("the morning message", () => {
      const morning = (now: Date, tz = SP) =>
        runMorningMessage({ db: ctx.db, timeZone: tz, now: () => now });
      async function doneReview(text: string | null) {
        const w = await team();
        await review(new FakeProvider([answer([], text)]));
        const conversation = await createDirectConversation(ctx.db, w.principal.id);
        await ctx.db.sql`update conversations set reception = 'done' where id = ${conversation.id}`;
        return { ...w, conversation };
      }

      it("posts ONE short message in the Principal's chat at the morning time, in the user's time zone, when it was useful", async () => {
        const w = await doneReview("O Tutor espera uma resposta sua sobre o cronograma.");
        expect(await morning(at(NIGHT, 3))).toBe(false); // 06:30 in São Paulo: too early
        expect(await morning(at(NIGHT, 5))).toBe(true); // 08:30
        expect(await morning(at(NIGHT, 6))).toBe(false); // once
        const messages = await listMessages(ctx.db, w.conversation.id, { limit: 10 });
        expect(messages).toMatchObject([
          {
            authorKind: "bot",
            authorBotId: w.principal.id,
            text: "O Tutor espera uma resposta sua sobre o cronograma.",
          },
        ]);
      });

      it("posts nothing when the review found nothing useful, when it is off, and for an old night", async () => {
        const quiet = await doneReview(null);
        expect(await morning(at(NIGHT, 5))).toBe(false);
        expect(await listMessages(ctx.db, quiet.conversation.id, { limit: 10 })).toHaveLength(0);

        const off = await doneReview("Algo útil.");
        await updateSupervisorSettings(ctx.db, { morningTime: null });
        expect(await morning(at(NIGHT, 5))).toBe(false);
        await updateSupervisorSettings(ctx.db, { morningTime: "08:00" });
        // a message of yesterday's review is not posted today
        expect(await morning(at(NIGHT, 29))).toBe(false);
        expect(await listMessages(ctx.db, off.conversation.id, { limit: 10 })).toHaveLength(0);
      });
    });

    describe("team_recall: reading another bot, read only", () => {
      const ctxOf = (botId: string) =>
        ({ runId: "00000000-0000-4000-8000-000000000000", botId }) as never;

      it("returns the other bot's notes, journal and open items, marked as outside text, and cannot write", async () => {
        const w = await team();
        const tool = teamRecallTool(ctx.db);
        const snapshot = async () =>
          JSON.stringify(
            await ctx.db
              .sql`select id, text, archived_at, status, updated_at from memories order by id`,
          ) +
          JSON.stringify((await ctx.db.sql`select count(*)::int as n from memory_revisions`)[0]);
        const before = await snapshot();
        const out = await tool.execute(
          { bot: w.tutor.name.toUpperCase(), query: "química" },
          ctxOf(w.principal.id),
        );
        expect(out.isError).toBeUndefined();
        expect(out.untrusted).toBe(true);
        expect(out.content).toContain("A prova de química é na sexta.");
        expect(out.content).not.toContain("montei o resumo de física"); // the query filtered it
        const all = await tool.execute({ bot: w.tutor.name }, ctxOf(w.principal.id));
        expect(all.content).toContain("montei o resumo de física");
        expect(await snapshot()).toBe(before); // nothing changed anywhere
      });

      it("refuses an unknown bot and itself, naming the team; the tool has no way to change memory", async () => {
        const w = await team();
        const tool = teamRecallTool(ctx.db);
        const unknown = await tool.execute({ bot: "Fantasma" }, ctxOf(w.principal.id));
        expect(unknown.isError).toBe(true);
        expect(unknown.content).toContain(w.tutor.name);
        expect((await tool.execute({ bot: w.principal.name }, ctxOf(w.principal.id))).isError).toBe(
          true,
        );
        expect(tool.risk).toBe("read");
      });
    });
  },
);

describe.skipIf(!DATABASE_URL)(dbSuiteName("delegation, end to end"), () => {
  const ctx = useIsolatedDb();

  const SCRIPT = {
    cases: [
      {
        whenObjectiveContains: "manda o Tutor montar",
        agent: [
          {
            calls: [
              {
                id: "d1",
                name: "delegate",
                args: {
                  bot: "Tutor",
                  objective: "Monte um cronograma de estudos para a prova de sexta.",
                  acceptanceCriteria: ["tem os dias e os temas"],
                  context: "A prova é de química, na sexta.",
                },
              },
            ],
          },
          { text: "Passei para o Tutor; o resultado volta aqui." },
        ],
      },
      {
        whenObjectiveContains: "Task delegated by",
        agent: [{ text: "Cronograma: seg e qua revisão, qui simulado." }],
      },
      {
        whenObjectiveContains: "Use o segredo",
        agent: [
          {
            calls: [
              { id: "s1", name: "shell", args: { command: 'echo "t={{secret:TUTOR_TOKEN}}"' } },
            ],
          },
          { text: "Feito com o token." },
        ],
      },
      {
        whenObjectiveContains: "tente delegar",
        agent: [{ text: "ok" }],
      },
    ],
  };

  async function open() {
    await ctx.db
      .sql`update bots set archived_at = now(), is_default = false where archived_at is null`;
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), SCRIPT);
    const runtime = createRuntime(parseConfig(rawConfig({ vault: { keyEnv: "TEST_VAULT_KEY" } })), {
      env: { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() },
      baseDir: dir,
    });
    const mk = (name: string) =>
      createBot(runtime.db, {
        name,
        modelProvider: "script",
        modelId: "model-s",
        allowedTools: ["shell", "write_file", "read_file"],
      });
    const principal = await mk("Principal");
    await setDefaultBot(runtime.db, principal.id);
    const tutor = await mk("Tutor");
    return { runtime, principal, tutor };
  }

  const work = (runtime: Runtime, runId: string): Promise<string> =>
    new Promise((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: runId,
        idleBackoff: { minMs: 5, maxMs: 20 },
        onRunEnd: (end) => {
          resolve(end.outcome === "settled" ? end.status : end.outcome);
          void worker.stop();
        },
      });
      worker.start();
    });

  const texts = async (runtime: Runtime, conversationId: string) =>
    (await listMessages(runtime.db, conversationId, { limit: 100 }))
      .filter((m) => m.authorKind !== "user")
      .map((m) => `${m.authorKind}: ${m.text}`);

  async function delegateFlow(runtime: Runtime, principal: Bot) {
    const sent = await sendMessage(runtime, {
      botId: principal.id,
      text: "manda o Tutor montar um cronograma da prova de sexta",
    });
    expect(await work(runtime, sent.run.id)).toBe("done");
    return sent;
  }

  it("the Principal delegates: a delegated run appears in the Tutor's own chat; the result comes back to the Principal's chat", async () => {
    const { runtime, principal, tutor } = await open();
    const sent = await delegateFlow(runtime, principal);
    // 1. the Principal told the user it delegated (async: it did not wait)
    expect(await texts(runtime, sent.message.conversationId)).toEqual([
      "bot: Passei para o Tutor; o resultado volta aqui.",
    ]);
    // 2. the run is in the Tutor's own conversation, visible there, origin delegation
    const tConv = await createDirectConversation(runtime.db, tutor.id);
    const delegated = (
      await runtime.db.sql<{ id: string }[]>`select id from runs where bot_id = ${tutor.id}`
    )[0];
    const run = await getRun(runtime.db, delegated?.id as string);
    expect(run).toMatchObject({
      origin: "delegation",
      conversationId: tConv.id,
      parentRunId: sent.run.id,
      status: "queued",
      acceptanceCriteria: ["tem os dias e os temas"],
    });
    expect(run?.objective).toContain("Monte um cronograma de estudos");
    expect(run?.objective).toContain("A prova é de química, na sexta.");
    expect((await texts(runtime, tConv.id))[0]).toContain("passou esta tarefa para Tutor");
    // 3. nothing came back yet
    expect(await texts(runtime, sent.message.conversationId)).toHaveLength(1);
    // 4. the delegated run ends: its answer is in the Tutor's chat and a short summary in the Principal's
    expect(await work(runtime, run?.id as string)).toBe("done");
    expect(await texts(runtime, tConv.id)).toContain(
      "bot: Cronograma: seg e qua revisão, qui simulado.",
    );
    expect(await texts(runtime, sent.message.conversationId)).toEqual([
      "bot: Passei para o Tutor; o resultado volta aqui.",
      "bot: Tutor terminou a tarefa que pedi: Cronograma: seg e qua revisão, qui simulado.",
    ]);
    await runtime.close();
  });

  it("is deterministic to replay and safe to repeat: finishing again or reconciling writes the result once", async () => {
    const { runtime, principal, tutor } = await open();
    const sent = await delegateFlow(runtime, principal);
    const replay = await replayRecordedRun(runtime, sent.run.id);
    expect(replay.view.identical).toBe(true);
    const delegated = (
      await runtime.db.sql<{ id: string }[]>`select id from runs where bot_id = ${tutor.id}`
    )[0]?.id as string;
    // the worker dies right after the delegated run is done: the effects are missing
    await setRunStatus(runtime.db, delegated, { from: "queued", to: "running" });
    await setRunStatus(runtime.db, delegated, {
      from: "running",
      to: "done",
      result: { summary: "Cronograma pronto." },
    } as never);
    expect(await texts(runtime, sent.message.conversationId)).toHaveLength(1);
    await reconcileRunEffects(runtime.db);
    await reconcileRunEffects(runtime.db);
    expect(await texts(runtime, sent.message.conversationId)).toEqual([
      "bot: Passei para o Tutor; o resultado volta aqui.",
      "bot: Tutor terminou a tarefa que pedi: Cronograma pronto.",
    ]);
    await runtime.close();
  });

  it("a delegated run cannot delegate: neither tool is offered to it, and the code refuses it too", async () => {
    const { runtime, principal, tutor } = await open();
    const sent = await delegateFlow(runtime, principal);
    const delegated = (
      await runtime.db.sql<{ id: string }[]>`select id from runs where bot_id = ${tutor.id}`
    )[0]?.id as string;
    const tutorDeps = await runtime.buildDeps(delegated, "w");
    expect(tutorDeps.bot.allowedTools).not.toContain("delegate");
    expect(tutorDeps.bot.allowedTools).not.toContain("team_recall");
    // even if the Principal's own bot were handed a delegated run, the code says no
    const deps = await runtime.buildDeps(sent.run.id, "w");
    expect(deps.bot.allowedTools).toEqual(expect.arrayContaining(["delegate", "team_recall"]));
    await runtime.db.sql`update runs set origin = 'delegation' where id = ${sent.run.id}`;
    expect((await runtime.buildDeps(sent.run.id, "w")).bot.allowedTools).not.toContain("delegate");
    await runtime.close();
  });

  it("the Tutor keeps its own approvals: the card goes to the user, and the result returns only after the user decides", async () => {
    const { runtime, principal, tutor } = await open();
    await runtime.vault.set("TUTOR_TOKEN", "valor-secreto-do-tutor-123", {
      description: "token do tutor",
    });
    await runtime.vault.grant("TUTOR_TOKEN", tutor.id);
    const sent = await delegateFlow(runtime, principal);
    const delegated = (
      await runtime.db.sql<{ id: string }[]>`select id from runs where bot_id = ${tutor.id}`
    )[0]?.id as string;
    // make the delegated run use the script that needs an approval
    await runtime.db
      .sql`update runs set objective = ${"Use o segredo do tutor (delegado)"} where id = ${delegated}`;
    expect(await work(runtime, delegated)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, {
      runId: delegated,
      status: "pending",
      limit: 5,
    });
    expect(card).toMatchObject({ tool: "shell", level: "external_irreversible" });
    expect(
      (await texts(runtime, sent.message.conversationId)).filter((t) => t.includes("terminou")),
    ).toEqual([]);
    await decideApproval(runtime.db, card?.id as string, { decision: "approved" });
    expect(await work(runtime, delegated)).toBe("done");
    expect(
      (await texts(runtime, sent.message.conversationId)).some((t) =>
        t.includes("Tutor terminou a tarefa que pedi: Feito com o token."),
      ),
    ).toBe(true);
    await runtime.close();
  });

  it("a delegated run that fails or is cancelled is reported too", async () => {
    const { runtime, principal, tutor } = await open();
    const sent = await delegateFlow(runtime, principal);
    const delegated = (
      await runtime.db.sql<{ id: string }[]>`select id from runs where bot_id = ${tutor.id}`
    )[0]?.id as string;
    await setRunStatus(runtime.db, delegated, { from: "queued", to: "cancelled" });
    await reconcileRunEffects(runtime.db);
    expect((await texts(runtime, sent.message.conversationId)).at(-1)).toContain(
      "foi cancelada antes de terminar",
    );
    await runtime.close();
  });

  it("at most 3 delegations are open at once, and a bot in the middle of a conversation is refused", async () => {
    const { runtime, principal } = await open();
    await runtime.db
      .sql`update runs set status = 'cancelled', finished_at = now() where origin = 'delegation'`;
    const parent = await createRun(runtime.db, {
      botId: principal.id,
      origin: "user",
      objective: "x",
    });
    const { delegateTool } = await import("../src/index.js");
    const tool = delegateTool(runtime.db);
    const bots: Bot[] = [];
    for (const name of ["A1", "A2", "A3", "A4"]) {
      bots.push(await createBot(runtime.db, { name, modelProvider: "script", modelId: "model-s" }));
    }
    const give = (to: string) =>
      tool.execute(
        {
          bot: to,
          objective: `Fazer a coisa de ${to} agora mesmo.`,
          acceptanceCriteria: ["feito"],
        },
        { runId: parent.id, botId: principal.id } as never,
      );
    for (const to of ["A1", "A2", "A3"]) expect((await give(to)).isError).toBeUndefined();
    const fourth = await give("A4");
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toContain("3 delegações");
    // a bot in the middle of a conversation with the user
    const conv = await createDirectConversation(runtime.db, (bots[3] as Bot).id);
    await createRun(runtime.db, {
      botId: (bots[3] as Bot).id,
      conversationId: conv.id,
      origin: "user",
      objective: "oi",
    });
    await runtime.db
      .sql`update runs set status = 'cancelled', finished_at = now() where origin = 'delegation'`;
    const busy = await give("A4");
    expect(busy.isError).toBe(true);
    expect(busy.content).toContain("no meio de uma conversa");
    await runtime.close();
  });
});
