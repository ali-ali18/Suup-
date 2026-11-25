import { BOT_COLORS } from "@suup/api";
import { SHAPE_IDS } from "@suup/avatar";
import { describe, expect, it } from "vitest";
import {
  avatarOf,
  colorVars,
  effectiveColor,
  mascotValue,
  PIXEL_THEME_COLOR,
  PIXELS,
  SHAPES,
  themeColor,
} from "./mascots.js";

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
      expect(["branco", "cinza"]).not.toContain(color);
    }
    expect(new Set(seeds.map((s) => effectiveColor(null, s))).size).toBeGreaterThan(1);
  });
});

describe("colorVars", () => {
  it("the user bubble's text is white on every colour; the white bot's bubble is a neutral grey", () => {
    expect(colorVars("branco")).toMatchObject({
      "--bot-fill": "#ffffff",
      "--bot-bubble": "#3a3a3c",
      "--bot-on-bubble": "#ffffff",
    });
    expect(colorVars("azul")["--bot-bubble"]).toBe(colorVars("azul")["--bot-fill"]);
  });
});

describe("mascotes pixel", () => {
  it("o estilo pixel lê `mascot:<personagem>`; o que não existe cai no personagem do id", () => {
    expect(avatarOf("mascot:gato", "s", "pixel")).toEqual({
      kind: "mascot",
      style: "pixel",
      pixel: "gato",
    });
    const fallback = avatarOf(null, "bot-7", "pixel");
    expect(fallback.pixel).toBeDefined();
    expect(avatarOf("mascot:blob", "bot-7", "pixel").pixel).toBe(fallback.pixel);
    expect(avatarOf("🙂", "s", "pixel")).toEqual({ kind: "emoji", text: "🙂" });
    // sem estilo, o de sempre: `mascot:gato` não é uma forma e cai na forma do id
    expect(avatarOf("mascot:gato", "s").pixel).toBeUndefined();
  });

  it("os 17 personagens estão na lista do seletor, com nome", () => {
    expect(PIXELS).toHaveLength(17);
    expect(PIXELS[0]).toEqual({ id: "folha", name: "Folha" });
    expect(Object.keys(PIXEL_THEME_COLOR).sort()).toEqual(PIXELS.map((p) => p.id).sort());
  });

  it("a cor do tema: a do bot; sem ela, a do desenho (pixel) ou a do id (formas)", () => {
    expect(themeColor({ color: "rosa", avatar: "mascot:folha", avatarStyle: "pixel" }, "x")).toBe(
      "rosa",
    );
    expect(themeColor({ color: null, avatar: "mascot:folha", avatarStyle: "pixel" }, "x")).toBe(
      "verde",
    );
    expect(themeColor({ color: null, avatar: "mascot:blob", avatarStyle: "shapes" }, "x")).toBe(
      effectiveColor(null, "x"),
    );
  });
});
