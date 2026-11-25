import { describe, expect, it } from "vitest";
import { withAlwaysOnTools } from "../src/always-on-tools.js";

const ALL = ["remember", "recall", "forget", "search_conversations", "web_search", "web_read"];

describe("withAlwaysOnTools", () => {
  it("appends memory and search, in a fixed order, to the end of the grants", () => {
    const cfg = { allowedTools: ["shell"], other: 1 };
    const out = withAlwaysOnTools(cfg, [...ALL].reverse());
    expect(out.allowedTools).toEqual(["shell", ...ALL]);
    expect(out.other).toBe(1);
    expect(cfg.allowedTools).toEqual(["shell"]);
  });

  it("does not duplicate a tool the bot already has, and returns the same object when nothing is missing", () => {
    const cfg = { allowedTools: ["web_read", "recall", ...ALL] };
    expect(withAlwaysOnTools(cfg, ALL)).toBe(cfg);
    const partial = withAlwaysOnTools({ allowedTools: ["recall"] }, ALL);
    expect(partial.allowedTools).toEqual([
      "recall",
      "remember",
      "forget",
      "search_conversations",
      "web_search",
      "web_read",
    ]);
  });

  it("ignores what the registry does not have", () => {
    const out = withAlwaysOnTools({ allowedTools: [] }, ["remember", "shell", "web_read"]);
    expect(out.allowedTools).toEqual(["remember", "web_read"]);
    expect(withAlwaysOnTools({ allowedTools: ["x"] }, []).allowedTools).toEqual(["x"]);
  });

  it("never adds shell, file tools or web_fetch", () => {
    const registry = [
      ...ALL,
      "shell",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "search_files",
      "web_fetch",
    ];
    expect(withAlwaysOnTools({ allowedTools: [] }, registry).allowedTools).toEqual(ALL);
  });
});
