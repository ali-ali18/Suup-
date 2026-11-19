import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DockerExecutor,
  type EgressContainer,
  type EgressEvent,
  type EgressSubject,
  ensureMachine,
  NetworkedExecutor,
  removeMachine,
  startEgressContainer,
} from "../src/index.js";
import { runProcess } from "../src/run-process.js";

// Real Docker, the topology of the Windows app: the proxy is a CONTAINER on the bots' internal
// network and on an ordinary one, and this test process (the "worker") is a plain process of the
// host: it never enters a container and reaches the proxy only through the control port that the
// container publishes on 127.0.0.1. The internet is the real one: it needs network access.
const REAL = process.env.SUUP_DOCKER_TESTS === "1";
const IMAGE = process.env.SUUP_SANDBOX_IMAGE;
const EGRESS_IMAGE = process.env.SUUP_EGRESS_IMAGE;
const BOT: EgressSubject = { kind: "bot", id: "44444444-4444-4444-8444-444444444444" };

async function docker(...args: string[]): Promise<{ code: number | null; out: string }> {
  const r = await runProcess("docker", args, {
    env: process.env as Record<string, string>,
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
    killGroup: false,
  });
  return { code: r.exitCode, out: `${r.stdout.toString("utf8")}${r.stderr.toString("utf8")}` };
}

describe.skipIf(!REAL || IMAGE === undefined || EGRESS_IMAGE === undefined)(
  "egress proxy in a container, worker as a host process (real Docker)",
  () => {
    const tag = randomBytes(4).toString("hex");
    const net = `suup-ectest-${tag}`;
    const proxyName = `suup-ectest-egress-${tag}`;
    const machineName = `suup-ectest-${tag}`;
    const volume = `suup-ectest-vol-${tag}`;
    const events: EgressEvent[] = [];
    const hosts = new Set<string>(["registry.npmjs.org"]);
    let egress: EgressContainer;
    let raw: DockerExecutor;
    let machine: NetworkedExecutor;

    beforeAll(async () => {
      egress = await startEgressContainer({
        image: EGRESS_IMAGE as string,
        name: proxyName,
        internalNetwork: net,
        policy: { allowedHosts: async () => new Set(hosts) },
        onEvent: (e) => events.push(e),
      });
      await ensureMachine({
        name: machineName,
        image: IMAGE as string,
        volume,
        network: net,
      });
      raw = new DockerExecutor({ container: machineName, workspace: "/workspace" });
      machine = new NetworkedExecutor(raw, egress, BOT);
    }, 180_000);

    afterAll(async () => {
      await removeMachine(machineName, { volume });
      await egress?.stop();
      await docker("network", "rm", net);
      await docker("network", "rm", `${net}-out`);
    }, 90_000);

    // The environment this runs in re-signs HTTPS, so the TLS check is skipped (`-k`): what is
    // proven is that the tunnel opened and the real server answered.
    it("reaches an allowed host from inside the machine, through the proxy container", async () => {
      const r = await machine.exec(
        'curl -sk -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/',
      );
      expect(r.stdout).toBe("200");
      const plain = await machine.exec(
        'curl -s -m 20 -o /dev/null -w "%{http_code}" http://registry.npmjs.org/',
      );
      expect(["200", "301", "308"]).toContain(plain.stdout);
    });

    it("refuses a host that is not allowed, says so in the result, and the worker has the event", async () => {
      const r = await machine.exec("curl -sS -f -m 15 https://denied.example.com/");
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("host denied.example.com is not allowed");
      expect(r.stderr).toContain("request_network_access");
      expect(events.find((e) => e.host === "denied.example.com")).toMatchObject({
        decision: "refused",
        reason: "not_allowed",
        subject: BOT,
        port: 443,
      });
      // exact equality: a sibling of an allowed name is not allowed
      const sibling = await machine.exec("curl -sS -f -m 15 https://x.registry.npmjs.org/");
      expect(sibling.exitCode).not.toBe(0);
      expect(sibling.stderr).toContain("host x.registry.npmjs.org is not allowed");
    });

    it("an approval (the worker adds the host for the run) opens it, and ending the run closes it", async () => {
      const probe = 'curl -sk -m 20 -o /dev/null -w "%{http_code}" https://pypi.org/';
      expect(hosts.has("pypi.org")).toBe(false);
      expect((await machine.exec(probe)).stdout).not.toBe("200");
      hosts.add("pypi.org"); // request_network_access approved: a run-scoped grant
      expect((await machine.exec(probe)).stdout).toBe("200");
      hosts.delete("pypi.org"); // the run ended
      expect((await machine.exec(probe)).stdout).not.toBe("200");
    });

    it("refuses IP literals, localhost and the metadata address, even when listed", async () => {
      hosts.add("169.254.169.254");
      hosts.add("localhost");
      try {
        for (const target of [
          "http://1.1.1.1/",
          "http://localhost/",
          "http://169.254.169.254/latest/meta-data/",
        ]) {
          const r = await machine.exec(`curl -sS -f -m 10 ${target}`);
          expect(r.exitCode, target).not.toBe(0);
        }
      } finally {
        hosts.delete("169.254.169.254");
        hosts.delete("localhost");
      }
    });

    it("keeps the machine without a way out of its own", async () => {
      for (const target of ["http://1.1.1.1/", "https://8.8.8.8/"]) {
        const r = await raw.exec(`curl -sS -m 6 --noproxy '*' ${target}`);
        expect(r.exitCode, target).not.toBe(0);
      }
      const dns = await raw.exec("getent hosts example.com; echo rc=$?");
      expect(dns.stdout).toContain("rc=2");
    });

    it("the control port is published on 127.0.0.1 only, and the machine cannot reach it", async () => {
      const published = await docker("port", proxyName, "3129/tcp");
      expect(
        published.out
          .trim()
          .split("\n")
          .every((l) => l.startsWith("127.0.0.1:")),
      ).toBe(true);
      expect(egress.controlPort).toBeGreaterThan(0);
      // from the machine, the proxy's address on the bots' network: the proxy port answers (407
      // without credentials), the control port does not exist there
      const control = await raw.exec(
        `curl -sS -m 5 -o /dev/null --noproxy '*' http://${egress.address.host}:3129/`,
      );
      expect(control.exitCode).not.toBe(0);
      const proxyPort = await raw.exec(
        `curl -sS -m 5 -o /dev/null -w "%{http_code}" --noproxy '*' http://${egress.address.host}:${egress.address.port}/`,
      );
      expect(proxyPort.stdout).toBe("400"); // a proxy answers a plain request with "send an absolute URL"
    });

    it("a stranger on the host cannot use the control port without the token", async () => {
      const answer = await new Promise<string>((resolve) => {
        const s = connect({ host: "127.0.0.1", port: egress.controlPort });
        let data = "";
        s.on("data", (c) => {
          data += c;
        });
        s.on("close", () => resolve(data));
        s.on("error", () => resolve("error"));
        s.on("connect", () => s.write('{"t":"hello","token":"wrong"}\n'));
      });
      expect(answer).toBe("");
    });

    it("the proxy container is hardened and carries no secret of the host", async () => {
      const inspect = await docker(
        "inspect",
        "--format",
        "{{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{.Config.User}} {{json .HostConfig.SecurityOpt}}",
        proxyName,
      );
      expect(inspect.out).toContain("true");
      expect(inspect.out).toContain('["ALL"]');
      expect(inspect.out).toContain("1000:1000");
      expect(inspect.out).toContain("no-new-privileges");
      const logs = await docker("logs", proxyName);
      expect(logs.out).toContain("suup-egress: proxy de saída em");
      const env = (await docker("inspect", "--format", "{{json .Config.Env}}", proxyName)).out;
      // the container's whole environment: image variables plus the three it was given, no more
      for (const name of [
        "DATABASE_URL",
        "SUUP_VAULT_KEY",
        "SUUP_SERVER_TOKEN",
        "ANTHROPIC_API_KEY",
      ]) {
        expect(env).not.toContain(name);
      }
      // and the log never holds the channel's token or the key of the credentials
      const given = JSON.parse(env) as string[];
      for (const entry of given) {
        if (
          entry.startsWith("SUUP_EGRESS_CONTROL_TOKEN=") ||
          entry.startsWith("SUUP_EGRESS_SECRET=")
        ) {
          expect(logs.out).not.toContain(entry.slice(entry.indexOf("=") + 1));
        }
      }
    });

    it("starting again replaces the container (a worker that restarted), and it works", async () => {
      const before = (await docker("inspect", "--format", "{{.Id}}", proxyName)).out.trim();
      const restarted = await startEgressContainer({
        image: EGRESS_IMAGE as string,
        name: proxyName,
        internalNetwork: net,
        policy: { allowedHosts: async () => new Set(["registry.npmjs.org"]) },
      });
      try {
        const after = (await docker("inspect", "--format", "{{.Id}}", proxyName)).out.trim();
        expect(after).not.toBe(before);
        const viaNew = new NetworkedExecutor(raw, restarted, BOT);
        const r = await viaNew.exec(
          'curl -sk -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/',
        );
        expect(r.stdout).toBe("200");
        // the first worker's credentials were made with the first key: they are not valid now
        const stale = await machine.exec(
          'curl -sk -m 20 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/',
        );
        expect(stale.stdout).not.toBe("200");
      } finally {
        await restarted.stop(); // also what removes the (shared-name) container
      }
    });
  },
);
