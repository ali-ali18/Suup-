import { randomUUID } from "node:crypto";
import { type Bot, createBot, createRun, type Db, type Run, type RunStatus } from "../src/index.js";

let botCache = new WeakMap<Db, Promise<Bot>>();

/** One bot per database handle, shared by the runs a test file creates. */
export function botFor(db: Db): Promise<Bot> {
  let bot = botCache.get(db);
  if (bot === undefined) {
    bot = createBot(db, { name: "test bot", modelProvider: "fake", modelId: "fake-1" });
    botCache.set(db, bot);
  }
  return bot;
}

export function resetBotCache(): void {
  botCache = new WeakMap();
}

export interface NewRun {
  objective?: string;
  acceptanceCriteria?: string[];
  status?: RunStatus;
  /** Lease the run to this worker (only meaningful for `running`). */
  leasedTo?: string;
  /** Pretend the lease was last renewed this long ago. */
  leaseAgeMs?: number;
}

/** A run in any status, made directly (not through a claim), for tests that need a given state. */
export async function makeRun(db: Db, input: NewRun = {}): Promise<Run> {
  const bot = await botFor(db);
  const run = await createRun(db, {
    botId: bot.id,
    origin: "user",
    objective: input.objective ?? "Do the task.",
    ...(input.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: input.acceptanceCriteria }),
  });
  const status = input.status ?? "queued";
  if (status === "queued") return run;
  await db.sql`
    update runs set
      status = ${status},
      started_at = now(),
      locked_by = ${input.leasedTo ?? null},
      locked_at = ${
        input.leasedTo === undefined ? null : new Date(Date.now() - (input.leaseAgeMs ?? 0))
      }
    where id = ${run.id}`;
  return { ...run, status };
}

export const uniqueWorkerId = (): string => `worker-${randomUUID().slice(0, 8)}`;

/** Polls `check` until it is true; fails after `timeoutMs`. */
export async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
