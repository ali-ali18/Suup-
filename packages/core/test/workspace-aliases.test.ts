import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../../vitest.config.js";

// `pnpm test` on a clean clone (no `dist`, no `tsc -b`) must resolve every workspace import to the
// SOURCES. A subpath missing from the aliases (`@suup/core/answers` was) silently falls through to
// `dist`, which does not exist yet: the suite fails only on a fresh checkout.

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

type Alias = { find: string | RegExp; replacement: string };

function nodeAliases(): Alias[] {
  const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
  const node = projects.find(
    (p): p is { test: { name: string }; resolve: { alias: Alias[] } } =>
      typeof p === "object" &&
      p !== null &&
      (p as { test?: { name?: string } }).test?.name === "node",
  );
  if (node === undefined) throw new Error("no node project in vitest.config.ts");
  return node.resolve.alias;
}

/** What vite does with an alias list: the first entry that matches wins. */
function resolveAlias(aliases: Alias[], id: string): string | null {
  for (const { find, replacement } of aliases) {
    if (typeof find === "string") {
      if (id === find) return replacement;
      if (id.startsWith(`${find}/`)) return replacement + id.slice(find.length);
    } else if (find.test(id)) {
      return id.replace(find, replacement);
    }
  }
  return null;
}

function workspaceExports(): { id: string; source: string }[] {
  const dirs = [...readdirSync(root("packages")).map((n) => `packages/${n}`), "apps/cli", "evals"];
  const out: { id: string; source: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(root(`${dir}/package.json`))) continue;
    const manifest = JSON.parse(readFileSync(root(`${dir}/package.json`), "utf8")) as {
      name: string;
      exports?: Record<string, { default: string }>;
    };
    for (const [sub, target] of Object.entries(manifest.exports ?? {})) {
      const built = target.default.slice("./dist/".length, -".js".length);
      out.push({
        id: sub === "." ? manifest.name : `${manifest.name}${sub.slice(1)}`,
        source: root(`${dir}/src/${built}.ts`),
      });
    }
  }
  return out;
}

describe("the node test project resolves every workspace export to its source", () => {
  it("includes the subpaths other packages import (@suup/core/answers, ./schedule, ./testing...)", () => {
    const ids = workspaceExports().map((e) => e.id);
    for (const id of ["@suup/core/answers", "@suup/core/schedule", "@suup/core/testing"]) {
      expect(ids).toContain(id);
    }
  });

  it.each(workspaceExports())("$id", ({ id, source }) => {
    expect(existsSync(source), `${source} exists`).toBe(true);
    expect(resolveAlias(nodeAliases(), id)).toBe(source);
  });
});
