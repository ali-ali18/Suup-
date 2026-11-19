import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EgressEvent,
  EgressProxy,
  type EgressSubject,
  NetworkedExecutor,
  parseAuthority,
} from "../src/index.js";

// The proxy without Docker: a client on loopback, a fake upstream, a fake resolver.
const BOT: EgressSubject = { kind: "bot", id: "11111111-1111-4111-8111-111111111111" };
const OTHER: EgressSubject = { kind: "bot", id: "22222222-2222-4222-8222-222222222222" };

let upstream: Server;
let upstreamPort = 0;
let proxy: EgressProxy;
const events: EgressEvent[] = [];
const dialed: string[] = [];

const ADDRESSES: Record<string, string[]> = {
  "allowed.example.com": ["93.184.216.34"],
  "sibling.example.com": ["93.184.216.34"],
  "rebind.example.com": ["169.254.169.254"],
  "mixed.example.com": ["8.8.8.8", "10.0.0.5"],
  "loop.example.com": ["127.0.0.1"],
};

beforeAll(async () => {
  upstream = createServer((req, res) => res.end(`upstream saw host=${req.headers.host}`));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
  proxy = new EgressProxy({
    listenHost: "127.0.0.1",
    policy: {
      async allowedHosts(subject) {
        return subject.id === BOT.id
          ? new Set([
              "allowed.example.com",
              "rebind.example.com",
              "mixed.example.com",
              "loop.example.com",
            ])
          : new Set<string>();
      },
    },
    resolver: {
      async resolve(host) {
        const found = ADDRESSES[host];
        if (found === undefined) throw new Error("NXDOMAIN");
        return found;
      },
    },
    dial: (address) => {
      dialed.push(address);
      return connect({ host: "127.0.0.1", port: upstreamPort });
    },
    onEvent: (e) => events.push(e),
  });
  await proxy.start();
});
afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function viaProxy(
  subject: EgressSubject,
  url: string,
  credentials = true,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const auth = new URL(proxy.proxyUrlFor(subject));
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "GET",
      path: url,
      headers: {
        host: target.host,
        ...(credentials
          ? {
              "proxy-authorization": `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
            }
          : {}),
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

function connectVia(
  subject: EgressSubject,
  target: string,
): Promise<{ status: string; socket: Socket }> {
  const auth = new URL(proxy.proxyUrlFor(subject));
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxy.port });
    socket.once("error", reject);
    socket.once("data", (chunk) =>
      resolve({ status: chunk.toString().split("\r\n")[0] ?? "", socket }),
    );
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}\r\n\r\n`,
    );
  });
}

describe("EgressProxy", () => {
  it("forwards an allowed host to the validated address", async () => {
    dialed.length = 0;
    const r = await viaProxy(BOT, "http://Allowed.Example.com./x");
    expect(r.status).toBe(200);
    expect(r.body).toContain(
      "host=Allowed.Example.com.".replace("Allowed.Example.com.", "allowed.example.com"),
    );
    expect(dialed).toEqual(["93.184.216.34"]);
  });

  it("tunnels CONNECT for an allowed host", async () => {
    const { status, socket } = await connectVia(BOT, "allowed.example.com:443");
    expect(status).toContain("200");
    socket.destroy();
  });

  it("refuses a host that is not on the list, by exact equality", async () => {
    for (const host of [
      "sibling.example.com",
      "example.com",
      "evil.allowed.example.com",
      "allowed.example.com.evil.net",
    ]) {
      const r = await viaProxy(BOT, `http://${host}/`);
      expect(r.status, host).toBe(403);
    }
    const { status } = await connectVia(BOT, "sibling.example.com:443");
    expect(status).toContain("403");
  });

  it("refuses IP literals, localhost and the metadata address", async () => {
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.1",
      "[::1]",
      "localhost",
      "2130706433",
    ]) {
      const r = await viaProxy(BOT, `http://${host}/`);
      expect(r.status, host).toBe(403);
    }
    expect((await connectVia(BOT, "169.254.169.254:80")).status).toContain("403");
  });

  it("refuses a name that resolves to a forbidden address, even when allowlisted", async () => {
    dialed.length = 0;
    for (const host of ["rebind.example.com", "mixed.example.com", "loop.example.com"]) {
      expect((await viaProxy(BOT, `http://${host}/`)).status, host).toBe(403);
    }
    expect(dialed).toEqual([]);
  });

  it("refuses a port that is not allowed", async () => {
    expect((await connectVia(BOT, "allowed.example.com:22")).status).toContain("403");
  });

  it("asks for credentials, and an unknown or other subject gets nothing", async () => {
    expect((await viaProxy(BOT, "http://allowed.example.com/", false)).status).toBe(407);
    expect((await viaProxy(OTHER, "http://allowed.example.com/")).status).toBe(403);
  });

  it("records refusals as events and hands them to the session of the command", async () => {
    events.length = 0;
    const session = proxy.open(BOT);
    await viaProxy(BOT, "http://sibling.example.com/");
    const refusals = session.close();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ host: "sibling.example.com", reason: "not_allowed" });
    expect(events.find((e) => e.decision === "refused")).toMatchObject({
      host: "sibling.example.com",
      subject: BOT,
    });
  });

  it("puts the proxy settings in the session env and exempts nothing", () => {
    const session = proxy.open(BOT);
    expect(session.env.HTTPS_PROXY).toBe(proxy.proxyUrlFor(BOT));
    expect(session.env.NO_PROXY).toBe("");
    session.close();
  });
});

describe("NetworkedExecutor", () => {
  it("adds the proxy env to every exec and the refusals to stderr", async () => {
    let seenEnv: Record<string, string> | undefined;
    const inner = {
      isolated: true,
      async exec(_c: string, o: { env?: Record<string, string> } = {}) {
        seenEnv = o.env;
        await viaProxy(BOT, "http://sibling.example.com/");
        return { exitCode: 56, stdout: "", stderr: "curl: (56) denied", timedOut: false };
      },
      readFile: async () => "",
      writeFile: async () => {},
      listDir: async () => [],
      stat: async () => null,
    };
    const exec = new NetworkedExecutor(inner, proxy, BOT);
    const result = await exec.exec("curl x");
    expect(seenEnv?.HTTP_PROXY).toContain("@");
    expect(result.stderr).toContain("host sibling.example.com is not allowed for this bot");
    expect(result.stderr).toContain("request_network_access");
    expect(exec.isolated).toBe(true);
  });
});

describe("parseAuthority", () => {
  it("reads host and port, digit by digit", () => {
    expect(parseAuthority("a.com:443")).toEqual({ host: "a.com", port: 443 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "[::1]", port: 80 });
    for (const bad of [
      "a.com",
      "a.com:",
      "a.com:0",
      "a.com:99999",
      "a.com:4x3",
      ":80",
      "[::1]80",
    ]) {
      expect(parseAuthority(bad), bad).toBeUndefined();
    }
  });
});
