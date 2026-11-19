import { TOOL_NAME_PATTERN } from "@suup/core";
import { describe, expect, it } from "vitest";
import {
  ConnectorConfigError,
  cleanDescription,
  connectorPrefix,
  hintFloor,
  isConnectorName,
  parseConnectorSpec,
  registeredName,
  scopeAllows,
  secretNamesOf,
  stripControl,
  toolRisk,
} from "../src/index.js";

describe("names", () => {
  it("namespaces a plain tool name and keeps it readable", () => {
    expect(registeredName("github", "search_issues")).toBe("conn_github__search_issues");
    expect(connectorPrefix("my-erp")).toBe("conn_my_erp__");
  });

  it("any server name becomes a valid, deterministic, collision-free registry name", () => {
    const names = [
      "Weird-Name.v2",
      "weird_name_v2",
      "weird-name.v2",
      "x".repeat(200),
      "x".repeat(201),
      "ação",
      "",
      "a b",
      "../../etc",
    ];
    const out = names.map((n) => registeredName("gh", n));
    for (const name of out) expect(name, name).toMatch(TOOL_NAME_PATTERN);
    expect(new Set(out).size).toBe(out.length);
    expect(registeredName("gh", "Weird-Name.v2")).toBe(registeredName("gh", "Weird-Name.v2"));
    // The only names used as they are: plain ones.
    expect(out[1]).toBe("conn_gh__weird_name_v2");
    expect(out[0]).not.toBe(out[1]);
  });

  it("connector names: lowercase words with hyphens", () => {
    for (const ok of ["github", "my-erp", "a1", "x".repeat(24)])
      expect(isConnectorName(ok)).toBe(true);
    for (const bad of [
      "",
      "GitHub",
      "a_b",
      "-a",
      "a-",
      "a--b",
      "1a",
      "x".repeat(25),
      "a b",
      "a__b",
    ]) {
      expect(isConnectorName(bad), bad).toBe(false);
    }
  });
});

describe("risk of a connector tool", () => {
  const spec = (over: Record<string, unknown> = {}) => ({
    tools: {} as Record<string, { risk: "read" | "write_reversible" | "external_irreversible" }>,
    trustAnnotations: false,
    ...over,
  });

  it("asks by default, whatever the server claims", () => {
    expect(toolRisk(spec(), "t", undefined).level).toBe("external_irreversible");
    expect(toolRisk(spec(), "t", { readOnlyHint: true }).level).toBe("external_irreversible");
    expect(toolRisk(spec(), "t", { readOnlyHint: true, destructiveHint: false }).level).toBe(
      "external_irreversible",
    );
  });

  it("a hint can only tighten what the user configured, never loosen it", () => {
    const marked = spec({ tools: { t: { risk: "read" } } });
    expect(toolRisk(marked, "t", undefined)).toEqual({ level: "read", basis: "user" });
    expect(toolRisk(marked, "t", { readOnlyHint: true })).toEqual({ level: "read", basis: "user" });
    // The server now says it is destructive, or that it is not read-only: it asks again.
    expect(toolRisk(marked, "t", { destructiveHint: true })).toEqual({
      level: "external_irreversible",
      basis: "tightened_by_hint",
    });
    expect(toolRisk(marked, "t", { readOnlyHint: false }).level).toBe("external_irreversible");
    // The user's own stricter choice stays, whatever the hint.
    const strict = spec({ tools: { t: { risk: "external_irreversible" } } });
    expect(toolRisk(strict, "t", { readOnlyHint: true }).level).toBe("external_irreversible");
    expect(hintFloor({ readOnlyHint: true })).toBe("read");
  });

  it("trusting annotations is the user's explicit choice, and still cannot beat a destructive hint", () => {
    const trusting = spec({ trustAnnotations: true });
    expect(toolRisk(trusting, "t", { readOnlyHint: true })).toEqual({
      level: "read",
      basis: "trusted_hint",
    });
    expect(toolRisk(trusting, "t", undefined).level).toBe("external_irreversible");
    expect(toolRisk(trusting, "t", { readOnlyHint: true, destructiveHint: true }).level).toBe(
      "external_irreversible",
    );
  });

  it("read_only scope keeps only reads", () => {
    expect(scopeAllows("read_only", "read")).toBe(true);
    expect(scopeAllows("read_only", "write_reversible")).toBe(false);
    expect(scopeAllows("read_only", "external_irreversible")).toBe(false);
    expect(scopeAllows("read_write", "external_irreversible")).toBe(true);
  });
});

describe("text from a server", () => {
  it("strips control, invisible and direction-changing characters, keeps line breaks", () => {
    expect(stripControl("a\u0000b\u0007c​d‮e⁦f﻿g\u{e0041}h\nz\tq")).toBe("abcdefgh\nz\tq");
  });

  it("cleans, collapses and bounds a description", () => {
    const text = cleanDescription(`  Hello\r\n\r\n\r\n\r\nWorld‮ ${"x".repeat(5000)}`, 100);
    expect(text.length).toBeLessThanOrEqual(101);
    expect(text.startsWith("Hello\n\nWorld")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(cleanDescription(undefined, 10)).toBe("");
  });
});

describe("connector configuration", () => {
  const stdio = (over: Record<string, unknown> = {}) => ({
    name: "tools",
    transport: { kind: "stdio", command: "node", args: ["server.js"], ...over },
  });

  it("fills the defaults", () => {
    const spec = parseConnectorSpec(stdio());
    expect(spec).toMatchObject({
      scope: "read_write",
      trustAnnotations: false,
      timeoutMs: 60_000,
      tools: {},
    });
    expect(spec.transport).toMatchObject({ kind: "stdio", env: {}, args: ["server.js"] });
  });

  const invalid: [string, unknown, RegExp][] = [
    ["a command with a shell string", stdio({ command: "npx -y server" }), /só o executável/],
    ["a shell -c", stdio({ command: "/bin/bash", args: ["-c", "curl x | sh"] }), /interpolação/],
    ["LD_PRELOAD", stdio({ env: { LD_PRELOAD: "x" } }), /não pode ser definida/],
    ["NODE_OPTIONS", stdio({ env: { NODE_OPTIONS: "--require x" } }), /não pode ser definida/],
    ["a bad env name", stdio({ env: { "A B": "x" } }), /nome de variável/],
    ["a bad secret name", stdio({ env: { TOKEN: { secret: "lower" } } }), /segredo/],
    ["an unknown field", { ...stdio(), extra: 1 }, /extra|chaves/i],
    ["a bad connector name", { ...stdio(), name: "Bad_Name" }, /minúsculas/],
    [
      "http without TLS",
      { name: "web", transport: { kind: "http", url: "http://example.com/mcp" } },
      /https/,
    ],
    [
      "a password in the URL",
      { name: "web", transport: { kind: "http", url: "https://u:p@example.com/mcp" } },
      /senha/,
    ],
    [
      "a bad header name",
      {
        name: "web",
        transport: { kind: "http", url: "https://example.com/mcp", headers: { "A B": "x" } },
      },
      /cabeçalho/,
    ],
    ["a bad risk", { ...stdio(), tools: { t: { risk: "free" } } }, /risco/],
    ["a timeout out of range", { ...stdio(), timeoutMs: 5 }, /timeoutMs|>=/],
  ];
  for (const [what, input, message] of invalid) {
    it(`refuses ${what}`, () => {
      expect(() => parseConnectorSpec(input)).toThrow(ConnectorConfigError);
      expect(() => parseConnectorSpec(input)).toThrow(message);
    });
  }

  it("accepts plain http only for localhost, and lists the secrets a connector refers to", () => {
    const local = parseConnectorSpec({
      name: "local",
      transport: {
        kind: "http",
        url: "http://127.0.0.1:9000/mcp",
        headers: {
          Authorization: { secret: "API_TOKEN", prefix: "Bearer " },
          "X-A": { secret: "API_TOKEN" },
        },
      },
    });
    expect(secretNamesOf(local)).toEqual(["API_TOKEN"]);
    const env = parseConnectorSpec(stdio({ env: { A: { secret: "B_TOKEN" }, LOG: "debug" } }));
    expect(secretNamesOf(env)).toEqual(["B_TOKEN"]);
  });
});
