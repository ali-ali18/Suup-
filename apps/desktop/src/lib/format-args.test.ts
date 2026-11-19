import { describe, expect, it } from "vitest";
import {
  COLLAPSED_CHARS,
  COLLAPSED_LINES,
  collapsedText,
  exactFields,
  formatArgs,
  isLong,
  secretsOf,
  splitSecrets,
} from "./format-args.js";

describe("formatArgs: the exact content of a call", () => {
  it("one field per argument, in the order sent; strings as they are, the rest as indented JSON", () => {
    const fields = formatArgs({
      path: "a.txt",
      content: "linha 1\nlinha 2",
      retries: 2,
      flags: ["a"],
    });
    expect(fields.map((f) => f.key)).toEqual(["path", "content", "retries", "flags"]);
    expect(fields[0]).toMatchObject({ text: "a.txt", json: false, lines: 1, long: false });
    expect(fields[1]).toMatchObject({ text: "linha 1\nlinha 2", lines: 2 });
    expect(fields[2]).toMatchObject({ text: "2", json: true });
    expect(fields[3]?.text).toBe('[\n  "a"\n]');
  });

  it("arguments that are not an object are one field without a name; no arguments, no field", () => {
    expect(formatArgs("só texto")).toEqual([
      expect.objectContaining({ key: null, text: "só texto" }),
    ]);
    expect(formatArgs(null)[0]).toMatchObject({ key: null, text: "null" });
    expect(formatArgs({})).toEqual([]);
  });

  it("a secret is only ever its placeholder: split out as a seal, and listed once by name", () => {
    expect(splitSecrets("Bearer {{secret:GH_TOKEN}} e {{secret:OUTRO}}!")).toEqual([
      { kind: "text", text: "Bearer " },
      { kind: "secret", name: "GH_TOKEN" },
      { kind: "text", text: " e " },
      { kind: "secret", name: "OUTRO" },
      { kind: "text", text: "!" },
    ]);
    expect(
      secretsOf({ a: "{{secret:GH_TOKEN}}", b: { x: "{{secret:GH_TOKEN}} {{secret:Z}}" } }),
    ).toEqual(["GH_TOKEN", "Z"]);
    // A redacted value is plain text, not a placeholder; a malformed placeholder is not one either.
    expect(splitSecrets("[REDACTED:GH_TOKEN] {{secret:minusculo}} {{secret:}}")).toEqual([
      { kind: "text", text: "[REDACTED:GH_TOKEN] {{secret:minusculo}} {{secret:}}" },
    ]);
  });

  it("long content collapses by lines and by characters, and says how much is hidden", () => {
    const lines = Array.from({ length: COLLAPSED_LINES + 5 }, (_, i) => `l${i}`).join("\n");
    expect(isLong(lines)).toBe(true);
    const collapsed = collapsedText(lines);
    expect(collapsed.head.split("\n")).toHaveLength(COLLAPSED_LINES);
    expect(collapsed.hiddenLines).toBe(5);
    expect(isLong("curto")).toBe(false);
    expect(collapsedText("curto")).toEqual({ head: "curto", hiddenLines: 0 });
    const wide = "x".repeat(COLLAPSED_CHARS * 3);
    expect(isLong(wide)).toBe(true);
    expect(collapsedText(wide).head).toHaveLength(COLLAPSED_CHARS);
  });

  it("collapsing never cuts a secret placeholder in half", () => {
    const text = `${"x".repeat(COLLAPSED_CHARS - 5)}{{secret:API_TOKEN}}${"y".repeat(100)}`;
    const { head } = collapsedText(text);
    expect(head.endsWith("{{secret:API_TOKEN}}")).toBe(true);
    expect(splitSecrets(head).some((s) => s.kind === "secret")).toBe(true);
  });

  it("an exact rule pins the top-level text arguments only", () => {
    expect(exactFields({ to: "ana", n: 2, ok: true, deep: { a: "b" }, body: "oi" })).toEqual([
      { field: "to", value: "ana" },
      { field: "body", value: "oi" },
    ]);
    expect(exactFields("x")).toEqual([]);
    expect(exactFields([1])).toEqual([]);
  });
});
