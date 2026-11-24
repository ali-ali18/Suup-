import type { Routine } from "@suup/api";
import { defineTool } from "@suup/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// Routines through the API, with a scripted model (docs/ROTINAS.md): the user asks in the chat, the
// bot creates the routine (the reviewer of Auto-review lets it run, "Perguntar tudo" makes a card),
// the time is forced due in the database, the worker fires it once: a fresh run of origin `routine`
// whose answer lands in the bot's chat. Plus: overlap is skipped, missed times catch up once.
//
// The server process is in UTC and the user in Sao Paulo: "todo dia às 08:00" is 11:00 UTC.
process.env.TZ = "UTC";

const usage = { inputTokens: 300, outputTokens: 40 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const verdict = (decision: string, reason: string) =>
  s({ calls: [{ name: "review_call", args: { decision, ruleId: null, reason } }] });
const daily8 = { kind: "daily" as const, time: "08:00" };
const createCall = (marker: string) => ({
  name: "create_routine",
  args: {
    name: "Calendário da manhã",
    instruction: `${marker} Veja meu calendário de hoje e me diga o que tenho.`,
    schedule: daily8,
  },
});

// The reminder of the owner's report: a daily routine with an end date a year from now.
const lembreteUntil = `${new Date().getUTCFullYear() + 1}-11-30`;
const lembreteCall = {
  name: "create_routine",
  args: {
    name: "Lembrete: trabalhos e prova",
    instruction: "Lembre o usuário dos trabalhos de POO e Teologia e das provas.",
    schedule: { kind: "daily", time: "20:00", until: lembreteUntil },
  },
};

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        // The second message of the chat: the model, seeing only the text of its earlier answer,
        // "corrects" itself and calls create_routine again with the same routine (the owner's case).
        whenObjectiveContains: "LEMBRETE-2",
        agent: [
          s({ text: "(o passo 0 é a resposta da primeira mensagem, no histórico)" }),
          s({ calls: [lembreteCall] }),
          s({ text: "O lembrete já está criado: todo dia às 20:00." }),
        ],
        autoReview: [verdict("run", "Você pediu este lembrete.")],
      },
      {
        whenObjectiveContains: "LEMBRETE-1",
        agent: [
          s({ calls: [lembreteCall] }),
          s({ text: "Combinado! Criei um lembrete todo dia às 20:00." }),
        ],
        autoReview: [verdict("run", "Você pediu este lembrete.")],
      },
      {
        whenObjectiveContains: "CRIAR-AUTO",
        agent: [
          s({ calls: [createCall("ROTINA-CAL")] }),
          s({ text: "Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?" }),
        ],
        autoReview: [verdict("run", "Você pediu esta rotina.")],
      },
      {
        whenObjectiveContains: "CRIAR-ASK",
        agent: [
          s({ calls: [createCall("ROTINA-ASK")] }),
          s({ text: "Combinado, todo dia às 8h." }),
        ],
        autoReview: [verdict("run", "Não devia ser usado: Perguntar tudo.")],
      },
      {
        whenObjectiveContains: "ROTINA-CAL",
        agent: [
          s({ calls: [{ name: "update_routine_state", args: { state: "Avisei do dentista." } }] }),
          s({ text: "Hoje você tem dentista às 15h." }),
        ],
      },
      {
        whenObjectiveContains: "ROTINA-LENTA",
        agent: [s({ text: "Terminei a rotina lenta.", delayMs: 2500 })],
      },
      {
        whenObjectiveContains: "ROTINA-PERDIDA",
        agent: [s({ text: "Recuperei a rotina perdida." })],
      },
      {
        // The reviewer of the edit asked in the chat (the agent is the other provider).
        whenObjectiveContains: "MUDA-7H",
        agent: [],
        autoReview: [verdict("run", "Você pediu para mudar esta rotina.")],
      },
      {
        whenObjectiveContains: "ROTINA-FONTE",
        agent: [
          s({ calls: [{ name: "ler_pagina_teste", args: {} }] }),
          s({ text: "## Agenda\n\n- **15h** dentista" }),
        ],
      },
      {
        whenObjectiveContains: "ROTINA-CARTAO",
        agent: [
          s({ calls: [{ name: "shell", args: { command: "echo da-rotina" } }] }),
          s({ text: "Rodei o comando da rotina." }),
        ],
        autoReview: [verdict("ask", "Uma rotina não é você pedindo agora.")],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("routines through the API"), { timeout: 90_000 }, () => {
  const w = useWorld({
    scripts: SCRIPTS,
    routinesEveryMs: 100,
    config: {
      approvals: { levels: { shell: "write_reversible" }, autoReview: { model: "model-x" } },
    },
  });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "no error",
      (error: { code?: string }) => error.code ?? String(error),
    );
  const finished = (runId: string) =>
    until(async () => {
      const run = await w.started.api.runs.get(runId);
      return run.status === "done" || run.status === "failed" ? run : undefined;
    }, "the run to end");
  /** The scheduled time, forced into the past: the worker's next pass fires it. */
  const forceDue = async (routineId: string) => {
    await w.db
      .sql`update routines set next_run_at = now() - interval '1 second' where id = ${routineId}`;
  };
  const firesOf = (routineId: string) => w.started.api.routines.fires(routineId);

  it("the user's time zone: unknown at first (never the server's), then the device's", async () => {
    const { api } = w.started;
    expect(await api.info()).toEqual({
      timeZone: null,
      timeZoneSource: null,
      oauthCallback: "loopback",
    });
    expect(
      await api.userSettings.update({ timeZone: "America/Sao_Paulo", source: "device" }),
    ).toEqual({ timeZone: "America/Sao_Paulo", timeZoneSource: "device" });
    expect(await api.info()).toEqual({
      timeZone: "America/Sao_Paulo",
      timeZoneSource: "device",
      oauthCallback: "loopback",
    });
    expect(await code(api.userSettings.update({ timeZone: "Marte/Olympus", source: "user" }))).toBe(
      "invalid_request",
    );
  });

  it("asked in the chat, created by the bot (auto-review lets it), fired once in its own run", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Agenda", modelId: "model-x" });
    const conversation = await api.bots.openConversation(bot.id);
    const sent = await api.conversations.send(
      conversation.id,
      "CRIAR-AUTO vê meu calendário todo dia",
    );
    expect((await finished(sent.run.id)).status).toBe("done");
    const [routine, ...others] = await api.routines.list({ botId: bot.id });
    expect(others).toEqual([]);
    expect(routine).toMatchObject({
      name: "Calendário da manhã",
      schedule: daily8,
      timeZone: "America/Sao_Paulo",
      status: "active",
      createdBy: "bot",
      lastFire: null,
    });
    // 08:00 in Sao Paulo is 11:00 UTC, whatever the server's zone
    expect(routine?.nextRunAt?.endsWith("T11:00:00.000Z")).toBe(true);
    expect(await api.approvals.list({ runId: sent.run.id })).toEqual([]);
    // The final message is written just after the run's status changes: wait for it.
    const said = await until(async () => {
      const texts = (await api.conversations.messages(conversation.id)).items.map((m) => m.text);
      return texts.length >= 2 ? texts : undefined;
    }, "the bot's answer");
    expect(said).toContain("Combinado, vejo seu calendário todo dia às 8h. Quer outro horário?");

    const id = (routine as Routine).id;
    await forceDue(id);
    const [fire] = await until(async () => {
      const fires = await firesOf(id);
      return fires[0]?.status === "done" ? fires : undefined;
    }, "the fire to end");
    expect(fire).toMatchObject({ kind: "scheduled", missedCount: 0, status: "done" });
    expect(fire?.resultText).toBe("Hoje você tem dentista às 15h.");
    // the run: fresh, origin routine, outside any conversation, told what fired it
    const run = await api.runs.get(fire?.runId as string);
    expect(run).toMatchObject({ origin: "routine", conversationId: null, status: "done" });
    const events = (await api.runs.events(run.id, { limit: 500 })).items;
    const loaded = events.find((e) => e.type === "context_loaded")?.payload as {
      routine?: { id: string; name: string; schedule: string; state: string };
      now?: { timeZone: string };
    };
    expect(loaded.routine).toMatchObject({
      id,
      name: "Calendário da manhã",
      schedule: "todo dia às 08:00",
      state: "",
    });
    expect(loaded.now?.timeZone).toBe("America/Sao_Paulo");
    // the answer is in the bot's chat, marked with the routine, once
    const result = await until(async () => {
      const found = (await api.conversations.messages(conversation.id)).items.filter(
        (m) => m.routineId === id,
      );
      return found.length > 0 ? found : undefined;
    }, "the routine's answer in the chat");
    expect(result.map((m) => [m.text, m.id])).toEqual([[fire?.resultText, fire?.messageId]]);
    // the note it kept, and the next time moved on
    const after = await api.routines.get(id);
    expect(after.state).toBe("Avisei do dentista.");
    expect(after.lastFire?.id).toBe(fire?.id);
    expect(new Date(after.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("a second run knows the routine an earlier run created: listed in its prompt, a duplicate is refused", async () => {
    const { api } = w.started;
    await api.userSettings.update({ timeZone: "America/Sao_Paulo", source: "device" });
    const bot = await api.bots.create({ name: "Estudo", modelId: "model-x" });
    const conversation = await api.bots.openConversation(bot.id);
    const first = await api.conversations.send(conversation.id, "LEMBRETE-1 me lembra das provas");
    expect((await finished(first.run.id)).status).toBe("done");
    const [created, ...none] = await api.routines.list({ botId: bot.id });
    expect(none).toEqual([]);
    expect(created).toMatchObject({ name: "Lembrete: trabalhos e prova", status: "active" });
    await until(async () => {
      const items = (await api.conversations.messages(conversation.id)).items;
      return items.length >= 2 ? items : undefined;
    }, "the first answer");

    const second = await api.conversations.send(conversation.id, "LEMBRETE-2 pesquisa a PUC");
    expect((await finished(second.run.id)).status).toBe("done");
    // only ONE routine: the second create_routine was refused as a duplicate
    const routines = await api.routines.list({ botId: bot.id });
    expect(routines.map((r) => r.id)).toEqual([created?.id]);
    const events = (await api.runs.events(second.run.id, { limit: 500 })).items;
    // the run started knowing its routines (recorded once, for resume and replay)
    expect(events.find((e) => e.type === "context_loaded")?.payload).toMatchObject({
      ownRoutines: {
        items: [
          {
            id: created?.id,
            name: "Lembrete: trabalhos e prova",
            schedule: `todo dia às 20:00, até 30/11/${lembreteUntil.slice(0, 4)}`,
            timeZone: "America/Sao_Paulo",
            status: "active",
          },
        ],
        more: 0,
      },
    });
    const request = events.find((e) => e.type === "model_request")?.payload as { system: string };
    expect(request.system).toContain("## Your routines");
    expect(request.system).toContain(
      `- "Lembrete: trabalhos e prova": todo dia às 20:00, até 30/11/${lembreteUntil.slice(0, 4)} (America/Sao_Paulo); active; id ${created?.id}`,
    );
    const call = events.find((e) => e.type === "tool_call")?.payload as { callId: string };
    const result = events.find(
      (e) => e.type === "tool_result" && (e.payload as { callId: string }).callId === call.callId,
    )?.payload as { isError: boolean; content: string };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("you already have this routine");
  });

  it("in 'Perguntar tudo', creating a routine is a card in Portuguese; approving creates it", async () => {
    const { api } = w.started;
    await api.approvalSettings.update({ mode: "ask_all" });
    try {
      const bot = await api.bots.create({ name: "Agenda 2", modelId: "model-x" });
      const conversation = await api.bots.openConversation(bot.id);
      const sent = await api.conversations.send(conversation.id, "CRIAR-ASK todo dia");
      const card = await until(async () => {
        const [pending] = await api.approvals.list({ runId: sent.run.id, status: "pending" });
        return pending;
      }, "the card");
      expect(card.tool).toBe("create_routine");
      expect(card.summary).toBe(
        "Criar uma rotina: ROTINA-ASK Veja meu calendário de hoje e me diga o que tenho. — todo dia às 08:00",
      );
      expect(await api.routines.list({ botId: bot.id })).toEqual([]);
      await api.approvals.decide(card.id, { decision: "approve" });
      expect((await finished(sent.run.id)).status).toBe("done");
      expect((await api.routines.list({ botId: bot.id })).map((r) => r.status)).toEqual(["active"]);
    } finally {
      await api.approvalSettings.update({ mode: "auto_review" });
    }
  });

  it("overlap: while the previous run goes on, the next time is skipped and recorded", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Lento", modelId: "model-x" });
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Lenta",
      instruction: "ROTINA-LENTA faça devagar",
      schedule: { kind: "interval", every: 5, unit: "minutes" },
    });
    expect(routine.createdBy).toBe("user");
    await forceDue(routine.id);
    const running = await until(async () => {
      const [f] = await firesOf(routine.id);
      return f !== undefined ? f : undefined;
    }, "the first fire");
    expect(running.status).toBe("running");
    expect(await code(api.routines.run(routine.id))).toBe("conflict");
    await forceDue(routine.id);
    const fires = await until(async () => {
      const all = await firesOf(routine.id);
      return all.length >= 2 ? all : undefined;
    }, "the second fire");
    expect(fires[0]).toMatchObject({ status: "skipped", skipReason: "overlap", runId: null });
    await finished(running.runId as string);
    const done = await until(async () => {
      const all = await firesOf(routine.id);
      return all.find((f) => f.id === running.id && f.status === "done");
    }, "the first fire to end");
    expect(done.resultText).toBe("Terminei a rotina lenta.");
    // "Rodar agora" works again once nothing is running
    const manual = await api.routines.run(routine.id);
    expect(manual).toMatchObject({ kind: "manual", status: "running" });
    await finished(manual.runId as string);
  });

  it("missed times while off: one catch-up for the latest, the older ones counted", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Recupera", modelId: "model-x" });
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Perdida",
      instruction: "ROTINA-PERDIDA veja",
      schedule: daily8,
    });
    // the most recent 08:00 in Sao Paulo (11:00 UTC) that passed, and three days before it
    const now = new Date();
    const last = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0),
    );
    if (last.getTime() > now.getTime()) last.setUTCDate(last.getUTCDate() - 1);
    const threeBefore = new Date(last.getTime() - 3 * 24 * 3_600_000);
    await w.db.sql`update routines set next_run_at = ${threeBefore} where id = ${routine.id}`;
    const [fire] = await until(async () => {
      const fires = await firesOf(routine.id);
      return fires[0]?.status === "done" ? fires : undefined;
    }, "the catch-up");
    expect(fire).toMatchObject({ kind: "catch_up", missedCount: 3 });
    expect(fire?.scheduledFor).toBe(last.toISOString());
    expect(await firesOf(routine.id)).toHaveLength(1);
    const run = await api.runs.get(fire?.runId as string);
    const loaded = (await api.runs.events(run.id, { limit: 500 })).items.find(
      (e) => e.type === "context_loaded",
    )?.payload as { routine?: { kind: string; missedCount: number } };
    expect(loaded.routine).toMatchObject({ kind: "catch_up", missedCount: 3 });
  });

  it("a fire is not approval: a call in a routine's run goes through the gate and waits in Pendências", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({
      name: "Comandos",
      modelId: "model-x",
      allowedTools: ["shell"],
    });
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Comando",
      instruction: "ROTINA-CARTAO rode o comando",
      schedule: daily8,
    });
    await forceDue(routine.id);
    const [fire] = await until(async () => {
      const fires = await firesOf(routine.id);
      return fires[0]?.runId ? fires : undefined;
    }, "the fire");
    const card = await until(async () => {
      const [pending] = await api.approvals.list({
        status: "pending",
        runId: fire?.runId as string,
      });
      return pending;
    }, "the card of the routine's run");
    expect(card).toMatchObject({ tool: "shell", botId: bot.id });
    const events = (await api.runs.events(fire?.runId as string, { limit: 500 })).items;
    expect(events.find((e) => e.type === "approval_review")?.payload).toMatchObject({
      decision: "ask",
      outcome: "ask",
    });
    await api.approvals.decide(card.id, { decision: "approve" });
    await finished(fire?.runId as string);
    const [after] = await until(async () => {
      const fires = await firesOf(routine.id);
      return fires[0]?.status === "done" ? fires : undefined;
    }, "the fire to record its end");
    expect(after).toMatchObject({ status: "done", resultText: "Rodei o comando da rotina." });
  });

  it("the history says what the run used: the page a tool declared it read, never text", async () => {
    const { api } = w.started;
    // A tool that declares the page it read, as web_read does (no network in a test).
    const tool = defineTool({
      name: "ler_pagina_teste",
      description: "Lê a página de teste.",
      input: z.object({}),
      risk: "read",
      execute: async () => ({
        content: "Agenda: dentista às 15h. Veja também https://so-texto.example/",
        source: { url: "https://agenda.exemplo.com.br/hoje", title: "Agenda de hoje" },
      }),
    });
    for (const runtime of [w.serverRuntime, w.workerRuntime]) {
      if (runtime.tools.get(tool.name) === undefined) runtime.tools.register(tool);
    }
    const bot = await api.bots.create({
      name: "Fontes",
      modelId: "model-x",
      allowedTools: ["ler_pagina_teste"],
    });
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Agenda",
      instruction: "ROTINA-FONTE leia a agenda",
      schedule: daily8,
    });
    await forceDue(routine.id);
    const [fire] = await until(async () => {
      const fires = await firesOf(routine.id);
      return fires[0]?.status === "done" ? fires : undefined;
    }, "the fire to end");
    expect(fire?.resultText).toBe("## Agenda\n\n- **15h** dentista");
    // only the declared page: the URL in the text is not a source
    expect(fire?.sources).toEqual([
      { kind: "web", url: "https://agenda.exemplo.com.br/hoje", title: "Agenda de hoje" },
    ]);
    // the list of routines does not carry them (only the history)
    expect((await api.routines.get(routine.id)).lastFire?.sources).toBeUndefined();
  });

  it("Editar: the message carries the routine as data, the bot reads its id and updates it", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Editora", modelId: "model-y" });
    const conversation = await api.bots.openConversation(bot.id);
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Calendário da manhã",
      instruction: "Veja meu calendário de hoje.",
      schedule: daily8,
    });
    // The scripted model answers by what it READS: only a conversation that has the routine's id
    // (which only the harness's note can carry) gets the update; anything else gets a question.
    await w.script("outro", {
      cases: [
        {
          whenObjectiveContains: routine.id,
          agent: [
            s({
              calls: [
                {
                  name: "update_routine",
                  args: { routine: routine.id, schedule: { kind: "daily", time: "07:00" } },
                },
              ],
            }),
            s({ text: "Pronto: agora é todo dia às 07:00." }),
          ],
        },
        { whenObjectiveContains: "MUDA-7H", agent: [s({ text: "Qual rotina?" })] },
      ],
    });
    const typed = "Editar a rotina “Calendário da manhã” (todo dia às 08:00): MUDA-7H muda pra 7h";
    const sent = await api.conversations.send(conversation.id, typed, {
      routineRef: { id: routine.id },
    });
    // stored with the message, never in its text
    expect(sent.message.text).toBe(typed);
    expect(sent.message.text).not.toContain(routine.id);
    expect(sent.message.routineRef).toEqual({ id: routine.id });
    expect((await finished(sent.run.id)).status).toBe("done");
    expect((await api.routines.get(routine.id)).schedule).toEqual({ kind: "daily", time: "07:00" });
    const events = (await api.runs.events(sent.run.id, { limit: 500 })).items;
    expect(events.find((e) => e.type === "context_loaded")?.payload).toMatchObject({
      routineRefs: [{ id: routine.id, name: "Calendário da manhã", schedule: "todo dia às 08:00" }],
    });
    expect(events.find((e) => e.type === "run_started")?.payload).toMatchObject({
      objective: typed,
    });
    const said = await until(async () => {
      const items = (await api.conversations.messages(conversation.id)).items;
      return items.length >= 2 ? items : undefined;
    }, "the bot's answer");
    expect(said.map((m) => m.text)).toEqual([typed, "Pronto: agora é todo dia às 07:00."]);
    expect(said.every((m) => !m.text.includes(routine.id))).toBe(true);
    expect(said[0]?.routineRef).toEqual({ id: routine.id });

    // a routine of ANOTHER bot is refused, and nothing is sent
    const other = await api.bots.create({ name: "Outra", modelId: "model-y" });
    const theirs = await api.routines.create({
      botId: other.id,
      name: "Delas",
      instruction: "x",
      schedule: daily8,
    });
    expect(
      await code(
        api.conversations.send(conversation.id, "muda", { routineRef: { id: theirs.id } }),
      ),
    ).toBe("invalid_request");
    expect((await api.conversations.messages(conversation.id)).items).toHaveLength(2);
    // deleting the routine keeps the message and drops the reference
    await api.routines.delete(routine.id);
    const [first] = (await api.conversations.messages(conversation.id)).items;
    expect(first?.text).toBe(typed);
    expect(first?.routineRef).toBeUndefined();
  });

  it("the cost cap: text, hex, exponents and more than 4 decimals are a 400; plain values are kept", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Teto", modelId: "model-x" });
    const create = (costCapUsd: unknown) =>
      api.routines.create({
        botId: bot.id,
        name: "Teto",
        instruction: "y",
        schedule: { kind: "daily", time: "08:00" },
        timeZone: "America/Sao_Paulo",
        costCapUsd: costCapUsd as never,
      });
    for (const bad of ["0x10", "0b11", "1e3", " 1", "-1", "0", "1", -1, 0, 1.1234567, 1.00001]) {
      expect(await code(create(bad)), String(bad)).toBe("invalid_request");
    }
    const routine = await create(0.5);
    expect(routine.costCapUsd).toBe("0.5000");
    expect((await api.routines.update(routine.id, { costCapUsd: 2 })).costCapUsd).toBe("2.0000");
    expect((await api.routines.update(routine.id, { costCapUsd: 1.25 })).costCapUsd).toBe("1.2500");
    expect(await code(api.routines.update(routine.id, { costCapUsd: 1.1234567 }))).toBe(
      "invalid_request",
    );
    expect((await api.routines.get(routine.id)).costCapUsd).toBe("1.2500");
  });

  it("CRUD: refuses cron text and a past date, pauses, resumes, deletes", async () => {
    const { api } = w.started;
    const bot = await api.bots.create({ name: "Crud", modelId: "model-x" });
    expect(
      await code(
        api.routines.create({
          botId: bot.id,
          name: "x",
          instruction: "y",
          schedule: { kind: "cron", expression: "0 8 * * *" } as never,
        }),
      ),
    ).toBe("invalid_request");
    expect(
      await code(
        api.routines.create({
          botId: bot.id,
          name: "x",
          instruction: "y",
          schedule: { kind: "once", date: "2020-01-01", time: "08:00" },
        }),
      ),
    ).toBe("invalid_request");
    const routine = await api.routines.create({
      botId: bot.id,
      name: "Semanal",
      instruction: "y",
      schedule: { kind: "weekly", days: ["mon", "wed"], time: "09:30" },
    });
    expect((await api.routines.update(routine.id, { paused: true })).status).toBe("paused");
    const resumed = await api.routines.update(routine.id, {
      paused: false,
      schedule: { kind: "monthly", day: 31, time: "07:00" },
    });
    expect(resumed).toMatchObject({ status: "active", schedule: { kind: "monthly", day: 31 } });
    await api.routines.delete(routine.id);
    expect(await code(api.routines.get(routine.id))).toBe("not_found");
    expect(await code(api.routines.delete(routine.id))).toBe("not_found");
  });
});
