import { MemoryExecutor } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { call } from "./helpers.js";

describe("read_file", () => {
  it("returns numbered lines", async () => {
    const ex = new MemoryExecutor({ files: { "a.txt": "one\ntwo\nthree\n" } });
    const r = await call(ex, "read_file", { path: "a.txt" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe("   1\tone\n   2\ttwo\n   3\tthree");
  });

  it("supports offset and limit and says how to continue", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const ex = new MemoryExecutor({ files: { "big.txt": lines } });
    const r = await call(ex, "read_file", { path: "big.txt", offset: 11, limit: 5 });
    expect(r.output.content).toContain("  11\tline 11");
    expect(r.output.content).toContain("  15\tline 15");
    expect(r.output.content).not.toContain("line 16");
    expect(r.output.content).toContain(
      "[showing lines 11-15 of 50; call again with offset=16 to continue]",
    );
    const tail = await call(ex, "read_file", { path: "big.txt", offset: 48 });
    expect(tail.output.content).toContain("[showing lines 48-50 of 50]");
  });

  it("rejects an offset past the end", async () => {
    const ex = new MemoryExecutor({ files: { "a.txt": "x\ny\n" } });
    const r = await call(ex, "read_file", { path: "a.txt", offset: 9 });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("has 2 lines");
  });

  it("handles empty files, CRLF and very long lines", async () => {
    const ex = new MemoryExecutor({
      files: { "empty.txt": "", "crlf.txt": "a\r\nb\r\n", "long.txt": "x".repeat(5000) },
    });
    expect((await call(ex, "read_file", { path: "empty.txt" })).output.content).toBe(
      "(empty.txt is empty)",
    );
    expect((await call(ex, "read_file", { path: "crlf.txt" })).output.content).toBe(
      "   1\ta\n   2\tb",
    );
    const long = (await call(ex, "read_file", { path: "long.txt" })).output.content;
    expect(long).toContain("line cut, 3000 more characters");
    expect(long.length).toBeLessThan(2200);
  });

  it("suggests similar names when the file is missing", async () => {
    const ex = new MemoryExecutor({
      files: {
        "src/main.ts": "x",
        "src/Main.test.ts": "x",
        "src/util.ts": "x",
        "src/other.css": "x",
      },
    });
    const r = await call(ex, "read_file", { path: "src/mian.ts" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("No such file");
    expect(r.output.content).toContain('"src/main.ts"');
    expect(r.output.content).not.toContain("other.css");
    const caseOnly = await call(ex, "read_file", { path: "src/MAIN.ts" });
    expect(caseOnly.output.content).toContain('"src/main.ts"');
  });

  it("says so when nothing is similar or the directory is missing", async () => {
    const ex = new MemoryExecutor({ files: { "src/main.ts": "x" } });
    const nothing = await call(ex, "read_file", { path: "src/zzzzzzzz.md" });
    expect(nothing.output.content).toContain("nothing with a similar name");
    const noDir = await call(ex, "read_file", { path: "nodir/file.txt" });
    expect(noDir.output.content).toContain("does not exist either");
  });

  it("refuses directories", async () => {
    const ex = new MemoryExecutor({ files: { "src/a.ts": "x" } });
    const r = await call(ex, "read_file", { path: "src" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("is a directory");
    expect(r.output.content).toContain("list_files");
  });

  it("refuses binary-looking files but not UTF-8 text", async () => {
    const ex = new MemoryExecutor({
      files: {
        "bin.dat": `PK\u0003\u0004\u0000\u0000\u0000${"\ufffd".repeat(50)}`,
        "mostly-garbage.bin": `${"\ufffd".repeat(200)}text`,
        "text.txt": "olá, 世界 \u{1F600}\n\ttabbed\n",
      },
    });
    const bin = await call(ex, "read_file", { path: "bin.dat" });
    expect(bin.outcome).toBe("tool_error");
    expect(bin.output.content).toContain("binary");
    expect((await call(ex, "read_file", { path: "mostly-garbage.bin" })).outcome).toBe(
      "tool_error",
    );
    expect((await call(ex, "read_file", { path: "text.txt" })).outcome).toBe("ok");
  });

  it("reports workspace escapes as a tool error, not a crash", async () => {
    const ex = new MemoryExecutor();
    const r = await call(ex, "read_file", { path: "../../etc/passwd" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("outside the bot workspace");
  });
});

describe("write_file", () => {
  it("creates a file and reports the byte count", async () => {
    const ex = new MemoryExecutor();
    const r = await call(ex, "write_file", { path: "notes/todo.md", content: "olá \u{1F600}" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe("Created notes/todo.md (9 bytes).");
    expect(ex.files.get("/workspace/notes/todo.md")).toBe("olá \u{1F600}");
  });

  it("says when it replaced an existing file", async () => {
    const ex = new MemoryExecutor({ files: { "a.txt": "old content" } });
    const r = await call(ex, "write_file", { path: "a.txt", content: "new" });
    expect(r.output.content).toBe("Replaced a.txt: 11 bytes before, 3 bytes now.");
    expect(ex.files.get("/workspace/a.txt")).toBe("new");
  });

  it("refuses to write onto a directory", async () => {
    const ex = new MemoryExecutor({ files: { "dir/a.txt": "x" } });
    const r = await call(ex, "write_file", { path: "dir", content: "x" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("is a directory");
  });

  it("turns write failures and escapes into tool errors", async () => {
    const ex = new MemoryExecutor();
    ex.failWrites = true;
    const failed = await call(ex, "write_file", { path: "a.txt", content: "x" });
    expect(failed.outcome).toBe("tool_error");
    expect(failed.output.content).toContain("ENOSPC");
    const escaped = await call(new MemoryExecutor(), "write_file", {
      path: "/etc/x",
      content: "x",
    });
    expect(escaped.outcome).toBe("tool_error");
    expect(escaped.output.content).toContain("outside the bot workspace");
  });

  it("accepts an empty file", async () => {
    const ex = new MemoryExecutor();
    const r = await call(ex, "write_file", { path: "empty.txt", content: "" });
    expect(r.output.content).toBe("Created empty.txt (0 bytes).");
  });
});

describe("edit_file", () => {
  const file = "alpha\nbeta\ngamma\nbeta\n";

  it("replaces a unique match", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": file } });
    const r = await call(ex, "edit_file", {
      path: "f.txt",
      old_string: "gamma",
      new_string: "GAMMA",
    });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain("replaced 1 occurrence");
    expect(r.output.content).toContain("line 3");
    expect(ex.files.get("/workspace/f.txt")).toBe("alpha\nbeta\nGAMMA\nbeta\n");
  });

  it("fails on several matches and reports how many, changing nothing", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": file } });
    const r = await call(ex, "edit_file", { path: "f.txt", old_string: "beta", new_string: "B" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("matches 2 places");
    expect(r.output.content).toContain("lines 2, 4");
    expect(r.output.content).toContain("replace_all");
    expect(ex.files.get("/workspace/f.txt")).toBe(file);
  });

  it("replaces every match with replace_all", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": file } });
    const r = await call(ex, "edit_file", {
      path: "f.txt",
      old_string: "beta",
      new_string: "B",
      replace_all: true,
    });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain("replaced 2 occurrences");
    expect(ex.files.get("/workspace/f.txt")).toBe("alpha\nB\ngamma\nB\n");
  });

  it("fails with 0 matches, hinting at whitespace differences", async () => {
    const ex = new MemoryExecutor({ files: { "f.ts": "function  go() {\n\treturn 1;\n}\n" } });
    const absent = await call(ex, "edit_file", {
      path: "f.ts",
      old_string: "nothing",
      new_string: "x",
    });
    expect(absent.outcome).toBe("tool_error");
    expect(absent.output.content).toContain("0 matches");
    expect(absent.output.content).toContain("line numbers");
    const spaced = await call(ex, "edit_file", {
      path: "f.ts",
      old_string: "function go() {\n  return 1;",
      new_string: "x",
    });
    expect(spaced.output.content).toContain("whitespace");
    expect(ex.files.get("/workspace/f.ts")).toBe("function  go() {\n\treturn 1;\n}\n");
  });

  it("does not interpret $ patterns in the replacement", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": "price: X" } });
    await call(ex, "edit_file", { path: "f.txt", old_string: "X", new_string: "$& $1 $$ $`" });
    expect(ex.files.get("/workspace/f.txt")).toBe("price: $& $1 $$ $`");
  });

  it("can delete text with an empty new_string, and rejects no-op edits", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": "keep REMOVE keep" } });
    await call(ex, "edit_file", { path: "f.txt", old_string: " REMOVE", new_string: "" });
    expect(ex.files.get("/workspace/f.txt")).toBe("keep keep");
    const same = await call(ex, "edit_file", {
      path: "f.txt",
      old_string: "keep",
      new_string: "keep",
    });
    expect(same.outcome).toBe("tool_error");
    expect(same.output.content).toContain("identical");
  });

  it("handles a missing file, a directory and an escape", async () => {
    const ex = new MemoryExecutor({ files: { "d/a.txt": "x" } });
    const missing = await call(ex, "edit_file", {
      path: "nope.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(missing.output.content).toContain("No such file");
    expect(missing.output.content).toContain("write_file");
    const dir = await call(ex, "edit_file", { path: "d", old_string: "a", new_string: "b" });
    expect(dir.output.content).toContain("is a directory");
    const esc = await call(ex, "edit_file", { path: "../x", old_string: "a", new_string: "b" });
    expect(esc.output.content).toContain("outside the bot workspace");
  });

  it("rejects an empty old_string at validation", async () => {
    const ex = new MemoryExecutor({ files: { "f.txt": "x" } });
    const r = await call(ex, "edit_file", { path: "f.txt", old_string: "", new_string: "b" });
    expect(r.outcome).toBe("invalid_args");
  });
});

describe("list_files", () => {
  const files = {
    "README.md": "x",
    "src/index.ts": "x",
    "src/lib/a.ts": "x",
    "src/lib/deep/b.ts": "x",
    "docs/guide.md": "x",
    "node_modules/pkg/index.js": "x",
  };

  it("lists the root with directories first and marked", async () => {
    const r = await call(new MemoryExecutor({ files }), "list_files", {});
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe(
      "workspace root (4 entries):\ndocs/\nnode_modules/\nsrc/\nREADME.md",
    );
  });

  it("shows nested levels as an indented tree", async () => {
    const r = await call(new MemoryExecutor({ files }), "list_files", { path: "src", depth: 3 });
    expect(r.output.content).toBe("src (5 entries):\nlib/\n  deep/\n    b.ts\n  a.ts\nindex.ts");
  });

  it("limits the depth", async () => {
    const r = await call(new MemoryExecutor({ files }), "list_files", { path: "src", depth: 2 });
    expect(r.output.content).toBe("src (4 entries):\nlib/\n  deep/\n  a.ts\nindex.ts");
  });

  it("lists but does not expand node_modules", async () => {
    const r = await call(new MemoryExecutor({ files }), "list_files", { depth: 2 });
    expect(r.output.content).toContain("node_modules/ (not expanded)");
    expect(r.output.content).not.toContain("pkg/");
  });

  it("caps the number of entries and says so", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 700; i++) many[`f${String(i).padStart(4, "0")}.txt`] = "x";
    const r = await call(new MemoryExecutor({ files: many }), "list_files", {});
    const shown = r.output.content.split("\n").filter((l) => l.endsWith(".txt"));
    expect(shown.length).toBe(500);
    expect(r.output.content).toContain("list cut");
    expect(r.output.content).toContain("Only the first 500 entries");
  });

  it("rejects a depth that is too large and bad paths", async () => {
    const ex = new MemoryExecutor({ files });
    expect((await call(ex, "list_files", { depth: 99 })).outcome).toBe("invalid_args");
    const missing = await call(ex, "list_files", { path: "nope" });
    expect(missing.outcome).toBe("tool_error");
    expect(missing.output.content).toContain("No such directory");
    const file = await call(ex, "list_files", { path: "README.md" });
    expect(file.output.content).toContain("is a file");
    expect((await call(ex, "list_files", { path: "../.." })).output.content).toContain(
      "outside the bot workspace",
    );
  });

  it("reports an empty directory", async () => {
    const r = await call(new MemoryExecutor(), "list_files", {});
    expect(r.output.content).toBe(". is empty.");
  });
});
