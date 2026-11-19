import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const packageDir = join(srcDir, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("dependency direction", () => {
  it("core imports no other @suup package", () => {
    const offenders = tsFiles(srcDir).filter((file) =>
      /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["']@suup\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("core's package.json depends on no other @suup package", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((field) => Object.keys(pkg[field] ?? {}))
      .filter((name) => name.startsWith("@suup/"));
    expect(names).toEqual([]);
  });
});

describe("tools only declare", () => {
  // Tools revolve around the harness (plan, section 4.4): they declare their risk, the fields that
  // may carry secrets and whether their output is external. They never reach the policy, the
  // vault, the database or the runtime, and nothing outside `core` can be imported by them.
  const toolsDir = join(srcDir, "..", "..", "tools", "src");

  it("tools import only core, zod, node built-ins and their own files", () => {
    const files = tsFiles(toolsDir);
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
        const from = match[1] as string;
        if (from.startsWith(".") || from.startsWith("node:")) continue;
        expect(["@suup/core", "zod"], `${file} imports ${from}`).toContain(from);
      }
    }
  });

  it("no tool names the approval policy, the vault or the redactor", () => {
    for (const file of tsFiles(toolsDir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /createToolGate|decidePolicy|SecretAccess|createRedactor|\bvault\./,
      );
    }
  });

  it("the loop never imports a concrete tool", () => {
    const loopFiles = tsFiles(join(srcDir, "loop")).concat(tsFiles(join(srcDir, "approvals")));
    for (const file of loopFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from\s+["'](?:\.\.\/)+tools\//);
    }
  });
});
