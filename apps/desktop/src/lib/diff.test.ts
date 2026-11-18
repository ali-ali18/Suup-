import { describe, expect, it } from "vitest";
import { diffLines } from "./diff.js";

describe("diffLines", () => {
  it("trims what both texts share and keeps one line of context", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "context", text: "c" },
    ]);
    expect(diffLines("x", "")).toEqual([
      { kind: "removed", text: "x" },
      { kind: "added", text: "" },
    ]);
  });
});
