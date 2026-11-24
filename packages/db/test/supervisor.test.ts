import { beforeEach, describe, expect, it } from "vitest";
import {
  addJournalMemory,
  addMemory,
  advanceReviewCursors,
  appendMessage,
  claimTeamReview,
  createBot,
  createDelegation,
  createDirectConversation,
  createRun,
  DelegationError,
  finishTeamReview,
  formatClockTime,
  getDelegationByRun,
  getSupervisorSettings,
  hadActivity,
  listMessages,
  localClock,
  markDelegationReturned,
  parseClockTime,
  postMorningMessage,
  readTeamMemory,
  setRunStatus,
  teamActivity,
  updateSupervisorSettings,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe("the clock of the supervisor", () => {
  it("reads and writes HH:MM and refuses anything else", () => {
    expect(parseClockTime("03:00")).toBe(180);
    expect(parseClockTime("23:59")).toBe(1439);
    for (const bad of ["3:00", "24:00", "12:60", "12-00", "ab:cd", " 1:00", "12:0", ""]) {
      expect(parseClockTime(bad)).toBeNull();
    }
    expect(formatClockTime(480)).toBe("08:00");
  });

  it("says the local date and minute in the user's time zone (and falls back to UTC)", () => {
    const instant = new Date("2026-11-21T02:30:00Z");
    expect(localClock(instant, "America/Sao_Paulo")).toEqual({
      date: "2026-11-20",
      minute: 23 * 60 + 30,
    });
    expect(localClock(instant, "Asia/Tokyo")).toEqual({ date: "2026-11-21", minute: 11 * 60 + 30 });
    expect(localClock(instant, "Not/AZone")).toEqual({ date: "2026-11-21", minute: 2 * 60 + 30 });
  });
});

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the supervisor: review record, memory reading, delegation"),
  () => {
    const ctx = useIsolatedDb();
    let n = 0;
    const newBot = (name?: string) =>
      createBot(ctx.db, { name: name ?? `b${++n}`, modelProvider: "f", modelId: "m" });
    const endRun = async (id: string) => {
      await setRunStatus(ctx.db, id, { from: "queued", to: "running" });
      await setRunStatus(ctx.db, id, { from: "running", to: "done" });
    };

    it("keeps the settings, with the defaults the owner chose and no cost cap", async () => {
      expect(await getSupervisorSettings(ctx.db)).toMatchObject({
        reviewEnabled: true,
        reviewTime: "03:00",
        morningTime: "08:00",
        costCapUsd: null,
      });
      expect(
        await updateSupervisorSettings(ctx.db, {
          reviewTime: "04:30",
          morningTime: null,
          costCapUsd: 0.25,
        }),
      ).toMatchObject({ reviewTime: "04:30", morningTime: null, costCapUsd: 0.25 });
      expect(await updateSupervisorSettings(ctx.db, { costCapUsd: null })).toMatchObject({
        costCapUsd: null,
        reviewTime: "04:30",
      });
      await expect(updateSupervisorSettings(ctx.db, { reviewTime: "25:00" })).rejects.toThrow();
      await expect(updateSupervisorSettings(ctx.db, { costCapUsd: 0 })).rejects.toThrow();
      await updateSupervisorSettings(ctx.db, { reviewTime: "03:00", morningTime: "08:00" });
    });

    describe("what the review may read", () => {
      it("reads journal, notes and open runs of the other bots only, never messages or events", async () => {
        const principal = await newBot("Principal");
        const tutor = await newBot("Tutor");
        const conversation = await createDirectConversation(ctx.db, tutor.id);
        await appendMessage(ctx.db, {
          conversationId: conversation.id,
          authorKind: "user",
          text: "TEXTO CRU DO USUARIO",
        });
        const run = await createRun(ctx.db, {
          botId: tutor.id,
          conversationId: conversation.id,
          origin: "user",
          objective: "montar o cronograma",
        });
        await ctx.db.sql`
        insert into run_events (run_id, seq, type, payload)
        values (${run.id}, 99, 'tool_result', ${ctx.db.sql.json({ content: "SAIDA DE FERRAMENTA" })})`;
        await addJournalMemory(ctx.db, {
          botId: tutor.id,
          text: "2026-11-20 · Conversa · concluída",
          sourceRunId: run.id,
        });
        await addMemory(ctx.db, {
          layer: "note",
          botId: tutor.id,
          text: "Prova de química na sexta.",
          createdBy: "bot",
        });
        await addMemory(ctx.db, {
          layer: "note",
          botId: principal.id,
          text: "nota do principal",
          createdBy: "bot",
        });
        const activity = await teamActivity(ctx.db, {
          principalBotId: principal.id,
          until: new Date(Date.now() + 1000),
        });
        expect(activity.map((a) => a.name)).not.toContain("Principal");
        const t = activity.find((a) => a.botId === tutor.id);
        expect(t?.journal.map((j) => j.text)).toEqual(["2026-11-20 · Conversa · concluída"]);
        expect(t?.notes.map((j) => j.text)).toEqual(["Prova de química na sexta."]);
        expect(hadActivity(t as NonNullable<typeof t>)).toBe(true);
        const everything = JSON.stringify(activity);
        expect(everything).not.toContain("TEXTO CRU");
        expect(everything).not.toContain("SAIDA DE FERRAMENTA");
      });

      it("moves with the cursor: what was read is not read again, and a quiet bot has no activity", async () => {
        const principal = await newBot("P2");
        const quiet = await newBot("Quieto");
        const busy = await newBot("Ocupado");
        await addMemory(ctx.db, {
          layer: "note",
          botId: busy.id,
          text: "algo novo",
          createdBy: "bot",
        });
        const until = new Date(Date.now() + 1000);
        const first = await teamActivity(ctx.db, { principalBotId: principal.id, until });
        expect(hadActivity(first.find((a) => a.botId === busy.id) as never)).toBe(true);
        expect(hadActivity(first.find((a) => a.botId === quiet.id) as never)).toBe(false);
        await advanceReviewCursors(ctx.db, [busy.id], until);
        const second = await teamActivity(ctx.db, {
          principalBotId: principal.id,
          until: new Date(until.getTime() + 1000),
        });
        expect(second.find((a) => a.botId === busy.id)?.notes).toEqual([]);
      });

      it("lists what is waiting for the user, for an approval and the scheduled returns", async () => {
        const principal = await newBot("P3");
        const bot = await newBot("Esperando");
        const conv = await createDirectConversation(ctx.db, bot.id);
        const run = await createRun(ctx.db, {
          botId: bot.id,
          conversationId: conv.id,
          origin: "user",
          objective: "preciso de uma resposta",
        });
        await setRunStatus(ctx.db, run.id, { from: "queued", to: "running" });
        await setRunStatus(ctx.db, run.id, { from: "running", to: "waiting_user" });
        const a = await teamActivity(ctx.db, {
          principalBotId: principal.id,
          until: new Date(Date.now() + 1000),
        });
        expect(a.find((x) => x.botId === bot.id)?.open).toMatchObject([
          { state: "waiting_user", objective: "preciso de uma resposta" },
        ]);
      });
    });

    describe("one review per night", () => {
      const claim = (principal: string, night: string, workerId: string, now = new Date()) =>
        claimTeamReview(ctx.db, {
          night,
          principalBotId: principal,
          workerId,
          leaseMs: 60_000,
          windowTo: now,
          costCapUsd: null,
          now,
        });

      it("two workers claim the same night: only one gets it, and a done night is not taken again", async () => {
        const principal = await newBot("PN");
        const both = await Promise.all([
          claim(principal.id, "2026-11-21", "w1"),
          claim(principal.id, "2026-11-21", "w2"),
        ]);
        expect(both.filter((r) => r !== null)).toHaveLength(1);
        const mine = both.find((r) => r !== null);
        expect(
          await finishTeamReview(ctx.db, {
            id: mine?.id as string,
            workerId: mine?.claimedBy as string,
            status: "done",
          }),
        ).toBe(true);
        expect(await claim(principal.id, "2026-11-21", "w3")).toBeNull();
        expect(await claim(principal.id, "2026-11-22", "w3")).not.toBeNull();
      });

      it("a worker that stopped loses the night after the lease, and the retry waits and has a limit", async () => {
        const principal = await newBot("PL");
        const t0 = new Date("2026-12-01T03:00:00Z");
        const first = await claim(principal.id, "2026-12-01", "w1", t0);
        expect(first).not.toBeNull();
        // still within the lease: nobody else
        expect(
          await claim(principal.id, "2026-12-01", "w2", new Date(t0.getTime() + 30_000)),
        ).toBeNull();
        // lease over: the row is marked failed, but the retry pause has not passed yet
        expect(
          await claim(principal.id, "2026-12-01", "w2", new Date(t0.getTime() + 61_000)),
        ).toBeNull();
        const retry = await claim(
          principal.id,
          "2026-12-01",
          "w2",
          new Date(t0.getTime() + 40 * 60_000),
        );
        expect(retry).not.toBeNull();
        // the old worker cannot close what it lost
        expect(
          await finishTeamReview(ctx.db, {
            id: first?.id as string,
            workerId: "w1",
            status: "done",
          }),
        ).toBe(false);
      });
    });

    describe("the morning message", () => {
      it("posts once, in the chat of the main bot, only after its welcome, and only for a done review with a text", async () => {
        const principal = await newBot("PM");
        const night = "2026-12-05";
        const review = await claimTeamReview(ctx.db, {
          night,
          principalBotId: principal.id,
          workerId: "w",
          leaseMs: 60_000,
          windowTo: new Date(),
          costCapUsd: null,
        });
        await finishTeamReview(ctx.db, {
          id: review?.id as string,
          workerId: "w",
          status: "done",
          morningText: "O Tutor espera sua resposta.",
        });
        // no chat yet: nothing is posted
        expect(await postMorningMessage(ctx.db, { night })).toBeNull();
        const conversation = await createDirectConversation(ctx.db, principal.id);
        // the welcome has not happened: the message must not take its place
        expect(await postMorningMessage(ctx.db, { night })).toBeNull();
        await ctx.db.sql`update conversations set reception = 'done' where id = ${conversation.id}`;
        const [a, b] = await Promise.all([
          postMorningMessage(ctx.db, { night }),
          postMorningMessage(ctx.db, { night }),
        ]);
        expect([a, b].filter((x) => x !== null)).toHaveLength(1);
        expect(await postMorningMessage(ctx.db, { night })).toBeNull();
        const messages = await listMessages(ctx.db, conversation.id, { limit: 10 });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          authorKind: "bot",
          authorBotId: principal.id,
          text: "O Tutor espera sua resposta.",
        });
      });

      it("posts nothing when the review had nothing useful to say", async () => {
        const principal = await newBot("PQ");
        const night = "2026-12-06";
        const review = await claimTeamReview(ctx.db, {
          night,
          principalBotId: principal.id,
          workerId: "w",
          leaseMs: 60_000,
          windowTo: new Date(),
          costCapUsd: null,
        });
        await finishTeamReview(ctx.db, {
          id: review?.id as string,
          workerId: "w",
          status: "done",
          morningText: null,
        });
        const conversation = await createDirectConversation(ctx.db, principal.id);
        await ctx.db.sql`update conversations set reception = 'done' where id = ${conversation.id}`;
        expect(await postMorningMessage(ctx.db, { night })).toBeNull();
        expect(await listMessages(ctx.db, conversation.id, { limit: 10 })).toHaveLength(0);
      });
    });

    describe("reading another bot's memory", () => {
      it("returns the notes and the journal of that bot only, filtered, and none of its rules", async () => {
        const bot = await newBot("Leitura");
        const other = await newBot("Outro");
        const run = await createRun(ctx.db, { botId: bot.id, origin: "user", objective: "x" });
        await addMemory(ctx.db, {
          layer: "note",
          botId: bot.id,
          text: "Cronograma de física montado.",
          createdBy: "bot",
        });
        await addMemory(ctx.db, {
          layer: "note",
          botId: other.id,
          text: "Cronograma do outro bot.",
          createdBy: "bot",
        });
        await addMemory(ctx.db, {
          layer: "rule",
          botId: bot.id,
          text: "Regra só deste bot.",
          createdBy: "user",
        });
        await addJournalMemory(ctx.db, {
          botId: bot.id,
          text: "2026-11-20 · concluída: física",
          sourceRunId: run.id,
        });
        const all = await readTeamMemory(ctx.db, { botId: bot.id, limit: 10 });
        expect(all.map((e) => e.text).sort()).toEqual(
          ["2026-11-20 · concluída: física", "Cronograma de física montado."].sort(),
        );
        const found = await readTeamMemory(ctx.db, {
          botId: bot.id,
          query: "cronograma",
          limit: 10,
        });
        expect(found.map((e) => e.text)).toEqual(["Cronograma de física montado."]);
        expect(
          await readTeamMemory(ctx.db, { botId: bot.id, layers: ["journal"], limit: 10 }),
        ).toHaveLength(1);
      });
    });

    describe("delegation", () => {
      // the limit counts every open delegation of the database: each test starts with none open
      beforeEach(async () => {
        await ctx.db.sql`
        update runs set status = 'cancelled', finished_at = now()
        where id in (select to_run_id from delegations) and status in ('queued', 'running')`;
      });
      const delegate = (fromRunId: string, toBotId: string, objective: string, maxOpen?: number) =>
        createDelegation(ctx.db, {
          fromRunId,
          toBotId,
          objective,
          notice: `O Principal pediu: ${objective}`,
          acceptanceCriteria: ["feito"],
          ...(maxOpen === undefined ? {} : { maxOpen }),
        });

      it("creates a delegated run in the target's own conversation, visible there, and links it", async () => {
        const principal = await newBot("PD");
        const tutor = await newBot("TutorD");
        const pConv = await createDirectConversation(ctx.db, principal.id);
        const from = await createRun(ctx.db, {
          botId: principal.id,
          conversationId: pConv.id,
          origin: "user",
          objective: "manda",
        });
        const out = await delegate(from.id, tutor.id, "montar o cronograma");
        expect(out.created).toBe(true);
        expect(out.run).toMatchObject({
          botId: tutor.id,
          origin: "delegation",
          parentRunId: from.id,
          status: "queued",
          acceptanceCriteria: ["feito"],
        });
        const tConv = await createDirectConversation(ctx.db, tutor.id);
        expect(out.run.conversationId).toBe(tConv.id);
        expect(tConv.reception).toBe("done");
        const messages = await listMessages(ctx.db, tConv.id, { limit: 10 });
        expect(messages).toMatchObject([
          { authorKind: "system", text: "O Principal pediu: montar o cronograma" },
        ]);
        expect(await getDelegationByRun(ctx.db, out.run.id)).toMatchObject({
          fromBotId: principal.id,
          toBotId: tutor.id,
          fromConversationId: pConv.id,
          returnedAt: null,
        });
      });

      it("the same delegation twice is one", async () => {
        const principal = await newBot("PI");
        const tutor = await newBot("TutorI");
        const from = await createRun(ctx.db, {
          botId: principal.id,
          origin: "user",
          objective: "x",
        });
        const a = await delegate(from.id, tutor.id, "Montar o  cronograma");
        const b = await delegate(from.id, tutor.id, "montar o cronograma");
        expect(b.created).toBe(false);
        expect(b.run.id).toBe(a.run.id);
      });

      it("refuses depth 2, itself, an archived bot, and a bot in the middle of a conversation", async () => {
        const principal = await newBot("PR");
        const tutor = await newBot("TutorR");
        const busy = await newBot("Ocupado2");
        const gone = await newBot("Arquivado");
        const from = await createRun(ctx.db, {
          botId: principal.id,
          origin: "user",
          objective: "x",
        });
        const delegated = await delegate(from.id, tutor.id, "tarefa");
        await expect(delegate(delegated.run.id, busy.id, "outra")).rejects.toMatchObject({
          code: "depth",
        });
        await expect(delegate(from.id, principal.id, "eu")).rejects.toMatchObject({ code: "self" });
        await ctx.db.sql`update bots set archived_at = now() where id = ${gone.id}`;
        await expect(delegate(from.id, gone.id, "arquivado")).rejects.toBeInstanceOf(
          DelegationError,
        );
        const conv = await createDirectConversation(ctx.db, busy.id);
        await createRun(ctx.db, {
          botId: busy.id,
          conversationId: conv.id,
          origin: "user",
          objective: "conversando",
        });
        await expect(delegate(from.id, busy.id, "ocupado")).rejects.toMatchObject({ code: "busy" });
        // the delegated bot is busy with the delegated run too: its chat has one foreground run
        await expect(delegate(from.id, tutor.id, "tarefa dois")).rejects.toMatchObject({
          code: "busy",
        });
      });

      it("limits the delegations open at once, and frees a place when one ends", async () => {
        const principal = await newBot("PL3");
        const from = await createRun(ctx.db, {
          botId: principal.id,
          origin: "user",
          objective: "x",
        });
        const bots = [await newBot("L1"), await newBot("L2"), await newBot("L3")];
        const first = await delegate(from.id, (bots[0] as { id: string }).id, "t1", 3);
        await delegate(from.id, (bots[1] as { id: string }).id, "t2", 3);
        await delegate(from.id, (bots[2] as { id: string }).id, "t3", 3);
        const extra = await newBot("L4");
        await expect(delegate(from.id, extra.id, "t4", 3)).rejects.toMatchObject({ code: "limit" });
        await endRun(first.run.id);
        expect((await delegate(from.id, extra.id, "t4", 3)).created).toBe(true);
      });

      it("marks the return once", async () => {
        const principal = await newBot("PK");
        const tutor = await newBot("TutorK");
        const from = await createRun(ctx.db, {
          botId: principal.id,
          origin: "user",
          objective: "x",
        });
        const out = await delegate(from.id, tutor.id, "k");
        await markDelegationReturned(ctx.db, out.delegation.id);
        await markDelegationReturned(ctx.db, out.delegation.id);
        expect((await getDelegationByRun(ctx.db, out.run.id))?.returnedAt).toBeInstanceOf(Date);
      });
    });
  },
);
