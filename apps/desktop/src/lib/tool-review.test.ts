import type { ConnectorToolReview, PinnedDefinition } from "@suup/api";
import { describe, expect, it } from "vitest";
import { makeConnector, makeConnectorTool } from "../test-fixtures.js";
import {
  alignLines,
  changeSummary,
  compareDefinitions,
  EVENT_LABEL,
  reviewNotice,
  schemaLines,
  wordParts,
} from "./tool-review.js";

const def = (over: Partial<PinnedDefinition> = {}): PinnedDefinition => ({
  name: "echo",
  description: "Returns the text it was given.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true },
  ...over,
});

const review = (over: Partial<ConnectorToolReview> = {}): ConnectorToolReview => ({
  tool: "echo",
  status: "changed",
  approvedFingerprint: "a".repeat(64),
  approved: def(),
  currentFingerprint: "b".repeat(64),
  current: def({ description: "Returns the text it was given. Now also sends it away." }),
  seenAt: "2026-11-18T12:00:00.000Z",
  ...over,
});

describe("the calm notice on a connector", () => {
  const tools = (...pins: ("approved" | "changed" | "new")[]) =>
    pins.map((pin, i) => makeConnectorTool({ tool: `t${i}`, name: `conn_fake__t${i}`, pin }));

  it("says nothing when no tool waits for a review", () => {
    expect(reviewNotice(makeConnector({ tools: tools("approved") }))).toBeNull();
    expect(reviewNotice(makeConnector({ tools: null }))).toBeNull();
  });

  it("counts changed tools, in the plural and the singular", () => {
    expect(
      reviewNotice(
        makeConnector({ tools: tools("changed", "changed", "approved"), pendingReviews: 2 }),
      ),
    ).toBe("2 ferramentas mudaram e estão desligadas até você revisar");
    expect(reviewNotice(makeConnector({ tools: tools("changed"), pendingReviews: 1 }))).toBe(
      "1 ferramenta mudou e está desligada até você revisar",
    );
  });

  it("counts new tools, and both at once", () => {
    expect(reviewNotice(makeConnector({ tools: tools("new"), pendingReviews: 1 }))).toBe(
      "1 ferramenta nova está desligada até você revisar",
    );
    expect(
      reviewNotice(makeConnector({ tools: tools("changed", "new", "new"), pendingReviews: 3 })),
    ).toBe(
      "1 ferramenta mudou e está desligada até você revisar. 2 ferramentas novas estão desligadas até você revisar",
    );
  });

  it("falls back to the server's count when the list does not explain it", () => {
    expect(reviewNotice(makeConnector({ tools: tools("approved"), pendingReviews: 2 }))).toBe(
      "2 ferramentas esperam a sua revisão e estão desligadas até lá",
    );
  });
});

describe("lines before and now, side by side", () => {
  it("equal text is the same on both sides", () => {
    const rows = alignLines(["a", "b"], ["a", "b"]);
    expect(rows.map((r) => [r.left?.mark, r.right?.mark])).toEqual([
      ["same", "same"],
      ["same", "same"],
    ]);
  });

  it("a changed line is removed on the left and added on the right, in the same row", () => {
    const rows = alignLines(["a", "b", "c"], ["a", "B", "c"]);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.left).toMatchObject({ text: "b", mark: "removed" });
    expect(rows[1]?.right).toMatchObject({ text: "B", mark: "added" });
  });

  it("a line only on one side leaves the other side empty", () => {
    const added = alignLines(["a"], ["a", "novo"]);
    expect(added[1]).toEqual({ left: null, right: { text: "novo", mark: "added" } });
    const removed = alignLines(["a", "velho"], ["a"]);
    expect(removed[1]).toEqual({ left: { text: "velho", mark: "removed" }, right: null });
  });

  it("with nothing before, everything is added", () => {
    const rows = alignLines([], ["x", "y"]);
    expect(rows.every((r) => r.left === null && r.right?.mark === "added")).toBe(true);
  });

  it("marks the words that differ in a line that changed in place", () => {
    const { left, right } = wordParts("Returns the text", "Returns the whole text now");
    expect(left.every((p) => !p.changed)).toBe(true);
    expect(left.map((p) => p.text).join("")).toBe("Returns the text");
    expect(right.filter((p) => p.changed).map((p) => p.text)).toEqual(["whole", "now"]);
    // Neighbouring words that differ are one stretch, and a mark never starts or ends on a space.
    expect(
      wordParts("a b", "a x y b")
        .right.filter((p) => p.changed)
        .map((p) => p.text),
    ).toEqual(["x y"]);
    expect(right.map((p) => p.text).join("")).toBe("Returns the whole text now");
    const rows = alignLines(["Returns the text"], ["Returns the whole text now"]);
    expect(rows[0]?.right?.parts?.some((p) => p.changed)).toBe(true);
  });

  it("copes with long lists without a quadratic table", () => {
    const a = Array.from({ length: 900 }, (_, i) => `linha ${i}`);
    const b = [...a.slice(0, 450), "do meio", ...a.slice(450)];
    const rows = alignLines(a, b);
    expect(rows.filter((r) => r.right?.mark === "added")).toHaveLength(1);
    expect(rows).toHaveLength(901);
  });
});

describe("the comparison of two definitions", () => {
  it("has a description, an input schema and hints section; only the description differs here", () => {
    const sections = compareDefinitions(review());
    expect(sections.map((s) => [s.id, s.same])).toEqual([
      ["description", false],
      ["schema", true],
      ["hints", true],
    ]);
    expect(changeSummary(sections[0] as (typeof sections)[number])).toBe("1 linha difere");
    expect(changeSummary(sections[1] as (typeof sections)[number])).toBe("sem mudança");
  });

  it("shows a schema change line by line", () => {
    const changed = review({
      current: def({
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, target: { type: "string" } },
          required: ["text"],
        },
      }),
    });
    const schema = compareDefinitions(changed).find((s) => s.id === "schema");
    expect(schema?.same).toBe(false);
    expect(
      schema?.rows.some((r) => r.right?.mark === "added" && r.right.text.includes("target")),
    ).toBe(true);
    expect(schema?.rows.every((r) => r.left?.mark !== "removed" || r.right !== undefined)).toBe(
      true,
    );
  });

  it("a new tool has nothing before: every row is added and nothing counts as unchanged", () => {
    const fresh = review({ status: "new", approved: null, approvedFingerprint: null });
    const sections = compareDefinitions(fresh);
    for (const section of sections) {
      expect(section.same).toBe(false);
      expect(section.rows.every((r) => r.left === null && r.right?.mark === "added")).toBe(true);
    }
  });

  it("a description that is missing reads as such, on either side", () => {
    const none = review({ current: def({ description: null }) });
    const rows = compareDefinitions(none)[0]?.rows ?? [];
    expect(rows[0]?.right?.text).toBe("(sem descrição)");
    expect(schemaLines(null)).toBeNull();
  });
});

describe("the history", () => {
  it("has a sentence for every kind of event", () => {
    expect(Object.keys(EVENT_LABEL).sort()).toEqual(
      ["approved", "baseline", "changed", "new", "pinned_on_grant", "restored"].sort(),
    );
  });
});
