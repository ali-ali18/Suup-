import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ControlClient,
  chooseAddresses,
  type EgressEvent,
  type EgressPolicy,
  type EgressSubject,
  inSubnet,
  type RunningEgressService,
  startEgressService,
} from "../src/index.js";

// The control channel without Docker: the proxy service (what runs in the container) and the
// worker's client talk over loopback; a fake upstream and a fake resolver stand in for the internet.
const BOT: EgressSubject = { kind: "bot", id: "11111111-1111-4111-8111-111111111111" };
const TOKEN = randomBytes(32).toString("hex");
const SECRET = randomBytes(32);

let upstream: Server;
let upstreamPort = 0;
const services: RunningEgressService[] = [];
const closers: (() => Promise<void>)[] = [];
const clients: ControlClient[] = [];
// How many times each test that a race can break runs. Under `repeats` a failure shows up in the
// ordinary test run (CI included), not only in a loop someone remembers to run.
const RACE_REPEATS = Number(process.env.RACE_REPEATS ?? 50);
const logs: string[] = [];

beforeAll(async () => {
  upstream = createServer((_req, res) => res.end("reached"));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});
beforeEach(() => {
  logs.length = 0;
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const close of closers.splice(0)) await close();
  for (const running of services.splice(0)) await running.stop();
});

async function boot(
  extra: { answerTimeoutMs?: number; ackTimeoutMs?: number; helloTimeoutMs?: number } = {},
) {
  const running = await startEgressService({
    controlToken: TOKEN,
    secret: SECRET,
    proxyHost: "127.0.0.1",
    controlHost: "127.0.0.1",
    proxyPort: 0,
    controlPort: 0,
    resolver: { resolve: async () => ["93.184.216.34"] },
    dial: () => connect({ host: "127.0.0.1", port: upstreamPort }),
    log: (t) => logs.push(t),
    ...extra,
  });
  services.push(running);
  return running;
}

/** Resolves when `log` is called with text that contains `needle` (an event, not a sleep). */
function logWatcher() {
  const seen: string[] = [];
  const waiting: { needle: string; resolve: () => void }[] = [];
  return {
    seen,
    log(text: string) {
      seen.push(text);
      for (const w of [...waiting]) {
        if (text.includes(w.needle)) {
          waiting.splice(waiting.indexOf(w), 1);
          w.resolve();
        }
      }
    },
    when(needle: string): Promise<void> {
      if (seen.some((t) => t.includes(needle))) return Promise.resolve();
      return new Promise((resolve) => waiting.push({ needle, resolve }));
    },
  };
}

/**
 * A TCP relay between a worker and a proxy's control port that the test controls: it can hold new
 * connections at a gate, cut the worker's side only (the proxy still sees the link as alive, like a
 * link that dropped without the proxy noticing yet), and be pointed at another proxy.
 */
async function relayTo(initialPort: number) {
  let target = initialPort;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  let swallow = false;
  const inbound = new Set<Socket>();
  const outbound = new Set<Socket>();
  const server = createNetServer((from) => {
    inbound.add(from);
    from.on("error", () => from.destroy());
    from.pause();
    void gate.then(() => {
      if (from.destroyed) return;
      const to = connect({ host: "127.0.0.1", port: target });
      outbound.add(to);
      to.on("error", () => from.destroy());
      from.on("close", () => to.destroy());
      to.on("close", () => from.destroy());
      from.pipe(to);
      to.on("data", (chunk) => {
        if (!swallow) from.write(chunk);
      });
      from.resume();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(async () => {
    for (const socket of [...inbound, ...outbound]) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return {
    port: (server.address() as { port: number }).port,
    /** New connections wait until `release()`. */
    hold() {
      gate = new Promise<void>((r) => {
        open = r;
      });
    },
    release: () => open(),
    /** What the proxy says is thrown away (the worker never reads it) while this is on. */
    swallowReplies(on: boolean) {
      swallow = on;
    },
    retarget(port: number) {
      target = port;
    },
    /** The worker's side drops; the proxy's side of the link is left as it is. */
    cutWorkerSide() {
      for (const socket of inbound) socket.destroy();
      inbound.clear();
    },
    /** Both sides drop (the proxy notices). */
    cutAll() {
      for (const socket of [...inbound, ...outbound]) socket.destroy();
      inbound.clear();
      outbound.clear();
    },
  };
}

function viaRelay(
  running: RunningEgressService,
  relayPort: number,
  policy: EgressPolicy,
  log?: (text: string) => void,
): ControlClient {
  const client = new ControlClient({
    host: "127.0.0.1",
    port: relayPort,
    token: TOKEN,
    secret: SECRET,
    advertise: { host: "127.0.0.1", port: running.proxyPort },
    policy,
    retryMs: 20,
    ...(log === undefined ? {} : { log }),
  });
  clients.push(client);
  return client;
}

function worker(
  running: RunningEgressService,
  policy: EgressPolicy,
  over: { token?: string; events?: EgressEvent[]; log?: (text: string) => void } = {},
): ControlClient {
  const client = new ControlClient({
    host: "127.0.0.1",
    port: running.controlPort,
    token: over.token ?? TOKEN,
    secret: SECRET,
    advertise: { host: "127.0.0.1", port: running.proxyPort },
    policy,
    onEvent: (e) => over.events?.push(e),
    retryMs: 20,
    ...(over.log === undefined ? {} : { log: over.log }),
  });
  clients.push(client);
  return client;
}

const allow = (...hosts: string[]): EgressPolicy => ({
  allowedHosts: async () => new Set(hosts),
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits (by polling the proxy's log, which is appended synchronously) for `count` lines. */
async function logsHave(needle: string, count: number): Promise<void> {
  for (let i = 0; i < 1000 && logs.filter((t) => t.includes(needle)).length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function get(client: ControlClient, port: number, url: string, subject = BOT) {
  const target = new URL(url);
  const auth = new URL(client.envFor(subject).HTTP_PROXY ?? "");
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: url,
      headers: {
        host: target.host,
        "proxy-authorization": `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("control channel: authentication", () => {
  it("closes a connection with the wrong token without saying why, and never logs a token", async () => {
    const running = await boot();
    const wrong = worker(running, allow("allowed.example.com"), { token: "x".repeat(64) });
    await expect(wrong.start(300)).rejects.toThrow("conexão de controle");
    expect(running.control.connected).toBe(false);
    const right = worker(running, allow("allowed.example.com"));
    await right.start(2000);
    expect(running.control.connected).toBe(true);
    const text = logs.join("\n");
    expect(text).toContain("token errado");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("xxxxxxxx");
  });

  it("does not answer a first line that is not a hello (the proxy asks nothing of strangers)", async () => {
    const running = await boot();
    const got = await new Promise<string>((resolve) => {
      const s = connect({ host: "127.0.0.1", port: running.controlPort });
      let data = "";
      s.on("data", (c) => {
        data += c;
      });
      s.on("close", () => resolve(data));
      s.on("connect", () => s.write('{"t":"hosts","id":"1","hosts":["evil.example.com"]}\n'));
    });
    expect(got).toBe("");
    expect(running.control.connected).toBe(false);
  });

  it("refuses a bot credential that this proxy did not issue", async () => {
    const running = await boot();
    const client = worker(running, allow("allowed.example.com"));
    await client.start(2000);
    const other = new ControlClient({
      host: "127.0.0.1",
      port: running.controlPort,
      token: TOKEN,
      secret: randomBytes(32),
      advertise: { host: "127.0.0.1", port: running.proxyPort },
      policy: allow(),
    });
    expect((await get(other, running.proxyPort, "http://allowed.example.com/")).status).toBe(407);
    expect((await get(client, running.proxyPort, "http://allowed.example.com/")).status).toBe(200);
  });
});

describe("control channel: decisions stay with the worker", () => {
  it("allows by exact host and refuses the rest, with the refusal in the command's window", async () => {
    const running = await boot();
    const events: EgressEvent[] = [];
    const client = worker(running, allow("allowed.example.com"), { events });
    await client.start(2000);
    const window = client.open(BOT);
    const ok = await get(client, running.proxyPort, "http://allowed.example.com/");
    expect(ok).toEqual({ status: 200, body: "reached" });
    const sibling = await get(client, running.proxyPort, "http://x.allowed.example.com/");
    expect(sibling.status).toBe(403);
    const refusals = window.close();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ host: "x.allowed.example.com", reason: "not_allowed" });
    expect(refusals[0]?.message).toContain("is not allowed");
    const refused = events.find((e) => e.decision === "refused");
    expect(refused).toMatchObject({ subject: BOT, host: "x.allowed.example.com", port: 80 });
    expect(refused?.at).toBeInstanceOf(Date);
    // the allowed one is reported too (fire and forget: give it a moment)
    for (let i = 0; i < 50 && !events.some((e) => e.decision === "allowed"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.find((e) => e.decision === "allowed")).toMatchObject({
      host: "allowed.example.com",
    });
  });

  it("asks the worker every time: an approval opens a host at once, and closes it again", async () => {
    const running = await boot();
    const hosts = new Set<string>();
    const client = worker(running, { allowedHosts: async () => new Set(hosts) });
    await client.start(2000);
    expect((await get(client, running.proxyPort, "http://new.example.com/")).status).toBe(403);
    hosts.add("new.example.com"); // an approved request_network_access card
    expect((await get(client, running.proxyPort, "http://new.example.com/")).status).toBe(200);
    hosts.delete("new.example.com"); // the run ended
    expect((await get(client, running.proxyPort, "http://new.example.com/")).status).toBe(403);
  });

  it("still refuses IP literals, localhost and forbidden addresses, whatever the worker lists", async () => {
    const running = await boot();
    const client = worker(running, allow("93.184.216.34", "localhost", "127.0.0.1"));
    await client.start(2000);
    for (const url of ["http://93.184.216.34/", "http://localhost/", "http://127.0.0.1/"]) {
      expect((await get(client, running.proxyPort, url)).status, url).toBe(403);
    }
  });

  it("refuses, saying so, when the worker cannot give the list", async () => {
    const running = await boot();
    const events: EgressEvent[] = [];
    const client = worker(
      running,
      {
        allowedHosts: async () => {
          throw new Error("database down");
        },
      },
      { events },
    );
    await client.start(2000);
    const r = await get(client, running.proxyPort, "http://allowed.example.com/");
    expect(r.status).toBe(403);
    expect(r.body).toContain("not available");
    expect(events.find((e) => e.decision === "refused")?.reason).toBe("policy_unavailable");
  });

  it("refuses everything while no worker is connected, and hands the events over later", async () => {
    const running = await boot();
    const events: EgressEvent[] = [];
    const early = worker(running, allow("allowed.example.com"));
    // credentials are the same whether or not the worker is connected: the secret is shared
    const alone = await get(early, running.proxyPort, "http://allowed.example.com/");
    expect(alone.status).toBe(403);
    expect(alone.body).toContain("not available");
    const client = worker(running, allow("allowed.example.com"), { events });
    await client.start(2000);
    for (let i = 0; i < 50 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.map((e) => e.reason)).toContain("policy_unavailable");
    expect((await get(client, running.proxyPort, "http://allowed.example.com/")).status).toBe(200);
  });
});

describe("control channel: the worker restarts", () => {
  it("the proxy keeps running; the new worker takes over, the old one is dropped", async () => {
    const running = await boot();
    const firstLog: string[] = [];
    const first = worker(running, allow("old.example.com"), { log: (t) => firstLog.push(t) });
    await first.start(2000);
    expect((await get(first, running.proxyPort, "http://old.example.com/")).status).toBe(200);
    // the new worker (same channel token) connects while the old one is still around
    const second = worker(running, allow("new.example.com"));
    await second.start(2000);
    // wait for the real event: the old worker was told it was replaced and stood down
    for (let i = 0; i < 500 && !firstLog.some((t) => t.includes("assumiu")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(firstLog.some((t) => t.includes("assumiu"))).toBe(true);
    expect(first.connected).toBe(false);
    expect((await get(second, running.proxyPort, "http://new.example.com/")).status).toBe(200);
    expect((await get(second, running.proxyPort, "http://old.example.com/")).status).toBe(403);
  });

  it("a worker that was replaced never takes the channel back, however long it waits", async () => {
    // The old worker's reconnect timer (20 ms here) used to fire after the takeover and give the
    // channel back to the old rules, so a request that the new worker refuses went through. The
    // race was between that timer and the request; this holds the request back for several
    // reconnect periods, so the old behaviour fails every time instead of under load only.
    const running = await boot();
    const connectedBefore = logs.filter((t) => t.includes("servidor conectado")).length;
    const firstLog: string[] = [];
    const first = worker(running, allow("old.example.com"), { log: (t) => firstLog.push(t) });
    await first.start(2000);
    const second = worker(running, allow("new.example.com"));
    await second.start(2000);
    for (let i = 0; i < 500 && !firstLog.some((t) => t.includes("assumiu")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 200)); // ten reconnect periods of the old worker
    expect(first.connected).toBe(false);
    expect(second.connected).toBe(true);
    expect((await get(second, running.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(second, running.proxyPort, "http://new.example.com/")).status).toBe(200);
    expect(logs.filter((t) => t.includes("servidor conectado"))).toHaveLength(connectedBefore + 2);
  });

  // The cases below are the ones a race can break, so they run many times (see README of the file).
  it("an old worker whose link dropped at the takeover reconnects AFTER the new one and is refused", {
    repeats: RACE_REPEATS,
  }, async () => {
    const running = await boot();
    const relay = await relayTo(running.controlPort);
    const oldLog = logWatcher();
    const old = viaRelay(running, relay.port, allow("old.example.com"), (t) => oldLog.log(t));
    await old.start(2000);
    expect((await get(old, running.proxyPort, "http://old.example.com/")).status).toBe(200);
    // The old worker's link drops (the proxy has not noticed, so it never tells it `replaced`), and
    // its reconnect is held at the gate until the new worker is the owner.
    relay.hold();
    relay.cutWorkerSide();
    const fresh = worker(running, allow("new.example.com"));
    await fresh.start(2000);
    expect(running.control.connected).toBe(true);
    relay.release(); // now the old worker gets through: after the new one
    await oldLog.when("recusado");
    expect(old.connected).toBe(false);
    expect(fresh.connected).toBe(true);
    expect((await get(fresh, running.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(fresh, running.proxyPort, "http://new.example.com/")).status).toBe(200);
    // the proxy never gave the channel back: two workers connected in all
    expect(logs.filter((t) => t.includes("servidor mais novo"))).toHaveLength(1);
  });

  it("the same, when the proxy had already noticed the drop (the old worker is gone, then comes back)", {
    repeats: RACE_REPEATS,
  }, async () => {
    const running = await boot();
    const relay = await relayTo(running.controlPort);
    const oldLog = logWatcher();
    const old = viaRelay(running, relay.port, allow("old.example.com"), (t) => oldLog.log(t));
    await old.start(2000);
    relay.hold();
    relay.cutAll();
    const fresh = worker(running, allow("new.example.com"));
    await fresh.start(2000);
    relay.release();
    await oldLog.when("recusado");
    expect(running.control.connected).toBe(true);
    expect((await get(fresh, running.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(fresh, running.proxyPort, "http://new.example.com/")).status).toBe(200);
  });

  it("a worker whose first link dropped before it read `ready` is ordered too", {
    repeats: RACE_REPEATS,
  }, async () => {
    const running = await boot();
    const relay = await relayTo(running.controlPort);
    const oldLog = logWatcher();
    const old = viaRelay(running, relay.port, allow("old.example.com"), (t) => oldLog.log(t));
    // The proxy gets the old worker's hello (and gives it a generation) but its `ready` is thrown
    // away, then the new worker comes. The old worker has no generation of its own to show.
    relay.swallowReplies(true);
    const starting = old.start(30_000).then(
      () => "started",
      (error: Error) => error.message,
    );
    await logsHave("servidor conectado", 1);
    relay.hold();
    relay.cutWorkerSide();
    relay.swallowReplies(false); // from here on the old worker hears the proxy again
    const fresh = worker(running, allow("new.example.com"));
    await fresh.start(2000);
    relay.release();
    await oldLog.when("recusado");
    expect(await starting).toContain("mais novo"); // the start of the old worker fails, it does not hang
    expect(fresh.connected).toBe(true);
    expect((await get(fresh, running.proxyPort, "http://old.example.com/")).status).toBe(403);
  });

  it("a request in progress at the swap, to a host only the old worker allowed, gets 403 and never 200", {
    repeats: RACE_REPEATS,
  }, async () => {
    const running = await boot();
    const asked = deferred();
    const release = deferred();
    const old = worker(running, {
      allowedHosts: async () => {
        asked.resolve(); // the proxy is waiting for this answer
        await release.promise; // held until the swap is done
        return new Set(["old.example.com"]);
      },
    });
    await old.start(2000);
    const inFlight = get(old, running.proxyPort, "http://old.example.com/");
    await asked.promise;
    const fresh = worker(running, allow("new.example.com"));
    await fresh.start(2000); // the swap happens while the question is out
    release.resolve(); // the old worker answers "allowed" when it no longer owns the channel
    expect((await inFlight).status).toBe(403);
    expect((await get(fresh, running.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(fresh, running.proxyPort, "http://new.example.com/")).status).toBe(200);
  });

  it("the proxy restarts: the new worker wins over a survivor of the old proxy that comes back late", {
    repeats: RACE_REPEATS,
  }, async () => {
    const first = await boot();
    const relay = await relayTo(first.controlPort);
    const oldLog = logWatcher();
    const old = viaRelay(first, relay.port, allow("old.example.com"), (t) => oldLog.log(t));
    await old.start(2000);
    // The proxy restarts (the counter is back to zero, the instance is another one).
    relay.hold();
    relay.cutAll();
    const second = await boot();
    relay.retarget(second.controlPort);
    const fresh = worker(second, allow("new.example.com"));
    await fresh.start(2000);
    relay.release(); // the old worker arrives with a generation of the OLD proxy
    await oldLog.when("recusado");
    expect(fresh.connected).toBe(true);
    expect((await get(fresh, second.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(fresh, second.proxyPort, "http://new.example.com/")).status).toBe(200);
  });

  it("the proxy restarts and only the old worker is left: it reconnects and is the owner", {
    repeats: RACE_REPEATS,
  }, async () => {
    const first = await boot();
    const relay = await relayTo(first.controlPort);
    const old = viaRelay(first, relay.port, allow("old.example.com"));
    await old.start(2000);
    relay.hold();
    relay.cutAll();
    const second = await boot();
    relay.retarget(second.controlPort);
    relay.release();
    for (let i = 0; i < 500 && !second.control.connected; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(second.control.connected).toBe(true);
    const client = viaRelay(second, relay.port, allow("x.example.com"));
    expect(client).toBeDefined();
    expect((await get(old, second.proxyPort, "http://old.example.com/")).status).toBe(200);
  });

  it("a survivor of the old proxy that comes first is replaced by a worker that starts later", {
    repeats: RACE_REPEATS,
  }, async () => {
    const first = await boot();
    const relay = await relayTo(first.controlPort);
    const oldLog = logWatcher();
    const old = viaRelay(first, relay.port, allow("old.example.com"), (t) => oldLog.log(t));
    await old.start(2000);
    const second = await boot();
    relay.retarget(second.controlPort);
    relay.cutAll();
    for (let i = 0; i < 500 && !second.control.connected; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(second.control.connected).toBe(true);
    const fresh = worker(second, allow("new.example.com"));
    await fresh.start(2000);
    await oldLog.when("assumiu");
    expect((await get(fresh, second.proxyPort, "http://old.example.com/")).status).toBe(403);
    expect((await get(fresh, second.proxyPort, "http://new.example.com/")).status).toBe(200);
  });

  it("a client reconnects by itself after the connection drops", async () => {
    const running = await boot();
    // a relay the test can cut: the client talks to it, it talks to the proxy's control port
    const relayed = new Set<Socket>();
    const relay = createNetServer((inbound) => {
      const outbound = connect({ host: "127.0.0.1", port: running.controlPort });
      relayed.add(inbound).add(outbound);
      inbound.pipe(outbound);
      outbound.pipe(inbound);
      inbound.on("error", () => outbound.destroy());
      outbound.on("error", () => inbound.destroy());
      inbound.on("close", () => outbound.destroy());
      outbound.on("close", () => inbound.destroy());
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const client = new ControlClient({
      host: "127.0.0.1",
      port: (relay.address() as { port: number }).port,
      token: TOKEN,
      secret: SECRET,
      advertise: { host: "127.0.0.1", port: running.proxyPort },
      policy: allow("allowed.example.com"),
      retryMs: 20,
    });
    clients.push(client);
    try {
      await client.start(2000);
      for (const socket of relayed) socket.destroy(); // the link drops; nobody replaced the worker
      let status = 0;
      for (let i = 0; i < 100 && status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await get(client, running.proxyPort, "http://allowed.example.com/")).status;
      }
      expect(status).toBe(200);
    } finally {
      for (const socket of relayed) socket.destroy();
      await new Promise<void>((r) => relay.close(() => r()));
    }
  });

  it("a question without an answer in time is a refusal, not a hang", async () => {
    const running = await boot({ answerTimeoutMs: 150 });
    const client = worker(running, { allowedHosts: () => new Promise(() => undefined) });
    await client.start(2000);
    const r = await get(client, running.proxyPort, "http://allowed.example.com/");
    expect(r.status).toBe(403);
    expect(r.body).toContain("not available");
  });
});

describe("addresses inside the container", () => {
  it("compares numerically with the subnet", () => {
    expect(inSubnet("172.29.0.7", "172.29.0.0/16")).toBe(true);
    expect(inSubnet("172.30.0.7", "172.29.0.0/16")).toBe(false);
    expect(inSubnet("10.0.0.255", "10.0.0.0/24")).toBe(true);
    expect(inSubnet("10.0.1.0", "10.0.0.0/24")).toBe(false);
    expect(inSubnet("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(inSubnet("not-an-ip", "10.0.0.0/24")).toBe(false);
    expect(inSubnet("10.0.0.1", "10.0.0.0/33")).toBe(false);
  });

  it("proxy on the internal network's address, control on the other's", () => {
    const nic = (address: string, internal = false) =>
      ({ address, family: "IPv4", internal, netmask: "", mac: "", cidr: null }) as const;
    const picked = chooseAddresses(
      { lo: [nic("127.0.0.1", true)], eth0: [nic("172.18.0.2")], eth1: [nic("172.19.0.5")] },
      "172.19.0.0/16",
    );
    expect(picked).toEqual({ proxyHost: "172.19.0.5", controlHost: "172.18.0.2" });
    expect(() => chooseAddresses({ eth0: [nic("172.18.0.2")] }, "172.19.0.0/16")).toThrow(
      "internal network",
    );
    expect(() => chooseAddresses({ eth1: [nic("172.19.0.5")] }, "172.19.0.0/16")).toThrow(
      "ordinary",
    );
  });
});

describe("control port is not an open service", () => {
  it("a stranger that says nothing is dropped after the hello time", async () => {
    const running = await boot({ helloTimeoutMs: 100 });
    const closed = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port: running.controlPort });
      s.on("close", () => resolve(true));
      s.on("error", () => undefined);
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
  });
});
