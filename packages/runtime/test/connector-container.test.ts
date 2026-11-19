import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  adaptConnector,
  ConnectorManager,
  type ConnectorSpec,
  parseConnectorSpec,
} from "@suup/connectors";
import {
  ContainerStdioLauncher,
  type EgressEvent,
  EgressProxy,
  ensureInternalNetwork,
} from "@suup/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFakeServerImage,
  dockerReady,
  FAKE_SERVER_PATH,
  removeImage,
  removeNetwork,
} from "./docker-kit.js";
import { tempDir } from "./helpers.js";

const run = promisify(execFile);

// A stdio connector in a container, with real Docker: the fake MCP server of the repo runs from
// the runner image on the internal network, and its only way out is the egress proxy.
describe.skipIf(!dockerReady)("stdio connector in a container (real Docker)", () => {
  const tag = randomBytes(4).toString("hex");
  const networkName = `suup-conntest-${tag}`;
  let image = "";
  let proxy: EgressProxy;
  let launcher: ContainerStdioLauncher;
  let upstream: Server;
  const events: EgressEvent[] = [];
  const managers: ConnectorManager[] = [];

  const SECRET = "tok_container_9fK2mQ7xL0aZ";
  const HOST_ONLY = `suup-host-secret-${tag}`;

  beforeAll(async () => {
    image = await buildFakeServerImage();
    upstream = createServer((_req, res) => res.end("reached the allowed host"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const net = await ensureInternalNetwork(networkName);
    proxy = new EgressProxy({
      listenHost: net.gateway,
      policy: {
        async allowedHosts(subject) {
          return subject.kind === "connector" ? new Set(["allowed.example.com"]) : new Set();
        },
      },
      resolver: { resolve: async () => ["93.184.216.34"] },
      dial: () => connect({ host: "127.0.0.1", port: upstreamPort }),
      onEvent: (e) => events.push(e),
    });
    await proxy.start();
    launcher = new ContainerStdioLauncher({ image, network: networkName, egress: proxy });
  }, 180_000);

  afterAll(async () => {
    for (const m of managers) await m.close();
    await launcher?.closeAll();
    await proxy?.stop();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    await removeImage(image);
    await removeNetwork(networkName);
  }, 60_000);

  function spec(over: Record<string, unknown> = {}): ConnectorSpec {
    return parseConnectorSpec({
      name: "fake",
      transport: {
        kind: "stdio",
        command: "node",
        args: [FAKE_SERVER_PATH],
        env: { FAKE_TOKEN: { secret: "FAKE_API" } },
        ...over,
      },
    });
  }

  function manager(): ConnectorManager {
    const m = new ConnectorManager({
      resolveSecrets: async () => ({ FAKE_API: SECRET }),
      launcher,
      backoff: { baseMs: 10, maxMs: 50 },
      connectTimeoutMs: 20_000,
    });
    managers.push(m);
    return m;
  }

  async function call(
    m: ConnectorManager,
    s: ConnectorSpec,
    tool: string,
    args: Record<string, unknown> = {},
  ) {
    return m.callTool(s, tool, args, { timeoutMs: 20_000 });
  }

  it("reports where it runs", () => {
    expect(manager().stdioIsolation).toBe("container");
  });

  it("a tool call works through the container, and the vault secret reaches the server", async () => {
    const m = manager();
    const s = spec();
    const tools = await m.tools(s);
    expect(tools.map((t) => t.name)).toContain("echo");
    const echoed = await call(m, s, "echo", { text: "hi" });
    expect(JSON.stringify(echoed.result)).toContain("echo: hi");
    const secret = await call(m, s, "needs_secret");
    expect(JSON.stringify(secret.result)).toContain(SECRET);
    // The secret travels in the docker client's environment and is named with `-e NAME`: it is
    // not in the argument list of any process.
    const ps = await run("ps", ["-eo", "args"]);
    expect(ps.stdout).not.toContain(SECRET);
  }, 60_000);

  it("the server sees only the declared variables and the proxy settings, not the host's", async () => {
    process.env.SUUP_TEST_HOST_SECRET = HOST_ONLY;
    process.env.DATABASE_URL ??= "postgres://leak-check@host/db";
    const m = manager();
    const s = spec();
    const names = String(
      ((await call(m, s, "env_names")).result as { content: { text: string }[] }).content[0]?.text,
    ).split(",");
    delete process.env.SUUP_TEST_HOST_SECRET;
    expect(names).toContain("FAKE_TOKEN");
    expect(names).toContain("HTTPS_PROXY");
    for (const forbidden of [
      "SUUP_TEST_HOST_SECRET",
      "DATABASE_URL",
      "SUUP_VAULT_KEY",
      "SUUP_SERVER_TOKEN",
      "HOME_HOST",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  }, 60_000);

  it("the container cannot read a host file, even one placed where a mount could have exposed it", async () => {
    const dir = await tempDir("suup-hostfile-");
    const file = join(dir, "private.txt");
    await writeFile(file, HOST_ONLY);
    const wrapped = launcher.wrap({
      connector: "probe",
      command: "sh",
      args: ["-c", `cat ${file} 2>&1; ls /workspace /host /mnt 2>&1; id -u`],
      env: {},
      egressHosts: [],
    });
    const out = await run(wrapped.command, wrapped.args, { env: wrapped.env }).catch((e) => e);
    const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(text).not.toContain(HOST_ONLY);
    expect(text).toContain("No such file or directory");
    expect(text.trim().endsWith("1000")).toBe(true);
  }, 60_000);

  it("reaches an allowed host through the proxy and is refused for one that is not", async () => {
    const probe = (url: string) => {
      const wrapped = launcher.wrap({
        connector: "fake",
        command: "python3",
        args: [
          "-c",
          `import urllib.request,sys\ntry:\n  print(urllib.request.urlopen(sys.argv[1], timeout=10).read().decode())\nexcept Exception as e:\n  print("ERR", e)`,
          url,
        ],
        env: {},
        egressHosts: [],
      });
      return run(wrapped.command, wrapped.args, { env: wrapped.env }).then((r) => r.stdout);
    };
    expect(await probe("http://allowed.example.com/")).toContain("reached the allowed host");
    const refused = await probe("http://denied.example.com/");
    expect(refused).toContain("ERR");
    expect(refused).toContain("403");
    expect(events.find((e) => e.host === "denied.example.com")).toMatchObject({
      decision: "refused",
      subject: { kind: "connector", id: "fake" },
    });
    // exact match: a sibling of the allowed name is refused too
    expect(await probe("http://x.allowed.example.com/")).toContain("403");
  }, 90_000);

  it("a crash is a tool error, and the next call reconnects in a new container", async () => {
    const m = manager();
    const s = spec();
    const tools = adaptConnector(s, await m.tools(s), m).tools;
    expect(tools.length).toBeGreaterThan(3);
    await expect(call(m, s, "crash")).rejects.toThrow();
    // the manager waits out its (short) backoff, then connects again from scratch
    let again: unknown;
    for (let i = 0; i < 40 && again === undefined; i++) {
      await new Promise((r) => setTimeout(r, 150));
      again = await call(m, s, "echo", { text: "back" }).catch(() => undefined);
    }
    expect(JSON.stringify(again)).toContain("echo: back");
  }, 90_000);

  it("closing the manager removes the container", async () => {
    const m = manager();
    await m.tools(spec());
    await m.close();
    await launcher.closeAll();
    const left = await run("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=suup.role=connector",
    ]);
    expect(left.stdout.trim()).toBe("");
  }, 60_000);
});
