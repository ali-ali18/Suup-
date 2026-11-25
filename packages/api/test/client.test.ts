import { describe, expect, it } from "vitest";
import { ApiError, createClient } from "../src/index.js";

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const bot = {
  id: BOT_ID,
  name: "Ajudante",
  description: "",
  personality: "",
  modelProvider: "p",
  modelId: "m",
  allowedTools: [],
  limits: {},
  avatar: null,
  isDefault: false,
  pinned: false,
  groupName: null,
  sortOrder: null,
  color: null,
  avatarStyle: "shapes",
  avatarPixel3d: false,
  createdAt: "2026-11-18T20:00:00.000Z",
  updatedAt: "2026-11-18T20:00:00.000Z",
  archivedAt: null,
  latestRun: null,
  conversationId: null,
  unreadCount: 0,
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(
  respond: (seen: Seen) => Response | Promise<Response>,
  options: { timeoutMs?: number } = {},
) {
  const calls: Seen[] = [];
  const api = createClient({
    baseUrl: "http://server:8787/",
    token: "secret-token",
    ...options,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const seen: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(seen);
      const signal = init?.signal;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return respond(seen);
    }) as typeof fetch,
  });
  return { api, calls };
}

describe("client", () => {
  it("sends the bearer token, builds the URL (no double slash), and parses a typed answer", async () => {
    const { api, calls } = client(() => Response.json({ items: [bot] }));
    const bots = await api.bots.list({ includeArchived: true });
    expect(bots).toEqual([bot]);
    expect(calls[0]).toMatchObject({
      url: "http://server:8787/v1/bots?includeArchived=true",
      method: "GET",
      headers: { Authorization: "Bearer secret-token", Accept: "application/json" },
    });
  });

  it("health sends no token", async () => {
    const { api, calls } = client(() => Response.json({ status: "ok" }));
    expect(await api.health()).toEqual({ status: "ok" });
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("encodes ids and arrays, sends JSON bodies with a content type, and omits undefined query values", async () => {
    const { api, calls } = client((seen) =>
      seen.url.includes("/events")
        ? Response.json({ items: [], hasMore: false, lastSeq: 0 })
        : Response.json(bot),
    );
    await api.runs.events("a/b c", {
      types: ["tool_call", "tool_result"],
      afterSeq: 5,
      view: "chat",
    });
    expect(calls[0]?.url).toBe(
      "http://server:8787/v1/runs/a%2Fb%20c/events?types=tool_call%2Ctool_result&afterSeq=5&view=chat",
    );
    await api.bots.create({ name: "x", modelId: "m", allowedTools: ["shell"] });
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { name: "x", modelId: "m", allowedTools: ["shell"] },
      headers: { "Content-Type": "application/json" },
    });
    await api.bots.update(BOT_ID, { name: "y" });
    expect(calls[2]?.method).toBe("PATCH");
    await api.bots.archive(BOT_ID);
    expect(calls[3]).toMatchObject({
      method: "POST",
      url: `http://server:8787/v1/bots/${BOT_ID}/archive`,
    });
    expect(calls[3]?.headers["Content-Type"]).toBeUndefined(); // no body, no content type
  });

  it("turns the server's error body into an ApiError with the code, message and status", async () => {
    const { api } = client(() =>
      Response.json(
        { error: { code: "conflict", message: "A execução já terminou." } },
        { status: 409 },
      ),
    );
    const error = await api.runs.pause(BOT_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "conflict",
      message: "A execução já terminou.",
      status: 409,
    });
  });

  it("calls an answer outside the contract invalid_response, whatever is wrong with it", async () => {
    const wrongShape = client(() => Response.json({ items: [{ ...bot, id: "nope" }] }));
    await expect(wrongShape.api.bots.list()).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });
    const notJson = client(() => new Response("<html>", { status: 200 }));
    await expect(notJson.api.bots.list()).rejects.toMatchObject({ code: "invalid_response" });
    const errorWithoutBody = client(() => new Response("oops", { status: 500 }));
    await expect(errorWithoutBody.api.bots.list()).rejects.toMatchObject({
      code: "invalid_response",
      status: 500,
    });
    const unknownCode = client(() =>
      Response.json({ error: { code: "made_up", message: "x" } }, { status: 400 }),
    );
    await expect(unknownCode.api.bots.list()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports a network failure, a timeout and a caller's abort as distinct codes", async () => {
    const down = createClient({
      baseUrl: "http://x",
      token: "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.bots.list()).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("fetch failed"),
    });

    const slow = client(
      (_seen) => new Promise<Response>(() => {}), // never answers
      { timeoutMs: 30 },
    );
    // The fake ignores the abort signal when it is pending, so make it honour it.
    const honouring = createClient({
      baseUrl: "http://x",
      token: "t",
      timeoutMs: 30,
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
    });
    await expect(honouring.bots.list()).rejects.toMatchObject({
      code: "network",
      message: expect.stringContaining("demorou demais"),
    });
    void slow;

    const controller = new AbortController();
    const aborting = createClient({
      baseUrl: "http://x",
      token: "t",
      fetch: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
    });
    const pending = aborting.diagnostics.resend(BOT_ID, { seq: 1 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("the vault client has no call that reads a value, and its schema has no field for one", async () => {
    const { vault } = client(() => new Response("{}")).api;
    expect(Object.keys(vault).sort()).toEqual(
      [
        "answerRequest",
        "grant",
        "list",
        "remove",
        "request",
        "revoke",
        "set",
        "setHosts",
        "status",
      ].sort(),
    );
    const { secretSchema } = await import("../src/index.js");
    expect(Object.keys(secretSchema.shape)).not.toEqual(expect.arrayContaining(["value"]));
    expect(Object.keys(secretSchema.shape)).not.toContain("ciphertext");
  });

  it("sends a decision and parses the card it gets back", async () => {
    const card = {
      id: BOT_ID,
      runId: BOT_ID,
      botId: BOT_ID,
      conversationId: null,
      callId: "c1",
      tool: "shell",
      args: { command: "ls" },
      level: "external_irreversible",
      summary: "Shell: ls",
      secrets: [],
      source: "default",
      outbound: {
        kind: "message",
        recipientFields: ["to"],
        recipients: [{ field: "to", value: "ana@x.com" }],
      },
      status: "approved",
      reason: null,
      ruleId: null,
      expiresAt: null,
      decidedAt: "2026-11-18T20:00:00.000Z",
      createdAt: "2026-11-18T20:00:00.000Z",
      waitedMs: 5000,
      stale: false,
    };
    const { api, calls } = client(() => Response.json({ approval: card, rule: null }));
    const result = await api.approvals.decide(BOT_ID, {
      decision: "approve",
      allowRecipient: true,
    });
    expect(result.approval.status).toBe("approved");
    expect(result.approval.outbound?.recipients).toEqual([{ field: "to", value: "ana@x.com" }]);
    expect(calls[0]?.body).toEqual({ decision: "approve", allowRecipient: true });
    const bad = client(() =>
      Response.json({ approval: { ...card, level: "nuclear" }, rule: null }),
    );
    await expect(bad.api.approvals.decide(BOT_ID, { decision: "deny" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("covers every endpoint of the API with the documented method and path", async () => {
    const uuid = BOT_ID;
    const sink = client(() => new Response("{}", { status: 500 }));
    const attempt = async (call: () => Promise<unknown>) => {
      await call().catch(() => undefined);
      return sink.calls.at(-1);
    };
    const api = sink.api;
    const table: [string, () => Promise<unknown>][] = [
      ["GET /health", () => api.health()],
      ["GET /v1/models", () => api.models.list()],
      ["GET /v1/tools", () => api.tools.list()],
      ["GET /v1/bots", () => api.bots.list()],
      [`GET /v1/bots/${uuid}`, () => api.bots.get(uuid)],
      ["POST /v1/bots", () => api.bots.create({ name: "n", modelId: "m" })],
      [`PATCH /v1/bots/${uuid}`, () => api.bots.update(uuid, { name: "n" })],
      [`POST /v1/bots/${uuid}/archive`, () => api.bots.archive(uuid)],
      [`POST /v1/bots/${uuid}/default`, () => api.bots.setDefault(uuid)],
      [`POST /v1/bots/${uuid}/conversation`, () => api.bots.openConversation(uuid)],
      ["POST /v1/bots/draft", () => api.bots.draft({ description: "d" })],
      ["GET /v1/conversations", () => api.conversations.list()],
      [`GET /v1/conversations/${uuid}`, () => api.conversations.get(uuid)],
      [`GET /v1/conversations/${uuid}/messages`, () => api.conversations.messages(uuid)],
      [`POST /v1/conversations/${uuid}/messages`, () => api.conversations.send(uuid, "oi")],
      [`POST /v1/conversations/${uuid}/read`, () => api.conversations.markRead(uuid)],
      ["GET /v1/runs", () => api.runs.list()],
      [`GET /v1/runs/${uuid}`, () => api.runs.get(uuid)],
      [`GET /v1/runs/${uuid}/events`, () => api.runs.events(uuid)],
      [`POST /v1/runs/${uuid}/pause`, () => api.runs.pause(uuid)],
      [`POST /v1/runs/${uuid}/interrupt`, () => api.runs.interrupt(uuid)],
      [`POST /v1/runs/${uuid}/cancel`, () => api.runs.cancel(uuid)],
      [`POST /v1/runs/${uuid}/resume`, () => api.runs.resume(uuid)],
      ["GET /v1/memories", () => api.memories.list()],
      ["POST /v1/memories", () => api.memories.add({ layer: "rule", text: "t" })],
      [`PATCH /v1/memories/${uuid}`, () => api.memories.edit(uuid, "t")],
      [`POST /v1/memories/${uuid}/archive`, () => api.memories.archive(uuid)],
      [`POST /v1/memories/${uuid}/restore`, () => api.memories.restore(uuid)],
      ["GET /v1/memories/search", () => api.memories.search({ q: "x" })],
      ["GET /v1/messages/search", () => api.search.messages({ q: "x" })],
      [`GET /v1/runs/${uuid}/requests/3`, () => api.diagnostics.request(uuid, 3)],
      [`POST /v1/runs/${uuid}/replay`, () => api.diagnostics.replay(uuid)],
      [`POST /v1/runs/${uuid}/resend`, () => api.diagnostics.resend(uuid, { seq: 1 })],
      ["GET /v1/doctor", () => api.diagnostics.doctor()],
      ["GET /v1/approvals", () => api.approvals.list()],
      [`GET /v1/approvals/${uuid}`, () => api.approvals.get(uuid)],
      [
        `POST /v1/approvals/${uuid}/decision`,
        () => api.approvals.decide(uuid, { decision: "approve" }),
      ],
      ["GET /v1/approval-rules", () => api.rules.list()],
      ["POST /v1/approval-rules", () => api.rules.create({ tool: "t", effect: "allow" })],
      [`PATCH /v1/approval-rules/${uuid}`, () => api.rules.update(uuid, { effect: "deny" })],
      [`DELETE /v1/approval-rules/${uuid}`, () => api.rules.remove(uuid)],
      ["GET /v1/approval-settings", () => api.approvalSettings.get()],
      ["PATCH /v1/approval-settings", () => api.approvalSettings.update({ mode: "ask_all" })],
      ["GET /v1/written-rules", () => api.writtenRules.list()],
      [
        "POST /v1/written-rules",
        () => api.writtenRules.create({ kind: "allow", text: "e-mails para acme.com" }),
      ],
      [`PATCH /v1/written-rules/${uuid}`, () => api.writtenRules.update(uuid, { kind: "ask" })],
      [`DELETE /v1/written-rules/${uuid}`, () => api.writtenRules.remove(uuid)],
      ["GET /v1/web-search", () => api.webSearch.get()],
      ["GET /v1/vault", () => api.vault.status()],
      ["GET /v1/secrets", () => api.vault.list()],
      ["PUT /v1/secrets/API_TOKEN", () => api.vault.set("API_TOKEN", { value: "12345678" })],
      ["DELETE /v1/secrets/API_TOKEN", () => api.vault.remove("API_TOKEN")],
      [`PUT /v1/secrets/API_TOKEN/grants/${uuid}`, () => api.vault.grant("API_TOKEN", uuid)],
      [`DELETE /v1/secrets/API_TOKEN/grants/${uuid}`, () => api.vault.revoke("API_TOKEN", uuid)],
      [`GET /v1/runs/${uuid}/secret-request`, () => api.vault.request(uuid)],
      [
        `POST /v1/runs/${uuid}/secret-request/answer`,
        () => api.vault.answerRequest(uuid, { declined: true }),
      ],
    ];
    for (const [expected, call] of table) {
      const seen = await attempt(call);
      const url = new URL(seen?.url ?? "http://x");
      expect(`${seen?.method} ${url.pathname}`).toBe(expected);
    }
  });
});
