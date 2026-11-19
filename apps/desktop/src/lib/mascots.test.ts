import { BOT_COLORS } from "@suup/api";
import { SHAPE_IDS } from "@suup/avatar";
import { describe, expect, it } from "vitest";
import { avatarOf, colorVars, effectiveColor, mascotValue, SHAPES } from "./mascots.js";

describe("shapes", () => {
  it("lists every shape of the engine, each with a name", () => {
    expect(SHAPES.map((s) => s.id)).toEqual([...SHAPE_IDS]);
    expect(SHAPES).toHaveLength(25);
    for (const shape of SHAPES) expect(shape.name).not.toBe("");
    expect(new Set(SHAPES.map((s) => s.name)).size).toBe(SHAPES.length);
  });
});

describe("avatarOf", () => {
  it("reads an engine shape from `mascot:<id>`", () => {
    for (const id of SHAPE_IDS) {
      expect(avatarOf(mascotValue(id), "seed")).toEqual({ kind: "mascot", id });
    }
  });

  it("keeps the six mascots of the first version looking alike", () => {
    const old: [string, string][] = [
      ["folha", "leaf"],
      ["gota", "teardrop"],
      ["cunha", "wedge"],
      ["esfera", "blob"],
      ["capsula", "capsule"],
      ["trevo", "clover"],
    ];
    for (const [legacy, shape] of old) {
      expect(avatarOf(`mascot:${legacy}`, "seed")).toEqual({ kind: "mascot", id: shape });
    }
  });

  it("an unknown shape, or none, falls back to a stable one picked from the seed", () => {
    const a = avatarOf("mascot:inexistente", "bot-1");
    expect(a.kind).toBe("mascot");
    expect(SHAPE_IDS).toContain(a.id);
    expect(avatarOf(null, "bot-1")).toEqual(a);
    expect(avatarOf("mascot:inexistente", "bot-1")).toEqual(a);
  });

  it("any other text is an emoji; blank is a mascot", () => {
    expect(avatarOf("🦊", "x")).toEqual({ kind: "emoji", text: "🦊" });
    expect(avatarOf("   ", "x").kind).toBe("mascot");
  });
});

describe("effectiveColor", () => {
  it("the bot's own colour wins", () => {
    expect(effectiveColor("branco", "x")).toBe("branco");
  });
  it("without one, a palette colour that is always the same for the same seed", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (const seed of seeds) {
      const color = effectiveColor(null, seed);
      expect(BOT_COLORS).toContain(color);
      expect(effectiveColor(null, seed)).toBe(color);
      expect(["branco", "grafite", "cinza"]).not.toContain(color);
    }
    expect(new Set(seeds.map((s) => effectiveColor(null, s))).size).toBeGreaterThan(1);
  });
});

describe("colorVars", () => {
  it("the white bot's user bubble is a neutral grey; the others' is the bot's colour", () => {
    expect(colorVars("branco")).toMatchObject({
      "--bot-fill": "#ffffff",
      "--bot-bubble": "#3a3a3c",
      "--bot-on-bubble": "#f5f5f5",
    });
    expect(colorVars("azul")["--bot-bubble"]).toBe(colorVars("azul")["--bot-fill"]);
  });
});
