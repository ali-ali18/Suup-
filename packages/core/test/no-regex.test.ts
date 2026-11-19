// Nenhuma regex nova no harness sem o dono saber. O dono decidiu (docs/REGRAS.md): regex que
// IDENTIFICA, CLASSIFICA, FILTRA ou INTERPRETA (o que um texto, arquivo, argumento, chamada ou
// mensagem "é", ou se algo pode rodar por causa de como "parece") é uma amarra e é proibida; regex
// que só lê um formato formal de gramática fixa é permitida, mas fica numa lista com o motivo.
//
// O detector lê a ÁRVORE SINTÁTICA (API do compilador TypeScript) e conta literais de regex e
// chamadas `RegExp(...)` / `new RegExp(...)`. Ele próprio não usa regex. A lista das que existem é
// `regex-allowlist.ts`; o código de aprovação (regras, cartões, decisões) tem que ficar SEM regex.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import { skipTrivia } from "typescript/unstable/ast/scanner";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";
import { REGEX_ALLOWLIST } from "./regex-allowlist.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** Os projetos TypeScript do harness: cada um lista os arquivos que ele compila. */
const PROJECTS = [
  "packages/core",
  "packages/api",
  "packages/avatar",
  "packages/providers",
  "packages/tools",
  "packages/connectors",
  "packages/db",
  "packages/sandbox",
  "packages/runtime",
  "packages/server",
  "evals",
  "apps/cli",
  "apps/desktop",
];

function isTestFile(path: string): boolean {
  const parts = path.split(sep);
  const name = parts.at(-1) ?? "";
  return (
    name.endsWith(".test.ts") ||
    name.endsWith(".test.tsx") ||
    name.endsWith(".spec.ts") ||
    parts.includes("test") ||
    parts.includes("e2e")
  );
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    const source = (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts");
    return source && !isTestFile(path) ? [path] : [];
  });
}

/** Os arquivos de código do harness: `src/` de cada pacote, app e `evals`, mais as configurações do app. */
function harnessFiles(): string[] {
  const dirs: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) dirs.push(join(root, group, name, "src"));
  }
  dirs.push(join(root, "evals", "src"));
  const files = dirs.flatMap(walk);
  for (const config of ["vite.config.ts", "playwright.config.ts", "vitest.config.ts"]) {
    const path = join(root, "apps", "desktop", config);
    if (existsSync(path)) files.push(path);
  }
  return files.sort();
}

interface Found {
  file: string;
  line: number;
  kind: "literal" | "RegExp";
}

let cache: Promise<{ found: Found[]; parsed: Set<string> }> | undefined;

function scan(): Promise<{ found: Found[]; parsed: Set<string> }> {
  cache ??= Promise.resolve().then(() => {
    const api = new API({ cwd: root });
    const found: Found[] = [];
    const parsed = new Set<string>();
    try {
      for (const project of PROJECTS) {
        const config = join(root, project, "tsconfig.json");
        const snapshot = api.updateSnapshot({ openProject: config });
        const opened = snapshot.getProjects().find((p) => p.configFileName === config);
        if (opened === undefined) throw new Error(`projeto não abriu: ${project}`);
        for (const path of opened.program.getSourceFileNames()) {
          if (!path.startsWith(root) || path.includes(`${sep}node_modules${sep}`)) continue;
          if (parsed.has(path)) continue;
          const source = opened.program.getSourceFile(path);
          if (source === undefined) continue;
          parsed.add(path);
          const visit = (node: {
            kind: SyntaxKind;
            pos: number;
            forEachChild(cb: (child: never) => unknown): unknown;
            expression?: { kind: SyntaxKind; text?: string };
          }): void => {
            const isLiteral = node.kind === SyntaxKind.RegularExpressionLiteral;
            const isCall =
              (node.kind === SyntaxKind.NewExpression || node.kind === SyntaxKind.CallExpression) &&
              node.expression?.kind === SyntaxKind.Identifier &&
              node.expression.text === "RegExp";
            if (isLiteral || isCall) {
              const start = skipTrivia(source.text, node.pos);
              // linha = quebras de linha antes do início, mais um (contadas uma a uma)
              let line = 1;
              for (let i = 0; i < start; i += 1) if (source.text[i] === "\n") line += 1;
              found.push({
                file: relative(root, path).split(sep).join("/"),
                line,
                kind: isLiteral ? "literal" : "RegExp",
              });
            }
            node.forEachChild(visit as never);
          };
          visit(source as never);
        }
      }
    } finally {
      api.close();
    }
    return { found, parsed };
  });
  return cache;
}

const allowed = new Map(REGEX_ALLOWLIST.map((entry) => [entry.file, entry]));

describe("no regex in the harness without the owner knowing (docs/REGRAS.md)", () => {
  it("every source file of the harness was read by the detector", async () => {
    const { parsed } = await scan();
    const missing = harnessFiles().filter((file) => !parsed.has(file));
    expect(missing.map((f) => relative(root, f))).toEqual([]);
  }, 120_000);

  it("a regex (literal or RegExp(...)) exists only in a file of the allowlist, with exactly that count", async () => {
    const { found } = await scan();
    const counts = new Map<string, number[]>();
    for (const item of found) {
      if (isTestFile(item.file)) continue;
      counts.set(item.file, [...(counts.get(item.file) ?? []), item.line]);
    }
    const problems: string[] = [];
    for (const [file, lines] of counts) {
      const entry = allowed.get(file);
      if (entry === undefined) {
        problems.push(
          `${file}: ${lines.length} regex nova (linhas ${lines.join(", ")}). Não use regex: compare por igualdade, use estrutura declarada ou deixe o entendimento ao modelo. Se for um formato formal, pergunte ao dono antes (docs/REGRAS.md).`,
        );
      } else if (entry.count !== lines.length) {
        problems.push(
          `${file}: a lista diz ${entry.count} regex, o código tem ${lines.length} (linhas ${lines.join(", ")}). Regex nova só com o OK do dono; se removeu alguma, atualize regex-allowlist.ts e docs/REGRAS.md.`,
        );
      }
    }
    for (const entry of REGEX_ALLOWLIST) {
      if (!counts.has(entry.file)) {
        problems.push(`${entry.file}: está na lista mas já não tem regex; tire a entrada.`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("every allowlist entry says what the regex is for and what would replace it", () => {
    for (const entry of REGEX_ALLOWLIST) {
      expect(entry.why.length, entry.file).toBeGreaterThan(15);
      expect(entry.instead.length, entry.file).toBeGreaterThan(5);
      // groups a and b wait for the owner's decision
      expect(entry.pending, entry.file).toBe(entry.group === "a" || entry.group === "b");
    }
  });

  it("the approvals, rules, vault-decision and card code has NO regex at all", async () => {
    const { found } = await scan();
    const approvalFiles = [
      "packages/core/src/approvals/",
      "packages/core/src/outbound.ts",
      "packages/db/src/approvals.ts",
      "packages/db/src/approval-rules.ts",
      "packages/api/src/approvals.ts",
      "packages/server/src/routes/approvals.ts",
      "apps/cli/src/commands/approvals.ts",
      "apps/cli/src/commands/rules.ts",
      "apps/cli/src/approval-prompt.ts",
      "packages/runtime/src/vault/",
      "apps/desktop/src/ui/approval-card.tsx",
      "apps/desktop/src/data/approval-text.ts",
      "apps/desktop/src/features/settings/ApprovalsSettings.tsx",
    ];
    const hits = found.filter((f) => approvalFiles.some((p) => f.file.startsWith(p)));
    expect(hits).toEqual([]);
  }, 120_000);

  it("the SQL of the rules (migration 0013 and later) uses no regular expression operator or function", () => {
    const dir = join(root, "packages", "db", "migrations");
    // 0001-0012 are history (never edited) and validate names with `~`; they are listed in docs/REGRAS.md.
    const files = readdirSync(dir).filter((n) => n.endsWith(".sql") && n >= "0013");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(join(dir, name), "utf8").toLowerCase();
      for (const banned of [" ~ ", " ~* ", " !~ ", "similar to", "regexp_", "regex", " rlike "]) {
        expect(text.includes(banned), `${name} contains ${JSON.stringify(banned)}`).toBe(false);
      }
    }
  });
});
