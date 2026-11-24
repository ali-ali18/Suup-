// Sets the version of the desktop app for a release (docs/ATUALIZACAO.md): `pnpm release:version 0.2.0`.
//   apps/desktop/src-tauri/tauri.conf.json   "version" (what the updater compares)
//   apps/desktop/package.json                "version"
//   apps/desktop/src-tauri/Cargo.toml        [package] version (the server the app carries reads it)
//   apps/desktop/src-tauri/Cargo.lock        the same, so `cargo check --locked` keeps passing
// The version is plain x.y.z and must be greater than the current one: the updater only installs a
// greater version. Then commit, and push the tag `v<version>` (the release workflow builds it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = join(import.meta.dirname, "..");
const TAURI_CONF = join(DESKTOP, "src-tauri", "tauri.conf.json");
const PACKAGE = join(DESKTOP, "package.json");
const CARGO_TOML = join(DESKTOP, "src-tauri", "Cargo.toml");
const CARGO_LOCK = join(DESKTOP, "src-tauri", "Cargo.lock");
const CRATE = "suup-desktop";

/** `x.y.z` with digits only: its three numbers, or null. */
export function parseVersion(text) {
  const parts = text.split(".");
  if (parts.length !== 3) return null;
  const numbers = [];
  for (const part of parts) {
    if (part === "" || part.length > 9) return null;
    for (const char of part) if (char < "0" || char > "9") return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    numbers.push(Number(part));
  }
  return numbers;
}

export function isGreater(next, current) {
  for (let i = 0; i < 3; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

/** Replaces the value of the first line `version = "..."` after the line `after` (exact lines). */
export function replaceTomlVersion(text, after, version) {
  const lines = text.split("\n");
  const start = lines.indexOf(after);
  if (start === -1) throw new Error(`linha não achada: ${after}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("version = ")) {
      lines[i] = `version = "${version}"`;
      return lines.join("\n");
    }
  }
  throw new Error(`versão não achada depois de: ${after}`);
}

function main() {
  const wanted = process.argv[2] ?? "";
  const next = parseVersion(wanted);
  if (next === null) {
    console.error("Uso: pnpm release:version <x.y.z>   (por exemplo: pnpm release:version 0.2.0)");
    process.exit(2);
  }
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const current = parseVersion(String(conf.version));
  if (current !== null && !isGreater(next, current)) {
    console.error(
      `A versão nova (${wanted}) precisa ser maior que a atual (${conf.version}): o app só instala uma maior.`,
    );
    process.exit(2);
  }
  // Only the value changes (the rest of the file keeps its formatting): the first `"version": "..."`,
  // which is the top-level one in both files, compared exactly with what the file says it is.
  const replaceJsonVersion = (path) => {
    const text = readFileSync(path, "utf8");
    const before = `"version": ${JSON.stringify(String(JSON.parse(text).version))}`;
    const at = text.indexOf(before);
    if (at === -1) throw new Error(`versão não achada em ${path}`);
    const after = `"version": ${JSON.stringify(wanted)}`;
    writeFileSync(path, text.slice(0, at) + after + text.slice(at + before.length));
  };
  replaceJsonVersion(TAURI_CONF);
  replaceJsonVersion(PACKAGE);
  writeFileSync(
    CARGO_TOML,
    replaceTomlVersion(readFileSync(CARGO_TOML, "utf8"), "[package]", wanted),
  );
  writeFileSync(
    CARGO_LOCK,
    replaceTomlVersion(readFileSync(CARGO_LOCK, "utf8"), `name = "${CRATE}"`, wanted),
  );
  console.log(
    `Versão ${wanted}. Agora: commit, e a tag v${wanted} (git tag v${wanted} && git push origin v${wanted}).`,
  );
}

if (process.argv[1] === import.meta.filename) main();
