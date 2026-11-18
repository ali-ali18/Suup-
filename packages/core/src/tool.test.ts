import { describe, expect, it } from "vitest";
import { MemoryExecutor } from "./testing/index.js";
import { resolveWorkspacePath, WorkspaceEscapeError } from "./tool.js";

describe("resolveWorkspacePath", () => {
  const root = "/work/bot";

  it("resolves relative paths inside the root", () => {
    expect(resolveWorkspacePath(root, "a/b.txt")).toBe("/work/bot/a/b.txt");
    expect(resolveWorkspacePath(root, "./a//b/../c")).toBe("/work/bot/a/c");
    expect(resolveWorkspacePath(root, "")).toBe("/work/bot");
    expect(resolveWorkspacePath(root, ".")).toBe("/work/bot");
    expect(resolveWorkspacePath("/work/bot/", "x")).toBe("/work/bot/x");
    expect(resolveWorkspacePath("/", "x")).toBe("/x");
  });

  it("accepts absolute paths that are inside the root", () => {
    expect(resolveWorkspacePath(root, "/work/bot/x")).toBe("/work/bot/x");
    expect(resolveWorkspacePath(root, "/work/bot")).toBe("/work/bot");
  });

  it.each([
    "..",
    "../x",
    "a/../../x",
    "a/b/../../..",
    "/etc/passwd",
    "/work/bot-evil/x",
    "/work",
    "/work/bot/../x",
    "a\0b",
  ])("rejects %j", (path) => {
    expect(() => resolveWorkspacePath(root, path)).toThrow(WorkspaceEscapeError);
  });

  it("requires an absolute root", () => {
    expect(() => resolveWorkspacePath("rel", "x")).toThrow(/absolute/);
  });
});

describe("MemoryExecutor", () => {
  it("stores files and rejects escapes", async () => {
    const ex = new MemoryExecutor({ files: { "a/b.txt": "hi" } });
    expect(await ex.readFile("a/b.txt")).toBe("hi");
    expect(await ex.stat("a")).toEqual({ kind: "dir", size: 0 });
    expect(await ex.stat("nope")).toBeNull();
    expect(await ex.listDir("a")).toEqual([{ name: "b.txt", kind: "file" }]);
    expect(await ex.listDir(".")).toEqual([{ name: "a", kind: "dir" }]);
    await expect(ex.readFile("../x")).rejects.toBeInstanceOf(WorkspaceEscapeError);
    await expect(ex.readFile("missing")).rejects.toThrow(/ENOENT/);
  });
});
