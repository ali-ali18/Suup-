import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { type ERROR_CODES, ERROR_STATUS } from "@suup/api";
import { createRuntime, parseConfig } from "@suup/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerConfigError } from "../src/errors.js";
import { readJsonBody } from "../src/http.js";
import { generateToken, MIN_TOKEN_LENGTH, TAURI_ORIGINS } from "../src/index.js";
import { createServer, type SuupServer } from "../src/server.js";

// The HTTP layer of the server on its own: auth, CORS, limits and the error shape. It never reaches
// the database (`startupChecks: false`, and the routes used here answer from the configuration or
// reject the request first), so these tests run with or without `DATABASE_URL`.

const config = parseConfig({
  providers: [{ id: "roteiro", kind: "scripted", scriptPath: "roteiro.json" }],
  models: [{ id: "model-x", provider: "roteiro", contextWindow: 1000, maxOutputTokens: 100 }],
  sandbox: { kind: "local", root: "workspace" },
});
const runtime = () =>
  createRuntime(config, {
    env: { DATABASE_URL: "postgres://suup@127.0.0.1:1/none" },
    baseDir: "/tmp",
  });

describe("the server refuses to start without a good token", () => {
  it.each([
    ["none", undefined],
    ["empty", ""],
    ["31 characters", "x".repeat(MIN_TOKEN_LENGTH - 1)],
  ])("%s", (_name, token) => {
    expect(() => createServer(runtime(), { token: token as string })).toThrow(ServerConfigError);
    expect(() => createServer(runtime(), { token: token as string })).toThrow(/token/);
  });

  it("accepts exactly 32 characters, and says what to do otherwise", () => {
    const server = createServer(runtime(), { token: "x".repeat(MIN_TOKEN_LENGTH) });
    expect(server).toBeDefined();
    expect(() => createServer(runtime(), { token: "curto" })).toThrow(
      /suup server --generate-token/,
    );
  });
});

describe("HTTP layer", () => {
  const token = generateToken();
  const ORIGIN = "http://localhost:1420";
  let server: SuupServer;
  let base: string;

  beforeAll(async () => {
    server = createServer(runtime(), {
      token,
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [ORIGIN, ...TAURI_ORIGINS],
      maxBodyBytes: 1024,
      requestTimeoutMs: 400,
      startupChecks: false,
      shutdownGraceMs: 200,
    });
    base = await server.listen();
  });
  afterAll(() => server.close());

  const authed = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${token}`,
    ...extra,
  });
  const bodyOf = async (res: Response) =>
    (await res.json()) as { error: { code: string; message: string } };
  const expectError = async (res: Response, code: (typeof ERROR_CODES)[number]) => {
    expect(res.status).toBe(ERROR_STATUS[code]);
    const body = await bodyOf(res);
    // The shape is exactly this, nothing more.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.code).toBe(code);
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  };

  it("health needs no token and says nothing but ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect((await fetch(`${base}/health`, { method: "HEAD" })).status).toBe(200);
    await expectError(await fetch(`${base}/health`, { method: "POST" }), "method_not_allowed");
  });

  describe("auth", () => {
    it("rejects a missing token, a wrong one and other schemes, with the documented shape", async () => {
      const missing = await fetch(`${base}/v1/models`);
      await expectError(missing, "unauthorized");
      expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/);
      for (const header of [
        `Bearer ${token}x`,
        `Bearer ${token.slice(1)}`,
        "Bearer ",
        "Bearer",
        `bearer`,
        `Basic ${Buffer.from(`user:${token}`).toString("base64")}`,
        token,
        `Token ${token}`,
      ]) {
        await expectError(
          await fetch(`${base}/v1/models`, { headers: { Authorization: header } }),
          "unauthorized",
        );
      }
      // The token in the query string is not a credential.
      await expectError(await fetch(`${base}/v1/models?token=${token}`), "unauthorized");
      expect((await fetch(`${base}/v1/models`, { headers: authed() })).status).toBe(200);
      // `bearer` is case-insensitive, as the HTTP auth scheme is.
      expect(
        (await fetch(`${base}/v1/models`, { headers: { Authorization: `bearer ${token}` } }))
          .status,
      ).toBe(200);
    });

    it("answers 401 before 404 under /v1, so a stranger learns nothing about the routes", async () => {
      await expectError(await fetch(`${base}/v1/does-not-exist`), "unauthorized");
      await expectError(
        await fetch(`${base}/v1/does-not-exist`, { headers: authed() }),
        "not_found",
      );
      await expectError(await fetch(`${base}/nowhere`), "not_found");
      await expectError(await fetch(`${base}/`), "not_found");
    });

    it("every /v1 route is behind the token", async () => {
      for (const [method, path] of [
        ["GET", "/v1/bots"],
        ["POST", "/v1/bots"],
        ["GET", "/v1/conversations"],
        ["GET", "/v1/runs"],
        ["POST", "/v1/runs/11111111-1111-4111-8111-111111111111/pause"],
        ["GET", "/v1/memories"],
        ["GET", "/v1/doctor"],
        ["GET", "/v1/stream"],
      ] as const) {
        await expectError(await fetch(`${base}${path}`, { method }), "unauthorized");
      }
    });
  });

  describe("routing and validation", () => {
    it("405 for a known route with the wrong method; 400 for a bad body; 404 for a malformed id", async () => {
      await expectError(
        await fetch(`${base}/v1/models`, { method: "DELETE", headers: authed() }),
        "method_not_allowed",
      );
      await expectError(
        await fetch(`${base}/v1/bots`, { method: "DELETE", headers: authed() }),
        "method_not_allowed",
      );
      const post = (body: string, type = "application/json") =>
        fetch(`${base}/v1/bots`, {
          method: "POST",
          headers: authed({ "Content-Type": type }),
          body,
        });
      await expectError(await post("{not json"), "invalid_request");
      await expectError(await post("{}"), "invalid_request");
      await expectError(await post(JSON.stringify({ name: "x", modelId: 5 })), "invalid_request");
      await expectError(
        await post(JSON.stringify({ name: "x", modelId: "m" }), "text/plain"),
        "unsupported_media_type",
      );
      const message = (await bodyOf(await post("{}"))).error.message;
      expect(message).toMatch(/name/);
      expect(message).toMatch(/modelId/);
      await expectError(
        await fetch(`${base}/v1/runs/not-a-uuid`, { headers: authed() }),
        "not_found",
      );
      await expectError(
        await fetch(`${base}/v1/stream`, { method: "POST", headers: authed() }),
        "method_not_allowed",
      );
      await expectError(
        await fetch(`${base}/v1/stream?runs=nope`, { headers: authed() }),
        "invalid_request",
      );
      await expectError(
        await fetch(`${base}/v1/stream`, { headers: authed({ "Last-Event-ID": "abc" }) }),
        "invalid_request",
      );
    });

    it("refuses a body over the limit, declared or not, and never reads past it", async () => {
      const big = JSON.stringify({ name: "x".repeat(2000), modelId: "model-x" });
      const res = await fetch(`${base}/v1/bots`, {
        method: "POST",
        headers: authed({ "Content-Type": "application/json" }),
        body: big,
      });
      await expectError(res, "payload_too_large");
      // Chunked, with no declared length: the limit is enforced while reading.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new TextEncoder().encode("x".repeat(512));
          for (let i = 0; i < 8; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      const chunked = await fetch(`${base}/v1/bots`, {
        method: "POST",
        headers: authed({ "Content-Type": "application/json" }),
        body: stream,
        duplex: "half",
      } as RequestInit);
      await expectError(chunked, "payload_too_large");
    });

    it("answers 408 to a client that stops sending the body", async () => {
      const response = await new Promise<string>((resolve, reject) => {
        const url = new URL(base);
        const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
          socket.write(
            `POST /v1/bots HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"na`,
          );
        });
        let text = "";
        socket.on("data", (chunk) => {
          text += chunk.toString();
        });
        socket.on("close", () => resolve(text));
        socket.on("error", reject);
      });
      expect(response).toMatch(/^HTTP\/1\.1 408 /);
      expect(response).toContain('"code":"request_timeout"');
    });
  });

  describe("CORS", () => {
    it("allows only the listed origins, and says so with the right headers", async () => {
      for (const origin of [ORIGIN, "tauri://localhost", "http://tauri.localhost"]) {
        const res = await fetch(`${base}/v1/models`, { headers: authed({ Origin: origin }) });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
        expect(res.headers.get("vary")).toContain("Origin");
      }
      // Not a browser: no Origin, no CORS headers.
      const plain = await fetch(`${base}/v1/models`, { headers: authed() });
      expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("rejects any other origin, with the documented error and no CORS headers", async () => {
      for (const origin of [
        "http://evil.example",
        "http://localhost:1421",
        "https://localhost:1420",
        "null",
      ]) {
        const res = await fetch(`${base}/v1/models`, { headers: authed({ Origin: origin }) });
        await expectError(res, "origin_not_allowed");
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
        // Not even health, and not even with a valid token.
        const health = await fetch(`${base}/health`, { headers: { Origin: origin } });
        await expectError(health, "origin_not_allowed");
      }
    });

    it("answers the preflight of an allowed origin without a token, and refuses the others", async () => {
      const ok = await fetch(`${base}/v1/bots`, {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(ok.headers.get("access-control-allow-methods")).toMatch(/POST/);
      expect(ok.headers.get("access-control-allow-methods")).toMatch(/PATCH/);
      const allowed = (ok.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      for (const header of ["authorization", "content-type", "last-event-id"])
        expect(allowed).toContain(header);
      expect(Number(ok.headers.get("access-control-max-age"))).toBeGreaterThan(0);
      expect(await ok.text()).toBe("");

      const denied = await fetch(`${base}/v1/bots`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
      });
      await expectError(denied, "origin_not_allowed");
      // A preflight with no Origin is not a CORS preflight.
      await expectError(await fetch(`${base}/v1/bots`, { method: "OPTIONS" }), "not_found");
    });
  });

  it("tags every answer with a request id, and echoes a harmless one the client sent", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{12}$/);
    const echoed = await fetch(`${base}/health`, { headers: { "X-Request-Id": "trace-123" } });
    expect(echoed.headers.get("x-request-id")).toBe("trace-123");
    const unsafe = await fetch(`${base}/health`, {
      headers: { "X-Request-Id": "bad id\twith spaces" },
    });
    expect(unsafe.headers.get("x-request-id")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readJsonBody", () => {
  const fake = (headers: Record<string, string>) => {
    const req = new EventEmitter() as EventEmitter & IncomingMessage;
    req.headers = headers;
    return req;
  };

  it("times out when the body never arrives", async () => {
    const req = fake({ "content-type": "application/json" });
    await expect(readJsonBody(req, { maxBytes: 100, timeoutMs: 30 })).rejects.toMatchObject({
      code: "request_timeout",
    });
  });

  it("reads a body in pieces, and treats an empty one as no body", async () => {
    const req = fake({ "content-type": "application/json; charset=utf-8" });
    const pending = readJsonBody(req, { maxBytes: 100, timeoutMs: 1000 });
    req.emit("data", Buffer.from('{"a":'));
    req.emit("data", Buffer.from("1}"));
    req.emit("end");
    expect(await pending).toEqual({ a: 1 });
    const empty = fake({});
    const none = readJsonBody(empty, { maxBytes: 100, timeoutMs: 1000 });
    empty.emit("end");
    expect(await none).toBeUndefined();
  });

  it("refuses a declared length over the limit before reading anything", async () => {
    const req = fake({ "content-length": "101", "content-type": "application/json" });
    await expect(readJsonBody(req, { maxBytes: 100, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "payload_too_large",
    });
  });

  it("accepts +json media types and rejects others", async () => {
    const ok = fake({ "content-type": "application/vnd.api+json" });
    const p = readJsonBody(ok, { maxBytes: 100, timeoutMs: 1000 });
    ok.emit("data", Buffer.from("[1]"));
    ok.emit("end");
    expect(await p).toEqual([1]);
    const bad = fake({ "content-type": "application/jsonp" });
    const q = readJsonBody(bad, { maxBytes: 100, timeoutMs: 1000 });
    bad.emit("data", Buffer.from("[1]"));
    bad.emit("end");
    await expect(q).rejects.toMatchObject({ code: "unsupported_media_type" });
  });
});
