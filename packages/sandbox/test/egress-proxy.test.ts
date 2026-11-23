import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EGRESS_REASON_HEADER,
  EGRESS_REFUSAL_REASONS,
  type EgressEvent,
  EgressProxy,
  type EgressSubject,
  egressRefusalReason,
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
              // On the list, but the resolver has no answer for it (a computer without DNS).
              "nodns.example.com",
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
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
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
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
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

/** The whole answer to a CONNECT the proxy closes: status line and headers (names in lower case). */
function connectAnswer(
  port: number,
  target: string,
  authorization: string | undefined,
): Promise<{ statusLine: string; headers: Map<string, string> }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      const head = text.slice(0, text.indexOf("\r\n\r\n"));
      const [statusLine = "", ...lines] = head.split("\r\n");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      resolve({ statusLine, headers });
    });
    socket.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        (authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`) +
        "\r\n",
    );
  });
}

function basicFor(subject: EgressSubject): string {
  const auth = new URL(proxy.proxyUrlFor(subject));
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
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

  it("says the reason code of every refusal in a header, on CONNECT and on GET", async () => {
    const cases: [target: string, reason: string][] = [
      ["sibling.example.com:443", "not_allowed"],
      ["169.254.169.254:80", "ip_literal"],
      ["localhost:443", "bad_host"],
      ["allowed.example.com:22", "bad_port"],
      ["nodns.example.com:443", "dns_failed"],
      ["rebind.example.com:443", "forbidden_address"],
    ];
    for (const [target, reason] of cases) {
      const answer = await connectAnswer(proxy.port, target, basicFor(BOT));
      expect(answer.statusLine, target).toBe("HTTP/1.1 403 Forbidden");
      expect(answer.headers.get(EGRESS_REASON_HEADER), target).toBe(reason);
      const [host = "", port = ""] = target.split(":");
      const url = port === "443" ? `http://${host}/` : `http://${host}:${port}/`;
      const plain = await viaProxy(BOT, url);
      expect(plain.status, url).toBe(403);
      expect(plain.headers[EGRESS_REASON_HEADER], url).toBe(reason);
    }
  });

  it("a name on the list that does not resolve is dns_failed, never not_allowed", async () => {
    events.length = 0;
    dialed.length = 0;
    const session = proxy.open(BOT);
    expect((await viaProxy(BOT, "http://nodns.example.com/")).status).toBe(403);
    expect(session.close()).toEqual([
      {
        host: "nodns.example.com",
        port: 80,
        reason: "dns_failed",
        message: "host nodns.example.com could not be resolved",
      },
    ]);
    expect(dialed).toEqual([]);
  });

  it("a policy that cannot be asked is policy_unavailable, in the header too", async () => {
    const down = new EgressProxy({
      listenHost: "127.0.0.1",
      anonymousSubject: { kind: "harness", id: "down" },
      policy: {
        async allowedHosts() {
          throw new Error("the server is restarting");
        },
      },
    });
    await down.start();
    try {
      const answer = await connectAnswer(down.port, "allowed.example.com:443", undefined);
      expect(answer.statusLine).toBe("HTTP/1.1 403 Forbidden");
      expect(answer.headers.get(EGRESS_REASON_HEADER)).toBe("policy_unavailable");
    } finally {
      await down.stop();
    }
  });

  it("a request without credentials (407) carries no refusal code", async () => {
    const answer = await connectAnswer(proxy.port, "allowed.example.com:443", undefined);
    expect(answer.statusLine).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(answer.headers.has(EGRESS_REASON_HEADER)).toBe(false);
    const plain = await viaProxy(BOT, "http://allowed.example.com/", false);
    expect(plain.status).toBe(407);
    expect(plain.headers[EGRESS_REASON_HEADER]).toBeUndefined();
  });

  it("reads a refusal code only by exact equality with the known codes", () => {
    for (const reason of EGRESS_REFUSAL_REASONS) expect(egressRefusalReason(reason)).toBe(reason);
    for (const text of [
      undefined,
      "",
      "DNS_FAILED",
      " dns_failed",
      "dns_failed ",
      "dns",
      "refused",
    ]) {
      expect(egressRefusalReason(text), String(text)).toBeUndefined();
    }
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
