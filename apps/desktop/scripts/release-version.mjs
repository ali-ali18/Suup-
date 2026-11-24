// Sets the version of the desktop app for a release (docs/ATUALIZACAO.md): `pnpm release:version 0.2.0`.
//   apps/desktop/src-tauri/tauri.conf.json   "version" (what the updater compares)
//   apps/desktop/package.json                "version"
//   apps/desktop/src-tauri/Cargo.toml        [package] version (the server the app carries reads it)
//   apps/desktop/src-tauri/Cargo.lock        the same, so `cargo check --locked` keeps passing
// The version is x.y.z, optionally with a pre-release (`0.1.0-beta`, `0.1.0-beta.2`), and must be
// greater than the current one by semver precedence: the updater only installs a greater version.
// The Windows MSI only takes numbers (major.minor.patch, docs: v2.tauri.app/reference/config,
// WixConfig.version), so `bundle.windows.wix.version` gets the numeric core (x.y.z).
// Then commit, and push the tag `v<version>` (the release workflow builds it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = join(import.meta.dirname, "..");
const TAURI_CONF = join(DESKTOP, "src-tauri", "tauri.conf.json");
const PACKAGE = join(DESKTOP, "package.json");
const CARGO_TOML = join(DESKTOP, "src-tauri", "Cargo.toml");
const CARGO_LOCK = join(DESKTOP, "src-tauri", "Cargo.lock");
const CRATE = "suup-desktop";

const isDigit = (char) => char >= "0" && char <= "9";
const isIdentChar = (char) =>
  isDigit(char) || (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "-";
const isNumber = (part) => part !== "" && [...part].every(isDigit);

/**
 * `x.y.z` or `x.y.z-<pre>` (semver: the pre-release is dot-separated identifiers of letters, digits
 * and hyphens; numeric ones without a leading zero): `{ core: [x, y, z], pre: [...] }`, or null.
 * Checked character by character (no pattern).
 */
export function parseVersion(text) {
  const dash = text.indexOf("-");
  const coreText = dash === -1 ? text : text.slice(0, dash);
  const preText = dash === -1 ? null : text.slice(dash + 1);
  const parts = coreText.split(".");
  if (parts.length !== 3) return null;
  const core = [];
  for (const part of parts) {
    if (part.length > 9 || !isNumber(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    core.push(Number(part));
  }
  const pre = [];
  if (preText !== null) {
    if (preText === "") return null;
    for (const ident of preText.split(".")) {
      if (ident === "" || ident.length > 32 || ![...ident].every(isIdentChar)) return null;
      if (isNumber(ident) && ident.length > 1 && ident.startsWith("0")) return null;
      pre.push(ident);
    }
  }
  return { core, pre };
}

/** Semver precedence: the core first; a version with a pre-release is lower than the same core without. */
export function isGreater(next, current) {
  for (let i = 0; i < 3; i++) {
    if (next.core[i] !== current.core[i]) return next.core[i] > current.core[i];
  }
  if (next.pre.length === 0) return current.pre.length > 0;
  if (current.pre.length === 0) return false;
  for (let i = 0; i < Math.max(next.pre.length, current.pre.length); i++) {
    const a = next.pre[i];
    const b = current.pre[i];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;
    const an = isNumber(a);
    const bn = isNumber(b);
    if (an && bn) return Number(a) > Number(b);
    if (an !== bn) return !an; // numeric identifiers are lower than alphanumeric ones
    return a > b;
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
    console.error(
      "Uso: pnpm release:version <x.y.z[-pre]>   (por exemplo: pnpm release:version 0.2.0 ou 0.1.0-beta)",
    );
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
  // The MSI takes only numbers: its version is the numeric core (`0.1.0` for `0.1.0-beta`).
  const confNow = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  confNow.bundle.windows.wix = {
    ...(confNow.bundle.windows.wix ?? {}),
    version: next.core.join("."),
  };
  writeFileSync(TAURI_CONF, `${JSON.stringify(confNow, null, 2)}\n`);
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
