import { describe, expect, it } from "vitest";
import {
  alwaysSentence,
  expiryText,
  instructionLine,
  isConnectorTool,
  matchersText,
  matcherText,
  parseConnectorTool,
  ruleSentence,
  toolTitle,
} from "./approval-text.js";

const connectors = [
  {
    name: "meu-erp",
    tools: [{ name: "conn_meu_erp__criar_pedido", tool: "criar_pedido" }],
  },
  { name: "meu", tools: [] },
];

describe("connector tool names", () => {
  it("reads the connector and the tool from the registered name, with or without the connector list", () => {
    expect(isConnectorTool("conn_meu_erp__criar_pedido")).toBe(true);
    expect(isConnectorTool("shell")).toBe(false);
    expect(parseConnectorTool("conn_meu_erp__criar_pedido", connectors)).toEqual({
      connector: "meu-erp",
      tool: "criar_pedido",
    });
    // The longest connector name wins over a shorter prefix of it.
    expect(parseConnectorTool("conn_meu_erp__outra", connectors)).toEqual({
      connector: "meu-erp",
      tool: "outra",
    });
    expect(parseConnectorTool("conn_fake__write_thing", [])).toEqual({
      connector: "fake",
      tool: "write_thing",
    });
    expect(parseConnectorTool("shell", connectors)).toBeNull();
  });

  it("titles a tool in human words", () => {
    expect(toolTitle("shell")).toBe("Terminal");
    expect(toolTitle("write_file")).toBe("Escrever arquivo");
    expect(toolTitle("*")).toBe("qualquer ferramenta");
    expect(toolTitle("conn_meu_erp__criar_pedido", connectors)).toBe(
      "Conector meu-erp → criar_pedido",
    );
    expect(toolTitle("ferramenta_nova")).toBe("ferramenta_nova");
  });
});

describe("rules in plain language", () => {
  it.each([
    [
      { field: "command", op: "equals", value: "git push" },
      "o campo command é exatamente “git push”",
    ],
    [{ field: "path", op: "starts_with", value: "/tmp/" }, "o campo path começa com “/tmp/”"],
    [{ field: "url", op: "contains", value: "api" }, "o campo url contém “api”"],
    [{ field: "command", op: "glob", value: "git *" }, "o campo command casa com o padrão “git *”"],
  ] as const)("matcher %j", (matcher, text) => {
    expect(matcherText(matcher)).toBe(text);
  });

  it("every condition has to hold: they are joined by 'e'", () => {
    expect(
      matchersText([
        { field: "a", op: "equals", value: "1" },
        { field: "b", op: "contains", value: "2" },
      ]),
    ).toBe("o campo a é exatamente “1” e o campo b contém “2”");
  });

  it("the sentence of a rule: effect, tool, who, and when", () => {
    expect(
      ruleSentence(
        {
          effect: "allow",
          tool: "shell",
          botId: null,
          matchers: [{ field: "command", op: "starts_with", value: "git " }],
        },
        {},
      ),
    ).toBe("Libera Terminal para todos os bots quando o campo command começa com “git ”.");
    expect(
      ruleSentence(
        { effect: "deny", tool: "*", botId: "b1", matchers: [] },
        { botName: "Ajudante" },
      ),
    ).toBe("Proíbe qualquer ferramenta para o bot Ajudante em qualquer uso.");
    expect(ruleSentence({ effect: "allow", tool: "shell", botId: "gone", matchers: [] })).toContain(
      "o bot (removido)",
    );
  });
});

describe("what 'always allow' will create", () => {
  const args = { command: "git push origin main", timeout: 30, cwd: "/repo" };

  it("exactly this: every text argument pinned, numbers left free, and what stays asking", () => {
    const text = alwaysSentence({
      scope: "bot",
      match: "exact",
      botName: "Ajudante",
      tool: "shell",
      args,
    });
    expect(text).toContain("o bot Ajudante");
    expect(text).toContain("command = “git push origin main” e cwd = “/repo”");
    expect(text).not.toContain("timeout");
    expect(text).toContain("continua pedindo");
  });

  it("any use of the tool, for all bots", () => {
    const text = alwaysSentence({
      scope: "global",
      match: "any",
      botName: "x",
      tool: "shell",
      args,
    });
    expect(text).toContain("todos os bots");
    expect(text).toContain("qualquer uso de Terminal");
  });

  it("a call with no text argument cannot be pinned: it says it is any use", () => {
    const text = alwaysSentence({
      scope: "bot",
      match: "exact",
      botName: "x",
      tool: "ferramenta",
      args: { n: 1 },
    });
    expect(text).toContain("qualquer uso");
  });
});

describe("the instruction line of a card", () => {
  it("says what the bot wants, and for a connector that the content leaves the computer", () => {
    expect(instructionLine("Ajudante", "shell", null)).toContain("Ajudante quer rodar um comando");
    expect(instructionLine("Ajudante", "write_file", null)).toContain("escrever um arquivo");
    expect(instructionLine("Ajudante", "conn_fake__write_thing", "fake")).toContain(
      "sai deste computador para um servidor externo",
    );
  });
});

describe("the time left on a card that expires", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  it.each([
    [40_000, "Expira em 40 s"],
    [61_000, "Expira em 2 min"],
    [12 * 60_000, "Expira em 12 min"],
    [3_600_000, "Expira em 1 h"],
    [5_400_000, "Expira em 1 h 30 min"],
    [0, "O prazo acabou"],
    [-5000, "O prazo acabou"],
  ])("%d ms left: %s", (ms, text) => {
    expect(expiryText(at(ms), now)).toBe(text);
  });
  it("a date it cannot read says nothing", () => {
    expect(expiryText("não é data", now)).toBe("");
  });
});
