import { describe, expect, it } from "vitest";
import { CATALOG, TONES, toneFor, toneOf } from "./catalog.js";

describe("the backgrounds of the logos: many, and FIXED for each connector", () => {
  it("there are twelve, four dark and eight light, with no repeated name", () => {
    expect(TONES).toHaveLength(12);
    expect(new Set(TONES).size).toBe(12);
  });

  it("every connector of the gallery has its own declared tone (nothing is drawn by chance)", () => {
    for (const entry of CATALOG) {
      expect(TONES, entry.id).toContain(entry.tone);
      expect(toneOf(entry), entry.id).toBe(entry.tone);
    }
  });

  it("the gallery uses many different tones, and the fixed ones are these", () => {
    const used = new Set(CATALOG.map((e) => e.tone));
    expect(used.size).toBeGreaterThanOrEqual(10);
    expect(Object.fromEntries(CATALOG.map((e) => [e.id, e.tone]))).toEqual({
      gmail: "coral",
      "google-calendar": "sky",
      notion: "paper",
      "google-docs": "indigo",
      "google-sheets": "mint",
      "google-drive": "amber",
      github: "slate",
      "stack-overflow": "sun",
      figma: "ink",
      composio: "plum",
      higgsfield: "navy",
    });
  });

  it("a connector with no declared tone gets one picked by its id, always the same", () => {
    for (const id of ["meu-servidor", "erp", "arquivos", "github-enterprise", "", "constructor"]) {
      const first = toneFor(id);
      expect(TONES).toContain(first);
      // the same id, the same tone, every time
      for (let i = 0; i < 5; i += 1) expect(toneFor(id)).toBe(first);
      expect(toneOf({ id })).toBe(first);
    }
    // a declared tone always wins over the picked one
    expect(toneOf({ id: "erp", tone: "lilac" })).toBe("lilac");
    // and the ids spread over the tones (not all in one)
    const spread = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((id) => toneFor(id)),
    );
    expect(spread.size).toBeGreaterThanOrEqual(10);
  });
});
