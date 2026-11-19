// The realtime hub: one per server process. It follows the change log of the database (woken by
// NOTIFY, with a periodic poll as the safety net), turns each change into stream events, and
// delivers them to the connected clients. It knows nothing of HTTP or Postgres: those are ports,
// so everything here is testable with fakes and a fake clock.
import type { RESYNC_REASONS, StreamEventType } from "@suup/api";

/** A change as the log gives it: ids only, in the order the transactions became visible. */
export interface ChangeRef {
  id: number;
}

/** An event the stream sends (the frame's id comes from the change that produced it). */
export interface WireEvent {
  type: StreamEventType;
  data: unknown;
  /** For `run.event`: the run, so the hub can leave it out for clients that did not ask for it. */
  runId?: string;
  /**
   * For snapshot events (a row's current state): which row (`kind:id`) and how new the state is
   * (a number that only grows with the row's changes, e.g. its `updated_at`). The hub never sends a
   * client a state older than one it already sent for the same row, which could otherwise happen
   * when a replay (read later) and a buffered live frame (read earlier) meet.
   */
  key?: string;
  version?: number;
}

/** The events one change (or several that were merged) produced, under the id of the last of them. */
export interface Resolved {
  id: number;
  events: WireEvent[];
}

/** What the hub needs from the database. */
export interface ChangeSource<C extends ChangeRef = ChangeRef> {
  /** The highest change id the log knows, and the highest it has already thrown away. */
  bounds(): Promise<{ newest: number; prunedThrough: number }>;
  /** Changes after `afterId`, oldest first. */
  read(afterId: number, limit: number): Promise<C[]>;
  /**
   * The events of these changes, by reading the rows they point at. Changes whose row is gone
   * produce nothing. `wantRun` says whether anyone follows the events of a run: when not, the
   * source need not read them.
   */
  resolve(changes: C[], wantRun: (runId: string) => boolean): Promise<Resolved[]>;
}

/** Whatever wakes the hub when something changed (Postgres NOTIFY). */
export interface Notifier {
  /** Starts listening; `wake` is called on every notification and after every reconnection. */
  start(wake: () => void): Promise<void>;
  stop(): Promise<void>;
}

export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realClock: Clock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One client's end of the connection. */
export interface Sink {
  /** Queues text for the client. `false`: the transport's buffer is full (back-pressure). */
  write(chunk: string): boolean;
  /** Bytes queued and not yet sent to the client. */
  readonly pendingBytes: number;
  /** Closes the connection. */
  end(): void;
}

export interface HubOptions<C extends ChangeRef> {
  source: ChangeSource<C>;
  notifier: Notifier;
  clock?: Clock;
  /** Most concurrent streams. Default 16. */
  maxStreams?: number;
  /** A client with more than this queued is dropped (it reconnects and resumes). Default 1 MiB. */
  maxPendingBytes?: number;
  /** A comment frame this often keeps proxies and the client's idle timer quiet. Default 15 s. */
  keepAliveMs?: number;
  /** The safety-net poll, in case a notification is lost. Default 2 s. */
  pollMs?: number;
  /** Changes read at a time. Default 200. */
  batch?: number;
  /** A client that missed more changes than this is told to reload instead of replayed. Default 5000. */
  maxReplay?: number;
  /** `retry:` the server suggests to `EventSource`-like clients, in ms. Default 3000. */
  retryMs?: number;
  onError?(error: unknown, context: string): void;
  onDrop?(reason: "slow_consumer" | "replay_failed"): void;
}

export class StreamLimitError extends Error {
  override readonly name = "StreamLimitError";
  constructor(readonly max: number) {
    super(`O servidor já atende ${max} streams ao mesmo tempo.`);
  }
}

type Resync = (typeof RESYNC_REASONS)[number];

interface Client {
  sink: Sink;
  runs: ReadonlySet<string>;
  /** Changes with an id up to this one the client already has. */
  floor: number;
  /** Replaying: live frames wait here until the replay is done. */
  buffer: { text: string; event: WireEvent }[] | null;
  bufferBytes: number;
  /** The newest version sent per snapshot row (see `WireEvent.version`). */
  sent: Map<string, number>;
  closed: boolean;
}

/** `id: N` + `event: T` + `data: <json>`, the frame of the stream. */
export function frame(type: string, data: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class StreamHub<C extends ChangeRef = ChangeRef> {
  readonly #source: ChangeSource<C>;
  readonly #notifier: Notifier;
  readonly #clock: Clock;
  readonly #maxStreams: number;
  readonly #maxPending: number;
  readonly #keepAliveMs: number;
  readonly #pollMs: number;
  readonly #batch: number;
  readonly #maxReplay: number;
  readonly #retryMs: number;
  readonly #onError: (error: unknown, context: string) => void;
  readonly #onDrop: (reason: "slow_consumer" | "replay_failed") => void;
  readonly #clients = new Set<Client>();

  #cursor = 0;
  #started = false;
  #stopped = false;
  #polling: Promise<void> | undefined;
  #again = false;
  #timers: unknown[] = [];

  constructor(options: HubOptions<C>) {
    this.#source = options.source;
    this.#notifier = options.notifier;
    this.#clock = options.clock ?? realClock;
    this.#maxStreams = options.maxStreams ?? 16;
    this.#maxPending = options.maxPendingBytes ?? 1_048_576;
    this.#keepAliveMs = options.keepAliveMs ?? 15_000;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#batch = options.batch ?? 200;
    this.#maxReplay = options.maxReplay ?? 5_000;
    this.#retryMs = options.retryMs ?? 3_000;
    this.#onError = options.onError ?? (() => {});
    this.#onDrop = options.onDrop ?? (() => {});
  }

  /** The id of the last change delivered (what a new client without `Last-Event-ID` starts after). */
  get cursor(): number {
    return this.#cursor;
  }

  get size(): number {
    return this.#clients.size;
  }

  /** Starts following the log from its current end. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#cursor = (await this.#source.bounds()).newest;
    await this.#notifier.start(() => this.wake());
    this.#timers.push(this.#clock.setInterval(() => this.wake(), this.#pollMs));
    this.#timers.push(this.#clock.setInterval(() => this.#keepAlive(), this.#keepAliveMs));
    this.wake(); // anything written while we were starting
  }

  /** Ends every stream and stops following. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#timers.splice(0)) this.#clock.clearInterval(timer);
    for (const client of [...this.#clients]) this.#close(client);
    await this.#notifier.stop().catch(() => {});
    await this.#polling?.catch(() => {});
  }

  /** Asks for a look at the log (a notification arrived, or the poll timer fired). */
  wake(): void {
    if (this.#stopped || !this.#started) return;
    if (this.#polling !== undefined) {
      this.#again = true;
      return;
    }
    this.#polling = this.#poll().finally(() => {
      this.#polling = undefined;
      if (this.#again) {
        this.#again = false;
        this.wake();
      }
    });
  }

  async #poll(): Promise<void> {
    try {
      for (;;) {
        const changes = await this.#source.read(this.#cursor, this.#batch);
        if (changes.length === 0) return;
        const wanted = new Set<string>();
        for (const client of this.#clients) for (const run of client.runs) wanted.add(run);
        const resolved = await this.#source.resolve(changes, (run) => wanted.has(run));
        // Deliver and advance in the same tick: a client that connects takes `cursor` as its
        // starting point and must see every later change as a live one.
        for (const item of resolved) this.#deliver(item);
        this.#cursor = (changes[changes.length - 1] as C).id;
        if (changes.length < this.#batch) return;
      }
    } catch (error) {
      this.#onError(error, "following the change log");
    }
  }

  #deliver(item: Resolved): void {
    for (const client of [...this.#clients]) {
      if (client.closed || item.id <= client.floor) continue;
      for (const event of item.events) {
        if (
          event.type === "run.event" &&
          !(event.runId !== undefined && client.runs.has(event.runId))
        ) {
          continue;
        }
        // A replaying client checks freshness when its buffer is flushed (after the replay).
        if (client.buffer === null && !this.#fresh(client, event)) continue;
        this.#send(client, frame(event.type, event.data, item.id), event);
        if (client.closed) break;
      }
    }
  }

  /** False for a snapshot older than one this client already got (and records the newer one). */
  #fresh(client: Client, event: WireEvent): boolean {
    if (event.key === undefined || event.version === undefined) return true;
    const seen = client.sent.get(event.key);
    if (seen !== undefined && event.version < seen) return false;
    if (client.sent.size > 20_000) client.sent.clear();
    client.sent.set(event.key, event.version);
    return true;
  }

  #send(client: Client, text: string, event: WireEvent): void {
    if (client.closed) return;
    if (client.buffer !== null) {
      client.buffer.push({ text, event });
      client.bufferBytes += text.length;
      if (client.bufferBytes > this.#maxPending) this.#drop(client, "slow_consumer");
      return;
    }
    if (client.sink.pendingBytes + text.length > this.#maxPending) {
      this.#drop(client, "slow_consumer");
      return;
    }
    client.sink.write(text);
  }

  #drop(client: Client, reason: "slow_consumer" | "replay_failed"): void {
    if (client.closed) return;
    this.#onDrop(reason);
    this.#close(client);
  }

  #close(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    client.buffer = null;
    this.#clients.delete(client);
    try {
      client.sink.end();
    } catch {
      // already gone
    }
  }

  #keepAlive(): void {
    for (const client of [...this.#clients]) {
      if (client.sink.pendingBytes > this.#maxPending) {
        this.#drop(client, "slow_consumer");
        continue;
      }
      client.sink.write(": ping\n\n");
    }
  }

  /** The client went away (the socket closed): forget it. */
  disconnect(sink: Sink): void {
    for (const client of this.#clients) if (client.sink === sink) this.#close(client);
  }

  /**
   * Adds a client. Writes `ready`, then, when it comes with `lastEventId`, replays what it missed
   * (or says `resync` when that is not possible), then follows live. Throws `StreamLimitError`
   * before writing anything when the server is full.
   */
  async connect(options: {
    sink: Sink;
    runs: readonly string[];
    lastEventId?: number | undefined;
  }): Promise<void> {
    if (this.#clients.size >= this.#maxStreams) throw new StreamLimitError(this.#maxStreams);
    const head = this.#cursor;
    const client: Client = {
      sink: options.sink,
      runs: new Set(options.runs),
      floor: options.lastEventId ?? head,
      buffer: [],
      bufferBytes: 0,
      sent: new Map(),
      closed: false,
    };
    // Registered before anything is awaited: from now on a live change is buffered, not lost.
    this.#clients.add(client);
    const { lastEventId } = options;
    let resync: Resync | undefined;
    let replayFrom: number | undefined;
    if (lastEventId !== undefined) {
      try {
        const bounds = await this.#source.bounds();
        if (lastEventId < bounds.prunedThrough) resync = "too_old";
        else if (lastEventId > bounds.newest) resync = "unknown_id";
        else if (head - lastEventId > this.#maxReplay) resync = "too_many";
        else if (lastEventId < head) replayFrom = lastEventId;
      } catch (error) {
        this.#onError(error, "checking where a client resumes");
        resync = "too_many";
      }
    }
    if (resync !== undefined) client.floor = head; // nothing older is replayed
    if (client.closed) return;
    client.sink.write(`retry: ${this.#retryMs}\n\n`);
    client.sink.write(
      frame("ready", { head, resync: resync !== undefined, runs: [...client.runs] }),
    );
    if (resync !== undefined) client.sink.write(frame("resync", { reason: resync }));

    if (replayFrom !== undefined) {
      try {
        await this.#replay(client, replayFrom, head);
      } catch (error) {
        this.#onError(error, "replaying to a client");
        return this.#drop(client, "replay_failed");
      }
    }
    if (client.closed) return;
    const buffered = client.buffer ?? [];
    client.buffer = null;
    for (const { text, event } of buffered) {
      if (!this.#fresh(client, event)) continue;
      if (client.sink.pendingBytes + text.length > this.#maxPending)
        return this.#drop(client, "slow_consumer");
      client.sink.write(text);
    }
  }

  async #replay(client: Client, from: number, upTo: number): Promise<void> {
    let cursor = from;
    while (cursor < upTo && !client.closed) {
      const changes = (await this.#source.read(cursor, this.#batch)).filter((c) => c.id <= upTo);
      if (changes.length === 0) return;
      const resolved = await this.#source.resolve(changes, (run) => client.runs.has(run));
      for (const item of resolved) {
        for (const event of item.events) {
          if (
            event.type === "run.event" &&
            !(event.runId !== undefined && client.runs.has(event.runId))
          )
            continue;
          if (client.closed) return;
          if (client.sink.pendingBytes > this.#maxPending)
            return this.#drop(client, "slow_consumer");
          if (!this.#fresh(client, event)) continue;
          client.sink.write(frame(event.type, event.data, item.id));
        }
      }
      cursor = (changes[changes.length - 1] as C).id;
    }
  }
}
