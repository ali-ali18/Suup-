import { describe, expect, it } from "vitest";
import { makeConnectorTool } from "../test-fixtures.js";
import {
  BLOCKED_TEXT,
  blockedCount,
  countLabel,
  countOf,
  draftOf,
  grantableTools,
  grantBody,
  isDirty,
  isTicked,
  NOTHING,
  selectAll,
  selectNone,
  selectReadOnly,
  tickedNames,
  toggleTool,
} from "./tool-grants.js";

const tool = (name: string, over: Parameters<typeof makeConnectorTool>[0] = {}) =>
  makeConnectorTool({ tool: name, name: `conn_fake__${name}`, ...over });

const TOOLS = [
  tool("echo", { risk: "read" }),
  tool("list", { risk: "read" }),
  tool("write_thing", { risk: "write_reversible" }),
  tool("send", { risk: "external_irreversible" }),
  tool("hidden", { available: false, reason: "esquema não suportado" }),
];
const list = grantableTools(TOOLS);

describe("the tools a bot can be given", () => {
  it("lists the offered tools only, and marks the ones a review blocks", () => {
    expect(list.map((i) => i.tool.tool)).toEqual(["echo", "list", "write_thing", "send"]);
    const withReview = grantableTools([
      tool("a"),
      tool("b", { pin: "changed" }),
      tool("c", { pin: "new" }),
      tool("d", { pin: "unseen" }),
    ]);
    expect(withReview.map((i) => i.blocked)).toEqual([null, "changed", "new", null]);
    expect(blockedCount(withReview)).toBe(2);
    expect(grantableTools(null)).toEqual([]);
  });

  it("a bot with no grant starts with nothing ticked", () => {
    const draft = draftOf(undefined);
    expect(draft).toEqual(NOTHING);
    expect(tickedNames(draft, list)).toEqual([]);
    expect(countLabel(draft, list)).toBe("0 de 4");
  });
});

describe("ticking, and the three shortcuts", () => {
  it("ticks and unticks one tool at a time", () => {
    let draft = draftOf(undefined);
    draft = toggleTool(draft, list, "echo");
    draft = toggleTool(draft, list, "send");
    expect(tickedNames(draft, list)).toEqual(["echo", "send"]);
    expect(countLabel(draft, list)).toBe("2 de 4");
    draft = toggleTool(draft, list, "echo");
    expect(tickedNames(draft, list)).toEqual(["send"]);
    expect(toggleTool(draft, list, "nope")).toBe(draft);
  });

  it("'Selecionar todas' is the only way to get `all`; unticking one of them makes an explicit list", () => {
    const all = selectAll();
    expect(all).toEqual({ all: true, tools: [] });
    expect(countLabel(all, list)).toBe("4 de 4 (todas)");
    expect(isTicked(all, list[0] as (typeof list)[number])).toBe(true);
    const less = toggleTool(all, list, "send");
    expect(less).toEqual({ all: false, tools: ["echo", "list", "write_thing"] });
    // Ticking every box by hand is still an explicit list, never `all`.
    let hand = draftOf(undefined);
    for (const name of ["echo", "list", "write_thing", "send"]) hand = toggleTool(hand, list, name);
    expect(grantBody(hand, list)).toEqual({ tools: ["echo", "list", "write_thing", "send"] });
    expect(grantBody(all, list)).toEqual({ tools: "all" });
  });

  it("'Só as de leitura' takes the tools whose risk is read, as a list", () => {
    const draft = selectReadOnly(list);
    expect(draft).toEqual({ all: false, tools: ["echo", "list"] });
    expect(grantBody(draft, list)).toEqual({ tools: ["echo", "list"] });
    expect(countLabel(draft, list)).toBe("2 de 4");
  });

  it("'Nenhuma' clears everything", () => {
    expect(selectNone()).toEqual({ all: false, tools: [] });
    expect(grantBody(selectNone(), list)).toEqual({ tools: [] });
  });
});

describe("a tool that is new or changed cannot be ticked", () => {
  const reviewed = grantableTools([
    tool("echo", { risk: "read" }),
    tool("moved", { risk: "read", pin: "changed" }),
    tool("fresh", { risk: "read", pin: "new" }),
  ]);

  it("shows unticked even when the server's grant names it, and ignores a tick on it", () => {
    const saved = draftOf({ botId: "b", all: false, tools: ["echo", "moved"] });
    expect(tickedNames(saved, reviewed)).toEqual(["echo"]);
    expect(toggleTool(saved, reviewed, "moved")).toBe(saved);
    expect(toggleTool(saved, reviewed, "fresh")).toBe(saved);
  });

  it("is left out of 'todas' and of 'só as de leitura', and counted against the total", () => {
    expect(tickedNames(selectAll(), reviewed)).toEqual(["echo"]);
    expect(countOf(selectAll(), reviewed)).toEqual({ selected: 1, total: 3 });
    expect(selectReadOnly(reviewed).tools).toEqual(["echo"]);
    expect(grantBody({ all: false, tools: ["echo", "moved"] }, reviewed)).toEqual({
      tools: ["echo"],
    });
  });

  it("says why", () => {
    expect(BLOCKED_TEXT.changed).toContain("mudou");
    expect(BLOCKED_TEXT.new).toContain("nova");
  });
});

describe("what changed since the server's grant", () => {
  it("is dirty only when the choice differs, whatever the order", () => {
    const saved = draftOf({ botId: "b", all: false, tools: ["echo", "list"] });
    expect(isDirty({ all: false, tools: ["list", "echo"] }, saved)).toBe(false);
    expect(isDirty({ all: false, tools: ["echo"] }, saved)).toBe(true);
    expect(isDirty(selectAll(), saved)).toBe(true);
    expect(isDirty(draftOf(undefined), draftOf(undefined))).toBe(false);
    expect(isDirty(selectAll(), draftOf({ botId: "b", all: true, tools: [] }))).toBe(false);
  });
});
