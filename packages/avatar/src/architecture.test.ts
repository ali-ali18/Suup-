import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL(".", import.meta.url));
const packageDir = join(srcDir, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Source without comments and string literals' contents (so prose does not trigger checks). */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = tsFiles(srcDir);
const BROWSER_ENTRY = join(srcDir, "browser.ts");

describe("package boundaries", () => {
  it("imports nothing outside the package (relative imports only)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const matches = code(file).matchAll(
        /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["']([^"']+)["']/g,
      );
      for (const m of matches) {
        const spec = m[1] as string;
        if (!spec.startsWith("./") && !spec.startsWith("../"))
          offenders.push(`${relative(srcDir, file)}: ${spec}`);
        else if (!spec.endsWith(".js"))
          offenders.push(`${relative(srcDir, file)}: ${spec} (missing .js)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json has no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(pkg[field]).toBeUndefined();
    }
  });

  it("only the browser entry touches the DOM, the clock or rAF", () => {
    const forbidden =
      /\b(window|document|requestAnimationFrame|cancelAnimationFrame|performance|IntersectionObserver|localStorage|navigator|setTimeout|setInterval)\b|\bDate\b|Math\.random/;
    const offenders = files
      .filter((f) => f !== BROWSER_ENTRY)
      .filter((f) => forbidden.test(code(f)))
      .map((f) => relative(srcDir, f));
    expect(offenders).toEqual([]);
  });

  it("the main entry does not import the browser entry", () => {
    for (const file of files.filter((f) => f !== BROWSER_ENTRY)) {
      expect(code(file)).not.toMatch(/from\s+["'](?:\.\/|\.\.\/)+browser\.js["']/);
    }
  });
});
