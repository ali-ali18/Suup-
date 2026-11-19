import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DockerExecutor,
  EgressProxy,
  type EgressSubject,
  ensureInternalNetwork,
  ensureMachine,
  NetworkedExecutor,
  removeMachine,
} from "../src/index.js";
import { runProcess } from "../src/run-process.js";

// Real Docker: the machine on an INTERNAL network, the proxy on the host's address of that bridge.
// The "internet" is a local server the proxy is told to dial for the names the fake resolver knows.
const REAL = process.env.SUUP_DOCKER_TESTS === "1";
const IMAGE = process.env.SUUP_SANDBOX_IMAGE;
const BOT: EgressSubject = { kind: "bot", id: "33333333-3333-4333-8333-333333333333" };

describe.skipIf(!REAL || IMAGE === undefined)("egress through the proxy, real Docker", () => {
  const tag = randomBytes(4).toString("hex");
  const networkName = `suup-egtest-${tag}`;
  const container = `suup-egtest-${tag}`;
  const volume = `suup-egtest-vol-${tag}`;
  let upstream: Server;
  let proxy: EgressProxy;
  let machine: NetworkedExecutor;
  let raw: DockerExecutor;
  const saved: Record<string, string | undefined> = {};
  const SECRETS = {
    DATABASE_URL: "postgres://user:pw-from-host@db/secret",
    SUUP_VAULT_KEY: "vault-key-from-host-0123456789",
    SUUP_SERVER_TOKEN: "server-token-from-host-0123456789",
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    upstream = createServer((_req, res) => res.end("hello from the allowed host"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const net = await ensureInternalNetwork(networkName);
    proxy = new EgressProxy({
      listenHost: net.gateway,
      policy: { allowedHosts: async () => new Set(["allowed.example.com"]) },
      resolver: {
        async resolve(host) {
          if (host === "allowed.example.com" || host === "sibling.example.com")
            return ["93.184.216.34"];
          throw new Error("NXDOMAIN");
        },
      },
      dial: () => connect({ host: "127.0.0.1", port: upstreamPort }),
    });
    await proxy.start();
    await ensureMachine({ name: container, image: IMAGE as string, volume, network: networkName });
    raw = new DockerExecutor({ container, workspace: "/workspace" });
    machine = new NetworkedExecutor(raw, proxy, BOT);
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await proxy?.stop();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await removeMachine(container, { volume });
    await runProcess("docker", ["network", "rm", networkName], {
      env: process.env as Record<string, string>,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      killGroup: false,
    });
  }, 60_000);

  it("reaches an allowed host through the proxy (http and CONNECT)", async () => {
    const plain = await machine.exec("curl -sS -m 10 http://allowed.example.com/");
    expect(plain).toMatchObject({ exitCode: 0, stdout: "hello from the allowed host" });
    const tunnel = await machine.exec("curl -sS -m 10 -p http://allowed.example.com/");
    expect(tunnel).toMatchObject({ exitCode: 0, stdout: "hello from the allowed host" });
  });

  it("refuses a host that is not allowed and says so in the result", async () => {
    const r = await machine.exec("curl -sS -f -m 10 http://denied.example.com/");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("host denied.example.com is not allowed for this bot");
  });

  it("matches exactly: a sibling subdomain of an allowed name is refused", async () => {
    const r = await machine.exec("curl -sS -f -m 10 http://sibling.example.com/");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("host sibling.example.com is not allowed");
  });

  it("refuses IP literals, localhost and the metadata address through the proxy", async () => {
    for (const target of [
      "http://93.184.216.34/",
      "http://127.0.0.1/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      const r = await machine.exec(`curl -sS -f -m 10 ${target}`);
      expect(r.exitCode, target).not.toBe(0);
      expect(r.stdout, target).not.toContain("hello");
    }
  });

  it("has no direct egress: curl without the proxy to an IP fails", async () => {
    for (const target of ["http://1.1.1.1/", "http://93.184.216.34/", "https://8.8.8.8/"]) {
      const r = await raw.exec(`curl -sS -m 6 --noproxy '*' ${target}`);
      expect(r.exitCode, target).not.toBe(0);
    }
    // the host itself, on a port that is not the proxy's, is not reachable either
    const r = await raw.exec(`curl -sS -m 6 --noproxy '*' http://${await gateway()}:1/`);
    expect(r.exitCode).not.toBe(0);
  });

  it("cannot resolve names by itself (no DNS out)", async () => {
    const r = await raw.exec("getent hosts example.com; echo rc=$?");
    expect(r.stdout).toContain("rc=2");
  });

  it("carries no secret of the host in its environment", async () => {
    const inspect = await runProcess(
      "docker",
      ["inspect", "--format", "{{json .Config.Env}}", container],
      {
        env: process.env as Record<string, string>,
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        killGroup: false,
      },
    );
    const configured = inspect.stdout.toString("utf8");
    const seen = (await machine.exec("env")).stdout;
    const names = seen
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => l.slice(0, l.indexOf("=")));
    for (const value of Object.values(SECRETS)) {
      expect(configured).not.toContain(value);
      expect(seen).not.toContain(value);
    }
    for (const name of Object.keys(SECRETS)) expect(names).not.toContain(name);
    // The only credential in there opens the proxy, with this bot's own allowlist.
    const withCredentials = names.filter((n) =>
      seen.split("\n").some((l) => l.startsWith(`${n}=`) && l.includes("@")),
    );
    expect(withCredentials.sort()).toEqual(
      ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "http_proxy", "https_proxy"].sort(),
    );
  });

  async function gateway(): Promise<string> {
    return (await ensureInternalNetwork(networkName)).gateway;
  }
});
