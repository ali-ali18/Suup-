import { describe, expect, it } from "vitest";
import {
  type ChangeRef,
  type ChangeSource,
  type Clock,
  frame,
  type Notifier,
  type Resolved,
  type Sink,
  StreamHub,
  StreamLimitError,
} from "../src/index.js";

// The realtime hub with fakes for everything outside it: a log in memory, a notifier that is just a
// function, a clock that moves when told, and sinks that record what they are given.

interface Change extends ChangeRef {
  run?: string;
  type?: "run.event" | "message.created" | "run.updated";
}

class FakeSource implements ChangeSource<Change> {
  log: Change[] = [];
  prunedThrough = 0;
  /** Hold `read` until released: lets a test change the world in the middle of a replay. */
  gate: Promise<void> | undefined;
  /** Hold only the next `read` (the replay's), not the live poll's. */
  gateOnce: Promise<void> | undefined;
  /** The version of the row at the moment a change is resolved (what the database would say). */
  version = 1;
  reads = 0;
  failNext = false;

  append(change: Omit<Change, "id">): number {
    const id = (this.log.at(-1)?.id ?? this.prunedThrough) + 1;
    this.log.push({ id, ...change });
    return id;
  }

  async bounds() {
    return { newest: this.log.at(-1)?.id ?? this.prunedThrough, prunedThrough: this.prunedThrough };
  }

  async read(afterId: number, limit: number): Promise<Change[]> {
    this.reads += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("database is down");
    }
    const once = this.gateOnce;
    this.gateOnce = undefined;
    await once;
    await this.gate;
    return this.log.filter((c) => c.id > afterId).slice(0, limit);
  }

  async resolve(changes: Change[], wantRun: (run: string) => boolean): Promise<Resolved[]> {
    const out: Resolved[] = [];
    for (const c of changes) {
      if (c.type === "run.event") {
        if (wantRun(c.run ?? "")) {
          out.push({
            id: c.id,
            events: [{ type: "run.event", runId: c.run ?? "", data: { n: c.id } }],
          });
        }
      } else if (c.type === "run.updated") {
        out.push({
          id: c.id,
          events: [
            { type: "run.updated", key: "run:x", version: this.version, data: { v: this.version } },
          ],
        });
      } else {
        out.push({ id: c.id, events: [{ type: "message.created", data: { n: c.id } }] });
      }
    }
    return out;
  }
}

class FakeClock implements Clock {
  #timers: { at: number; every: number; fn: () => void; id: number }[] = [];
  now = 0;
  #next = 1;
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.push({ at: this.now + ms, every: ms, fn, id });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.now = due.at;
      due.at += due.every;
      due.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

class FakeSink implements Sink {
  chunks: string[] = [];
  pendingBytes = 0;
  ended = false;
  write(chunk: string): boolean {
    if (this.ended) return false;
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  get text(): string {
    return this.chunks.join("");
  }
  /** The `id: N` of every frame, in order. */
  get ids(): number[] {
    return [...this.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  }
  get types(): string[] {
    return [...this.text.matchAll(/^event: (.+)$/gm)].map((m) => m[1] as string);
  }
}

function setup(
  options: {
    maxStreams?: number;
    maxPendingBytes?: number;
    maxReplay?: number;
    batch?: number;
    redactLive?: <T>(value: T) => T;
  } = {},
) {
  const source = new FakeSource();
  const clock = new FakeClock();
  const errors: string[] = [];
  const drops: string[] = [];
  let wake: () => void = () => {};
  const notifier: Notifier & { stopped: boolean } = {
    stopped: false,
    async start(w) {
      wake = w;
    },
    async stop() {
      this.stopped = true;
    },
  };
  const hub = new StreamHub<Change>({
    source,
    notifier,
    clock,
    keepAliveMs: 15_000,
    pollMs: 2_000,
    ...options,
    onError: (error, context) => errors.push(`${context}: ${(error as Error).message}`),
    onDrop: (reason) => drops.push(reason),
  });
  return { source, clock, hub, errors, drops, notify: () => wake(), notifier };
}

describe("frame", () => {
  it("is the SSE format: id, event and one line of JSON data", () => {
    expect(frame("run.event", { a: "x\ny" }, 7)).toBe(
      'id: 7\nevent: run.event\ndata: {"a":"x\\ny"}\n\n',
    );
    expect(frame("ready", { head: 1 })).toBe('event: ready\ndata: {"head":1}\n\n');
  });
});

describe("StreamHub", () => {
  it("starts after the newest change and delivers what comes, in order, as soon as it is notified", async () => {
    const { source, hub, notify } = setup();
    source.append({ type: "message.created" }); // before the hub started: not replayed to anyone
    await hub.start();
    expect(hub.cursor).toBe(1);

    const sink = new FakeSink();
    await hub.connect({ sink, runs: [] });
    expect(sink.text).toMatch(
      /^retry: 3000\n\nevent: ready\ndata: \{"head":1,"resync":false,"runs":\[\]\}\n\n$/,
    );

    source.append({ type: "message.created" });
    source.append({ type: "message.created" });
    notify();
    await flush();
    expect(sink.ids).toEqual([2, 3]);
    expect(hub.cursor).toBe(3);
  });

  it("delivers the events of a run only to the clients that asked for it, and everything else to all", async () => {
    const { source, hub, notify } = setup();
    await hub.start();
    const watching = new FakeSink();
    const other = new FakeSink();
    await hub.connect({ sink: watching, runs: ["run-a"] });
    await hub.connect({ sink: other, runs: ["run-b"] });
    source.append({ type: "run.event", run: "run-a" });
    source.append({ type: "run.event", run: "run-b" });
    source.append({ type: "message.created" });
    notify();
    await flush();
    expect(watching.ids).toEqual([1, 3]);
    expect(other.ids).toEqual([2, 3]);
  });

  it("does not even resolve the events of runs nobody follows", async () => {
    const { source, hub, notify } = setup();
    const resolved: string[] = [];
    const inner = source.resolve.bind(source);
    source.resolve = async (changes, want) => {
      resolved.push(
        ...changes
          .filter((c) => c.type === "run.event" && want(c.run ?? ""))
          .map((c) => c.run ?? ""),
      );
      return inner(changes, want);
    };
    await hub.start();
    await hub.connect({ sink: new FakeSink(), runs: ["run-a"] });
    source.append({ type: "run.event", run: "run-a" });
    source.append({ type: "run.event", run: "run-z" });
    notify();
    await flush();
    expect(resolved).toEqual(["run-a"]);
  });

  describe("resuming with Last-Event-ID", () => {
    it("replays exactly what was missed, then goes live, with nothing twice", async () => {
      const { source, hub, notify } = setup();
      await hub.start();
      for (let i = 0; i < 6; i++) source.append({ type: "message.created" });
      notify();
      await flush();
      expect(hub.cursor).toBe(6);

      const sink = new FakeSink();
      await hub.connect({ sink, runs: [], lastEventId: 3 });
      expect(sink.types[0]).toBe("ready");
      expect(sink.ids).toEqual([4, 5, 6]);
      source.append({ type: "message.created" });
      notify();
      await flush();
      expect(sink.ids).toEqual([4, 5, 6, 7]);
    });

    it("a change that arrives in the middle of the replay is buffered, not lost and not repeated", async () => {
      const { source, hub, notify } = setup({ batch: 2 });
      await hub.start();
      for (let i = 0; i < 4; i++) source.append({ type: "message.created" });
      notify();
      await flush();

      // Hold the replay's reads; then a change is written and notified while the client replays.
      let release!: () => void;
      source.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sink = new FakeSink();
      const connecting = hub.connect({ sink, runs: [], lastEventId: 1 });
      await flush();
      source.append({ type: "message.created" }); // id 5: live, while the replay (2..4) is held
      source.gate = undefined;
      notify();
      release();
      await connecting;
      await flush();
      expect(sink.ids).toEqual([2, 3, 4, 5]);
    });

    it("an id from another server that is ahead of this one is not delivered again when this one catches up", async () => {
      const { source, hub, notify } = setup();
      await hub.start(); // cursor 0
      // Three changes exist, but this server's hub has not read them yet (a notification is late).
      source.append({ type: "message.created" });
      source.append({ type: "message.created" });
      source.append({ type: "message.created" });
      const sink = new FakeSink();
      await hub.connect({ sink, runs: [], lastEventId: 2 }); // the client saw 1..2 on another server
      notify();
      await flush();
      expect(sink.ids).toEqual([3]);
    });

    it("says so when the client cannot resume: too old, unknown id, too many", async () => {
      const { source, hub, notify } = setup({ maxReplay: 5 });
      await hub.start();
      for (let i = 0; i < 10; i++) source.append({ type: "message.created" });
      notify();
      await flush();
      source.prunedThrough = 3;

      const tooOld = new FakeSink();
      await hub.connect({ sink: tooOld, runs: [], lastEventId: 2 });
      expect(tooOld.text).toContain('"resync":true');
      expect(tooOld.text).toContain('event: resync\ndata: {"reason":"too_old"}');
      expect(tooOld.ids).toEqual([]);

      const unknown = new FakeSink();
      await hub.connect({ sink: unknown, runs: [], lastEventId: 500 });
      expect(unknown.text).toContain('{"reason":"unknown_id"}');

      const many = new FakeSink();
      await hub.connect({ sink: many, runs: [], lastEventId: 4 }); // 10 - 4 > 5
      expect(many.text).toContain('{"reason":"too_many"}');

      // After a resync the client is live from the head: later changes still arrive.
      source.append({ type: "message.created" });
      notify();
      await flush();
      expect(many.ids).toEqual([11]);

      const fine = new FakeSink();
      await hub.connect({ sink: fine, runs: [], lastEventId: 8 });
      expect(fine.text).not.toContain("resync\n");
      expect(fine.ids).toEqual([9, 10, 11]);
    });

    it("a replay that fails drops the client, which can try again", async () => {
      const { source, hub, errors, drops } = setup();
      await hub.start();
      source.append({ type: "message.created" });
      source.append({ type: "message.created" });
      await hub.wake();
      await flush();
      source.failNext = true;
      const sink = new FakeSink();
      await hub.connect({ sink, runs: [], lastEventId: 0 });
      expect(sink.ended).toBe(true);
      expect(drops).toEqual(["replay_failed"]);
      expect(errors[0]).toContain("database is down");
      expect(hub.size).toBe(0);
    });
  });

  it("falls back to polling when a notification is lost", async () => {
    const { source, hub, clock } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [] });
    source.append({ type: "message.created" }); // written, but nobody called notify
    await clock.advance(2_000);
    expect(sink.ids).toEqual([1]);
  });

  it("survives a failing read and tries again at the next wake", async () => {
    const { source, hub, errors, notify } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [] });
    source.append({ type: "message.created" });
    source.failNext = true;
    notify();
    await flush();
    expect(errors).toEqual(["following the change log: database is down"]);
    expect(sink.ids).toEqual([]);
    notify();
    await flush();
    expect(sink.ids).toEqual([1]);
  });

  it("sends a keep-alive comment to everyone on a timer", async () => {
    const { hub, clock } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [] });
    const before = sink.chunks.length;
    await clock.advance(15_000);
    expect(sink.chunks.slice(before)).toEqual([": ping\n\n"]);
    await clock.advance(30_000);
    expect(sink.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(3);
  });

  it("never sends a state older than one it already sent for the same row (replay meets a buffered live frame)", async () => {
    const { source, hub, notify } = setup();
    await hub.start();
    source.append({ type: "run.updated" }); // id 1
    notify();
    await flush();

    let release!: () => void;
    source.gateOnce = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = new FakeSink();
    const connecting = hub.connect({ sink, runs: [], lastEventId: 0 }); // replays id 1, held
    await flush();
    source.append({ type: "run.updated" }); // id 2: read live while the replay waits, at version 1
    notify();
    await flush();
    source.version = 2; // the row moved on before the replay reads it
    release();
    await connecting;
    await flush();
    const states = [...sink.text.matchAll(/"v":(\d+)/g)].map((m) => Number(m[1]));
    expect(states).toEqual([2]); // the replay's newer state; the older live frame is not sent after it
    expect(states).toEqual([...states].sort((a, b) => a - b));
    // The next change, newer, goes through.
    source.version = 3;
    source.append({ type: "run.updated" });
    notify();
    await flush();
    expect([...sink.text.matchAll(/"v":(\d+)/g)].map((m) => Number(m[1]))).toEqual([2, 3]);
  });

  describe("back-pressure", () => {
    it("drops a client whose queue passed the limit, and goes on with the others", async () => {
      const { source, hub, notify, drops } = setup({ maxPendingBytes: 1000 });
      await hub.start();
      const slow = new FakeSink();
      const fast = new FakeSink();
      await hub.connect({ sink: slow, runs: [] });
      await hub.connect({ sink: fast, runs: [] });
      source.append({ type: "message.created" });
      notify();
      await flush();
      expect(slow.ids).toEqual([1]);

      slow.pendingBytes = 5000; // the socket does not drain
      source.append({ type: "message.created" });
      source.append({ type: "message.created" });
      notify();
      await flush();
      expect(slow.ended).toBe(true);
      expect(slow.ids).toEqual([1]); // nothing more was queued for it
      expect(fast.ids).toEqual([1, 2, 3]);
      expect(drops).toEqual(["slow_consumer"]);
      expect(hub.size).toBe(1);
    });

    it("drops a client that is still replaying when the live changes pile up past the limit", async () => {
      const { source, hub, notify, drops } = setup({ maxPendingBytes: 300 });
      await hub.start();
      source.append({ type: "message.created" });
      notify();
      await flush();
      let release!: () => void;
      source.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sink = new FakeSink();
      const connecting = hub.connect({ sink, runs: [], lastEventId: 0 });
      await flush();
      source.gate = undefined;
      for (let i = 0; i < 30; i++) source.append({ type: "message.created" });
      notify();
      await flush();
      release();
      await connecting;
      expect(sink.ended).toBe(true);
      expect(drops).toContain("slow_consumer");
      expect(hub.size).toBe(0);
    });

    it("also drops a client that does not drain between keep-alives", async () => {
      const { hub, clock, drops } = setup({ maxPendingBytes: 100 });
      await hub.start();
      const sink = new FakeSink();
      await hub.connect({ sink, runs: [] });
      sink.pendingBytes = 1000;
      await clock.advance(15_000);
      expect(sink.ended).toBe(true);
      expect(drops).toEqual(["slow_consumer"]);
    });
  });

  it("refuses more streams than the limit, before writing anything, and frees a slot when one goes", async () => {
    const { hub } = setup({ maxStreams: 2 });
    await hub.start();
    const a = new FakeSink();
    const b = new FakeSink();
    await hub.connect({ sink: a, runs: [] });
    await hub.connect({ sink: b, runs: [] });
    const c = new FakeSink();
    await expect(hub.connect({ sink: c, runs: [] })).rejects.toBeInstanceOf(StreamLimitError);
    expect(c.chunks).toEqual([]);
    hub.disconnect(a);
    expect(hub.size).toBe(1);
    await hub.connect({ sink: c, runs: [] });
    expect(hub.size).toBe(2);
  });

  it("stop() ends every stream, stops listening and ignores later wakes", async () => {
    const { source, hub, notify, notifier } = setup();
    await hub.start();
    const a = new FakeSink();
    const b = new FakeSink();
    await hub.connect({ sink: a, runs: [] });
    await hub.connect({ sink: b, runs: [] });
    await hub.stop();
    expect([a.ended, b.ended]).toEqual([true, true]);
    expect(notifier.stopped).toBe(true);
    expect(hub.size).toBe(0);
    source.append({ type: "message.created" });
    notify();
    await flush();
    expect(a.ids).toEqual([]);
    await hub.stop(); // idempotent
  });
});

describe("StreamHub: the answer being typed", () => {
  const RUN = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const text = (offset: number, t: string, over: Record<string, unknown> = {}) => ({
    type: "live.text",
    runId: RUN,
    call: 5,
    attempt: 1,
    block: 0,
    offset,
    text: t,
    ...over,
  });
  /** The `live.text` frames a sink got, as `[offset, text]`. */
  const typed = (sink: FakeSink) =>
    [...sink.text.matchAll(/event: live\.text\ndata: (.+)\n/g)].map((m) => {
      const d = JSON.parse(m[1] as string) as { offset: number; text: string };
      return [d.offset, d.text];
    });

  it("relays a frame with no id to the clients that follow the run, and to nobody else", async () => {
    const { hub } = setup();
    await hub.start();
    const mine = new FakeSink();
    const other = new FakeSink();
    await hub.connect({ sink: mine, runs: [RUN] });
    await hub.connect({ sink: other, runs: [OTHER] });
    hub.pushLive(text(0, "Olá"));
    hub.pushLive(text(3, ", mundo"));
    expect(typed(mine)).toEqual([
      [0, "Olá"],
      [3, ", mundo"],
    ]);
    expect(mine.ids).toEqual([]); // never an id: the Last-Event-ID stays the change log's
    expect(typed(other)).toEqual([]);
  });

  it("a client that connects in the middle gets the text so far, whole, then the next pieces", async () => {
    const { hub } = setup();
    await hub.start();
    hub.pushLive(text(0, "Olá"));
    hub.pushLive(text(3, ", mun"));
    const late = new FakeSink();
    await hub.connect({ sink: late, runs: [RUN] });
    expect(typed(late)).toEqual([[0, "Olá, mun"]]);
    hub.pushLive(text(8, "do"));
    expect(typed(late)).toEqual([
      [0, "Olá, mun"],
      [8, "do"],
    ]);
    const stranger = new FakeSink();
    await hub.connect({ sink: stranger, runs: [OTHER] });
    expect(typed(stranger)).toEqual([]);
  });

  it("forgets the text when the call ends, and says so", async () => {
    const { hub } = setup();
    await hub.start();
    hub.pushLive(text(0, "abc"));
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [RUN] });
    hub.pushLive({ type: "live.end", runId: RUN, call: 5, attempt: 1, outcome: "recorded" });
    expect(sink.types).toContain("live.end");
    const later = new FakeSink();
    await hub.connect({ sink: later, runs: [RUN] });
    expect(typed(later)).toEqual([]);
  });

  it("a hole (a piece lost between processes) drops the block instead of showing wrong text", async () => {
    const { hub } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [RUN] });
    hub.pushLive(text(0, "abc"));
    hub.pushLive(text(40, "xyz")); // pieces 3..40 never arrived
    expect(sink.text).toContain('"outcome":"dropped"');
    const late = new FakeSink();
    await hub.connect({ sink: late, runs: [RUN] });
    expect(typed(late)).toEqual([]);
  });

  it("scrubs known secret values out of a frame (the second barrier)", async () => {
    const { hub } = setup({
      redactLive: (value) =>
        JSON.parse(JSON.stringify(value).replaceAll("seg-redo-123", "[REDACTED:K]")),
    });
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [RUN] });
    hub.pushLive(text(0, "a chave é seg-redo-123 ok"));
    expect(sink.text).not.toContain("seg-redo-123");
    expect(typed(sink)).toEqual([[0, "a chave é [REDACTED:K] ok"]]);
    const late = new FakeSink();
    await hub.connect({ sink: late, runs: [RUN] });
    expect(late.text).not.toContain("seg-redo-123");
  });

  it("ignores a frame that does not match the contract, and never throws", async () => {
    const { hub } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [RUN] });
    const before = sink.text;
    for (const bad of [
      null,
      5,
      {},
      { type: "live.text" },
      { type: "other" },
      text(0, "x", { runId: "nope" }),
    ]) {
      expect(() => hub.pushLive(bad)).not.toThrow();
    }
    expect(sink.text).toBe(before);
  });

  it("a slow client misses frames and the next one for that block goes out whole", async () => {
    const { hub } = setup();
    await hub.start();
    const sink = new FakeSink();
    await hub.connect({ sink, runs: [RUN] });
    hub.pushLive(text(0, "um"));
    sink.pendingBytes = 10_000_000;
    hub.pushLive(text(2, " dois"));
    sink.pendingBytes = 0;
    hub.pushLive(text(7, " tres"));
    expect(typed(sink)).toEqual([
      [0, "um"],
      [0, "um dois tres"],
    ]);
  });
});
