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

  it("one tool vocabulary: the decision card, the decided approval and the action row read the label and icon from toolCategory", () => {
    const row = read(join(SRC, "features", "chat", "ActionRow.tsx"));
    expect(row).toContain("categoryGlyph(item.icon)");
    expect(row).not.toMatch(/SquareTerminal|FileText|Globe|Brain|Wrench/);
    expect(read(join(SRC, "data", "actions.ts"))).toContain("toolCategory(name, connectors)");
    expect(read(join(SRC, "data", "actions.ts"))).not.toMatch(/kindLabel: "/);
    for (const name of ["approval-card.tsx"])
      expect(ui(name), name).toContain("categoryGlyph(category.icon)");
  });

  it("one row per tool call: the chat timeline merges the approvals into their calls", () => {
    expect(read(join(SRC, "features", "chat", "timeline.ts"))).toContain("mergeApprovals(");
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
    expect(block(".ui-bubble")).toContain("border-radius: var(--radius-bubble)");
  });

  it("dynamic bubbles: the outer radius is the card's, the linking one is a smaller token, and only bubbles carry the position", () => {
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain("--radius-bubble: var(--radius-card);");
    expect(tokens).toContain("--radius-bubble-link:");
    expect(tokens).toContain("--bubble-gap-group:");
    const css = read(join(SRC, "ui", "ui.css"));
    // Linking corners use the link token; no bubble rule uses a literal or the card radius for them.
    expect(css).toContain("border-bottom-left-radius: var(--radius-bubble-link)");
    expect(css).toContain("border-top-right-radius: var(--radius-bubble-link)");
    // The position is set by the two text bubbles and by nothing else: cards keep their chrome.
    const message = read(join(SRC, "ui", "message.tsx"));
    expect(message.split("data-bubble={position}").length - 1).toBe(2);
    for (const name of ["decision-card.tsx", "action-card.tsx", "question-card.tsx"])
      expect(read(join(SRC, "ui", name)), name).not.toContain("data-bubble");
    // The radius of a bubble is never animated: a new message must not move anything.
    const start = css.indexOf("/* Dynamic bubbles");
    const rules = css.slice(start, css.indexOf(".ui-bubble--pending {", start));
    expect(rules).not.toContain("transition");
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

describe("approval buttons: normal = Aprovar / Recusar; the split button is only for messages to another person", () => {
  const card = read(join(SRC, "ui", "approval-card.tsx"));
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = text.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return text.slice(start, end);
  };

  it("the split button class is drawn only by the message footer of the approval card, nowhere else", () => {
    const offenders = files(SRC, /\.tsx?$/)
      .filter((f) => !f.endsWith("design-rules.test.ts"))
      .filter((f) => read(f).includes("ui-split"))
      .map(rel);
    expect(offenders).toEqual(["ui/approval-card.tsx"]);
    const messageFooter = between(card, "function MessageFooter(", "function ResolvedCard(");
    expect(messageFooter).toContain('className="ui-split"');
    // every use of the split button in the file is inside the message footer
    expect(card.split("ui-split").length - 1).toBe(messageFooter.split("ui-split").length - 1);
  });

  it("the message footer is rendered only when the approval DECLARES an outbound message", () => {
    expect(card.split("<MessageFooter").length - 1).toBe(1);
    const branch = between(card, "outbound === null ? (", "<MessageFooter");
    // the branch before it is the normal footer: Recusar and Aprovar, no menu of any kind
    expect(branch).toContain('data-testid="approval-approve"');
    expect(branch).not.toContain("MenuButton");
    expect(branch).not.toContain("ui-split");
    // `outbound` comes from the approval's declaration, never from the tool's name or text
    expect(card).toContain("const outbound = approval.outbound;");
  });

  it("no card offers 'always allow', and there is no setting for it", () => {
    const sources = files(SRC, /\.tsx?$/).filter((f) => !f.endsWith("design-rules.test.ts"));
    for (const f of sources) {
      const text = read(f).toLowerCase();
      expect(text.includes("sempre permitir"), rel(f)).toBe(false);
      expect(text.includes("alwaysscope"), rel(f)).toBe(false);
      expect(text.includes("aprovar e permitir"), rel(f)).toBe(false);
    }
  });

  it("nothing in the app guesses a message from a tool's name", () => {
    for (const f of files(SRC, /\.tsx?$/).filter((x) => !x.endsWith("design-rules.test.ts"))) {
      const text = read(f).toLowerCase();
      expect(text.includes("smtp"), rel(f)).toBe(false);
      expect(text.includes("imap"), rel(f)).toBe(false);
    }
  });
});

describe("connectors: per-tool grants, the review of a definition, the network", () => {
  const settings = (name: string) => read(join(SRC, "features", "settings", name));

  it("a bot's access to a connector is a collapsed row (the shared ActionCard) with a count, never an on/off switch", () => {
    const grants = settings("ConnectorGrants.tsx");
    expect(grants).toContain('from "../../ui/action-card.js"');
    expect(grants).toContain("countLabel(");
    expect(grants).not.toContain("<Toggle");
    // `all` is sent only for "Selecionar todas": the body comes from the pure function.
    expect(grants).toContain("grantBody(draft, list)");
    expect(read(join(SRC, "features", "settings", "ConnectorsSettings.tsx"))).not.toContain(
      'tools: "all"',
    );
  });

  it("the comparison of two definitions marks differences without colour alone, and says the text is the server's", () => {
    const review = settings("ToolReview.tsx");
    expect(review).toContain('aria-hidden="true"');
    expect(review).toContain("Linha removida");
    expect(review).toContain("Linha nova");
    expect(review).toContain("Texto escrito pelo servidor");
    const css = read(join(SRC, "features", "features.css"));
    const word = css.slice(
      css.indexOf(".diff-word {"),
      css.indexOf("}", css.indexOf(".diff-word {")),
    );
    expect(word).toContain("font-weight");
    expect(word).toContain("text-decoration: underline");
    // Approving is one tool at a time: there is no "approve all".
    expect(review.toLowerCase()).not.toContain("aprovar tudo");
    expect(review.toLowerCase()).not.toContain("aprovar todas");
  });

  it("the network section judges nothing about a host: no pattern, only the server's refusal", () => {
    const form = read(join(SRC, "lib", "network.ts"));
    expect(form).not.toMatch(/\bnew RegExp\b|\.test\(|\.match\(/);
    expect(read(join(SRC, "features", "new-bot", "BotNetwork.tsx"))).toContain("hostInput(host)");
  });

  it("the network request is a normal decision card: the same DecisionCard, no split button for it", () => {
    const card = read(join(SRC, "ui", "approval-card.tsx"));
    expect(card).toContain("networkRequestOf(approval.tool, approval.args)");
    expect(card).toContain('from "./decision-card.js"');
  });
});

describe("the settings dialog: a modal with a left nav, groups of simple rows, nothing giant", () => {
  const settings = (name: string) => read(join(SRC, "features", "settings", name));
  const sections = [
    "GeneralSettings",
    "PermissionsSettings",
    "VaultSettings",
    "ConnectorsSettings",
  ];

  it("is a modal dialog with a nav on the left, closed by Escape and the X, with the focus trapped", () => {
    const dialog = settings("SettingsDialog.tsx");
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('role="tablist"');
    expect(dialog).toContain("useModalFocus(close)");
    expect(settings("parts.tsx")).toContain('aria-label="Fechar as configurações"');
    // It is a dialog over the screen, not a screen of its own.
    expect(read(join(SRC, "app", "ui-store.ts"))).not.toContain('"settings"');
    expect(read(join(SRC, "features", "shell", "Shell.tsx"))).toContain("<SettingsDialog />");
    // The focus helpers every dialog shares live in one place.
    const primitives = read(join(SRC, "ui", "primitives.tsx"));
    expect(primitives).toContain("export function useModalFocus");
    expect(primitives).toContain('e.key === "Escape"');
  });

  it("has exactly the sections the backend can fill, and no hollow ones", () => {
    const dialog = settings("SettingsDialog.tsx");
    for (const label of ["Geral", "Permissões", "Cofre", "Conectores"])
      expect(dialog, label).toContain(`label: "${label}"`);
    for (const hollow of ["Uso e cobrança", "Atualizações", "Computador", "Conta"])
      expect(dialog, hollow).not.toContain(`label: "${hollow}"`);
  });

  it("every section is built from the shared pieces: a group label, a card, rows with one control", () => {
    for (const name of sections) {
      const source = settings(`${name}.tsx`);
      expect(source, name).toContain('from "./parts.js"');
      expect(source, name).toContain("PaneHead");
      // No old full-width card or uppercase heading in a section.
      expect(source, name).not.toContain("<Card");
      expect(source, name).not.toContain('className="section-label"');
    }
    const css = read(join(SRC, "features", "settings", "settings.css"));
    for (const part of [".sdialog", ".snav", ".sgroup__label", ".scard", ".srow", ".sselect"])
      expect(css, part).toContain(`${part} {`);
    // Sizes come from tokens.
    const tokens = read(join(SRC, "styles", "tokens.css"));
    for (const token of ["--width-settings:", "--height-settings:", "--width-settings-nav:"])
      expect(tokens, token).toContain(token);
  });

  it("a setting with two values is a switch, one with more is a quiet menu: never a row of pills", () => {
    const general = settings("GeneralSettings.tsx");
    expect(general).toContain("<Toggle");
    expect(general).toContain("<SettingsSelect");
    expect(general).not.toContain('role="radiogroup"');
    expect(general).not.toContain('role="radio"');
  });

  it("Permissões is small: the approval mode, two rule rows with 'Adicionar regra', the connectors card", () => {
    const page = settings("PermissionsSettings.tsx");
    for (const text of [
      'title="Aprovações"',
      "Nunca permitir",
      "Permitir sem perguntar",
      "Adicionar regra",
      "Permissões dos conectores",
      "Abrir conectores",
    ])
      expect(page, text).toContain(text);
    // What left the first view: pending cards (they are in Pendências), the card behaviour (Geral).
    expect(page).not.toContain("pendingApprovals");
    expect(page).not.toContain("ApprovalRow");
    expect(page).not.toContain("BehaviourRow");
    // The mode is drawn as the backend has it: no menu while the server cannot switch it.
    expect(page).not.toContain("<SettingsSelect");
    expect(page).not.toContain("<select");
  });

  it("the rule dialog asks for the tool only; the rest is behind 'Mais opções'; the comparison is exact", () => {
    const dialog = settings("RuleDialog.tsx");
    expect(dialog).toContain('data-testid="rule-more"');
    expect(dialog.indexOf("{more && (")).toBeGreaterThan(dialog.indexOf('data-testid="rule-tool"'));
    expect(dialog.indexOf('data-testid="rule-bot"')).toBeGreaterThan(dialog.indexOf("{more && ("));
    expect(dialog.indexOf('data-testid="rule-condition"')).toBeGreaterThan(
      dialog.indexOf("{more && ("),
    );
    expect(dialog).toContain("é exatamente");
    expect(dialog.toLowerCase()).not.toContain("começa com");
    expect(dialog.toLowerCase()).not.toContain("contém");
  });

  it("Cofre has 'Novo item' in the head, a search by exact substring, and never draws a value", () => {
    const vault = settings("VaultSettings.tsx");
    expect(vault).toContain("Novo item");
    expect(vault).toContain('aria-label="Pesquisar no cofre"');
    expect(vault).toContain(".includes(needle)");
    expect(vault).not.toContain("RegExp");
  });

  it("Conectores shows the list first; a connector's details open on selecting it", () => {
    const connectors = settings("ConnectorsSettings.tsx");
    expect(connectors).toContain("function ConnectorRow");
    expect(connectors).toContain("function ConnectorDetail");
    expect(connectors).toContain("const [selected, setSelected]");
    // The list row has a switch and "Abrir"; the grants, network and tools are only in the detail.
    const list = connectors.slice(
      connectors.indexOf("function ConnectorRow"),
      connectors.indexOf("function ConnectorDetail"),
    );
    expect(list).not.toContain("<ConnectorGrants");
    expect(list).not.toContain("<ConnectorNetwork");
    expect(connectors).toContain('data-testid="connectors-back"');
  });

  it("a dialog opened from another is its own modal surface, on top", () => {
    const primitives = read(join(SRC, "ui", "primitives.tsx"));
    expect(primitives).toContain("createPortal(");
    expect(read(join(SRC, "lib", "focus.ts"))).toContain("topModal");
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
