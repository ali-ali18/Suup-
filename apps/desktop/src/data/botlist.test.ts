import { describe, expect, it } from "vitest";
import { makeBot } from "../test-fixtures.js";
import { arrangeBots, filterBots, flatBots, fold } from "./botlist.js";

describe("arrangeBots", () => {
  const principal = makeBot({ name: "Principal", isDefault: true });
  const nova = makeBot({ name: "Nova", isDefault: false });
  const gota = makeBot({ name: "Gota", isDefault: false, groupName: "Estudos" });
  const atlas = makeBot({ name: "Atlas", isDefault: false, groupName: "Trabalho" });
  const fixo = makeBot({
    name: "Fixo",
    isDefault: false,
    pinned: true,
    groupName: "Estudos",
    sortOrder: 1,
  });
  const fixo2 = makeBot({ name: "Alfa", isDefault: false, pinned: true, sortOrder: 0 });
  const velho = makeBot({
    name: "Velho",
    isDefault: false,
    archivedAt: "2026-11-18T12:00:00.000Z",
  });
  const layout = arrangeBots([principal, nova, gota, atlas, fixo, fixo2, velho]);

  it("pinned first (by sort order), then groups (alphabetical), then the default list", () => {
    expect(layout.pinned.map((b) => b.name)).toEqual(["Alfa", "Fixo"]);
    expect(layout.groups.map((g) => [g.name, g.bots.map((b) => b.name)])).toEqual([
      ["Estudos", ["Gota"]],
      ["Trabalho", ["Atlas"]],
    ]);
    expect(layout.rest.map((b) => b.name)).toEqual(["Principal", "Nova"]);
  });

  it("a pinned bot appears only among the pinned, even if it has a group; archived ones nowhere", () => {
    expect(flatBots(layout).map((b) => b.name)).toEqual([
      "Alfa",
      "Fixo",
      "Gota",
      "Atlas",
      "Principal",
      "Nova",
    ]);
  });

  it("bots with no group and not pinned are the default list, with the main bot first", () => {
    expect(arrangeBots([nova, principal]).rest.map((b) => b.name)).toEqual(["Principal", "Nova"]);
  });
});

describe("search helpers", () => {
  it("fold ignores case and accents", () => {
    expect(fold("Cápsula Ação")).toBe("capsula acao");
  });
  it("filterBots matches name or description without accents", () => {
    const a = makeBot({ name: "Pepê", description: "Ajuda a estudar inglês" });
    const b = makeBot({ name: "Outro", description: "Faz contas" });
    expect(filterBots([a, b], "ingles").map((x) => x.name)).toEqual(["Pepê"]);
    expect(filterBots([a, b], "  ")).toHaveLength(2);
    expect(filterBots([a, b], "zzz")).toEqual([]);
  });
});
