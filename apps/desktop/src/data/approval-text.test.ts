import { describe, expect, it } from "vitest";
import {
  allowRecipientSentence,
  approvalTitle,
  decidedDetail,
  decidedLabel,
  expiryText,
  instructionLine,
  isConnectorTool,
  matchersText,
  matcherText,
  NETWORK_SCOPE_NOTE,
  NETWORK_TOOL,
  networkLede,
  networkRequestOf,
  parseConnectorTool,
  ruleSentence,
  toolCategory,
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
  it("a condition is always an exact comparison: there is no other wording", () => {
    expect(matcherText({ field: "command", value: "git push" })).toBe(
      "o campo command é exatamente “git push”",
    );
    // "git *" or "/tmp/" are just text to be equal to, never a pattern or a start
    expect(matcherText({ field: "command", value: "git *" })).toBe(
      "o campo command é exatamente “git *”",
    );
  });

  it("every condition has to hold: they are joined by 'e'", () => {
    expect(
      matchersText([
        { field: "a", value: "1" },
        { field: "b", value: "2" },
      ]),
    ).toBe("o campo a é exatamente “1” e o campo b é exatamente “2”");
  });

  it("the sentence of a rule: effect, tool, who, and when", () => {
    expect(
      ruleSentence(
        {
          effect: "allow",
          tool: "shell",
          botId: null,
          matchers: [{ field: "command", value: "git status" }],
        },
        {},
      ),
    ).toBe("Libera Terminal para todos os bots quando o campo command é exatamente “git status”.");
    expect(
      ruleSentence(
        { effect: "deny", tool: "*", botId: "b1", matchers: [] },
        { botName: "Ajudante" },
      ),
    ).toBe(
      "Proíbe qualquer ferramenta para o bot Ajudante em QUALQUER uso da ferramenta, com quaisquer argumentos.",
    );
    expect(ruleSentence({ effect: "allow", tool: "shell", botId: "gone", matchers: [] })).toContain(
      "o bot (removido)",
    );
  });
});

describe("what 'Permitir destinatário' will create", () => {
  it("pins exactly the recipient, for this bot only, and says what keeps asking", () => {
    const text = allowRecipientSentence({
      botName: "Ajudante",
      tool: "conn_mail__send_email",
      recipients: [{ field: "to", value: "ana@exemplo.com" }],
    });
    expect(text).toContain("o bot Ajudante");
    expect(text).toContain("to = “ana@exemplo.com”");
    expect(text).toContain("Qualquer outro destinatário continua pedindo");
    expect(text).not.toContain("todos os bots");
    expect(text).not.toContain("qualquer uso");
  });
});

describe("the instruction line of a card", () => {
  it("says what the bot wants, and for a connector that the content leaves the computer", () => {
    expect(instructionLine("Ajudante", "shell", null)).toContain("Ajudante quer rodar um comando");
    expect(instructionLine("Ajudante", "write_file", null)).toContain("escrever um arquivo");
    expect(instructionLine("Ajudante", "shell", null)).not.toContain("Confira");
    expect(instructionLine("Ajudante", "conn_fake__write_thing", "fake")).toContain(
      "sai deste computador para um servidor externo",
    );
  });
});

describe("the category and the title of a card", () => {
  it("names the category by the tool or the connector; 'Mensagem' only when a call DECLARES it", () => {
    expect(toolCategory("shell")).toEqual({ label: "Terminal", icon: "terminal" });
    expect(toolCategory("write_file").label).toBe("Arquivo");
    expect(toolCategory("web_fetch").label).toBe("Web");
    expect(toolCategory("web_search").label).toBe("Web");
    expect(toolCategory("web_read").label).toBe("Web");
    expect(toolCategory("remember").label).toBe("Memória");
    // a one-time reminder is not a routine (owner, 23/11/2026)
    expect(toolCategory("create_reminder")).toEqual({ label: "Lembrete", icon: "routine" });
    expect(toolCategory("create_routine").label).toBe("Rotina");
    expect(toolCategory("conn_erp__criar_pedido")).toEqual({ label: "erp", icon: "connector" });
    // The name of a tool never makes it a message: only the declaration does.
    expect(toolCategory("conn_gmail__send_email")).toEqual({ label: "gmail", icon: "connector" });
    expect(toolCategory("send_mail")).toEqual({ label: "Ferramenta", icon: "generic" });
    expect(toolCategory("conn_gmail__send_email", [], true)).toEqual({
      label: "Mensagem",
      icon: "mail",
    });
    expect(toolCategory("algo_novo")).toEqual({ label: "Ferramenta", icon: "generic" });
  });

  it("writes a pt-BR title per known tool and falls back to the server's summary", () => {
    expect(approvalTitle("write_file", { path: "a.txt" }, "Write a.txt (3 characters)")).toBe(
      "Escrever a.txt",
    );
    expect(approvalTitle("shell", { command: "git push\nmais" }, "Shell: x")).toBe(
      "Rodar git push",
    );
    expect(approvalTitle("web_fetch", { url: "https://a.b" }, "x")).toBe("Acessar https://a.b");
    expect(approvalTitle("shell", {}, "x")).toBe("Rodar um comando");
    // A page read that asks is of a new address; the title carries all of it, query string included.
    const long = `https://novo.example/a/b?token=${"x".repeat(200)}&q=1`;
    expect(approvalTitle("web_read", { url: long }, "x")).toBe(`Ler uma página nova: ${long}`);
    expect(approvalTitle("web_read", {}, "x")).toBe("Ler uma página nova");
    expect(
      approvalTitle("conn_fake__write_thing", {}, "x", [
        { name: "fake", tools: [{ name: "conn_fake__write_thing", tool: "write_thing" }] },
      ]),
    ).toBe("Usar write_thing no conector fake");
    expect(approvalTitle("tool_nova", {}, "Resumo do servidor")).toBe("Resumo do servidor");
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

describe("the card that asks for network access", () => {
  const args = { host: "api.novo.com", reason: "preciso baixar o relatório" };

  it("is the category 'Rede', named by the tool and never by its text", () => {
    expect(NETWORK_TOOL).toBe("request_network_access");
    expect(toolCategory(NETWORK_TOOL)).toEqual({ label: "Rede", icon: "network" });
    expect(toolCategory("acesso_a_rede").label).toBe("Ferramenta");
  });

  it("the title is 'Acessar <host>', and a missing host does not break it", () => {
    expect(approvalTitle(NETWORK_TOOL, args, "Allow network access to api.novo.com ...")).toBe(
      "Acessar api.novo.com",
    );
    expect(approvalTitle(NETWORK_TOOL, {}, "x")).toBe("Acessar um host");
  });

  it("reads the host and the reason of the call, only for this tool", () => {
    expect(networkRequestOf(NETWORK_TOOL, args)).toEqual({
      host: "api.novo.com",
      reason: "preciso baixar o relatório",
    });
    expect(networkRequestOf(NETWORK_TOOL, { host: " " })).toEqual({
      host: undefined,
      reason: undefined,
    });
    expect(networkRequestOf("web_fetch", args)).toBeNull();
  });

  it("the reason is the bot's own words, and the note says how far an approval reaches", () => {
    expect(networkLede("Nova", "preciso baixar o relatório")).toBe(
      "Motivo dado pelo bot: “preciso baixar o relatório”",
    );
    expect(networkLede("Nova", undefined)).toContain("Nova");
    expect(NETWORK_SCOPE_NOTE).toContain("só para esta execução");
  });
});

describe("decided card: approved through the chat", () => {
  it("says so, from the server's field only", () => {
    const base = { status: "approved", stale: false, waitedMs: 1000 };
    expect(decidedLabel({ ...base, decidedVia: "chat" })).toBe("Aprovado pelo chat");
    expect(decidedLabel({ ...base, decidedVia: "click" })).toBe("Aprovado");
    expect(decidedLabel({ ...base, decidedVia: null })).toBe("Aprovado");
    expect(decidedLabel({ ...base })).toBe("Aprovado");
    expect(decidedDetail({ ...base, decidedVia: "chat" })).toContain("escrevendo no chat");
    // late wins: the action did not run then
    expect(
      decidedLabel({
        status: "approved",
        stale: true,
        waitedMs: 5 * 3_600_000,
        decidedVia: "chat",
      }),
    ).toContain("depois de");
    expect(decidedLabel({ status: "denied", stale: false, waitedMs: 1, decidedVia: "chat" })).toBe(
      "Recusado",
    );
  });
});
