import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The checkable part of docs/DESIGN.md: rules a test can read from the source, so the next card
// or screen cannot drift without a red test.

const SRC = join(import.meta.dirname);
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
const read = (path: string): string => readFileSync(path, "utf8");
const rel = (path: string): string => relative(SRC, path);

describe("tokens: no literal colour, radius or font size outside tokens.css", () => {
  const css = files(SRC, /\.css$/).filter((f) => !f.endsWith("tokens.css"));
  const code = files(SRC, /\.tsx?$/).filter((f) => !f.endsWith("design-rules.test.ts"));

  it("no literal colour in any stylesheet or component", () => {
    const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
    const found = [...css, ...code].filter((f) =>
      read(f)
        .split("\n")
        .some((line) => COLOUR.test(line) && !line.trim().startsWith("//") && !/&#\d+;/.test(line)),
    );
    expect(found.map(rel)).toEqual([]);
  });

  it("literal radii and font sizes in the stylesheets only go down (a ratchet: new ones go in tokens.css)", () => {
    const LITERAL = /(?:font-size|border-radius):\s*[1-9]\d*px/;
    const count = css.reduce(
      (n, f) =>
        n +
        read(f)
          .split("\n")
          .filter((line) => LITERAL.test(line)).length,
      0,
    );
    expect(count).toBeLessThanOrEqual(9);
  });
});

describe("chat cards share one chrome and one collapsed row", () => {
  const ui = (name: string) => read(join(SRC, "ui", name));

  it("the cards that wait for you are built on DecisionCard, and the decided ones on ActionCard", () => {
    for (const name of ["approval-card.tsx", "secret-request-card.tsx"]) {
      const source = ui(name);
      expect(source, name).toContain('from "./decision-card.js"');
      expect(source, name).toContain('from "./action-card.js"');
      expect(source, name).not.toMatch(/className="ui-action[ "]/);
    }
    // The generic "needs you" variant of ActionCard (the bot's computer) uses the same chrome.
    expect(ui("action-card.tsx")).toContain('from "./decision-card.js"');
  });

  it("the tool actions are drawn by the same collapsed row", () => {
    expect(read(join(SRC, "features", "chat", "ActionRow.tsx"))).toContain("ActionCard");
  });

  it("the chrome of every chat card is the same: 1px border and the card radius", () => {
    const css = read(join(SRC, "ui", "ui.css"));
    const block = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };
    for (const selector of [".ui-action", ".qcard", ".ui-bubble--bot"]) {
      expect(block(selector), selector).toContain("border: 1px solid var(--color-border)");
      // (the bot bubble takes its radius from `.ui-bubble`)
      if (selector !== ".ui-bubble--bot")
        expect(block(selector), selector).toContain("border-radius: var(--radius-card)");
    }
    expect(block(".ui-bubble")).toContain("border-radius: var(--radius-card)");
  });

  it("the expand affordance is the stacked chevrons, never a single chevron", () => {
    const src = read(join(SRC, "ui", "action-card.tsx"));
    expect(src).toContain("ChevronsUpDown");
    expect(src).toContain("ChevronsDownUp");
    expect(src).not.toMatch(/\bChevron(Down|Up)\b/);
  });

  it("the expand chevron is hidden at rest and shown on hover and on keyboard focus", () => {
    const css = read(join(SRC, "ui", "ui.css"));
    expect(css).toMatch(/\.ui-action__chevron \{[^}]*opacity: 0/);
    expect(css).toMatch(
      /\.ui-action__row:hover \.ui-action__chevron,\s*\.ui-action__row:focus-visible \.ui-action__chevron \{[^}]*opacity: 1/,
    );
  });
});

describe("docs/DESIGN.md is the standard, and everyone is pointed to it", () => {
  const root = join(SRC, "..", "..", "..");
  it("exists and is referenced by the desktop README, FRONTEND.md and CLAUDE.md", () => {
    expect(read(join(root, "docs", "DESIGN.md"))).toContain("Antes de entregar uma tela");
    for (const file of ["apps/desktop/README.md", "docs/FRONTEND.md", "CLAUDE.md"]) {
      expect(read(join(root, file)), file).toContain("DESIGN.md");
    }
  });
});
