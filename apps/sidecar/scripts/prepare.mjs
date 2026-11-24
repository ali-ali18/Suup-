// Prepares what the desktop app carries for "neste computador" (docs/pesquisas/fase-4-backend-embutido-e-vps.md):
//   src-tauri/binaries/node-<triple>[.exe]   the Node runtime (Tauri's externalBin: the sidecar)
//   src-tauri/resources/sidecar/sidecar.mjs  the server + worker + CLI, bundled into one file
//   src-tauri/resources/sidecar/xhr-sync-worker.js  a file jsdom looks up next to the bundle when it loads
//   src-tauri/resources/postgres/            the PostgreSQL binaries of this platform
//   src-tauri/resources/migrations/          the SQL migrations
//   src-tauri/resources/docker/              the Dockerfiles of the bots' machine, the connector runner, the egress proxy
//                                            and the page reader (with the bundled programs the last two carry)
// Run it on the platform being built (`pnpm --filter @suup/sidecar run bundle`); CI does.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleEgress } from "./egress-image.mjs";
import { bundleReader, jsdomWorker } from "./reader-image.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sidecar = join(here, "..");
const root = join(sidecar, "..", "..");
// SUUP_PREPARE_OUT puts everything somewhere else (the test of the packaged layout does).
const tauri = process.env.SUUP_PREPARE_OUT ?? join(root, "apps", "desktop", "src-tauri");
const resources = join(tauri, "resources");
const binaries = join(tauri, "binaries");

const PG_PACKAGES = {
  "linux-x64": "@embedded-postgres/linux-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

function hostTriple() {
  if (process.env.SUUP_TARGET_TRIPLE) return process.env.SUUP_TARGET_TRIPLE;
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  if (line === undefined) throw new Error("rustc -vV não disse o host");
  return line.slice("host:".length).trim();
}

function size(path) {
  return statSync(path).size;
}

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSyncSafe(dir)) {
    const path = join(dir, name);
    total += statSync(path).isDirectory() ? dirSize(path) : size(path);
  }
  return total;
}

import { readdirSync } from "node:fs";

const readdirSyncSafe = (dir) => readdirSync(dir);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// 1. The bundle: the CLI's `server --with-worker` and the migrations runner, with every dependency
// inside (they are all pure JavaScript; no native module is involved).
execFileSync("pnpm", ["-w", "exec", "tsc", "-b", "apps/sidecar"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
rmSync(resources, { recursive: true, force: true });
mkdirSync(join(resources, "sidecar"), { recursive: true });
await build({
  entryPoints: [join(sidecar, "dist", "main.js")],
  outfile: join(resources, "sidecar", "sidecar.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "none",
  // Optional native module that pdf.js and jsdom try to load and do without (the PDF check of
  // `create_document` and the page reader need no canvas): never bundled.
  external: ["@napi-rs/canvas"],
  // A few dependencies are CommonJS and call `require`; pdfkit (the PDF builder of
  // `create_document`) also reads `__filename` when it loads.
  banner: {
    js: "import { createRequire as __suupRequire } from 'node:module'; import { fileURLToPath as __suupFileURL } from 'node:url'; import { dirname as __suupDirname } from 'node:path'; const require = __suupRequire(import.meta.url); const __filename = __suupFileURL(import.meta.url); const __dirname = __suupDirname(__filename);",
  },
  logLevel: "warning",
});
// The web's page reading (jsdom) is inside the bundle; jsdom needs this file beside it to load.
cpSync(jsdomWorker(), join(resources, "sidecar", "xhr-sync-worker.js"));

// 2. Migrations and Dockerfiles.
cpSync(join(root, "packages", "db", "migrations"), join(resources, "migrations"), {
  recursive: true,
});
cpSync(join(root, "docker", "sandbox"), join(resources, "docker", "sandbox"), { recursive: true });
cpSync(join(root, "docker", "connector-runner"), join(resources, "docker", "connector-runner"), {
  recursive: true,
});

// The egress proxy's image: its Dockerfile and the bundled program it carries.
cpSync(
  join(root, "docker", "egress", "Dockerfile"),
  join(resources, "docker", "egress", "Dockerfile"),
);
await bundleEgress(join(resources, "docker", "egress"));
// The page reader's image (docs/BUSCA.md): its recipe and the bundled program, no repository needed.
await bundleReader(join(resources, "docker", "reader"));

// 3. PostgreSQL for this platform (symlinks become real files: the installer does not keep them).
const key = `${process.platform}-${process.arch}`;
const pgPackage = PG_PACKAGES[key];
if (pgPackage === undefined) throw new Error(`sem PostgreSQL embutido para ${key}`);
const pgNative = join(realpathSync(join(sidecar, "node_modules", pgPackage)), "native");
if (!existsSync(pgNative)) throw new Error(`${pgPackage} não trouxe a pasta native`);
cpSync(pgNative, join(resources, "postgres"), { recursive: true });
// The package lists its symbolic links in a file and re-creates them in an install script, which
// pnpm does not run; do it here (relative links, next to what they point at).
const linksFile = join(pgNative, "pg-symlinks.json");
if (existsSync(linksFile) && process.platform !== "win32") {
  for (const { source, target } of JSON.parse(readFileSync(linksFile, "utf8"))) {
    const at = join(resources, "postgres", target.slice("native/".length));
    rmSync(at, { force: true });
    symlinkSync(basename(source), at);
  }
}
rmSync(join(resources, "postgres", "pg-symlinks.json"), { force: true });
rmSync(join(resources, "postgres", "include"), { recursive: true, force: true });
if (process.platform !== "win32") {
  for (const name of ["initdb", "pg_ctl", "postgres"])
    chmodSync(join(resources, "postgres", "bin", name), 0o755);
}

// 4. The Node runtime, named the way Tauri's externalBin wants (`node-<target triple>`).
mkdirSync(binaries, { recursive: true });
const triple = process.env.SUUP_PREPARE_NO_NODE === "1" ? "none" : hostTriple();
const nodeOut = join(binaries, `node-${triple}${process.platform === "win32" ? ".exe" : ""}`);
if (process.env.SUUP_PREPARE_NO_NODE !== "1") {
  cpSync(process.execPath, nodeOut);
  if (process.platform !== "win32") chmodSync(nodeOut, 0o755);
}

if (existsSync(nodeOut)) console.log(`Node ${process.version} (${triple}): ${mb(size(nodeOut))}`);
console.log(`sidecar.mjs: ${mb(size(join(resources, "sidecar", "sidecar.mjs")))}`);
console.log(`postgres: ${mb(dirSize(join(resources, "postgres")))}`);
console.log(`resources: ${mb(dirSize(resources))}`);
