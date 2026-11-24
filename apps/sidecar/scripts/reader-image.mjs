// Prepares the folder the desktop app builds the page reader's image from (docker/reader/app.Dockerfile):
//   Dockerfile               the recipe (no repository needed on the user's computer)
//   package.json             only `playwright-core`, at the exact version of packages/web
//   dist/serve.js            the reader's program (packages/web/src/serve.ts), bundled into one file
//   dist/xhr-sync-worker.js  the file jsdom looks up next to itself when it loads (see `jsdomWorker`)
// Needs `tsc -b` first (it bundles the compiled output).
//   node apps/sidecar/scripts/reader-image.mjs <folder>
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const web = join(root, "packages", "web");

/**
 * jsdom resolves `./xhr-sync-worker.js` next to its own code when it loads (for synchronous XHR,
 * which a page read never does). Bundled, "next to its code" is next to the bundle: the file must be
 * there, or loading jsdom throws.
 */
export function jsdomWorker() {
  const fromWeb = createRequire(join(web, "package.json"));
  const jsdom = dirname(realpathSync(fromWeb.resolve("jsdom/package.json")));
  return join(jsdom, "lib", "jsdom", "living", "xhr", "xhr-sync-worker.js");
}

/** The version of `playwright-core` packages/web pins (exact, so the browser of the image matches). */
function playwrightVersion() {
  const pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
  const version = pkg.dependencies?.["playwright-core"];
  if (typeof version !== "string" || version === "") {
    throw new Error("packages/web/package.json não fixa o playwright-core");
  }
  return version;
}

export async function bundleReader(folder) {
  const version = playwrightVersion();
  const dockerfile = readFileSync(join(root, "docker", "reader", "app.Dockerfile"), "utf8");
  if (!dockerfile.includes(`mcr.microsoft.com/playwright:v${version}-`)) {
    throw new Error(`docker/reader/app.Dockerfile não usa a imagem do Playwright ${version}`);
  }
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "Dockerfile"), dockerfile);
  writeFileSync(
    join(folder, "package.json"),
    `${JSON.stringify(
      {
        name: "suup-reader",
        private: true,
        type: "module",
        dependencies: { "playwright-core": version },
      },
      null,
      2,
    )}\n`,
  );
  await build({
    entryPoints: [join(web, "dist", "serve.js")],
    outfile: join(folder, "dist", "serve.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // The browser driver is installed in the image (its own files are read at run time). The
    // optional native canvas that jsdom tries to load (and does without) is never bundled: it is in
    // the workspace since pdf.js (create_document) brought it.
    external: ["playwright-core", "@napi-rs/canvas"],
    legalComments: "none",
    // A few dependencies are CommonJS and call `require`.
    banner: {
      js: "import { createRequire as __suupRequire } from 'node:module'; const require = __suupRequire(import.meta.url);",
    },
    logLevel: "warning",
  });
  copyFileSync(jsdomWorker(), join(folder, "dist", "xhr-sync-worker.js"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (folder === undefined) throw new Error("uso: reader-image.mjs <pasta>");
  await bundleReader(resolve(folder));
}
