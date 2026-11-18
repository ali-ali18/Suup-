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
