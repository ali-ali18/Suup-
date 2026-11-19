import { describe, expect, it } from "vitest";
import {
  argsOf,
  bearerRow,
  buildCreateBody,
  type ConnectorForm,
  emptyForm,
  emptyRow,
} from "./connector-form.js";

const stdio = (over: Partial<ConnectorForm> = {}): ConnectorForm => ({
  ...emptyForm("stdio"),
  name: "meu-erp",
  command: "node",
  ...over,
});

describe("the add-connector form becomes the API body", () => {
  it("a local program: the executable alone, one argument per line, env as text or a vault reference", () => {
    const result = buildCreateBody(
      stdio({
        description: " ERP da loja ",
        argsText: "--experimental-strip-types\n\n  server.ts  \r\n",
        env: [
          emptyRow({ key: "FAKE_LOG", text: "/tmp/x.log" }),
          emptyRow({ key: "API_TOKEN", mode: "secret", secret: "ERP_TOKEN" }),
        ],
        timeoutSec: "30",
        grantBotIds: ["b1"],
        scope: "read_write",
      }),
      ["ERP_TOKEN"],
    );
    expect(result).toEqual({
      ok: true,
      body: {
        name: "meu-erp",
        description: "ERP da loja",
        scope: "read_write",
        timeoutMs: 30_000,
        grants: [{ botId: "b1", tools: "all" }],
        transport: {
          kind: "stdio",
          command: "node",
          args: ["--experimental-strip-types", "  server.ts  "],
          env: { FAKE_LOG: "/tmp/x.log", API_TOKEN: { secret: "ERP_TOKEN" } },
        },
      },
    });
  });

  it("the default scope is read-only, and empty optional parts are left out", () => {
    const result = buildCreateBody(stdio(), []);
    expect(result).toEqual({
      ok: true,
      body: { name: "meu-erp", scope: "read_only", transport: { kind: "stdio", command: "node" } },
    });
  });

  it("an HTTP connector: the URL and headers, with the Authorization Bearer shortcut", () => {
    const form: ConnectorForm = {
      ...emptyForm("http"),
      name: "api",
      url: " https://mcp.example.com/mcp ",
      headers: [bearerRow("API_TOKEN"), emptyRow({ key: "X-Team", text: "loja" })],
    };
    const result = buildCreateBody(form, ["API_TOKEN"]);
    expect(result).toMatchObject({
      ok: true,
      body: {
        transport: {
          kind: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: { secret: "API_TOKEN", prefix: "Bearer " }, "X-Team": "loja" },
        },
      },
    });
  });

  it("a command with spaces is refused with the way out: arguments go in the list", () => {
    const result = buildCreateBody(stdio({ command: "node server.ts" }), []);
    expect(result).toMatchObject({
      ok: false,
      errors: { command: expect.stringContaining("sem espaços") },
    });
  });

  it.each([
    ["name", { name: "" }, "Dê um nome"],
    ["name", { name: "Meu_ERP" }, "minúsculas"],
    ["name", { name: "a".repeat(25) }, "24"],
    ["command", { command: "" }, "qual programa"],
    ["timeout", { timeoutSec: "0" }, "1 a 600"],
    ["timeout", { timeoutSec: "abc" }, "1 a 600"],
    ["timeout", { timeoutSec: "601" }, "1 a 600"],
  ] as const)("%s: %j is refused", (field, over, text) => {
    const result = buildCreateBody(stdio(over), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toContain(text);
  });

  it("environment variables: a valid name, no repeats, a value, and a secret that exists in the vault", () => {
    const env = (rows: ReturnType<typeof emptyRow>[]) => {
      const result = buildCreateBody(stdio({ env: rows }), ["OK_SECRET"]);
      return result.ok ? undefined : result.errors.env;
    };
    expect(env([emptyRow({ key: "", text: "x" })])).toContain("Dê um nome");
    expect(env([emptyRow({ key: "1BAD", text: "x" })])).toContain("não é um nome válido");
    expect(env([emptyRow({ key: "A", text: "x" }), emptyRow({ key: "A", text: "y" })])).toContain(
      "duas vezes",
    );
    expect(env([emptyRow({ key: "A", text: "" })])).toContain("Escreva o valor");
    expect(env([emptyRow({ key: "A", mode: "secret", secret: "" })])).toContain(
      "Escolha o segredo",
    );
    expect(env([emptyRow({ key: "A", mode: "secret", secret: "NO_SUCH" })])).toContain(
      "não existe no cofre",
    );
    expect(env([emptyRow({ key: "A", mode: "secret", secret: "OK_SECRET" })])).toBeUndefined();
  });

  it("HTTP: the address must be http(s), and header names are real header names", () => {
    const base = { ...emptyForm("http"), name: "api" };
    const run = (over: Partial<ConnectorForm>) => buildCreateBody({ ...base, ...over }, []);
    expect(run({ url: "" })).toMatchObject({ ok: false, errors: { url: expect.any(String) } });
    expect(run({ url: "ftp://x" })).toMatchObject({
      ok: false,
      errors: { url: expect.any(String) },
    });
    expect(
      run({ url: "https://x.y/mcp", headers: [emptyRow({ key: "Bad Header", text: "x" })] }),
    ).toMatchObject({
      ok: false,
      errors: { headers: expect.stringContaining("não é um nome válido") },
    });
  });

  it("the arguments are lines: blank ones go, the rest are kept as typed", () => {
    expect(argsOf("a\n\n b \n\r\n")).toEqual(["a", " b "]);
    expect(argsOf("")).toEqual([]);
  });
});
