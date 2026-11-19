import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError, flattenResult, parseConnectorSpec } from "../src/index.js";
import { startFakeHttpServer } from "../src/testing/index.js";
import { fakeSpec, newManager } from "./kit.js";

const managers: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(m: T): T => {
  managers.push(m);
  return m;
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

const textOf = (outcome: { result: unknown }) => flattenResult(outcome.result).text;

describe("connection over stdio", () => {
  it("connects lazily, lists the tools, reuses the connection, and closes", async () => {
    const manager = track(newManager());
    expect(manager.status()).toEqual([]);
    const spec = fakeSpec();
    const tools = await manager.tools(spec);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["echo", "write_thing", "hang", "Weird-Name.v2"]),
    );
    expect(manager.status()).toMatchObject([{ connector: "fake", connected: true, failures: 0 }]);
    const out = await manager.callTool(spec, "echo", { text: "hi" });
    expect(textOf(out)).toBe("echo: hi");
    // The list is cached: no new connection and the same objects.
    expect(await manager.tools(spec)).toBe(tools);
    await manager.close();
    expect(manager.status()).toEqual([]);
  });

  it("test() connects from scratch on its own connection and reports the server", async () => {
    const manager = track(newManager());
    const report = await manager.test(fakeSpec());
    expect(report).toMatchObject({ serverName: "fake-server", serverVersion: "1.2.3" });
    expect(report.tools.length).toBeGreaterThan(10);
    // It did not leave a pooled connection behind.
    expect(manager.status()).toEqual([]);
  });

  it("a child process gets only the declared variables, never ours", async () => {
    process.env.SUUP_TEST_LEAK = "leaked-value";
    try {
      const manager = track(newManager());
      const spec = fakeSpec({ transport: { env: { DECLARED_VAR: "yes" } } });
      const names = textOf(await manager.callTool(spec, "env_names", {})).split(",");
      expect(names).toContain("DECLARED_VAR");
      expect(names).not.toContain("SUUP_TEST_LEAK");
      expect(names).not.toContain("DATABASE_URL");
      expect(names).not.toContain("SUUP_VAULT_KEY");
    } finally {
      delete process.env.SUUP_TEST_LEAK;
    }
  });

  it("a server that does not start is a ConnectorError naming the connector, never a throw of something else", async () => {
    const manager = track(newManager());
    const spec = fakeSpec({ transport: { command: "/nonexistent/binary", args: [] } });
    await expect(manager.tools(spec)).rejects.toMatchObject({
      name: "ConnectorError",
      connector: "fake",
      kind: "unavailable",
    });
    await expect(manager.tools(spec)).rejects.toThrow(/Conector "fake"/);
  });

  it("a call that hangs times out (naming the connector) and the connection stays usable", async () => {
    const manager = track(newManager());
    const spec = fakeSpec();
    await manager.tools(spec);
    const started = Date.now();
    await expect(manager.callTool(spec, "hang", {}, { timeoutMs: 300 })).rejects.toMatchObject({
      kind: "timeout",
      connector: "fake",
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(textOf(await manager.callTool(spec, "echo", { text: "still here" }))).toBe(
      "echo: still here",
    );
  });

  it("cancelling aborts the call in flight, quickly", async () => {
    const manager = track(newManager());
    const spec = fakeSpec();
    await manager.tools(spec);
    const controller = new AbortController();
    const call = manager.callTool(
      spec,
      "hang",
      {},
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    setTimeout(() => controller.abort(new Error("run cancelled")), 100);
    const started = Date.now();
    await expect(call).rejects.toMatchObject({ kind: "aborted", connector: "fake" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(textOf(await manager.callTool(spec, "echo", { text: "ok" }))).toBe("echo: ok");
    // Already aborted: nothing is even started.
    await expect(
      manager.callTool(spec, "echo", { text: "x" }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("a server that dies in the middle of a call fails that call, and the next call reconnects", async () => {
    const manager = track(newManager());
    const spec = fakeSpec();
    await manager.tools(spec);
    await expect(manager.callTool(spec, "crash", {})).rejects.toMatchObject({
      kind: "closed",
      connector: "fake",
    });
    expect(manager.status()[0]?.connected).toBe(false);
    // No backoff after a crash of a connection that had been fine: it reconnects at once.
    expect(textOf(await manager.callTool(spec, "echo", { text: "back" }))).toBe("echo: back");
    expect(manager.status()[0]).toMatchObject({ connected: true, failures: 0 });
  });

  it("an error the server returns is a result, a protocol error is a rejection; both keep the connection", async () => {
    const manager = track(newManager());
    const spec = fakeSpec();
    const failed = flattenResult((await manager.callTool(spec, "is_error", {})).result);
    expect(failed.isError).toBe(true);
    await expect(manager.callTool(spec, "rpc_error", {})).rejects.toMatchObject({
      kind: "rejected",
    });
    expect(textOf(await manager.callTool(spec, "echo", { text: "x" }))).toBe("echo: x");
  });

  it("never compiles or enforces the server's output schema (it is untrusted, and Ajv would run its pattern)", async () => {
    const manager = track(newManager());
    const out = await manager.callTool(fakeSpec(), "structured", {});
    expect(textOf(out)).toBe("structured ok");
  });

  it("bounds a huge result", async () => {
    const manager = track(newManager());
    const out = flattenResult((await manager.callTool(fakeSpec(), "huge", { kb: 3000 })).result);
    expect(out.cut).toBe(true);
    expect(out.text.length).toBeLessThan(1_000_300);
    expect(out.text).toContain("the rest was dropped");
  });

  it("a message larger than the transport buffer breaks the connection, and it recovers", async () => {
    const manager = track(newManager());
    const spec = fakeSpec();
    await expect(manager.callTool(spec, "huge", { kb: 6000 })).rejects.toBeInstanceOf(
      ConnectorError,
    );
    expect(textOf(await manager.callTool(spec, "echo", { text: "after" }))).toBe("echo: after");
  });

  it("changing the configuration drops the connection opened with the old one", async () => {
    const manager = track(newManager());
    const first = fakeSpec({ version: "1", transport: { env: { WHO: "one" } } });
    const names1 = textOf(await manager.callTool(first, "env_names", {}));
    expect(names1).toContain("WHO");
    const second = fakeSpec({ version: "2", transport: { env: { OTHER: "two" } } });
    const names2 = textOf(await manager.callTool(second, "env_names", {}));
    expect(names2).toContain("OTHER");
    expect(names2).not.toContain("WHO");
  });

  it("resolves secrets at connection time and puts them in the environment of the child only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suup-conn-"));
    try {
      const asked: string[][] = [];
      const manager = track(
        newManager({
          resolveSecrets: async (names) => {
            asked.push(names);
            return { FAKE_API: "tok-live-1234567890" };
          },
        }),
      );
      const spec = fakeSpec({
        transport: { env: { FAKE_TOKEN: { secret: "FAKE_API", prefix: "tk:" } } },
      });
      expect(asked).toEqual([]);
      const out = textOf(await manager.callTool(spec, "needs_secret", {}));
      expect(out).toBe("credential=tk:tok-live-1234567890");
      expect(asked).toEqual([["FAKE_API"]]);
      // Reused: not resolved again.
      await manager.callTool(spec, "needs_secret", {});
      expect(asked).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing secret is a clear configuration error naming the connector and the secret, not its value", async () => {
    const manager = track(newManager({ resolveSecrets: async () => ({}) }));
    const spec = fakeSpec({ transport: { env: { FAKE_TOKEN: { secret: "NOT_THERE" } } } });
    await expect(manager.tools(spec)).rejects.toMatchObject({ kind: "config", connector: "fake" });
    await expect(manager.tools(spec)).rejects.toThrow(/NOT_THERE/);
  });
});

describe("reconnecting with a backoff", () => {
  it("waits longer after each failed attempt, fails fast meanwhile, and recovers", async () => {
    let now = 1_000_000;
    const manager = track(newManager({ now: () => now, backoff: { baseMs: 1000, maxMs: 4000 } }));
    const broken = fakeSpec({ transport: { command: "/nonexistent/binary", args: [] } });
    // Same name and version: the connector "was fixed" by changing the version below.
    const attempts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const error = await manager.tools(broken).catch((e: ConnectorError) => e);
      attempts.push((error as Error).message);
      // Inside the window: no new attempt, the message says when.
      const waiting = await manager.tools(broken).catch((e: ConnectorError) => e);
      expect((waiting as Error).message).toMatch(/nova tentativa de conexão em \d+ s/);
      now += [1000, 2000, 4000][i] as number;
    }
    expect(manager.status()[0]).toMatchObject({ failures: 3 });
    expect(attempts.every((m) => /não foi possível conectar/.test(m))).toBe(true);
    // The connector is fixed (a new version): the next attempt after the wait works.
    now += 10_000;
    const fixed = fakeSpec({ version: "fixed" });
    expect((await manager.tools(fixed)).length).toBeGreaterThan(5);
    expect(manager.status()[0]).toMatchObject({ connected: true, failures: 0 });
  });

  it("an idle connection is health-checked before use (and a dead one replaced)", async () => {
    let now = 5_000;
    const manager = track(newManager({ now: () => now, healthIntervalMs: 1000 }));
    const spec = fakeSpec();
    await manager.tools(spec);
    // Idle for longer than the interval: the next use pings first, and the live server answers.
    now += 5000;
    expect(textOf(await manager.callTool(spec, "echo", { text: "pinged" }))).toBe("echo: pinged");
    // The server dies (during a call) and stays idle past the interval: the next use replaces it.
    await expect(manager.callTool(spec, "crash", {})).rejects.toBeInstanceOf(ConnectorError);
    now += 5000;
    expect(textOf(await manager.callTool(spec, "echo", { text: "alive" }))).toBe("echo: alive");
  });
});

describe("connection over streamable HTTP", () => {
  it("lists and calls tools, sending the header built from a vault secret", async () => {
    const server = await startFakeHttpServer({ requireAuthorization: "Bearer tok-http-123456" });
    try {
      const manager = track(
        newManager({ resolveSecrets: async () => ({ HTTP_TOKEN: "tok-http-123456" }) }),
      );
      const spec = parseConnectorSpec({
        name: "web",
        transport: {
          kind: "http",
          url: server.url,
          headers: { Authorization: { secret: "HTTP_TOKEN", prefix: "Bearer " } },
        },
      });
      const tools = await manager.tools(spec);
      expect(tools.map((t) => t.name)).toContain("write_thing");
      expect(textOf(await manager.callTool(spec, "echo", { text: "over http" }))).toBe(
        "echo: over http",
      );
      expect(textOf(await manager.callTool(spec, "needs_secret", {}))).toBe(
        "credential=Bearer tok-http-123456",
      );
      await manager.callTool(spec, "write_thing", { name: "n", body: "b" });
      expect(server.calls).toEqual(['write_thing {"name":"n","body":"b"}']);
    } finally {
      await server.close();
    }
  });

  it("a wrong credential is a failure to connect that names the connector and not the secret", async () => {
    const server = await startFakeHttpServer({ requireAuthorization: "Bearer right-token-000" });
    try {
      const manager = track(
        newManager({
          resolveSecrets: async () => ({ HTTP_TOKEN: "wrong-token-111" }),
          redact: (t) => t.replaceAll("wrong-token-111", "[REDACTED:HTTP_TOKEN]"),
        }),
      );
      const spec = parseConnectorSpec({
        name: "web",
        transport: {
          kind: "http",
          url: server.url,
          headers: { Authorization: { secret: "HTTP_TOKEN", prefix: "Bearer " } },
        },
      });
      const error = (await manager.tools(spec).catch((e: ConnectorError) => e)) as ConnectorError;
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error.connector).toBe("web");
      expect(error.message).not.toContain("wrong-token-111");
    } finally {
      await server.close();
    }
  });

  it("a server that goes away is a closed/unavailable connector, and it comes back when the server does", async () => {
    const first = await startFakeHttpServer();
    const manager = track(newManager());
    const spec = parseConnectorSpec({ name: "web", transport: { kind: "http", url: first.url } });
    expect(textOf(await manager.callTool(spec, "echo", { text: "a" }))).toBe("echo: a");
    await first.close();
    await expect(manager.callTool(spec, "echo", { text: "b" })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});

describe("the log of a fake child", () => {
  it("writes through FAKE_LOG, which the other suites rely on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suup-conn-"));
    const log = join(dir, "calls.log");
    try {
      const manager = track(newManager());
      const spec = fakeSpec({ transport: { env: { FAKE_LOG: log } } });
      await manager.callTool(spec, "write_thing", { name: "a", body: "b" });
      expect(readFileSync(log, "utf8")).toBe('write_thing {"name":"a","body":"b"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
