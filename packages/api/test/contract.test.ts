import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_EVENT_TYPES as CORE_EVENT_TYPES,
  FAILURE_ORIGINS as CORE_FAILURE_ORIGINS,
  RUN_ORIGINS as CORE_ORIGINS,
  runStatusSchema as coreStatus,
} from "@suup/core";
import { describe, expect, it } from "vitest";
import {
  addMemoryBodySchema,
  approvalSchema,
  BOT_COLORS,
  BOT_PALETTE,
  botColorSchema,
  decideApprovalBodySchema,
  FAILURE_ORIGINS,
  listMessagesQuerySchema,
  listRunsQuerySchema,
  RUN_EVENT_TYPES,
  RUN_ORIGINS,
  RUN_STATUSES,
  runEventsQuerySchema,
  sendMessageBodySchema,
  streamEventSchema,
  streamQuerySchema,
  updateBotBodySchema,
} from "../src/index.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("the contract follows the core's vocabulary", () => {
  // The API package carries its own copy of these lists (it must not pull the core into a browser);
  // this keeps the copies honest.
  it("run statuses, origins, failure origins and event types are the core's", () => {
    expect([...RUN_STATUSES]).toEqual(coreStatus.options);
    expect([...RUN_ORIGINS]).toEqual([...CORE_ORIGINS]);
    expect([...FAILURE_ORIGINS]).toEqual([...CORE_FAILURE_ORIGINS]);
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...CORE_EVENT_TYPES].sort());
  });
});

describe("browser safety", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

  it("uses nothing of Node at runtime: no node: imports, no process, no Buffer, no require", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["']node:/);
      expect(text, file).not.toMatch(/\brequire\s*\(/);
      expect(text, file).not.toMatch(/\bprocess\./);
      expect(text, file).not.toMatch(/\bBuffer\b/);
      expect(text, file).not.toMatch(/__dirname|__filename/);
      // What it imports from outside itself: zod, and TYPES of the core (erased at build time).
      for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
        const [, isType, from] = match;
        if (from?.startsWith(".")) continue;
        if (from === "zod") continue;
        expect(from, `${file} imports ${from}`).toBe("@suup/core");
        expect(isType, `${file}: imports of @suup/core must be \`import type\``).toBeDefined();
      }
    }
  });

  it("depends only on zod (and the core's types) in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@suup/core", "zod"]);
  });
});

describe("request schemas", () => {
  it("read query values as text and apply the documented defaults and limits", () => {
    expect(listMessagesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(listMessagesQuerySchema.parse({ before: "10", limit: "5" })).toEqual({
      before: 10,
      limit: 5,
    });
    expect(listMessagesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ before: "abc" }).success).toBe(false);
    expect(listRunsQuerySchema.parse({ status: "done" })).toEqual({ status: "done", limit: 50 });
    expect(listRunsQuerySchema.safeParse({ status: "paused" }).success).toBe(false);
    expect(listRunsQuerySchema.safeParse({ botId: "x" }).success).toBe(false);
    expect(runEventsQuerySchema.parse({ types: "tool_call, tool_result", view: "chat" })).toEqual({
      types: ["tool_call", "tool_result"],
      view: "chat",
      afterSeq: 0,
      limit: 200,
    });
    expect(runEventsQuerySchema.safeParse({ types: "nope" }).success).toBe(false);
    expect(runEventsQuerySchema.safeParse({ view: "tiny" }).success).toBe(false);
    expect(runEventsQuerySchema.safeParse({ limit: "1001" }).success).toBe(false);
  });

  it("validate bodies: blank text, unknown layers, empty patches", () => {
    expect(sendMessageBodySchema.safeParse({ text: "oi" }).success).toBe(true);
    expect(sendMessageBodySchema.safeParse({ text: "  \n " }).success).toBe(false);
    expect(sendMessageBodySchema.safeParse({}).success).toBe(false);
    expect(addMemoryBodySchema.safeParse({ layer: "rule", text: "x" }).success).toBe(true);
    expect(addMemoryBodySchema.safeParse({ layer: "journal", text: "x" }).success).toBe(false);
    expect(addMemoryBodySchema.safeParse({ layer: "rule", text: "x", botId: "nope" }).success).toBe(
      false,
    );
    expect(updateBotBodySchema.safeParse({}).success).toBe(false);
    expect(updateBotBodySchema.safeParse({ name: "x" }).success).toBe(true);
    expect(
      streamQuerySchema.parse({
        runs: "11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222",
      }).runs,
    ).toHaveLength(2);
    expect(streamQuerySchema.safeParse({ runs: "x" }).success).toBe(false);
    expect(
      streamQuerySchema.safeParse({
        runs: Array.from({ length: 51 }, () => "11111111-1111-4111-8111-111111111111").join(","),
      }).success,
    ).toBe(false);
  });
});

describe("stream events", () => {
  it("ready and resync carry no id; the rest must", () => {
    expect(
      streamEventSchema.safeParse({ type: "ready", data: { head: 1, resync: false, runs: [] } })
        .success,
    ).toBe(true);
    expect(
      streamEventSchema.safeParse({ type: "resync", data: { reason: "too_old" } }).success,
    ).toBe(true);
    expect(
      streamEventSchema.safeParse({ type: "resync", data: { reason: "whatever" } }).success,
    ).toBe(false);
    expect(
      streamEventSchema.safeParse({
        type: "run.event",
        data: {
          runId: "11111111-1111-4111-8111-111111111111",
          event: { seq: 1, type: "nudge", createdAt: "2026-11-18T20:00:00.000Z", payload: {} },
        },
      }).success,
    ).toBe(false); // no id
    expect(
      streamEventSchema.safeParse({
        type: "run.event",
        id: 5,
        data: {
          runId: "11111111-1111-4111-8111-111111111111",
          event: { seq: 1, type: "nudge", createdAt: "2026-11-18T20:00:00.000Z", payload: {} },
        },
      }).success,
    ).toBe(true);
    expect(streamEventSchema.safeParse({ type: "other", id: 1, data: {} }).success).toBe(false);
  });
});

describe("bot palette", () => {
  const luminance = (hex: string): number => {
    const channel = (i: number) => {
      const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("every colour's text colour reads on it with at least 4.5:1", () => {
    for (const [id, entry] of Object.entries(BOT_PALETTE)) {
      expect(contrast(entry.fill, entry.onFill), id).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(entry.userBubbleFill, entry.userBubbleOnFill),
        `${id} (user bubble)`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(entry.id).toBe(id);
    }
  });

  it("the user's bubble is the bot's colour, except for the white bot: a neutral grey with light text", () => {
    for (const [id, entry] of Object.entries(BOT_PALETTE)) {
      if (id === "branco") continue;
      expect([entry.userBubbleFill, entry.userBubbleOnFill]).toEqual([entry.fill, entry.onFill]);
    }
    expect(BOT_PALETTE.branco.fill).toBe("#ffffff");
    expect(BOT_PALETTE.branco.userBubbleFill).toBe("#3a3a3c");
    expect(luminance(BOT_PALETTE.branco.userBubbleFill)).toBeLessThan(0.1);
    expect(luminance(BOT_PALETTE.branco.userBubbleOnFill)).toBeGreaterThan(0.8);
  });

  it("the ids are the closed set the schema accepts", () => {
    expect(botColorSchema.options).toEqual(Object.keys(BOT_PALETTE));
    expect(botColorSchema.safeParse("vermelho-vivo; background:url(x)").success).toBe(false);
    expect(BOT_COLORS).toContain("branco");
  });
});

describe("approvals in the contract", () => {
  const card = {
    id: "11111111-1111-4111-8111-111111111111",
    runId: "11111111-1111-4111-8111-111111111111",
    botId: "11111111-1111-4111-8111-111111111111",
    conversationId: null,
    callId: "c1",
    tool: "send",
    args: { to: "ana" },
    level: "external_irreversible",
    summary: "Send",
    secrets: ["TOKEN"],
    source: "rule",
    status: "pending",
    reason: null,
    ruleId: null,
    expiresAt: null,
    decidedAt: null,
    createdAt: "2026-11-18T20:00:00.000Z",
  };

  it("the stream carries the card, and an unknown level or status is refused", () => {
    const frame = (approval: unknown) =>
      streamEventSchema.safeParse({
        type: "approval.changed",
        id: 7,
        data: { change: "created", approval },
      }).success;
    expect(frame(card)).toBe(true);
    expect(frame({ ...card, level: "nuclear" })).toBe(false);
    expect(frame({ ...card, status: "maybe" })).toBe(false);
    expect(approvalSchema.safeParse(card).success).toBe(true);
  });

  it("a decision is either an approval (maybe always) or a denial (maybe with a reason)", () => {
    const ok = (body: unknown) => decideApprovalBodySchema.safeParse(body).success;
    expect(ok({ decision: "approve" })).toBe(true);
    expect(ok({ decision: "approve", always: { scope: "global" } })).toBe(true);
    expect(ok({ decision: "approve", always: {} })).toBe(true);
    expect(ok({ decision: "deny", reason: "no" })).toBe(true);
    expect(ok({ decision: "deny" })).toBe(true);
    expect(ok({ decision: "maybe" })).toBe(false);
    expect(ok({})).toBe(false);
    expect(
      ok({
        decision: "approve",
        always: { scope: "bot", matchers: [{ field: "a", op: "regex", value: "b" }] },
      }),
    ).toBe(false);
  });
});
