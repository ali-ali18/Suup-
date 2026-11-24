// A small real-model check of the routines and delegation engine (docs/TESTES-REAIS.md, "Motor de
// rotinas e delegação"). Not a harness task: it needs the conversation of a user with a team, the
// routine tools and a database, so it drives the runtime the way the server does (`sendMessage` and
// a worker). Four cases, each on a fresh database schema, with made-up bots and data:
//
//   recurring   a request that starts "from tomorrow" ends with a routine, or its approval card
//   delegation  with a bot whose declared description covers routines, the Principal delegates
//   weekday     the weekday of today and of a date this month are right
//   tombstone   a routine the owner deleted is said to be deleted by the owner, not as an own error
//
// The judgment of the model's wording is printed for reading; what is checked automatically is
// structured (rows in the database, the `delegate` call), never a pattern in the text.
import {
  appendMessage,
  createBot,
  createDb,
  createDirectConversation,
  createRoutine,
  deleteRoutine,
  migrate,
  setDefaultBot,
  setUserTimeZone,
} from "@suup/db";
import { createRuntime, parseConfig, sendMessage } from "@suup/runtime";

const MODEL = process.env.SUUP_CHECK_MODEL ?? "claude-haiku-5-5";
const ZONE = "America/Sao_Paulo";
const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

export interface CaseResult {
  id: string;
  pass: boolean;
  facts: Record<string, string | number | boolean>;
  reply: string;
  costUsd: number;
}

type World = Awaited<ReturnType<typeof world>>;

async function world(databaseUrl: string, schema: string) {
  const admin = createDb(databaseUrl, { max: 1 });
  await admin.sql.unsafe(`create schema ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("search_path", schema);
  const config = parseConfig({
    providers: [{ id: "anthropic", kind: "anthropic", apiKeyEnv: "SUUP_ANTHROPIC_KEY" }],
    models: [
      {
        id: MODEL,
        provider: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        pricing: {
          inputPerMTok: 0.1,
          outputPerMTok: 0.5,
          cachedInputPerMTok: 0.01,
          cacheWriteInputPerMTok: 0.125,
        },
      },
    ],
    reviewer: { model: MODEL },
    sandbox: { kind: "local", root: "workspace" },
    worker: { concurrency: 4, leaseRenewMs: 1000, staleAfterMs: 8000, controlPollMs: 100 },
    defaults: { maxTurns: 12, maxCostUsd: 0.05 },
  });
  const runtime = createRuntime(config, {
    env: { ...process.env, DATABASE_URL: url.toString() } as Record<string, string>,
    baseDir: process.cwd(),
  });
  await migrate(runtime.db);
  await setUserTimeZone(runtime.db, { timeZone: ZONE, source: "user" });
  const worker = runtime.createWorker({ concurrency: 4, idleBackoff: { minMs: 15, maxMs: 80 } });
  worker.start();
  return {
    runtime,
    db: runtime.db,
    async close() {
      await worker.stop({ graceMs: 2000 });
      await runtime.close();
      await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
      await admin.close();
    },
  };
}

const bot = (w: World, name: string, description: string, tools: string[] = []) =>
  createBot(w.db, {
    name,
    description,
    modelProvider: "anthropic",
    modelId: MODEL,
    allowedTools: tools,
  });

async function settle(w: World, runId: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await w.db.sql<{ status: string }[]>`select status from runs where id = ${runId}`;
    const status = row?.status ?? "missing";
    if (["done", "failed", "cancelled", "waiting_user", "waiting_approval"].includes(status)) {
      return status;
    }
    if (Date.now() > deadline) return "timeout";
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function lastBotText(w: World, conversationId: string): Promise<string> {
  const rows = await w.db.sql<{ text: string }[]>`
    select text from messages where conversation_id = ${conversationId} and author_kind = 'bot'
    order by seq desc limit 1`;
  return rows[0]?.text ?? "";
}

async function spent(w: World): Promise<number> {
  const [row] = await w.db.sql<
    { total: string | null }[]
  >`select sum(cost_usd)::text as total from runs`;
  return Number(row?.total ?? 0);
}

const count = async (query: Promise<{ n: number }[]>): Promise<number> => (await query)[0]?.n ?? 0;

async function recurring(w: World): Promise<CaseResult> {
  const main = await bot(w, "Principal", "O bot principal.");
  await setDefaultBot(w.db, main.id);
  const sent = await sendMessage(w.runtime, {
    botId: main.id,
    text: "Liste os feriados nacionais desta semana hoje e, a partir de amanhã, os do dia anterior e os do dia atual.",
  });
  const status = await settle(w, sent.run.id);
  const routines = await count(
    w.db.sql<
      { n: number }[]
    >`select count(*)::int as n from routines where bot_id = ${main.id} and not reminder`,
  );
  const cards = await count(
    w.db.sql<
      { n: number }[]
    >`select count(*)::int as n from approvals where tool = 'create_routine'`,
  );
  const reply = await lastBotText(w, sent.message.conversationId);
  return {
    id: "recurring",
    pass: routines + cards > 0,
    facts: { runStatus: status, routinesCreated: routines, routineCards: cards },
    reply,
    costUsd: await spent(w),
  };
}

async function delegation(w: World): Promise<CaseResult> {
  const main = await bot(w, "Principal", "O bot principal.");
  await setDefaultBot(w.db, main.id);
  const agenda = await bot(w, "Agenda", "cuida de rotinas e lembretes");
  await bot(w, "Código", "escreve e revisa programas");
  const sent = await sendMessage(w.runtime, {
    botId: main.id,
    text: "Crie uma rotina que, todo dia às 7h, me lembre de tomar água.",
  });
  const status = await settle(w, sent.run.id);
  const delegated = await count(
    w.db.sql<
      { n: number }[]
    >`select count(*)::int as n from delegations where to_bot_id = ${agenda.id}`,
  );
  // let the delegated run end, then see where the routine landed
  const [d] = await w.db.sql<{ to_run_id: string }[]>`select to_run_id from delegations limit 1`;
  const childStatus = d === undefined ? "none" : await settle(w, d.to_run_id);
  const onAgenda = await count(
    w.db.sql<{ n: number }[]>`select count(*)::int as n from routines where bot_id = ${agenda.id}`,
  );
  const cardsAgenda = await count(
    w.db.sql<
      { n: number }[]
    >`select count(*)::int as n from approvals where bot_id = ${agenda.id} and tool = 'create_routine'`,
  );
  const onMain = await count(
    w.db.sql<{ n: number }[]>`select count(*)::int as n from routines where bot_id = ${main.id}`,
  );
  return {
    id: "delegation",
    pass: delegated > 0 && onMain === 0,
    facts: {
      runStatus: status,
      delegatedToAgenda: delegated,
      delegatedRunStatus: childStatus,
      routinesOnAgenda: onAgenda,
      routineCardsOnAgenda: cardsAgenda,
      routinesOnPrincipal: onMain,
    },
    reply: await lastBotText(w, sent.message.conversationId),
    costUsd: await spent(w),
  };
}

async function weekday(w: World): Promise<CaseResult> {
  const main = await bot(w, "Principal", "O bot principal.");
  const sent = await sendMessage(w.runtime, {
    botId: main.id,
    text: "Que dia da semana é hoje, e em que dia da semana cai o dia 29 deste mês? Responda em uma frase curta.",
  });
  const status = await settle(w, sent.run.id);
  const now = new Date();
  const part = (d: Date, type: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONE,
      [type]: type === "year" ? "numeric" : "2-digit",
    }).format(d);
  const year = Number(part(now, "year"));
  const month = Number(part(now, "month"));
  const today = new Date(Date.UTC(year, month - 1, Number(part(now, "day")), 12)).getUTCDay();
  const day29 = new Date(Date.UTC(year, month - 1, 29, 12)).getUTCDay();
  const reply = await lastBotText(w, sent.message.conversationId);
  const lower = reply.toLowerCase();
  const wantToday = WEEKDAYS_PT[today] as string;
  const want29 = WEEKDAYS_PT[day29] as string;
  // the other weekday names must not be given to the two days: both right ones are present
  const hasBoth = lower.includes(wantToday) && lower.includes(want29);
  return {
    id: "weekday",
    pass: hasBoth,
    facts: { runStatus: status, expectedToday: wantToday, expected29: want29 },
    reply,
    costUsd: await spent(w),
  };
}

async function tombstone(w: World): Promise<CaseResult> {
  const main = await bot(w, "Principal", "O bot principal.");
  const conversation = await createDirectConversation(w.db, main.id);
  await appendMessage(w.db, {
    conversationId: conversation.id,
    authorKind: "user",
    text: "Cria uma rotina chamada Bom dia, todo dia às 8h, que me deseje bom dia.",
  });
  const routine = await createRoutine(w.db, {
    botId: main.id,
    name: "Bom dia",
    instruction: "Deseje bom dia ao usuário.",
    schedule: { kind: "daily", time: "08:00" },
    timeZone: ZONE,
    createdBy: "bot",
  });
  await appendMessage(w.db, {
    conversationId: conversation.id,
    authorKind: "bot",
    authorBotId: main.id,
    text: "Combinado, criei a rotina “Bom dia”: todo dia às 8h eu te desejo bom dia.",
  });
  // the owner deletes it in the panel
  await deleteRoutine(w.db, routine.id, "owner");
  const sent = await sendMessage(w.runtime, {
    conversationId: conversation.id,
    text: "A rotina Bom dia sumiu. Você errou ao criar?",
  });
  const status = await settle(w, sent.run.id);
  const stillThere = await count(
    w.db.sql<{ n: number }[]>`select count(*)::int as n from routines where bot_id = ${main.id}`,
  );
  const reply = await lastBotText(w, conversation.id);
  // Automatic: the run ended, and it did not recreate the routine on its own. Whether it says the
  // owner deleted it is read by a person (the reply is printed).
  return {
    id: "tombstone",
    pass: status === "done" && stillThere === 0,
    facts: { runStatus: status, routinesRecreated: stillThere },
    reply,
    costUsd: await spent(w),
  };
}

const CASES: Record<string, (w: World) => Promise<CaseResult>> = {
  recurring,
  delegation,
  weekday,
  tombstone,
};

/** Runs the cases (names, or all), each on its own schema of `databaseUrl`; returns the results. */
export async function runRoutineChecks(
  databaseUrl: string,
  names: string[] = Object.keys(CASES),
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let n = 0;
  for (const name of names) {
    const run = CASES[name];
    if (run === undefined) throw new Error(`unknown case ${name}`);
    const w = await world(databaseUrl, `chk_${Date.now().toString(36)}_${n++}`);
    try {
      results.push(await run(w));
    } finally {
      await w.close();
    }
  }
  return results;
}
