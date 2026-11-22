import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, until, useWorld } from "./world.js";

// What a client reads must never contradict itself: a run that says "done", "waiting_user" or
// "waiting_timer" already has the bot's message of that moment in its conversation. The harness
// writes the message in the same transaction that sets the status; here a reader hammers the
// database while runs park and finish, and asserts the pair at every single snapshot.

const usage = { inputTokens: 500, outputTokens: 50 };
const s = <T extends object>(step: T) => ({ ...step, usage });
const schedule = (note: string) => ({ name: "schedule_return", args: { inMinutes: 1, note } });

const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-VOLTAS",
        agent: [
          s({ calls: [schedule("Primeira conferência.")] }),
          s({ text: "Volto em 1 minuto." }),
          s({ calls: [schedule("Segunda conferência.")] }),
          s({ text: "Ainda rodando; volto em 1 minuto." }),
          s({ text: "Agora sim, terminou." }),
        ],
      },
      {
        whenObjectiveContains: "CASE-PERGUNTA",
        agent: [
          s({ calls: [{ name: "escalate", args: { question: "Qual cor você prefere?" } }] }),
          s({ text: "Azul, então." }),
        ],
      },
    ],
  },
  outro: { agent: [] },
};

interface Snapshot {
  id: string;
  status: string;
  waitMessages: number;
  parks: number;
  questionMessages: number;
  questions: number;
  doneMessages: number;
}

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the bot's message and the run's status are written together"),
  { timeout: 120_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS, wakeEveryMs: 50 });

    it("no reader sees a parked or finished run without the bot's message", async () => {
      const { api } = w.started;
      // Each bot has one conversation: one bot per run.
      const newConversation = async (name: string) => {
        const bot = await api.bots.create({ name, modelId: "model-x", allowedTools: ["shell"] });
        return api.bots.openConversation(bot.id);
      };
      const runIds: string[] = [];
      const conversations = new Map<string, string>();
      for (let i = 0; i < 4; i++) {
        const conversation = await newConversation(`Volta ${i}`);
        const sent = await api.conversations.send(conversation.id, "CASE-VOLTAS vá e volte");
        runIds.push(sent.run.id);
        conversations.set(sent.run.id, conversation.id);
      }
      for (let i = 0; i < 4; i++) {
        const conversation = await newConversation(`Pergunta ${i}`);
        const sent = await api.conversations.send(conversation.id, "CASE-PERGUNTA pergunte");
        runIds.push(sent.run.id);
        conversations.set(sent.run.id, conversation.id);
      }

      // One statement is one snapshot: the status and the messages are read at the same instant.
      const snapshot = async (): Promise<Snapshot[]> =>
        w.db.sql<Snapshot[]>`
          select r.id, r.status,
            (select count(*)::int from messages m
              where m.run_id = r.id and starts_with(m.dedupe_key, 'run:' || r.id || ':wait:')) as "waitMessages",
            (select count(*)::int from run_events e
              where e.run_id = r.id and e.type = 'status_changed' and e.payload->>'to' = 'waiting_timer') as parks,
            (select count(*)::int from messages m
              where m.run_id = r.id and starts_with(m.dedupe_key, 'run:' || r.id || ':question:')) as "questionMessages",
            (select count(*)::int from run_events e
              where e.run_id = r.id and e.type = 'escalated') as questions,
            (select count(*)::int from messages m
              where m.run_id = r.id and m.dedupe_key = 'run:' || r.id || ':done') as "doneMessages"
          from runs r where r.id = any(${runIds}::uuid[])`;

      const seen = { parked: 0, asked: 0, done: 0 };
      // What the reader has checked: the driver moves a run on only after that, so every parked and
      // asking state is read at least once.
      const checkedParks = new Map<string, number>();
      const checkedAsking = new Set<string>();
      const violations: string[] = [];
      const check = (row: Snapshot) => {
        if (row.status === "waiting_timer") {
          seen.parked++;
          checkedParks.set(row.id, row.parks);
          if (row.waitMessages !== row.parks) violations.push(`parked: ${JSON.stringify(row)}`);
        } else if (row.status === "waiting_user") {
          seen.asked++;
          checkedAsking.add(row.id);
          if (row.questionMessages < 1 || row.questionMessages !== row.questions) {
            violations.push(`asking: ${JSON.stringify(row)}`);
          }
        } else if (row.status === "done") {
          seen.done++;
          if (row.doneMessages !== 1) violations.push(`done: ${JSON.stringify(row)}`);
        }
      };

      // The driver moves the runs along (wakes the parked ones, answers the questions) while the
      // reader below never stops reading.
      let driving = true;
      const answered = new Set<string>();
      const woken = new Map<string, number>();
      const driver = (async () => {
        while (driving) {
          for (const row of await snapshot()) {
            const parks = checkedParks.get(row.id) ?? 0;
            if (row.status === "waiting_timer" && (woken.get(row.id) ?? 0) < parks) {
              woken.set(row.id, parks);
              await w.db
                .sql`update runs set wake_at = now() - interval '1 minute' where id = ${row.id} and status = 'waiting_timer'`;
            }
            if (
              row.status === "waiting_user" &&
              checkedAsking.has(row.id) &&
              !answered.has(row.id)
            ) {
              answered.add(row.id);
              await api.conversations.send(conversations.get(row.id) as string, "Azul");
            }
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      })();

      try {
        await until(async () => {
          const rows = await snapshot();
          for (const row of rows) check(row);
          return rows.every((r) => r.status === "done") ? true : undefined;
        }, "every run to finish");
      } finally {
        driving = false;
        await driver;
      }

      expect(violations).toEqual([]);
      // The reader did see the moments it checks (they last until the driver moves on).
      expect(seen.parked).toBeGreaterThan(0);
      expect(seen.asked).toBeGreaterThan(0);
      expect(seen.done).toBeGreaterThan(0);
    });
  },
);
