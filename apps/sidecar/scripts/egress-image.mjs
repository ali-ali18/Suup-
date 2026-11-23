// Bundles the egress container's program (packages/sandbox/src/egress/container-main.ts) into ONE
// file next to the Dockerfile of the image (docker/egress): `egress.mjs`, with its dependencies
// inside. Needs `tsc -b` first (it bundles the compiled output).
//   node apps/sidecar/scripts/egress-image.mjs <folder>
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function bundleEgress(folder) {
  mkdirSync(folder, { recursive: true });
  await build({
    entryPoints: [join(root, "packages", "sandbox", "dist", "egress", "container-main.js")],
    outfile: join(folder, "egress.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    logLevel: "warning",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (folder === undefined) throw new Error("uso: egress-image.mjs <pasta>");
  await bundleEgress(resolve(folder));
}
