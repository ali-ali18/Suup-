import { describe, expect, it } from "vitest";
import { createSummaryStream } from "./summary-stream.js";

// The `summary` of a call, read from JSON that arrives in pieces cut anywhere: whatever the cut, the
// characters typed add up to exactly what `JSON.parse` gives for the finished call.

/** Feeds `json` in the given pieces and returns what was typed, piece by piece. */
function typed(pieces: string[]): string[] {
  const stream = createSummaryStream();
  return pieces.map((p) => stream.feed(p));
}

function everyCut(json: string): string[][] {
  const cuts: string[][] = [];
  for (let i = 0; i <= json.length; i++) cuts.push([json.slice(0, i), json.slice(i)]);
  // Also three-way cuts and one character at a time.
  cuts.push([...json]);
  for (let i = 0; i < json.length; i += 3) {
    for (let j = i + 1; j < json.length; j += 5) {
      cuts.push([json.slice(0, i), json.slice(i, j), json.slice(j)]);
    }
  }
  return cuts;
}

const SAMPLES: Record<string, unknown> = {
  plain: { summary: "Feito. Tudo certo.", evidence: [] },
  escapes: { summary: 'Linha 1\nLinha "2"\t\\ barra / fim \b\f\r', evidence: [] },
  accents: { summary: "Ação concluída: café, coração, ñ, 日本語", evidence: [] },
  emoji: { summary: "Pronto \u{1F600} e \u{1F680} fim", evidence: [] },
  evidenceFirst: {
    evidence: [{ criterion: 'um "summary": "falso"', evidence: 'e {"summary":"outro"}' }],
    summary: "O de verdade",
  },
  nested: {
    other: { summary: "no fundo", list: [1, [2, { summary: "x" }], "}"] },
    summary: "topo",
  },
  numbers: { n: 12.5e3, ok: true, nothing: null, summary: "depois dos primitivos" },
  empty: { summary: "" },
};

describe("summary stream", () => {
  for (const [name, value] of Object.entries(SAMPLES)) {
    it(`${name}: every cut gives exactly the summary JSON.parse gives`, () => {
      for (const raw of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
        const expected = (value as { summary: string }).summary;
        for (const pieces of everyCut(raw)) {
          expect(typed(pieces).join("")).toBe(expected);
        }
      }
    });
  }

  it("decodes \\uXXXX escapes, a surrogate pair split between pieces included", () => {
    const raw = '{"summary":"a\\u00e9b \\ud83d\\ude00 c\\u4e2d"}';
    const expected = "a\u00e9b \u{1F600} c\u4e2d";
    expect(JSON.parse(raw).summary).toBe(expected);
    for (const pieces of everyCut(raw)) expect(typed(pieces).join("")).toBe(expected);
  });

  it("types nothing for a summary that is not a string, and nothing when the JSON is broken", () => {
    expect(typed(['{"summary": ["a","b"], "x": 1}']).join("")).toBe("");
    expect(typed(['{"summary": 5}']).join("")).toBe("");
    expect(typed(['{"summary": "ok" ']).join("")).toBe("ok");
    expect(typed(["not json at all"]).join("")).toBe("");
    expect(typed(['{"summary": "a\\qb"}']).join("")).toBe("a"); // an invalid escape stops it
    expect(typed(['{"sum": "x"}']).join("")).toBe("");
  });

  it("only the first top-level summary is typed", () => {
    expect(typed(['{"summary":"um","summary":"dois"}']).join("")).toBe("um");
  });

  it("gives the characters as they arrive, not all at the end", () => {
    const parts = typed(['{"summ', 'ary":"Olá', ", mu", 'ndo"', "}"]);
    expect(parts).toEqual(["", "Olá", ", mu", "ndo", ""]);
  });
});
