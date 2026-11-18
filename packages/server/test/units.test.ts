import { ERROR_CODES, ERROR_STATUS, MEMORY_LAYERS, WRITABLE_MEMORY_LAYERS } from "@suup/api";
import {
  ConversationNotFoundError,
  ConversationRuleError,
  MEMORY_LAYERS as DB_LAYERS,
  RunControlError,
  RunNotFoundError,
} from "@suup/db";
import { RuntimeError } from "@suup/runtime";
import { describe, expect, it } from "vitest";
import { type ZodError, z } from "zod";
import {
  assertToken,
  bearerToken,
  checkOrigin,
  constantTimeEqual,
  corsHeaders,
  generateToken,
  HttpError,
  isAuthorized,
  MIN_TOKEN_LENGTH,
  toHttpError,
} from "../src/index.js";
import { splitExcerpt } from "../src/routes/memories.js";

describe("tokens", () => {
  it("generates a different, long, URL-safe token every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => assertToken(a)).not.toThrow();
  });

  it("assertToken explains what is wrong", () => {
    expect(() => assertToken(undefined, "a variável FOO")).toThrow(/a variável FOO/);
    expect(() => assertToken("a".repeat(31))).toThrow(/31 caracteres/);
    expect(() => assertToken("a".repeat(32))).not.toThrow();
  });

  describe("constantTimeEqual", () => {
    it("compares by value, whatever the lengths", () => {
      expect(constantTimeEqual("abc", "abc")).toBe(true);
      expect(constantTimeEqual("abc", "abd")).toBe(false);
      expect(constantTimeEqual("abc", "abcd")).toBe(false);
      expect(constantTimeEqual("", "")).toBe(true);
      expect(constantTimeEqual("", "x")).toBe(false);
      expect(constantTimeEqual("ação", "ação")).toBe(true);
      expect(constantTimeEqual("ação", "acao")).toBe(false);
    });

    it("does not take longer when the difference is at the start than at the end", () => {
      // A statistical smoke test, not a proof: the comparison is on fixed-size hashes. The two
      // medians over many repetitions stay within the same order of magnitude.
      const token = "t".repeat(64);
      const early = `x${token.slice(1)}`;
      const late = `${token.slice(0, -1)}x`;
      const time = (candidate: string) => {
        const samples: number[] = [];
        for (let round = 0; round < 15; round++) {
          const start = process.hrtime.bigint();
          for (let i = 0; i < 2000; i++) constantTimeEqual(candidate, token);
          samples.push(Number(process.hrtime.bigint() - start));
        }
        return samples.sort((a, b) => a - b)[7] as number;
      };
      const ratio = time(early) / time(late);
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5);
    });
  });

  describe("bearerToken and isAuthorized", () => {
    const token = "k".repeat(40);
    it("reads only a well-formed Bearer header", () => {
      expect(bearerToken(`Bearer ${token}`)).toBe(token);
      expect(bearerToken(`bearer ${token}`)).toBe(token);
      expect(bearerToken(`Bearer   ${token}  `)).toBe(token);
      expect(bearerToken(undefined)).toBeUndefined();
      expect(bearerToken(["Bearer a", "Bearer b"])).toBeUndefined();
      expect(bearerToken("Bearer")).toBeUndefined();
      expect(bearerToken("Bearer a b")).toBeUndefined();
      expect(bearerToken("Basic abc")).toBeUndefined();
      expect(bearerToken(token)).toBeUndefined();
    });

    it("authorizes only the exact token", () => {
      expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
      expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
      expect(isAuthorized(undefined, token)).toBe(false);
      expect(isAuthorized("Bearer ", token)).toBe(false);
      // A missing header never matches, even if the configured token were empty.
      expect(isAuthorized(undefined, "")).toBe(false);
    });
  });
});

describe("CORS helpers", () => {
  const allowed = new Set(["http://localhost:1420", "tauri://localhost"]);
  it("classifies the Origin header", () => {
    expect(checkOrigin(undefined, allowed)).toEqual({ kind: "none" });
    expect(checkOrigin("tauri://localhost", allowed)).toEqual({
      kind: "allowed",
      origin: "tauri://localhost",
    });
    expect(checkOrigin("http://localhost:1420/", allowed)).toEqual({
      kind: "denied",
      origin: "http://localhost:1420/",
    });
    expect(checkOrigin("null", allowed)).toEqual({ kind: "denied", origin: "null" });
    expect(checkOrigin(["a", "b"], allowed)).toEqual({ kind: "none" });
    expect(checkOrigin("http://localhost:1420", new Set())).toMatchObject({ kind: "denied" });
  });

  it("echoes the one origin (never *), and adds the preflight headers only for a preflight", () => {
    const simple = corsHeaders("tauri://localhost", false);
    expect(simple).toEqual({ "Access-Control-Allow-Origin": "tauri://localhost", Vary: "Origin" });
    const pre = corsHeaders("tauri://localhost", true);
    expect(pre["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(pre["Access-Control-Allow-Origin"]).not.toBe("*");
  });
});

describe("error mapping", () => {
  const map = (error: unknown) => {
    const mapped = toHttpError(error);
    return [mapped.code, mapped.status] as const;
  };

  it("every code has a status, and the list is the documented closed one", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    expect(ERROR_CODES).toHaveLength(13);
  });

  it("maps the runtime's and the database's errors to the documented codes", () => {
    const runtime = (code: ConstructorParameters<typeof RuntimeError>[0]) =>
      new RuntimeError(code, "m");
    expect(map(runtime("bot_not_found"))).toEqual(["not_found", 404]);
    expect(map(runtime("run_not_found"))).toEqual(["not_found", 404]);
    expect(map(runtime("conversation_not_found"))).toEqual(["not_found", 404]);
    expect(map(runtime("event_not_found"))).toEqual(["not_found", 404]);
    expect(map(runtime("bot_archived"))).toEqual(["conflict", 409]);
    expect(map(runtime("conversation_unsupported"))).toEqual(["conflict", 409]);
    expect(map(runtime("not_a_model_request"))).toEqual(["conflict", 409]);
    expect(map(runtime("model_provider_mismatch"))).toEqual(["conflict", 409]);
    expect(map(runtime("empty_message"))).toEqual(["invalid_request", 400]);
    expect(map(runtime("invalid_input"))).toEqual(["invalid_request", 400]);
    expect(map(runtime("draft_failed"))).toEqual(["provider_error", 502]);
    expect(map(runtime("sandbox_failed"))).toEqual(["unavailable", 503]);
    expect(map(new RunControlError("not_found", "m"))).toEqual(["not_found", 404]);
    expect(map(new RunControlError("finished", "m"))).toEqual(["conflict", 409]);
    expect(map(new RunControlError("not_pausable", "m"))).toEqual(["conflict", 409]);
    expect(map(new ConversationNotFoundError("x"))).toEqual(["not_found", 404]);
    expect(map(new RunNotFoundError("x"))).toEqual(["not_found", 404]);
    expect(map(new ConversationRuleError("x"))).toEqual(["conflict", 409]);
  });

  it("maps validation errors to invalid_request, listing the fields in Portuguese-friendly form", () => {
    const error = z.object({ a: z.string(), b: z.number() }).safeParse({ a: 1 }).error as ZodError;
    const mapped = toHttpError(error);
    expect(mapped.code).toBe("invalid_request");
    expect(mapped.message).toMatch(/a: esperado texto/);
    expect(mapped.message).toMatch(/b: campo obrigatório ausente/);
  });

  it("describes validation problems in Portuguese, whatever kind they are", () => {
    const schema = z.object({
      name: z.string().min(2).max(5),
      id: z.uuid(),
      kind: z.enum(["a", "b"]),
      tags: z.array(z.string()).min(1),
      n: z.number().int().min(3),
      when: z.iso.datetime(),
      custom: z.string().refine(() => false, "a mensagem está vazia"),
    });
    const message = toHttpError(
      schema.safeParse({
        name: "x",
        id: "no",
        kind: "c",
        tags: [],
        n: 1,
        when: "ontem",
        custom: "z",
      }).error,
    ).message;
    expect(message).toContain("name: deve ter no mínimo 2 caracteres");
    expect(message).toContain("id: deve ser um UUID válido");
    expect(message).toContain('kind: valor inválido; opções: "a", "b"');
    expect(message).toContain("tags: deve ter no mínimo 1 item");
    expect(message).toContain("n: deve ser no mínimo 3");
    expect(message).toContain("when: deve ser uma data ISO 8601");
    expect(message).toContain("custom: a mensagem está vazia");
    expect(message).not.toMatch(/Invalid|expected|received|Too small/);
    const long = toHttpError(z.object({ s: z.string().max(3) }).safeParse({ s: "abcdef" }).error);
    expect(long.message).toBe("s: deve ter no máximo 3 caracteres");
  });

  it("turns a database that is down into unavailable, and anything unknown into a generic internal_error", () => {
    expect(map(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))).toEqual([
      "unavailable",
      503,
    ]);
    expect(map(Object.assign(new Error("boom"), { code: "57P01" }))).toEqual(["unavailable", 503]);
    const unknown = toHttpError(new Error("password=hunter2 leaked in a stack"));
    expect(unknown.code).toBe("internal_error");
    expect(unknown.message).not.toContain("hunter2"); // internals never reach the client
    expect(toHttpError("a string")).toBeInstanceOf(HttpError);
    const own = new HttpError("conflict", "x");
    expect(toHttpError(own)).toBe(own);
  });
});

describe("splitExcerpt", () => {
  it("turns the database's highlight markers into plain text and offsets", () => {
    const marked = "Vou de \u0002ônibus\u0003 às vezes, o \u0002ônibus\u0003 303";
    expect(splitExcerpt(marked)).toEqual({
      excerpt: "Vou de ônibus às vezes, o ônibus 303",
      matches: [
        { start: 7, end: 13 },
        { start: 26, end: 32 },
      ],
    });
    expect(splitExcerpt("sem marcação")).toEqual({ excerpt: "sem marcação", matches: [] });
    expect(splitExcerpt("aberta \u0002sem fim")).toEqual({
      excerpt: "aberta sem fim",
      matches: [],
    });
  });
});

describe("the contract follows the database", () => {
  it("memory layers are the database's, and the writable ones are all but the diary", () => {
    expect([...MEMORY_LAYERS]).toEqual([...DB_LAYERS]);
    expect([...WRITABLE_MEMORY_LAYERS]).toEqual(DB_LAYERS.filter((l) => l !== "journal"));
  });
});
