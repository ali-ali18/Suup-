import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "./index.js";
import { describeRunStoreContract } from "./store-contract.js";

describeRunStoreContract("InMemoryRunStore", () => {
  const memory = new InMemoryRunStore();
  const worker = "worker-1";
  const store = memory.forWorker(worker);
  return {
    store,
    createRun: async (input) => {
      const run = memory.createRun(input);
      memory.assignLease(run.id, worker);
      return run.id;
    },
    post: async (runId, item) => memory.postInbox(runId, item),
    statusOf: async (runId) => (await memory.getRun(runId)).status,
    outcome: async (runId) => memory.outcome(runId),
    takeLease: async (runId) => memory.assignLease(runId, "worker-2"),
    leased: async (runId) => memory.leaseHolder(runId) !== null,
    decideApproval: async (runId, approvalId, decision) => {
      memory.decideApproval(runId, approvalId, decision);
    },
  };
});

describe("InMemoryRunStore", () => {
  const make = () => {
    const store = new InMemoryRunStore();
    const run = store.createRun({ objective: "o", acceptanceCriteria: ["c"] });
    return { store, id: run.id };
  };

  it("assigns increasing seq numbers and returns copies", async () => {
    const { store, id } = make();
    const a = await store.appendEvent(id, { type: "nudge", payload: { reason: "r", text: "a" } });
    const b = await store.appendEvent(id, { type: "nudge", payload: { reason: "r", text: "b" } });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    const events = await store.listEvents(id);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    events.pop();
    expect(await store.listEvents(id)).toHaveLength(2);
  });

  it("rejects events that do not match the event schema", async () => {
    const { store, id } = make();
    await expect(
      store.appendEvent(id, { type: "nudge", payload: { reason: 1 } } as never),
    ).rejects.toThrow();
  });

  it("changes status only from an expected one (compare-and-set)", async () => {
    const { store, id } = make();
    expect(await store.setStatus(id, { from: ["queued"], to: "done" })).toBe(false);
    expect((await store.getRun(id)).status).toBe("running");
    expect(
      await store.setStatus(id, {
        from: ["running"],
        to: "failed",
        failure: { origin: "model", detail: "d" },
      }),
    ).toBe(true);
    expect(store.outcome(id).failure).toEqual({ origin: "model", detail: "d" });
  });

  it("peeks inbox items without consuming them, until they are acknowledged", async () => {
    const { store, id } = make();
    const first = store.postInbox(id, { kind: "user_message", text: "hi" });
    const second = store.postInbox(id, { kind: "stop" });
    expect(first).not.toBe(second);
    const items = [
      { id: first, kind: "user_message", text: "hi" },
      { id: second, kind: "stop" },
    ];
    expect(await store.peekInbox(id)).toEqual(items);
    expect(await store.peekInbox(id)).toEqual(items);
    await store.ackInbox(id, [first]);
    await store.ackInbox(id, [first, "unknown"]); // idempotent, unknown ids ignored
    expect(await store.peekInbox(id)).toEqual([items[1]]);
    await store.ackInbox(id, [second]);
    expect(await store.peekInbox(id)).toEqual([]);
    expect(store.inboxLog(id).every((e) => e.acked)).toBe(true);
  });

  it("accumulates usage and counts heartbeats", async () => {
    const { store, id } = make();
    await store.addUsage(id, { turns: 1, inputTokens: 5, costUsd: 0.5 });
    await store.addUsage(id, { outputTokens: 2, costUsd: 0.25 });
    await store.heartbeat(id);
    const run = await store.getRun(id);
    expect(run).toMatchObject({ turns: 1, inputTokens: 5, outputTokens: 2, costUsd: 0.75 });
    expect(store.heartbeats(id)).toBe(1);
  });
});
