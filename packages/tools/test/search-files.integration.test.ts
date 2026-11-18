import { describe, expect, it } from "vitest";
import { buildSearchCommand } from "../src/index.js";
import { call } from "./helpers.js";
import { localWorkspace } from "./local-helpers.js";

async function project() {
  const ex = await localWorkspace();
  await ex.writeFile(
    "src/app.ts",
    "export function start() {\n  return 'Hello';\n}\nconst x = 1;\n",
  );
  await ex.writeFile(
    "src/util.ts",
    "export const hello = 'hello world';\n// TODO: fix $HOME handling\n",
  );
  await ex.writeFile("docs/notes.md", "# Notes\nhello from the docs\n-v is a flag\n");
  await ex.writeFile("node_modules/dep/index.js", "hello from a dependency\n");
  await ex.writeFile("weird name/it's $(x).txt", "needle in a odd file\n");
  await ex.writeFile("data.bin.txt", "text before\n");
  await ex.exec("printf 'hello\\000binary' > blob.dat");
  return ex;
}

describe("search_files (LocalExecutor)", () => {
  it("finds matches as path:line:text", async () => {
    const ex = await project();
    const r = await call(ex, "search_files", { pattern: "start\\(" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe("src/app.ts:1:export function start() {");
  });

  it("searches a subdirectory and is case sensitive by default", async () => {
    const ex = await project();
    const r = await call(ex, "search_files", { pattern: "hello", path: "src" });
    expect(r.output.content.split("\n").sort()).toEqual([
      "src/util.ts:1:export const hello = 'hello world';",
    ]);
    const ci = await call(ex, "search_files", { pattern: "hello", path: "src", ignore_case: true });
    expect(ci.output.content).toContain("src/app.ts:2:  return 'Hello';");
    expect(ci.output.content).toContain("src/util.ts:1");
  });

  it("filters by glob", async () => {
    const ex = await project();
    const r = await call(ex, "search_files", { pattern: "hello", glob: "*.md" });
    expect(r.output.content).toBe("docs/notes.md:2:hello from the docs");
  });

  it("skips node_modules and binary files", async () => {
    const ex = await project();
    const r = await call(ex, "search_files", { pattern: "hello" });
    expect(r.output.content).not.toContain("node_modules");
    expect(r.output.content).not.toContain("blob.dat");
  });

  it("reports no matches as a normal result", async () => {
    const r = await call(await project(), "search_files", { pattern: "zzz-not-there" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toContain("No matches");
  });

  it("treats shell metacharacters in the pattern as pattern text", async () => {
    const ex = await project();
    const marker = "pwned.txt";
    const patterns = [
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `'; touch ${marker}; echo '`,
      `"; touch ${marker}; "`,
      `x\ntouch ${marker}`,
      "$HOME",
    ];
    for (const pattern of patterns) {
      const r = await call(ex, "search_files", { pattern });
      expect(r.outcome, pattern).not.toBe("crashed");
    }
    expect(await ex.stat(marker)).toBeNull();
    // `$HOME` is a regex end anchor followed by text: it must not have been expanded either way
    const literal = await call(ex, "search_files", { pattern: "TODO: fix \\$HOME" });
    expect(literal.output.content).toBe("src/util.ts:2:// TODO: fix $HOME handling");
  });

  it("accepts patterns that start with a dash", async () => {
    const r = await call(await project(), "search_files", { pattern: "-v is" });
    expect(r.outcome).toBe("ok");
    expect(r.output.content).toBe("docs/notes.md:3:-v is a flag");
    const flagLike = await call(await project(), "search_files", { pattern: "--files" });
    expect(flagLike.output.content).toContain("No matches");
  });

  it("handles quotes and spaces in paths and globs", async () => {
    const ex = await project();
    const r = await call(ex, "search_files", { pattern: "needle", path: "weird name" });
    expect(r.output.content).toBe("weird name/it's $(x).txt:1:needle in a odd file");
    const g = await call(ex, "search_files", { pattern: "needle", glob: "*'s*" });
    expect(g.output.content).toContain("needle in a odd file");
    expect(await ex.stat("x")).toBeNull();
  });

  it("returns an error message for an invalid regex", async () => {
    const r = await call(await project(), "search_files", { pattern: "(unclosed" });
    expect(r.outcome).toBe("tool_error");
    expect(r.output.content).toContain("search failed");
  });

  it("rejects missing paths and paths outside the workspace", async () => {
    const ex = await project();
    const missing = await call(ex, "search_files", { pattern: "x", path: "nope" });
    expect(missing.outcome).toBe("tool_error");
    expect(missing.output.content).toContain("No such file or directory");
    const escaped = await call(ex, "search_files", { pattern: "x", path: "../.." });
    expect(escaped.output.content).toContain("outside the bot workspace");
    const abs = await call(ex, "search_files", { pattern: "x", path: "/etc" });
    expect(abs.output.content).toContain("outside the bot workspace");
  });

  it("caps the number of matches and says so", async () => {
    const ex = await localWorkspace();
    await ex.writeFile(
      "many.txt",
      `${Array.from({ length: 250 }, (_, i) => `match ${i}`).join("\n")}\n`,
    );
    const r = await call(ex, "search_files", { pattern: "match" });
    const lines = r.output.content.split("\n");
    expect(lines.filter((l) => l.startsWith("many.txt:")).length).toBe(100);
    expect(r.output.content).toContain("150 more matching lines not shown");
  });

  describe("grep fallback", () => {
    // PATH holding only grep (symlinked into a temp dir): exercises the second branch.
    async function withoutRg() {
      const ex = await project();
      const run = (
        pattern: string,
        path = ".",
        extra: Partial<Parameters<typeof buildSearchCommand>[0]> = {},
      ) =>
        ex.exec(buildSearchCommand({ pattern, path, ignoreCase: false, ...extra }), {
          env: { PATH: "/nonexistent-bin-dir:/bin:/usr/bin" },
        });
      return { ex, run };
    }

    it("uses grep -rnE when rg is not installed", async () => {
      const { ex } = await withoutRg();
      await ex.exec('mkdir -p fakebin && ln -sf "$(command -v grep)" fakebin/grep');
      const cmd = buildSearchCommand({ pattern: "hello|start\\(", path: ".", ignoreCase: false });
      const r = await ex.exec(cmd, { env: { PATH: `${ex.root}/fakebin` } });
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines).toContain("./src/app.ts:1:export function start() {");
      expect(lines).toContain("./docs/notes.md:2:hello from the docs");
      expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
      expect(lines.some((l) => l.includes("blob.dat"))).toBe(false);
    });

    it("keeps hostile input as data in the grep branch", async () => {
      const { ex } = await withoutRg();
      await ex.exec('mkdir -p fakebin && ln -sf "$(command -v grep)" fakebin/grep');
      const cmd = buildSearchCommand({
        pattern: "$(touch pwned)'\"`x`",
        path: "weird name",
        glob: "*'s*",
        ignoreCase: true,
      });
      const r = await ex.exec(cmd, { env: { PATH: `${ex.root}/fakebin` } });
      expect(r.exitCode).toBe(1);
      expect(await ex.stat("pwned")).toBeNull();
    });
  });
});
