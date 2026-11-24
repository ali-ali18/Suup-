import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EgressEvent, EgressProxy } from "../src/index.js";

// The two modes that are not the bots' own: `openWeb` (the renderer's browser, any public NAME) and
// `anonymousSubject` (the search container's proxy, no credentials, a fixed list).
let upstream: Server;
let upstreamPort = 0;
const events: EgressEvent[] = [];
const resolver = {
  async resolve(host: string) {
    const table: Record<string, string[]> = {
      "any.example.com": ["93.184.216.34"],
      "evil.example.com": ["169.254.169.254"],
      "engine.example.com": ["93.184.216.34"],
      "other.example.com": ["93.184.216.34"],
    };
    const found = table[host];
    if (found === undefined) throw new Error("NXDOMAIN");
    return found;
  },
};

beforeAll(async () => {
  upstream = createServer((req, res) => res.end(`host=${req.headers.host}`));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

function get(
  proxy: EgressProxy,
  url: string,
  auth?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "GET",
      path: url,
      headers: {
        host: new URL(url).host,
        ...(auth === undefined ? {} : { "proxy-authorization": auth }),
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

function make(extra: Partial<ConstructorParameters<typeof EgressProxy>[0]>): EgressProxy {
  return new EgressProxy({
    listenHost: "127.0.0.1",
    policy: { allowedHosts: async () => new Set(["engine.example.com"]) },
    resolver,
    dial: () => connect({ host: "127.0.0.1", port: upstreamPort }),
    onEvent: (e) => events.push(e),
    ...extra,
  });
}

describe("EgressProxy openWeb", () => {
  it("lets any public host name through, still refusing addresses, private answers and other ports", async () => {
    const proxy = make({ openWeb: true });
    await proxy.start();
    try {
      const auth = new URL(proxy.proxyUrlFor({ kind: "harness", id: "renderer" }));
      const header = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
      expect((await get(proxy, "http://any.example.com/x", header)).status).toBe(200);
      expect((await get(proxy, "http://evil.example.com/x", header)).status).toBe(403);
      expect((await get(proxy, "http://127.0.0.1/x", header)).status).toBe(403);
      expect((await get(proxy, "http://localhost/x", header)).status).toBe(403);
      expect((await get(proxy, "http://any.example.com:8080/x", header)).status).toBe(403);
      expect((await get(proxy, "http://any.example.com/x")).status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });
});

describe("EgressProxy anonymousSubject", () => {
  it("serves one fixed list without credentials", async () => {
    const proxy = make({ anonymousSubject: { kind: "harness", id: "search" } });
    await proxy.start();
    try {
      expect((await get(proxy, "http://engine.example.com/x")).status).toBe(200);
      expect((await get(proxy, "http://other.example.com/x")).status).toBe(403);
      expect((await get(proxy, "http://127.0.0.1/x")).status).toBe(403);
      expect(events.some((e) => e.subject.id === "search" && e.decision === "refused")).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
