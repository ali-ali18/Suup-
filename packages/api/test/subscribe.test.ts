import { describe, expect, it } from "vitest";
import {
  type ApiError,
  type StreamEvent,
  type SubscribeOptions,
  subscribe,
  type Timers,
} from "../src/index.js";

// The subscription's reconnect logic against a fetch whose streams the test controls, and timers
// that fire only when told. No real network and no real time.

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

class FakeTimers implements Timers {
  scheduled: { id: number; fn: () => void; ms: number; live: boolean }[] = [];
  #next = 1;
  randomValue = 0.5; // the middle of the jitter range: x1.0
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.scheduled.push({ id, fn, ms, live: true });
    return id;
  }
  clearTimeout(handle: unknown): void {
    const t = this.scheduled.find((s) => s.id === handle);
    if (t !== undefined) t.live = false;
  }
  random(): number {
    return this.randomValue;
  }
  /** The live timers, oldest first. */
  get pending() {
    return this.scheduled.filter((t) => t.live);
  }
  /** Fires the live timer with this delay. */
  async fire(ms: number): Promise<void> {
    const t = this.pending.find((s) => s.ms === ms);
    if (t === undefined)
      throw new Error(
        `no live timer of ${ms} ms (have ${this.pending.map((p) => p.ms).join(", ")})`,
      );
    t.live = false;
    t.fn();
    await flush();
  }
}

interface Connection {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  push(text: string): void;
  end(): void;
  fail(error: Error): void;
}

function fakeFetch() {
  const connections: Connection[] = [];
  const queue: (() => Response | Promise<Response>)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const next = queue.shift();
    if (next !== undefined) return next();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const signal = init?.signal as AbortSignal;
    const encoder = new TextEncoder();
    const connection: Connection = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      signal,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      fail: (error) => controller.error(error),
    };
    connections.push(connection);
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // already closed
      }
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetchImpl, connections, queue };
}

const READY = (head: number, extra: Record<string, unknown> = {}) =>
  `event: ready\ndata: ${JSON.stringify({ head, resync: false, runs: [], ...extra })}\n\n`;
const MSG = (id: number) =>
  `id: ${id}\nevent: bot.updated\ndata: ${JSON.stringify({ bot: bot(id) })}\n\n`;
const bot = (n: number) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: `b${n}`,
  description: "",
  personality: "",
  modelProvider: "p",
  modelId: "m",
  allowedTools: [],
  limits: {},
  avatar: null,
  isDefault: false,
  createdAt: "2026-11-18T20:00:00.000Z",
  updatedAt: "2026-11-18T20:00:00.000Z",
  archivedAt: null,
  latestRun: null,
  conversationId: null,
  unreadCount: 0,
});

function setup(
  options: Partial<SubscribeOptions> = {},
  answers: (() => Response | Promise<Response>)[] = [],
) {
  const f = fakeFetch();
  f.queue.push(...answers);
  const timers = new FakeTimers();
  const events: StreamEvent[] = [];
  const errors: ApiError[] = [];
  const statuses: string[] = [];
  const closed: (ApiError | undefined)[] = [];
  const sub = subscribe(
    { baseUrl: "http://server/", token: "tok", fetch: f.fetchImpl, timers },
    {
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
      onStatus: (s) => statuses.push(s),
      onClose: (e) => closed.push(e),
      ...options,
    },
  );
  return { ...f, timers, events, errors, statuses, closed, sub };
}

describe("subscribe", () => {
  it("connects with the token in a header, asks for the runs in the query, and tracks the last id", async () => {
    const t = setup({ runs: ["b", "a", "a"] });
    await flush();
    const c = t.connections[0] as Connection;
    expect(c.url).toBe("http://server/v1/stream?runs=b%2Ca");
    expect(c.headers).toMatchObject({ Authorization: "Bearer tok", Accept: "text/event-stream" });
    expect(c.headers["Last-Event-ID"]).toBeUndefined(); // a first connection starts from now
    expect(t.sub.status).toBe("connecting");

    c.push(`retry: 3000\n\n${READY(40)}`);
    await flush();
    expect(t.sub.status).toBe("open");
    expect(t.sub.lastEventId).toBe(40); // nothing seen yet: the head it was told is where it is
    c.push(MSG(41) + MSG(42));
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(["ready", "bot.updated", "bot.updated"]);
    expect(t.sub.lastEventId).toBe(42);
    expect(t.errors).toEqual([]);
  });

  it("reconnects after the connection ends, resuming from the last id, with a growing pause that resets once it is back", async () => {
    const t = setup();
    await flush();
    t.connections[0]?.push(READY(10) + MSG(11));
    await flush();
    t.connections[0]?.end(); // the server went away
    await flush();
    expect(t.sub.status).toBe("reconnecting");
    expect(t.errors.at(-1)?.code).toBe("network");
    expect(t.timers.pending.map((p) => p.ms)).toContain(500);
    await t.timers.fire(500);
    const second = t.connections[1] as Connection;
    expect(second.headers["Last-Event-ID"]).toBe("11");

    // It fails again before the server answers: the pause doubles (jitter at the middle: x1.0).
    second.fail(new Error("reset"));
    await flush();
    await t.timers.fire(1000);
    t.connections[2]?.fail(new Error("reset"));
    await flush();
    await t.timers.fire(2000);
    // Back for good: the pause starts over.
    t.connections[3]?.push(READY(11));
    await flush();
    t.connections[3]?.end();
    await flush();
    await t.timers.fire(500);
    expect(t.connections).toHaveLength(5);
    expect(t.connections[4]?.headers["Last-Event-ID"]).toBe("11");
  });

  it("caps the pause, and spreads it with jitter", async () => {
    const t = setup({ backoff: { minMs: 100, maxMs: 400 } });
    t.timers.randomValue = 0; // x0.8
    await flush();
    t.connections[0]?.fail(new Error("x"));
    await flush();
    await t.timers.fire(80); // 100 * 0.8
    t.connections[1]?.fail(new Error("x"));
    await flush();
    await t.timers.fire(160);
    t.connections[2]?.fail(new Error("x"));
    await flush();
    await t.timers.fire(320);
    t.connections[3]?.fail(new Error("x"));
    await flush();
    t.timers.randomValue = 0.999; // x1.2
    t.connections[4]?.fail(new Error("x"));
    await t.timers.fire(320); // 400 (the cap) * 0.8, from the pending retry before the jitter changed
    await flush();
    expect(t.connections.length).toBeGreaterThanOrEqual(5);
  });

  it("an answer with an error body is reported and retried; unauthorized or origin_not_allowed end it for good", async () => {
    const t = setup({}, [
      () =>
        Response.json({ error: { code: "too_many_streams", message: "cheio" } }, { status: 429 }),
    ]);
    await flush();
    expect(t.errors.map((e) => [e.code, e.status])).toEqual([["too_many_streams", 429]]);
    expect(t.sub.status).toBe("reconnecting");
    t.queue.push(() =>
      Response.json({ error: { code: "unauthorized", message: "token errado" } }, { status: 401 }),
    );
    await t.timers.fire(500);
    expect(t.sub.status).toBe("closed");
    expect(t.closed[0]).toMatchObject({ code: "unauthorized", message: "token errado" });
    expect(t.timers.pending.map((p) => p.ms)).not.toContain(500);
    await flush();
    expect(t.connections).toHaveLength(0); // never reached a stream

    const t2 = setup({}, [
      () =>
        Response.json(
          { error: { code: "origin_not_allowed", message: "origem" } },
          { status: 403 },
        ),
    ]);
    await flush();
    expect(t2.sub.status).toBe("closed");

    const t3 = setup({}, [() => new Response("<html>bad gateway</html>", { status: 502 })]);
    await flush();
    expect(t3.errors[0]).toMatchObject({ code: "invalid_response", status: 502 });
    expect(t3.sub.status).toBe("reconnecting"); // a proxy hiccup is retried
  });

  it("setRuns reopens the connection at once with the new list, resuming from the last id; the same list does nothing", async () => {
    const t = setup({ runs: ["a"] });
    await flush();
    t.connections[0]?.push(READY(5) + MSG(6));
    await flush();
    t.sub.setRuns(["a"]);
    t.sub.setRuns(["a", "a"]);
    await flush();
    expect(t.connections).toHaveLength(1);

    t.sub.setRuns(["a", "b"]);
    await flush();
    expect(t.connections[0]?.signal.aborted).toBe(true);
    expect(t.connections).toHaveLength(2);
    expect(t.connections[1]?.url).toBe("http://server/v1/stream?runs=a%2Cb");
    expect(t.connections[1]?.headers["Last-Event-ID"]).toBe("6");
    expect(t.errors).toEqual([]); // on purpose: not reported as a failure
    expect(t.sub.runs).toEqual(["a", "b"]);

    t.sub.setRuns([]);
    await flush();
    expect(t.connections[2]?.url).toBe("http://server/v1/stream");
  });

  it("setRuns while waiting to reconnect connects right away", async () => {
    const t = setup();
    await flush();
    t.connections[0]?.fail(new Error("gone"));
    await flush();
    expect(t.sub.status).toBe("reconnecting");
    t.sub.setRuns(["x"]);
    await flush();
    expect(t.connections).toHaveLength(2);
    expect(t.connections[1]?.url).toContain("runs=x");
    expect(t.timers.pending.map((p) => p.ms)).not.toContain(500); // the retry timer is gone
  });

  it("a connection that goes silent past the idle timeout is dropped and reopened", async () => {
    const t = setup({ idleTimeoutMs: 45_000 });
    await flush();
    t.connections[0]?.push(READY(1));
    await flush();
    const idle = t.timers.pending.find((p) => p.ms === 45_000);
    expect(idle).toBeDefined();
    // A keep-alive comment is a sign of life: it restarts the timer.
    t.connections[0]?.push(": ping\n\n");
    await flush();
    expect(t.timers.pending.filter((p) => p.ms === 45_000)).toHaveLength(1);
    expect(idle?.live).toBe(false);
    await t.timers.fire(45_000);
    expect(t.connections[0]?.signal.aborted).toBe(true);
    await flush();
    expect(t.sub.status).toBe("reconnecting");
    expect(t.errors.at(-1)?.message).toMatch(/sem sinais/);
    await t.timers.fire(500);
    expect(t.connections).toHaveLength(2);
  });

  it("delivers a resync event and, after it, resumes from the head the server named", async () => {
    const t = setup({ lastEventId: 3 });
    await flush();
    expect(t.connections[0]?.headers["Last-Event-ID"]).toBe("3");
    t.connections[0]?.push(
      `${READY(90, { resync: true })}event: resync\ndata: {"reason":"too_old"}\n\n`,
    );
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(["ready", "resync"]);
    expect(t.sub.lastEventId).toBe(90);
    t.connections[0]?.end();
    await flush();
    await t.timers.fire(500);
    expect(t.connections[1]?.headers["Last-Event-ID"]).toBe("90");
  });

  it("keeps its own last id on a resumed connection (it does not move back to the head)", async () => {
    const t = setup({ lastEventId: 20 });
    await flush();
    t.connections[0]?.push(READY(80) + MSG(21));
    await flush();
    expect(t.sub.lastEventId).toBe(21);
  });

  it("never delivers an id it already delivered", async () => {
    const t = setup();
    await flush();
    t.connections[0]?.push(READY(1) + MSG(2) + MSG(3) + MSG(3) + MSG(2) + MSG(4));
    await flush();
    expect(t.events.flatMap((e) => (e.id === undefined ? [] : [e.id]))).toEqual([2, 3, 4]);
  });

  it("skips and reports frames outside the contract, and goes on", async () => {
    const t = setup();
    await flush();
    t.connections[0]?.push(
      `${READY(1)}id: 2\nevent: bot.updated\ndata: {"bot": 5}\n\nid: 3\nevent: made.up\ndata: {}\n\nid: 4\nevent: bot.updated\ndata: {oops\n\n${MSG(5)}`,
    );
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(["ready", "bot.updated"]);
    expect(t.errors).toHaveLength(3);
    expect(t.errors.every((e) => e.code === "invalid_response")).toBe(true);
    expect(t.sub.lastEventId).toBe(5);
    expect(t.sub.status).toBe("open");
  });

  it("a listener that throws does not break the stream", async () => {
    let calls = 0;
    const t = setup({
      onEvent: () => {
        calls += 1;
        throw new Error("listener bug");
      },
    });
    await flush();
    t.connections[0]?.push(READY(1) + MSG(2));
    await flush();
    expect(calls).toBe(2);
    expect(t.errors.map((e) => e.message)).toEqual([
      expect.stringContaining("listener bug"),
      expect.stringContaining("listener bug"),
    ]);
    expect(t.sub.status).toBe("open");
  });

  it("close() ends the connection and every retry; so does an abort signal", async () => {
    const t = setup();
    await flush();
    t.connections[0]?.push(READY(1));
    await flush();
    t.sub.close();
    expect(t.connections[0]?.signal.aborted).toBe(true);
    expect(t.sub.status).toBe("closed");
    expect(t.closed).toEqual([undefined]);
    await flush();
    expect(t.timers.pending).toEqual([]);
    expect(t.connections).toHaveLength(1);
    t.sub.setRuns(["z"]); // after close: nothing
    await flush();
    expect(t.connections).toHaveLength(1);

    const controller = new AbortController();
    const t2 = setup({ signal: controller.signal });
    await flush();
    controller.abort();
    await flush();
    expect(t2.sub.status).toBe("closed");
    const pre = new AbortController();
    pre.abort();
    const t3 = setup({ signal: pre.signal });
    await flush();
    expect(t3.connections).toHaveLength(0);
    expect(t3.sub.status).toBe("closed");
  });
});
