import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string, file = "index.ts") =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of the workspace packages, so `pnpm test` does not depend on
    // a previous build of `dist`.
    alias: [
      { find: /^@suup\/core\/testing$/, replacement: src("core", "testing/index.ts") },
      {
        find: /^@suup\/core\/testing\/store-contract$/,
        replacement: src("core", "testing/store-contract.ts"),
      },
      { find: /^@suup\/(core|providers|tools|db|sandbox|runtime)$/, replacement: src("$1") },
    ],
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
