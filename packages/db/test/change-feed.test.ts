import { describe, expect, it } from "vitest";
import {
  addMemory,
  appendMessage,
  appendRunEvent,
  archiveBot,
  archiveMemory,
  changeChannel,
  changeLogBounds,
  claimRun,
  createBot,
  createDirectConversation,
  createRun,
  heartbeatRun,
  listChanges,
  markConversationRead,
  pruneChangeLog,
  restoreMemory,
  setRunStatus,
  updateMemory,
  withTransaction,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { until } from "./kit.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.skipIf(!DATABASE_URL)(dbSuiteName("the change log behind the realtime stream"), () => {
  const ctx = useIsolatedDb();

  const last = async () => (await changeLogBounds(ctx.db)).newest;
  /** The changes made by `fn`, as "kind:op" in log order. */
  const changesOf = async (fn: () => Promise<unknown>) => {
    const before = await last();
    await fn();
    return (await listChanges(ctx.db, before)).map((c) => `${c.kind}:${c.op}`);
  };

  it("records what changed, as ids only, for each table the app follows", async () => {
    const before = await last();
    const bot = await createBot(ctx.db, { name: "feed", modelProvider: "p", modelId: "m" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const message = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "user",
      text: "SEGREDO-DA-MENSAGEM",
    });
    const run = await createRun(ctx.db, {
      botId: bot.id,
      conversationId: conv.id,
      origin: "user",
      objective: "SEGREDO-DO-OBJETIVO",
    });
    const event = await appendRunEvent(ctx.db, run.id, "nudge", {
      reason: "r",
      text: "SEGREDO-DO-EVENTO",
    });
    const memory = await addMemory(ctx.db, {
      layer: "profile",
      text: "SEGREDO-DA-MEMORIA",
      createdBy: "user",
    });

    const changes = await listChanges(ctx.db, before);
    const find = (kind: string, ref: string) =>
      changes.filter((c) => c.kind === kind && c.ref === ref);
    expect(find("bot", bot.id).map((c) => c.op)).toEqual(["created"]);
    expect(find("conversation", conv.id).map((c) => c.op)).toContain("created");
    expect(find("message", message.id)).toMatchObject([{ op: "created", seq: 1 }]);
    expect(find("run", run.id).map((c) => c.op)).toEqual(["created"]);
    expect(find("run_event", run.id)).toMatchObject([{ op: "created", seq: event.seq }]);
    expect(find("memory", memory.id).map((c) => c.op)).toEqual(["created"]);
    // Ids are increasing, and nothing of the content is in the log.
    expect(changes.map((c) => c.id)).toEqual([...changes.map((c) => c.id)].sort((a, b) => a - b));
    const raw = await ctx.db.sql`select * from change_log`;
    expect(JSON.stringify(raw)).not.toContain("SEGREDO");
  });

  it("emits the right operation for each kind of update, and nothing for a heartbeat", async () => {
    const bot = await createBot(ctx.db, { name: "ops", modelProvider: "p", modelId: "m" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const memory = await addMemory(ctx.db, { layer: "rule", text: "regra", createdBy: "user" });
    expect(await changesOf(() => updateMemory(ctx.db, memory.id, "regra nova"))).toEqual([
      "memory:updated",
    ]);
    expect(await changesOf(() => archiveMemory(ctx.db, memory.id))).toEqual(["memory:archived"]);
    expect(await changesOf(() => restoreMemory(ctx.db, memory.id))).toEqual(["memory:restored"]);
    // Setting `embedding_ready` or other bookkeeping is not a change the app shows.
    expect(
      await changesOf(
        () => ctx.db.sql`update memories set embedding_ready = true where id = ${memory.id}`,
      ),
    ).toEqual([]);

    const msg = await appendMessage(ctx.db, {
      conversationId: conv.id,
      authorKind: "user",
      text: "x",
      status: "sent",
    });
    expect(
      await changesOf(
        () => ctx.db.sql`update messages set status = 'delivered' where id = ${msg.id}`,
      ),
    ).toEqual(["message:updated"]);
    expect(await changesOf(() => markConversationRead(ctx.db, conv.id))).toEqual([
      "conversation:updated",
    ]);
    expect(await changesOf(() => archiveBot(ctx.db, bot.id))).toEqual(["bot:updated"]);

    const bot2 = await createBot(ctx.db, { name: "runs", modelProvider: "p", modelId: "m" });
    const run = await createRun(ctx.db, { botId: bot2.id, origin: "user", objective: "o" });
    expect((await claimRun(ctx.db, run.id, "w1"))?.id).toBe(run.id);
    expect(await changesOf(() => heartbeatRun(ctx.db, run.id, "w1"))).toEqual([]);
    expect(
      await changesOf(
        () =>
          ctx.db
            .sql`update runs set plan = '[{"id":"a","title":"t","status":"pending"}]'::jsonb where id = ${run.id}`,
      ),
    ).toEqual(["run:updated"]);
    expect(
      await changesOf(() => setRunStatus(ctx.db, run.id, { from: "running", to: "done" })),
    ).toEqual(["run:updated"]);
  });

  it("numbers changes in the order the transactions became visible, not the order they started", async () => {
    const bot = await createBot(ctx.db, { name: "order", modelProvider: "p", modelId: "m" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const before = await last();
    const slowStarted = deferred();
    const slowMayCommit = deferred();
    // The slow transaction writes first and commits last.
    const slow = withTransaction(ctx.db, async (tx) => {
      await tx.sql`insert into memories (layer, scope, text, created_by) values ('profile', 'shared', 'lenta', 'user')`;
      slowStarted.resolve();
      await slowMayCommit.promise;
    });
    await slowStarted.promise;
    await appendMessage(ctx.db, { conversationId: conv.id, authorKind: "user", text: "rápida" });
    // Nothing of the slow one is visible, and the fast one is already numbered.
    expect((await listChanges(ctx.db, before)).map((c) => c.kind)).toEqual([
      "message",
      "conversation",
    ]);
    slowMayCommit.resolve();
    await slow;
    const after = await listChanges(ctx.db, before);
    expect(after.map((c) => c.kind)).toEqual(["message", "conversation", "memory"]);
    expect(after.map((c) => c.id)).toEqual([...after.map((c) => c.id)].sort((a, b) => a - b));
  });

  it("a reader that follows 'id > cursor' never misses a change, even with many concurrent writers", async () => {
    const bot = await createBot(ctx.db, { name: "race", modelProvider: "p", modelId: "m" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    const start = await last();
    const total = 60;
    const seen = new Set<number>();
    let cursor = start;
    let writing = true;
    const reader = (async () => {
      while (writing || (await listChanges(ctx.db, cursor)).length > 0) {
        for (const c of await listChanges(ctx.db, cursor)) {
          expect(c.id).toBeGreaterThan(cursor); // strictly forward
          seen.add(c.id);
          cursor = c.id;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        appendMessage(ctx.db, { conversationId: conv.id, authorKind: "user", text: `m${i}` }),
      ),
    );
    writing = false;
    await reader;
    const all = (await listChanges(ctx.db, start, 1000)).map((c) => c.id);
    expect(all.length).toBeGreaterThanOrEqual(total);
    expect([...seen].sort((a, b) => a - b)).toEqual(all);
  });

  it("notifies on a channel named after the schema, with the change id and nothing else", async () => {
    const channel = await changeChannel(ctx.db);
    expect(channel).toBe(`suup_changes_${ctx.schema}`);
    const payloads: string[] = [];
    const sub = await ctx.db.sql.listen(channel, (payload) => payloads.push(payload));
    try {
      const bot = await createBot(ctx.db, { name: "notify", modelProvider: "p", modelId: "m" });
      await until(() => payloads.length >= 1, 10_000, "the notification");
      const created = (await listChanges(ctx.db, (await last()) - 1)).at(-1);
      expect(payloads).toContain(String(created?.id));
      for (const p of payloads) expect(p).toMatch(/^\d+$/);
      expect(bot.id).toBeDefined();
    } finally {
      await sub.unlisten();
    }
  });

  it("prunes by age and by count, and remembers how far it pruned", async () => {
    const bot = await createBot(ctx.db, { name: "prune", modelProvider: "p", modelId: "m" });
    const conv = await createDirectConversation(ctx.db, bot.id);
    for (let i = 0; i < 5; i++) {
      await appendMessage(ctx.db, { conversationId: conv.id, authorKind: "user", text: `p${i}` });
    }
    const bounds = await changeLogBounds(ctx.db);
    expect(bounds.prunedThrough).toBeLessThan(bounds.newest);

    // Nothing is old enough, and the count is generous: nothing goes.
    expect(await pruneChangeLog(ctx.db, { olderThanMs: 3_600_000, keepLast: 10_000 })).toBe(0);
    // Keep only the newest 3.
    const deleted = await pruneChangeLog(ctx.db, { olderThanMs: 3_600_000, keepLast: 3 });
    expect(deleted).toBeGreaterThan(0);
    const after = await changeLogBounds(ctx.db);
    expect(after.newest).toBe(bounds.newest);
    expect(after.prunedThrough).toBe(bounds.newest - 3);
    expect((await listChanges(ctx.db, 0)).map((c) => c.id)).toEqual([
      bounds.newest - 2,
      bounds.newest - 1,
      bounds.newest,
    ]);
    // By age: everything older than "now" goes, and the mark moves to the newest.
    await pruneChangeLog(ctx.db, { olderThanMs: 0, keepLast: 10_000 });
    expect(await listChanges(ctx.db, 0)).toEqual([]);
    expect(await changeLogBounds(ctx.db)).toEqual({
      newest: bounds.newest,
      prunedThrough: bounds.newest,
    });
  });
});
