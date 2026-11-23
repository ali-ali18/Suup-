import { describe, expect, it } from "vitest";
import { CATALOG, TONES, toneOf } from "./catalog.js";

describe("the backgrounds of the logos: neutral, and FIXED for each connector", () => {
  it("there are four: the project's grey, the black and the white a brand's own icon has, and the brand's own colour", () => {
    expect([...TONES]).toEqual(["neutral", "black", "white", "solid"]);
  });

  it("every connector of the gallery declares its own tone (nothing is drawn by chance)", () => {
    for (const entry of CATALOG) {
      expect(TONES, entry.id).toContain(entry.tone);
      expect(toneOf(entry), entry.id).toBe(entry.tone);
    }
  });

  it("a one-colour brand takes its own colour (solid), the black or white brands their own neutral, the multi-colour logos the grey", () => {
    expect(Object.fromEntries(CATALOG.map((e) => [e.id, e.tone]))).toEqual({
      gmail: "neutral",
      "google-calendar": "neutral",
      notion: "white",
      "google-docs": "neutral",
      "google-sheets": "neutral",
      "google-drive": "neutral",
      github: "black",
      "stack-overflow": "solid",
      figma: "black",
      composio: "black",
      higgsfield: "neutral",
      trello: "solid",
      linear: "solid",
      todoist: "solid",
      discord: "solid",
      telegram: "solid",
      whatsapp: "solid",
    });
  });

  it("a connector with no declared tone (one the user made) is on the neutral grey, always", () => {
    expect(toneOf({})).toBe("neutral");
    expect(toneOf({ tone: "black" })).toBe("black");
  });
});
