// Owns the control channel between the worker (which owns the policy: the allowlists, the approvals,
// the database) and an egress proxy that runs in its OWN container. The worker is the one that
// connects: on Docker Desktop the proxy's control port is published on 127.0.0.1 of the computer and
// a process of the host (the Windows app's sidecar) can open a connection to it, while nothing
// reaches the host from the container's networks.
//
// One TCP connection, one JSON object per line:
//   worker -> proxy  {t:"hello", token}                the first line; wrong token: closed without a word
//   proxy  -> worker {t:"ready"}                        the worker is now THE owner of the policy
//   proxy  -> worker {t:"replaced"}                     another worker took over: do not reconnect
//   proxy  -> worker {t:"hosts?", id, subject}          "which hosts may this subject reach?"
//   worker -> proxy  {t:"hosts", id, hosts} | {t:"hosts", id, error}
//   proxy  -> worker {t:"event", id, event}             every decision, with the time as text
//   worker -> proxy  {t:"ack", id}                      a refusal is answered to the bot only after this
// The proxy decides nothing by itself: with no worker connected every host is refused
// (`policy_unavailable`), and the events wait (a bounded queue) for the next worker.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { proxyEnv, proxyUrl } from "./proxy.js";
import { RefusalSessions } from "./sessions.js";
import type {
  EgressEvent,
  EgressPolicy,
  EgressService,
  EgressSession,
  EgressSubject,
} from "./types.js";

const MAX_LINE_BYTES = 256 * 1024;
const MAX_QUEUED_EVENTS = 500;
const SUBJECT_KINDS = new Set(["bot", "connector", "harness"]);

interface WireEvent extends Omit<EgressEvent, "at"> {
  at: string;
}

/** What the proxy sends the worker. */
type ToWorker =
  | { t: "ready" }
  | { t: "replaced" }
  | { t: "hosts?"; id: string; subject: EgressSubject }
  | { t: "event"; id: string; event: WireEvent };

/** What the worker sends the proxy. */
type ToProxy =
  | { t: "hello"; token: string }
  | { t: "hosts"; id: string; hosts: string[] }
  | { t: "hosts"; id: string; error: string }
  | { t: "ack"; id: string };

/** Splits a socket's bytes into lines; a line over the limit ends the connection. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      onLine(line);
    }
    if (pending.length > MAX_LINE_BYTES) socket.destroy();
  });
}

function send(socket: Socket, message: ToWorker | ToProxy): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function toSubject(value: unknown): EgressSubject | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  if (typeof kind !== "string" || !SUBJECT_KINDS.has(kind)) return undefined;
  if (typeof id !== "string" || id === "") return undefined;
  return { kind: kind as EgressSubject["kind"], id };
}

// --- The proxy's side -------------------------------------------------------------------------

export interface ControlServerOptions {
  /** The shared secret of the channel (random, made by the worker for each start). */
  token: string;
  /** How long to wait for the worker's answer to a question. Default 5 s. */
  answerTimeoutMs?: number;
  /** How long to wait for the worker to acknowledge a refusal. Default 1.5 s. */
  ackTimeoutMs?: number;
  /** How long a new connection has to say hello. Default 5 s. */
  helloTimeoutMs?: number;
  /** For diagnostics only: never given a token, a host or a subject. */
  log?(text: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** The proxy's end: the policy it consults and the place it reports to is whoever holds the channel. */
export class ControlServer implements EgressPolicy {
  readonly #o: ControlServerOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #pending = new Map<string, Pending>();
  readonly #queue: WireEvent[] = [];
  #worker: Socket | undefined;

  constructor(options: ControlServerOptions) {
    this.#o = options;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  async listen(port: number, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    return typeof address === "object" && address !== null ? address.port : port;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get connected(): boolean {
    return this.#worker !== undefined;
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on("close", () => {
      this.#sockets.delete(socket);
      if (this.#worker === socket) {
        this.#worker = undefined;
        this.#failPending(new Error("the worker disconnected"));
        this.#o.log?.("controle: o servidor desconectou");
      }
    });
    socket.on("error", () => socket.destroy());
    let hello = false;
    const timer = setTimeout(() => {
      if (!hello) socket.destroy();
    }, this.#o.helloTimeoutMs ?? 5000);
    socket.on("close", () => clearTimeout(timer));
    lines(socket, (line) => {
      const message = parse(line);
      if (message === undefined) return socket.destroy();
      if (!hello) {
        if (message.t !== "hello" || !sameToken(message.token, this.#o.token)) {
          this.#o.log?.("controle: conexão recusada (token errado)");
          return socket.destroy();
        }
        hello = true;
        // A new owner replaces the old one (the worker restarted).
        const old = this.#worker;
        this.#worker = socket;
        if (old !== undefined && old !== socket) {
          this.#failPending(new Error("another worker took over"));
          // Say so before closing: a worker that is told it was replaced stands down for good.
          // Without this it would reconnect, take the channel back and the proxy would apply the
          // old worker's (stale) rules while the new one is the owner.
          send(old, { t: "replaced" });
          old.end();
          setTimeout(() => old.destroy(), 1000).unref();
        }
        send(socket, { t: "ready" });
        this.#o.log?.("controle: servidor conectado");
        this.#flush(socket);
        return;
      }
      if (this.#worker !== socket) return;
      const id = typeof message.id === "string" ? message.id : undefined;
      if (id === undefined) return;
      const waiting = this.#pending.get(id);
      if (waiting === undefined) return;
      this.#pending.delete(id);
      clearTimeout(waiting.timer);
      if (message.t === "hosts" || message.t === "ack") waiting.resolve(message);
      else waiting.reject(new Error("unexpected answer"));
    });
  }

  #failPending(error: Error): void {
    for (const [id, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
      this.#pending.delete(id);
    }
  }

  #ask(socket: Socket, message: ToWorker & { id: string }, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(message.id);
        reject(new Error("the worker did not answer in time"));
      }, timeoutMs);
      this.#pending.set(message.id, { resolve, reject, timer });
      send(socket, message);
    });
  }

  #flush(socket: Socket): void {
    const waiting = this.#queue.splice(0);
    for (const event of waiting) {
      void this.#ask(socket, { t: "event", id: randomUUID(), event }, this.#ackMs()).catch(() => {
        // Lost with the connection: events are a record, not a promise.
      });
    }
  }

  #ackMs(): number {
    return this.#o.ackTimeoutMs ?? 1500;
  }

  /** The policy the proxy consults: asks the worker; with none connected it rejects. */
  async allowedHosts(subject: EgressSubject): Promise<ReadonlySet<string>> {
    const socket = this.#worker;
    if (socket === undefined) throw new Error("no worker is connected");
    const answer = (await this.#ask(
      socket,
      { t: "hosts?", id: randomUUID(), subject },
      this.#o.answerTimeoutMs ?? 5000,
    )) as { hosts?: unknown; error?: unknown };
    if (!Array.isArray(answer.hosts) || answer.error !== undefined) {
      throw new Error("the worker could not give the list");
    }
    return new Set(answer.hosts.filter((h): h is string => typeof h === "string"));
  }

  /**
   * Reports a decision. A refusal waits (a little) for the worker's acknowledgement so the worker
   * has recorded it before the bot hears the answer; an allowed one is sent and forgotten. With no
   * worker connected the event waits in a bounded queue.
   */
  async report(event: EgressEvent): Promise<void> {
    const wire: WireEvent = { ...event, at: event.at.toISOString() };
    const socket = this.#worker;
    if (socket === undefined) {
      this.#queue.push(wire);
      if (this.#queue.length > MAX_QUEUED_EVENTS) this.#queue.shift();
      return;
    }
    const sent = this.#ask(socket, { t: "event", id: randomUUID(), event: wire }, this.#ackMs());
    if (event.decision === "refused") await sent.catch(() => undefined);
    else void sent.catch(() => undefined);
  }
}

// --- The worker's side ------------------------------------------------------------------------

export interface ControlClientOptions {
  /** Where the control port is (the published port, on this computer). */
  host: string;
  port: number;
  /** The channel's token (the proxy was started with the same). */
  token: string;
  /** The key the subject credentials derive from (the proxy was started with the same). */
  secret: Buffer;
  /** Where the bots' machines reach the proxy: written into their proxy settings. */
  advertise: { host: string; port: number };
  /** The allowlists: the worker's own policy. */
  policy: EgressPolicy;
  /** Every decision the proxy took. */
  onEvent?(event: EgressEvent): void;
  /** Wait between attempts to connect. Default 250 ms, growing to 2 s. */
  retryMs?: number;
  log?(text: string): void;
}

/** The worker's end: answers the proxy's questions and is the `EgressService` the executors use. */
export class ControlClient implements EgressService {
  readonly #o: ControlClientOptions;
  readonly #sessions = new RefusalSessions();
  #socket: Socket | undefined;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #ready: (() => void) | undefined;

  constructor(options: ControlClientOptions) {
    this.#o = options;
  }

  /** Connects (and keeps reconnecting); resolves when the proxy has accepted the token. */
  start(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.#ready = undefined;
        this.#stopped = true;
        this.#socket?.destroy();
        reject(new Error("o proxy de saída não aceitou a conexão de controle a tempo"));
      }, timeoutMs);
      this.#ready = () => {
        clearTimeout(deadline);
        resolve();
      };
      this.#stopped = false;
      this.#connect();
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#socket?.destroy();
  }

  get connected(): boolean {
    return this.#socket !== undefined && !this.#socket.destroyed && this.#helloDone;
  }

  #helloDone = false;

  #connect(): void {
    if (this.#stopped) return;
    const socket = connect({ host: this.#o.host, port: this.#o.port });
    this.#socket = socket;
    this.#helloDone = false;
    socket.on("connect", () => send(socket, { t: "hello", token: this.#o.token }));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.#socket === socket) this.#helloDone = false;
      if (this.#stopped) return;
      const wait = Math.min(2000, (this.#o.retryMs ?? 250) * 2 ** Math.min(this.#attempt++, 4));
      this.#timer = setTimeout(() => this.#connect(), wait);
    });
    lines(socket, (line) => void this.#onLine(socket, line));
  }

  async #onLine(socket: Socket, line: string): Promise<void> {
    const message = parse(line);
    if (message === undefined) return;
    if (message.t === "replaced") {
      // Another worker owns the policy now. Stand down: reconnecting would take the channel back
      // from it and put this worker's rules in force again.
      this.#helloDone = false;
      this.stop();
      this.#o.log?.("controle: outro servidor assumiu o proxy; este parou de reconectar");
      return;
    }
    if (message.t === "ready") {
      this.#helloDone = true;
      this.#attempt = 0;
      this.#ready?.();
      this.#ready = undefined;
      return;
    }
    const id = typeof message.id === "string" ? message.id : undefined;
    if (id === undefined) return;
    if (message.t === "hosts?") {
      const subject = toSubject(message.subject);
      if (subject === undefined) return send(socket, { t: "hosts", id, error: "bad subject" });
      try {
        const hosts = await this.#o.policy.allowedHosts(subject);
        send(socket, { t: "hosts", id, hosts: [...hosts] });
      } catch {
        send(socket, { t: "hosts", id, error: "policy failed" });
      }
    } else if (message.t === "event") {
      const event = this.#readEvent(message.event);
      if (event !== undefined) {
        if (event.decision === "refused") {
          this.#sessions.refused(event.subject, {
            host: event.host,
            port: event.port,
            reason: event.reason ?? "refused",
            message: event.message ?? `host ${event.host} is not allowed`,
          });
        }
        try {
          this.#o.onEvent?.(event);
        } catch {
          // Recording failed; the decision stands.
        }
      }
      send(socket, { t: "ack", id });
    }
  }

  #readEvent(value: unknown): EgressEvent | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const e = value as Record<string, unknown>;
    const subject = toSubject(e.subject);
    const at = typeof e.at === "string" ? new Date(e.at) : undefined;
    if (
      subject === undefined ||
      typeof e.host !== "string" ||
      typeof e.port !== "number" ||
      (e.decision !== "allowed" && e.decision !== "refused") ||
      at === undefined ||
      Number.isNaN(at.getTime())
    ) {
      return undefined;
    }
    return {
      subject,
      host: e.host,
      port: e.port,
      decision: e.decision,
      ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
      ...(typeof e.message === "string" ? { message: e.message } : {}),
      at,
    };
  }

  open(subject: EgressSubject): EgressSession {
    const window = this.#sessions.open(subject);
    return { env: this.envFor(subject), close: () => window.close() };
  }

  envFor(subject: EgressSubject): Record<string, string> {
    return proxyEnv(
      proxyUrl(this.#o.secret, subject, this.#o.advertise.host, this.#o.advertise.port),
    );
  }
}
