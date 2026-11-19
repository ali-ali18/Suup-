import type { Executor } from "@suup/core";
import { sha256, sq } from "../kit.js";

/**
 * Helpers of the HARD tasks. Everything here is deterministic: seeded generators only, no clock,
 * no network (the one task that uses a local HTTP server binds the loopback interface).
 */

/** A tiny seeded generator (LCG), the same on every machine and every Node version. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A float in [0, 1). */
  float(): number {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0;
    return (this.#state >>> 8) / 16_777_216;
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** An integer in [lo, hi]. */
  between(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  chance(p: number): boolean {
    return this.float() < p;
  }
}

const UNPACK = `import json, os
with open(".suup-bundle.json", encoding="utf-8") as f:
    bundle = json.load(f)
for path, text in bundle.items():
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
os.remove(".suup-bundle.json")
`;

/**
 * Writes many files with two commands instead of one per file (a Docker sandbox pays a process per
 * `writeFile`). Text is written byte for byte (no newline translation).
 */
export async function seedBundle(ws: Executor, files: Record<string, string>): Promise<void> {
  await ws.writeFile(".suup-bundle.json", JSON.stringify(files));
  const run = await ws.exec(`python3 -c ${sq(UNPACK)}`, { timeoutMs: 120_000 });
  if (run.exitCode !== 0) {
    throw new Error(`não foi possível preparar os arquivos: ${run.stderr.trim().slice(0, 300)}`);
  }
}

/**
 * Runs a Python verifier file: written to the workspace root (so the project's own modules import),
 * run, and removed. The code is only in the workspace while the verifier runs, after the bot is done.
 */
export async function runVerifier(
  ws: Executor,
  name: string,
  code: string,
  args: string[] = [],
  timeoutMs = 120_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const file = `.suup-verify-${name}.py`;
  await ws.writeFile(file, code);
  try {
    const run = await ws.exec(`python3 ${file} ${args.map(sq).join(" ")}`, { timeoutMs });
    return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
  } finally {
    await ws.exec(`rm -f ${file}`, { timeoutMs: 30_000 });
  }
}

const HASHER = `import hashlib, json, os, sys
out = {}
for root in json.loads(sys.argv[1]):
    if os.path.isfile(root):
        paths = [root]
    elif os.path.isdir(root):
        paths = [os.path.join(d, f) for d, ds, fs in os.walk(root) if "__pycache__" not in d for f in fs]
    else:
        paths = []
    for p in paths:
        with open(p, "rb") as handle:
            out[os.path.normpath(p)] = hashlib.sha256(handle.read()).hexdigest()
print(json.dumps(out))
`;

/** SHA-256 of every file under `roots` (files or folders), by workspace path; `__pycache__` is skipped. */
export async function hashesOf(ws: Executor, roots: string[]): Promise<Record<string, string>> {
  const run = await runVerifier(ws, "hashes", HASHER, [JSON.stringify(roots)], 60_000);
  try {
    return JSON.parse(run.stdout) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The hashes a seeded set of files must keep (only the files under `roots`). */
export function expectedHashes(
  files: Record<string, string>,
  roots: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (roots.some((r) => path === r || path.startsWith(`${r}/`))) out[path] = sha256(text);
  }
  return out;
}

/** Describes how `actual` differs from `expected` (changed, missing, extra files); `""` when equal. */
export function diffHashes(
  actual: Record<string, string>,
  expected: Record<string, string>,
): string {
  const parts: string[] = [];
  const changed = Object.keys(expected).filter(
    (p) => actual[p] !== undefined && actual[p] !== expected[p],
  );
  const missing = Object.keys(expected).filter((p) => actual[p] === undefined);
  const extra = Object.keys(actual).filter((p) => expected[p] === undefined);
  if (changed.length > 0) parts.push(`alterados: ${changed.slice(0, 5).join(", ")}`);
  if (missing.length > 0) parts.push(`ausentes: ${missing.slice(0, 5).join(", ")}`);
  if (extra.length > 0) parts.push(`a mais: ${extra.slice(0, 5).join(", ")}`);
  return parts.join("; ");
}

/** Parses `python3 -m unittest -v` output into test name -> outcome. */
export function parseUnittest(output: string): Record<string, string> {
  const outcomes: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^\S+ \(([\w.]+)\) \.\.\. (ok|FAIL|ERROR|skipped.*)$/.exec(line.trim());
    if (match !== null) outcomes[match[1] as string] = match[2] as string;
  }
  return outcomes;
}

/** The text a `finish` call carried: its summary and every evidence line, for the accepted attempt. */
export function finishText(
  events: readonly { type: string; payload: unknown }[],
): { summary: string; evidence: string[] } | null {
  for (const event of events) {
    if (event.type !== "finish_attempt") continue;
    const p = event.payload as {
      accepted?: boolean;
      summary?: string;
      evidence?: { evidence?: string }[];
    };
    if (p.accepted !== true) continue;
    return {
      summary: p.summary ?? "",
      evidence: (p.evidence ?? []).map((e) => e.evidence ?? ""),
    };
  }
  return null;
}
