import { describe, expect, it } from "vitest";
import { CATALOG, TONES, toneOf } from "./catalog.js";

describe("the backgrounds of the logos: neutral, and FIXED for each connector", () => {
  it("there are three: the project's grey, and the black and the white a brand's own icon has", () => {
    expect([...TONES]).toEqual(["neutral", "black", "white"]);
  });

  it("every connector of the gallery declares its own tone (nothing is drawn by chance)", () => {
    for (const entry of CATALOG) {
      expect(TONES, entry.id).toContain(entry.tone);
      expect(toneOf(entry), entry.id).toBe(entry.tone);
    }
  });

  it("only the brands whose own icon has a neutral background take it; every other logo sits on the grey", () => {
    expect(Object.fromEntries(CATALOG.map((e) => [e.id, e.tone]))).toEqual({
      gmail: "neutral",
      "google-calendar": "neutral",
      notion: "white",
      "google-docs": "neutral",
      "google-sheets": "neutral",
      "google-drive": "neutral",
      github: "black",
      "stack-overflow": "neutral",
      figma: "black",
      composio: "black",
      higgsfield: "neutral",
    });
  });

  it("a connector with no declared tone (one the user made) is on the neutral grey, always", () => {
    expect(toneOf({})).toBe("neutral");
    expect(toneOf({ tone: "black" })).toBe("black");
  });
});
