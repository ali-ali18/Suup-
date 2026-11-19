import { describe, expect, it } from "vitest";
import type { RunEventData } from "../events.js";
import {
  type InboxItemInput,
  LeaseLostError,
  type RunResult,
  type RunStatus,
  type RunStore,
} from "../loop/store.js";

/**
 * What the contract needs besides the `RunStore` itself: a way to make runs and to play the part
 * of the server and of a second worker, which the store interface does not cover.
 */
export interface StoreHarness {
  /** The store as one worker sees it, fenced by its lease (writes need the lease). */
  store: RunStore;
  /** A new run in status `running`, leased to this harness's worker. Returns its id. */
  createRun(input: { objective: string; acceptanceCriteria?: string[] }): Promise<string>;
  /** Posts to the run's inbox as the server would. Returns the item id. */
  post(runId: string, item: InboxItemInput): Promise<string>;
  /** The status as stored. */
  statusOf(runId: string): Promise<RunStatus>;
  /** The failure and result stored with the run's last status change. */
  outcome(runId: string): Promise<{
    failure?: { origin: string; detail: string };
    result?: RunResult;
  }>;
  /** Another worker takes the run over (this worker presumed dead). */
  takeLease(runId: string): Promise<void>;
  /** Whether a worker holds the run (false after a requeue or a terminal status). */
  leased(runId: string): Promise<boolean>;
  /**
   * The user answers an approval card of the run, as the server does: `approvalId` is the one in
   * the run's `approval_requested` event. A run waiting for it becomes claimable again.
   */
  decideApproval(
    runId: string,
    approvalId: string,
    decision: { decision: "approved" | "denied"; reason?: string },
  ): Promise<void>;
}

const nudge = (text: string): RunEventData => ({ type: "nudge", payload: { reason: "r", text } });

/**
 * The behaviour every `RunStore` must have, as tests. Run it against each implementation
 * (`InMemoryRunStore` and `PgRunStore`), so the fake the loop tests use cannot drift from the
 * real thing. `make` is called once per test and must give an isolated, empty harness.
 */
export function describeRunStoreContract(
  label: string,
  make: () => Promise<StoreHarness> | StoreHarness,
): void {
  describe(`RunStore contract: ${label}`, () => {
    describe("runs", () => {
      it("returns the run as created, and throws for an unknown one", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "Find it.", acceptanceCriteria: ["a", "b"] });
        const run = await h.store.getRun(id);
        expect(run).toMatchObject({
          id,
          objective: "Find it.",
          acceptanceCriteria: ["a", "b"],
          plan: [],
          status: "running",
          origin: "user",
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.startedAt).toBeInstanceOf(Date);
        await expect(h.store.getRun("00000000-0000-4000-8000-000000000000")).rejects.toThrow();
      });

      it("keeps the plan mirror and adds usage up", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const plan = [
          { id: "s1", title: "One", status: "done" as const },
          { id: "s2", title: "Two", status: "pending" as const, note: "later" },
        ];
        await h.store.updatePlan(id, plan);
        await h.store.addUsage(id, { turns: 1, inputTokens: 100, outputTokens: 20, costUsd: 0.25 });
        await h.store.addUsage(id, { outputTokens: 5, costUsd: 0.125 });
        await h.store.addUsage(id, {});
        const run = await h.store.getRun(id);
        expect(run.plan).toEqual(plan);
        expect(run).toMatchObject({ turns: 1, inputTokens: 100, outputTokens: 25 });
        expect(run.costUsd).toBeCloseTo(0.375, 6);
      });

      it("does not lose concurrent usage increments", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await Promise.all(
          Array.from({ length: 12 }, () => h.store.addUsage(id, { turns: 1, inputTokens: 3 })),
        );
        expect(await h.store.getRun(id)).toMatchObject({ turns: 12, inputTokens: 36 });
      });
    });

    describe("events", () => {
      it("numbers events 1, 2, 3 in the order appended and lists them back unchanged", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const events: RunEventData[] = [
          {
            type: "run_started",
            payload: { botId: "b", objective: "o", acceptanceCriteria: ["c"], origin: "user" },
          },
          {
            type: "model_request",
            payload: {
              provider: "p",
              model: "m",
              system: "sys ✓ ünïcode",
              messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
              tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
              toolChoice: { name: "t" },
              maxOutputTokens: 100,
            },
          },
          {
            type: "tool_call",
            payload: {
              callId: "c1",
              name: "t",
              args: { nested: { list: [1, "two", null, true] } },
            },
          },
          nudge("keep going"),
        ];
        const seqs: number[] = [];
        for (const event of events) seqs.push((await h.store.appendEvent(id, event)).seq);
        expect(seqs).toEqual([1, 2, 3, 4]);

        const stored = await h.store.listEvents(id);
        expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
        expect(stored.map((e) => ({ type: e.type, payload: e.payload }))).toEqual(events);
        for (const e of stored) expect(e.createdAt).toBeInstanceOf(Date);
      });

      it("returns copies: changing what was listed changes nothing stored", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await h.store.appendEvent(id, nudge("a"));
        const first = await h.store.listEvents(id);
        first.pop();
        expect(await h.store.listEvents(id)).toHaveLength(1);
      });

      it("rejects an event that does not match the schema, and does not use up its seq", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await expect(
          h.store.appendEvent(id, { type: "nudge", payload: { reason: 1 } } as never),
        ).rejects.toThrow();
        await expect(
          h.store.appendEvent(id, { type: "no_such_event", payload: {} } as never),
        ).rejects.toThrow();
        expect((await h.store.appendEvent(id, nudge("ok"))).seq).toBe(1);
      });

      it("gives concurrent appends distinct, consecutive seq numbers", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => h.store.appendEvent(id, nudge(`n${i}`))),
        );
        expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
        const listed = await h.store.listEvents(id);
        expect(listed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it("numbers each run's events on its own", async () => {
        const h = await make();
        const a = await h.createRun({ objective: "a" });
        const b = await h.createRun({ objective: "b" });
        await h.store.appendEvent(a, nudge("a1"));
        await h.store.appendEvent(a, nudge("a2"));
        expect((await h.store.appendEvent(b, nudge("b1"))).seq).toBe(1);
        expect(await h.store.listEvents(b)).toHaveLength(1);
      });

      it("lists a long log completely and in order", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const total = 1100; // more than one page of any reasonable implementation
        for (let i = 0; i < total; i += 50) {
          await Promise.all(
            Array.from({ length: 50 }, (_, j) => h.store.appendEvent(id, nudge(`n${i + j}`))),
          );
        }
        const listed = await h.store.listEvents(id);
        expect(listed.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
        // Over a thousand commits on a real database: generous, so a slow machine only takes longer.
      }, 60_000);
    });

    describe("status", () => {
      it("changes status only from an expected one (compare-and-set)", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        expect(await h.store.setStatus(id, { from: ["queued"], to: "waiting_user" })).toBe(false);
        expect(await h.statusOf(id)).toBe("running");
        expect(
          await h.store.setStatus(id, { from: ["queued", "running"], to: "waiting_approval" }),
        ).toBe(true);
        expect(await h.statusOf(id)).toBe("waiting_approval");
        // The same change a second time finds the status already moved.
        expect(await h.store.setStatus(id, { from: ["running"], to: "waiting_approval" })).toBe(
          false,
        );
      });

      it("only one of two racing changes wins", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const results = await Promise.all([
          h.store.setStatus(id, { from: ["running"], to: "waiting_user" }),
          h.store.setStatus(id, { from: ["running"], to: "waiting_approval" }),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it("stores the result of a finished run", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const result = { summary: "Done.", evidence: [{ criterion: "c", evidence: "e" }] };
        expect(await h.store.setStatus(id, { from: ["running"], to: "done", result })).toBe(true);
        expect(await h.statusOf(id)).toBe("done");
        expect((await h.outcome(id)).result).toEqual(result);
      });

      for (const origin of [
        "provider",
        "model",
        "tool",
        "harness",
        "limit",
        "approval",
        "user",
      ] as const) {
        it(`stores a failure with origin "${origin}"`, async () => {
          const h = await make();
          const id = await h.createRun({ objective: "o" });
          const failure = { origin, detail: `it went wrong: ${origin}` };
          expect(await h.store.setStatus(id, { from: ["running"], to: "failed", failure })).toBe(
            true,
          );
          expect(await h.statusOf(id)).toBe("failed");
          expect((await h.outcome(id)).failure).toEqual(failure);
        });
      }

      it("releases the lease when the run ends", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        expect(await h.leased(id)).toBe(true);
        await h.store.setStatus(id, { from: ["running"], to: "cancelled" });
        expect(await h.leased(id)).toBe(false);
      });

      it("keeps a run that waits for the user waiting, unless something is in its inbox", async () => {
        const h = await make();
        const calm = await h.createRun({ objective: "o" });
        await h.store.setStatus(calm, {
          from: ["running"],
          to: "waiting_user",
          requeueIfInbox: true,
        });
        expect(await h.statusOf(calm)).toBe("waiting_user");

        // An item that arrived while the loop was on its way to waiting: the run must not sleep.
        const busy = await h.createRun({ objective: "o" });
        await h.post(busy, { kind: "user_message", text: "wait, one more thing" });
        expect(
          await h.store.setStatus(busy, {
            from: ["running"],
            to: "waiting_user",
            requeueIfInbox: true,
          }),
        ).toBe(true);
        expect(await h.statusOf(busy)).toBe("queued");
        expect(await h.leased(busy)).toBe(false);
        expect(await h.store.peekInbox(busy)).toHaveLength(1);

        // Without the flag (the loop re-applying a status its log already holds) it just waits.
        const again = await h.createRun({ objective: "o" });
        await h.post(again, { kind: "user_message", text: "x" });
        await h.store.setStatus(again, { from: ["running"], to: "waiting_user" });
        expect(await h.statusOf(again)).toBe("waiting_user");
      });
    });

    describe("approvals", () => {
      const request = (approvalId: string, callId: string): RunEventData => ({
        type: "approval_requested",
        payload: {
          approvalId,
          callId,
          tool: "send",
          args: { to: "ana" },
          level: "external_irreversible",
          summary: "Send a message to ana",
          secrets: [],
          source: "default",
        },
      });
      // Fresh ids per test: a real database keeps the cards of every test of the file.
      const newIds = () => [crypto.randomUUID(), crypto.randomUUID()] as const;

      it("hands decisions to the loop once, in order, and forgets them when acknowledged", async () => {
        const h = await make();
        const IDS = newIds();
        const id = await h.createRun({ objective: "o" });
        await h.store.appendEvent(id, request(IDS[0], "c1"));
        expect(await h.store.peekApprovalDecisions(id)).toEqual([]);
        await h.decideApproval(id, IDS[0], { decision: "denied", reason: "not now" });
        const first = await h.store.peekApprovalDecisions(id);
        expect(first).toEqual([
          { approvalId: IDS[0], callId: "c1", decision: "denied", reason: "not now" },
        ]);
        // Peeking does not consume: the same decision, the same id.
        expect(await h.store.peekApprovalDecisions(id)).toEqual(first);
        await h.store.ackApprovalDecisions(id, [IDS[0]]);
        expect(await h.store.peekApprovalDecisions(id)).toEqual([]);
        // Acknowledging again, or something unknown, is harmless.
        await h.store.ackApprovalDecisions(id, [IDS[0], IDS[1]]);
        await h.store.ackApprovalDecisions(id, []);
      });

      it("makes a run that waits for the decision claimable again", async () => {
        const h = await make();
        const IDS = newIds();
        const id = await h.createRun({ objective: "o" });
        await h.store.appendEvent(id, request(IDS[0], "c1"));
        await h.store.setStatus(id, { from: ["running"], to: "waiting_approval" });
        expect(await h.statusOf(id)).toBe("waiting_approval");
        await h.decideApproval(id, IDS[0], { decision: "approved" });
        expect(await h.statusOf(id)).toBe("queued");
        expect(await h.leased(id)).toBe(false);
      });

      it("does not let a run go to sleep on a decision that arrived on its way to waiting", async () => {
        const h = await make();
        const IDS = newIds();
        const calm = await h.createRun({ objective: "o" });
        await h.store.appendEvent(calm, request(IDS[0], "c1"));
        await h.store.setStatus(calm, {
          from: ["running"],
          to: "waiting_approval",
          requeueIfDecided: true,
        });
        expect(await h.statusOf(calm)).toBe("waiting_approval");

        const busy = await h.createRun({ objective: "o" });
        await h.store.appendEvent(busy, request(IDS[1], "c9"));
        await h.decideApproval(busy, IDS[1], { decision: "approved" });
        expect(await h.statusOf(busy)).toBe("running"); // it had not paused yet: nothing to wake
        expect(
          await h.store.setStatus(busy, {
            from: ["running"],
            to: "waiting_approval",
            requeueIfDecided: true,
          }),
        ).toBe(true);
        expect(await h.statusOf(busy)).toBe("queued");
        expect(await h.store.peekApprovalDecisions(busy)).toHaveLength(1);
      });

      it("fences acknowledgements by the lease", async () => {
        const h = await make();
        const IDS = newIds();
        const id = await h.createRun({ objective: "o" });
        await h.store.appendEvent(id, request(IDS[0], "c1"));
        await h.decideApproval(id, IDS[0], { decision: "approved" });
        await h.takeLease(id);
        await expect(h.store.ackApprovalDecisions(id, [IDS[0]])).rejects.toBeInstanceOf(
          LeaseLostError,
        );
      });
    });

    describe("inbox", () => {
      it("peeks items in order with stable ids, without consuming them", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const first = await h.post(id, { kind: "user_message", text: "one" });
        const second = await h.post(id, { kind: "stop" });
        const third = await h.post(id, { kind: "user_message", text: "tres ✓" });
        expect(new Set([first, second, third]).size).toBe(3);

        const expected = [
          { id: first, kind: "user_message", text: "one" },
          { id: second, kind: "stop" },
          { id: third, kind: "user_message", text: "tres ✓" },
        ];
        expect(await h.store.peekInbox(id)).toEqual(expected);
        expect(await h.store.peekInbox(id)).toEqual(expected);
      });

      it("acknowledges only what it is told to, and acknowledging twice is harmless", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        const a = await h.post(id, { kind: "user_message", text: "a" });
        const b = await h.post(id, { kind: "user_message", text: "b" });
        const c = await h.post(id, { kind: "user_message", text: "c" });

        await h.store.ackInbox(id, [a, c]);
        expect((await h.store.peekInbox(id)).map((i) => i.id)).toEqual([b]);
        await h.store.ackInbox(id, [a, c]);
        await h.store.ackInbox(id, ["999999", a]);
        await h.store.ackInbox(id, []);
        expect((await h.store.peekInbox(id)).map((i) => i.id)).toEqual([b]);

        const d = await h.post(id, { kind: "user_message", text: "d" });
        expect((await h.store.peekInbox(id)).map((i) => i.id)).toEqual([b, d]);
        await h.store.ackInbox(id, [b, d]);
        expect(await h.store.peekInbox(id)).toEqual([]);
      });

      it("keeps the inboxes of different runs apart", async () => {
        const h = await make();
        const one = await h.createRun({ objective: "1" });
        const two = await h.createRun({ objective: "2" });
        const mine = await h.post(one, { kind: "user_message", text: "mine" });
        await h.post(two, { kind: "user_message", text: "yours" });
        await h.store.ackInbox(two, [mine]); // an id of another run: nothing happens
        expect((await h.store.peekInbox(one)).map((i) => i.id)).toEqual([mine]);
        expect(await h.store.peekInbox(two)).toHaveLength(1);
      });

      it("puts a run that waits for the user back in the queue when something is posted", async () => {
        const h = await make();
        const waiting = await h.createRun({ objective: "o" });
        await h.store.setStatus(waiting, { from: ["running"], to: "waiting_user" });
        await h.post(waiting, { kind: "user_message", text: "the answer" });
        expect(await h.statusOf(waiting)).toBe("queued");
        expect(await h.leased(waiting)).toBe(false);

        // Any other status is left as it is: the item waits for the loop.
        const running = await h.createRun({ objective: "o" });
        await h.post(running, { kind: "user_message", text: "hello" });
        expect(await h.statusOf(running)).toBe("running");

        const approval = await h.createRun({ objective: "o" });
        await h.store.setStatus(approval, { from: ["running"], to: "waiting_approval" });
        await h.post(approval, { kind: "user_message", text: "yes please" });
        expect(await h.statusOf(approval)).toBe("waiting_approval");

        const finished = await h.createRun({ objective: "o" });
        await h.store.setStatus(finished, {
          from: ["running"],
          to: "done",
          result: { summary: "s" },
        });
        await h.post(finished, { kind: "user_message", text: "too late" });
        expect(await h.statusOf(finished)).toBe("done");
      });
    });

    describe("lease", () => {
      it("renews while held and keeps counting as held", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await h.store.heartbeat(id);
        await h.store.heartbeat(id);
        expect(await h.leased(id)).toBe(true);
      });

      it("throws LeaseLostError once another worker took the run, and writes nothing", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await h.store.appendEvent(id, nudge("mine"));
        await h.takeLease(id);

        await expect(h.store.heartbeat(id)).rejects.toBeInstanceOf(LeaseLostError);
        await expect(h.store.appendEvent(id, nudge("zombie"))).rejects.toBeInstanceOf(
          LeaseLostError,
        );
        await expect(
          h.store.setStatus(id, { from: ["running"], to: "done", result: { summary: "s" } }),
        ).rejects.toBeInstanceOf(LeaseLostError);
        await expect(h.store.updatePlan(id, [])).rejects.toBeInstanceOf(LeaseLostError);
        await expect(h.store.addUsage(id, { turns: 1 })).rejects.toBeInstanceOf(LeaseLostError);
        const item = await h.post(id, { kind: "user_message", text: "m" });
        await expect(h.store.ackInbox(id, [item])).rejects.toBeInstanceOf(LeaseLostError);

        // Reads still work, and show nothing of what the zombie tried.
        expect((await h.store.listEvents(id)).map((e) => e.seq)).toEqual([1]);
        expect(await h.statusOf(id)).toBe("running");
        expect((await h.store.getRun(id)).turns).toBe(0);
        expect(await h.store.peekInbox(id)).toHaveLength(1);
      });

      it("the error names the run", async () => {
        const h = await make();
        const id = await h.createRun({ objective: "o" });
        await h.takeLease(id);
        const error = await h.store.heartbeat(id).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LeaseLostError);
        expect((error as LeaseLostError).runId).toBe(id);
      });
    });
  });
}
