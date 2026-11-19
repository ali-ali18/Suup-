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

  it("no literal radius or font size in a stylesheet but tokens.css (new ones go there)", () => {
    const LITERAL = /(?:font-size|border-radius):\s*[1-9]\d*px/;
    const count = css.reduce(
      (n, f) =>
        n +
        read(f)
          .split("\n")
          .filter((line) => LITERAL.test(line)).length,
      0,
    );
    expect(count).toBe(0);
  });
});

describe("Tailwind: classes name tokens, never a colour, a palette or a pixel", () => {
  const components = files(SRC, /\.tsx$/).filter((f) => !f.endsWith("design-rules.test.ts"));
  const tokens = read(join(SRC, "styles", "tokens.css"));
  const theme = read(join(SRC, "styles", "theme.css"));

  /** The class-like words of a source file: what sits between quotes, spaces and braces. */
  const words = (source: string): string[] => {
    const separators = new Set([
      " ",
      "\n",
      "\t",
      '"',
      "'",
      "`",
      "{",
      "}",
      "(",
      ")",
      ",",
      ";",
      "<",
      ">",
    ]);
    const out: string[] = [];
    let current = "";
    for (const ch of source) {
      if (separators.has(ch)) {
        if (current !== "") out.push(current);
        current = "";
      } else current += ch;
    }
    if (current !== "") out.push(current);
    return out;
  };
  /** The variable names a stylesheet defines with a prefix (`--color-`), read line by line. */
  const defined = (css: string, prefix: string): string[] =>
    css
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith(prefix) &&
          line.includes(":") &&
          !line.slice(0, line.indexOf(":")).includes("*"),
      )
      .map((line) => line.slice(0, line.indexOf(":")));

  // The one arbitrary value with a pixel size that is allowed: the 1.5 px ring of a selected option
  // (Tailwind's `border-<n>` takes whole pixels only). Anything else with a size goes in tokens.css.
  const PIXEL_ALLOWLIST: ReadonlySet<string> = new Set(["border-[1.5px]"]);
  // Tailwind's default palette. It is removed (`--color-*: initial`), so a class with one of these
  // names would simply not exist: the test says so before the screen does.
  const PALETTE = [
    "slate",
    "gray",
    "zinc",
    "neutral",
    "stone",
    "red",
    "orange",
    "amber",
    "yellow",
    "lime",
    "green",
    "emerald",
    "teal",
    "cyan",
    "sky",
    "blue",
    "indigo",
    "violet",
    "purple",
    "fuchsia",
    "pink",
    "rose",
  ];
  const COLOUR_PREFIXES = [
    "bg-",
    "text-",
    "border-",
    "outline-",
    "ring-",
    "fill-",
    "stroke-",
    "from-",
    "via-",
    "to-",
    "divide-",
    "decoration-",
    "shadow-",
    "accent-",
    "caret-",
  ];

  it("the theme maps every token of tokens.css, exactly, and empties the default scales", () => {
    for (const reset of ["--color-*", "--radius-*", "--text-*", "--shadow-*", "--font-*"])
      expect(theme, reset).toContain(`${reset}: initial;`);
    for (const prefix of ["--color-", "--radius-", "--shadow-", "--font-sans", "--font-mono"]) {
      for (const name of defined(tokens, prefix)) {
        // A token is exposed by name, pointing at itself: `--color-bg: var(--color-bg);`.
        expect(theme, name).toContain(`${name}: var(${name});`);
      }
    }
    // ...and the theme names no colour or radius that tokens.css does not have (the bot's colour,
    // which the chat sets from the bot, is the one source outside tokens.css).
    const known = new Set(defined(tokens, "--"));
    for (const prefix of ["--color-", "--radius-"]) {
      for (const name of defined(theme, prefix)) {
        if (name.startsWith("--color-bot-")) continue;
        expect(known.has(name), `${name} is not a token`).toBe(true);
      }
    }
  });

  it("no arbitrary colour in a class, and no arbitrary pixel value outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of components) {
      for (const word of words(read(file))) {
        if (!word.includes("[")) continue;
        const inside = word.slice(word.indexOf("["));
        if (inside.startsWith("[#") || inside.includes("rgb(") || inside.includes("hsl("))
          offenders.push(`${rel(file)}: ${word}`);
        else if (inside.includes("px") && !PIXEL_ALLOWLIST.has(word))
          offenders.push(`${rel(file)}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no class names a colour of the default palette (it does not exist here)", () => {
    const offenders: string[] = [];
    for (const file of components) {
      for (const word of words(read(file))) {
        // the utility is what follows the last variant colon
        let utility = word.slice(word.lastIndexOf(":") + 1);
        while (utility.startsWith("-") || utility.startsWith("!")) utility = utility.slice(1);
        const prefix = COLOUR_PREFIXES.find((p) => utility.startsWith(p));
        if (prefix === undefined) continue;
        const name = utility.slice(prefix.length).split("/")[0] ?? "";
        const isPalette = PALETTE.some((c) => name === c || name.startsWith(`${c}-`));
        if (isPalette || name === "white" || name === "black")
          offenders.push(`${rel(file)}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** The class names written as `className="..."` in a source file (a plain string, no template). */
  const classNames = (source: string): string[] => {
    const out: string[] = [];
    const marker = 'className="';
    let from = source.indexOf(marker);
    while (from !== -1) {
      const start = from + marker.length;
      const end = source.indexOf('"', start);
      if (end === -1) break;
      for (const name of source.slice(start, end).split(" ")) if (name !== "") out.push(name);
      from = source.indexOf(marker, end);
    }
    return out;
  };

  it("there is one stylesheet, Tailwind's: no legacy CSS file, Preflight on, a base that only adds", () => {
    const sheets = files(SRC, /\.css$/)
      .map(rel)
      .sort();
    expect(sheets).toEqual(
      ["styles/app.css", "styles/base.css", "styles/theme.css", "styles/tokens.css"].sort(),
    );
    const app = read(join(SRC, "styles", "app.css"));
    expect(app).toContain('@import "tailwindcss/preflight.css" layer(base);');
    expect(app).toContain("@layer theme, base, components, utilities;");
    expect(app).not.toContain("legacy");
    // base.css is not a second set of classes: it names no class of its own.
    const base = read(join(SRC, "styles", "base.css"));
    for (const old of [".muted", ".small", ".mono", ".wrap", ".section-label", ".form", ".sr-only"])
      expect(base.includes(old), old).toBe(false);
  });

  it("a screen does not use the old global helpers or the old per-screen class names", () => {
    const helpers = new Set([
      "muted",
      "small",
      "mono",
      "wrap",
      "section-label",
      "form",
      "form__row",
    ]);
    const prefixes = [
      "bot-entry",
      "bot-badge",
      "bot-chip",
      "sidebar__",
      "chat__",
      "panel__",
      "screen__",
      "memory__",
      "pending__",
      "inspector__",
      "newbot",
      "palette__",
      "botnet",
      "shortcuts",
      "group-dialog",
      "connect__",
      "shell__",
      "ui-code__",
    ];
    const offenders: string[] = [];
    for (const file of components) {
      for (const name of classNames(read(file))) {
        if (helpers.has(name) || prefixes.some((p) => name.startsWith(p)))
          offenders.push(`${rel(file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
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
    // The action card and the decision card share one constant; the question card writes the same.
    expect(ui("decision-card.tsx")).toContain(
      'CARD_CHROME = "ui-action min-w-0 rounded-card border border-border bg-surface"',
    );
    expect(ui("action-card.tsx")).toContain("CARD_CHROME");
    expect(ui("question-card.tsx")).toContain("rounded-card border border-border bg-surface");
    // The bot bubble has the border of a card and the radius of a bubble (itself a card radius).
    const message = ui("message.tsx");
    expect(message).toContain('"max-w-full self-start border border-border bg-surface"');
    expect(message).toContain("rounded-bubble");
  });

  it("dynamic bubbles: the outer radius is the card's, the linking one is a smaller token, and only bubbles carry the position", () => {
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain("--radius-bubble: var(--radius-card);");
    expect(tokens).toContain("--radius-bubble-link:");
    expect(tokens).toContain("--bubble-gap-group:");
    // The position is set by the two text bubbles and by nothing else: cards keep their chrome.
    const message = read(join(SRC, "ui", "message.tsx"));
    // Linking corners use the link token; no bubble class uses a literal or the card radius for them.
    expect(message).toContain("rounded-bl-bubble-link");
    expect(message).toContain("rounded-tr-bubble-link");
    expect(message.split("data-bubble={position}").length - 1).toBe(2);
    for (const name of ["decision-card.tsx", "action-card.tsx", "question-card.tsx"])
      expect(read(join(SRC, "ui", name)), name).not.toContain("data-bubble");
    // The radius of a bubble is never animated: a new message must not move anything.
    expect(message).not.toContain("transition");
  });

  it("the expand affordance is the stacked chevrons, never a single chevron", () => {
    const src = read(join(SRC, "ui", "action-card.tsx"));
    expect(src).toContain("ChevronsUpDown");
    expect(src).toContain("ChevronsDownUp");
    expect(src).not.toMatch(/\bChevron(Down|Up)\b/);
  });

  it("the expand chevron is hidden at rest and shown on hover and on keyboard focus", () => {
    const src = read(join(SRC, "ui", "action-card.tsx"));
    const chevron = src.slice(src.indexOf("const CHEVRON ="), src.indexOf("const CHEVRON =") + 220);
    expect(chevron).toContain("opacity-0");
    expect(chevron).toContain("group-hover:opacity-100");
    expect(chevron).toContain("group-focus-visible:opacity-100");
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
      .filter((f) => read(f).includes("split-button"))
      .map(rel);
    expect(offenders).toEqual(["ui/approval-card.tsx"]);
    const messageFooter = between(card, "function MessageFooter(", "function ResolvedCard(");
    expect(messageFooter).toContain('data-testid="split-button"');
    // every use of the split button in the file is inside the message footer
    expect(card.split("split-button").length - 1).toBe(
      messageFooter.split("split-button").length - 1,
    );
  });

  it("the message footer is rendered only when the approval DECLARES an outbound message", () => {
    expect(card.split("<MessageFooter").length - 1).toBe(1);
    const branch = between(card, "outbound === null ? (", "<MessageFooter");
    // the branch before it is the normal footer: Recusar and Aprovar, no menu of any kind
    expect(branch).toContain('data-testid="approval-approve"');
    expect(branch).not.toContain("MenuButton");
    expect(branch).not.toContain("split-button");
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

  it("a bot's access to a connector is a collapsed row (a SettingsRow) with a count, never an on/off switch", () => {
    const grants = settings("ConnectorGrants.tsx");
    expect(grants).toContain("<SettingsRow");
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
    // The changed words are bold and underlined.
    expect(review).toContain('data-testid="diff-word"');
    expect(review).toContain('className="font-bold underline"');
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
    expect(dialog).toContain("useModalFocus(");
    expect(settings("parts.tsx")).toContain('label="Fechar as configurações"');
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
    for (const label of ["Geral", "Permissões", "Memória", "Cofre", "Conectores"])
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
    const parts = settings("parts.tsx");
    for (const part of ["SettingsGroup", "SettingsCard", "SettingsRow", "RowShell", "PaneHead"])
      expect(parts, part).toContain(`export function ${part}(`);
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

  it("never a native select: every choice is the dropdown of ui/dropdown.tsx", () => {
    const dropdown = read(join(SRC, "ui", "dropdown.tsx"));
    // The dropdown is the ARIA listbox pattern, with the keys of the menu and no pattern matching.
    for (const part of [
      'aria-haspopup="listbox"',
      'role="listbox"',
      'role="option"',
      "aria-selected",
      "preventScroll",
      'e.key === "Escape"',
      'e.key === "ArrowDown"',
      'e.key === "Home"',
      'e.key === "End"',
      'e.key === "Enter"',
      "createPortal(",
      ".includes(needle)",
      "DROPDOWN_FILTER_AFTER",
    ])
      expect(dropdown, part).toContain(part);
    expect(dropdown).not.toContain("RegExp");
    // No native select element anywhere in the app, with no exception.
    const offenders = files(SRC, /\.tsx$/).filter((f) => read(f).includes("<select"));
    expect(offenders.map(rel)).toEqual([]);
    // The quiet row control of Geral is that same dropdown.
    expect(settings("parts.tsx")).toContain("<Dropdown");
    expect(dropdown).toContain("const TRIGGER =");
  });

  it("every section is made of the pieces of Geral, and a row action has one style", () => {
    const parts = settings("parts.tsx");
    expect(parts).toContain("export function RowAction");
    const all = [...sections, "ConnectorGrants", "ConnectorNetwork"];
    for (const name of all) {
      const source = settings(`${name}.tsx`);
      expect(source, name).toContain('from "./parts.js"');
      // No pill of the row styled by hand, no bare text button: RowAction is the only row button.
      expect(source, name).not.toContain("spill--ghost");
      expect(source, name).not.toContain('tone="ghost"');
      expect(source, name).not.toContain("link-button");
      expect(source, name).not.toContain("<ActionCard");
    }
    for (const name of [
      "PermissionsSettings",
      "VaultSettings",
      "ConnectorsSettings",
      "ConnectorGrants",
      "ConnectorNetwork",
    ])
      expect(settings(`${name}.tsx`), name).toContain("<SettingsGroup");
    // The rule groups are a labelled card whose first row has the title and "Adicionar regra".
    const permissions = settings("PermissionsSettings.tsx");
    expect(permissions).toContain("label={KIND_TEXT[kind].title}");
    expect(permissions).toContain("precedenceHint(settings)");
    expect(permissions).not.toContain('className="srow"');
  });

  it("Memória: Geral's pieces, a numeric field from ui/, a dropdown for the validity, no native select", () => {
    const page = settings("MemorySettings.tsx");
    expect(page).toContain('from "./parts.js"');
    expect(page).toContain("<SettingsGroup");
    expect(page).toContain("<SettingsRow");
    expect(page).toContain("<RowAction");
    expect(page).toContain("<SettingsSelect");
    expect(page).toContain("<NumberField");
    expect(page).toContain('from "../../ui/number-field.js"');
    expect(page).not.toContain("<select");
    expect(page).not.toContain("<input");
    expect(page).not.toContain("<Card");
    for (const group of ["Consolidação", "Contexto", "Validade"])
      expect(page, group).toContain(`label="${group}"`);
    // The field is one reusable piece: quiet, right-aligned, no native spinner, no `type="number"`.
    const field = read(join(SRC, "ui", "number-field.tsx"));
    expect(field).toContain("text-right");
    expect(field).not.toContain('type="number"');
    expect(field).not.toContain("<select");
    // Nothing else draws a bare input for a number in the settings.
    for (const name of files(join(SRC, "features", "settings"), /\.tsx$/))
      expect(read(name), rel(name)).not.toContain('type="number"');
  });

  it("memories are never asked about in the chat: no memory card, and the history is the only undo", () => {
    expect(files(join(SRC, "ui"), /\.tsx$/).map(rel)).not.toContain(join("ui", "memory-card.tsx"));
    const history = read(join(SRC, "features", "memory", "MemoryHistoryDialog.tsx"));
    expect(history).toContain("Desfazer");
    expect(read(join(SRC, "features", "chat", "MessageList.tsx"))).not.toContain("memory");
  });

  it("separators run the card's full width, and a row has one optional leading icon slot", () => {
    const parts = settings("parts.tsx");
    // The line between rows is drawn out to the card's edges (it reaches back over the card's padding).
    expect(parts).toContain("[--scard-pad:var(--space-4)]");
    expect(parts).toContain("inset-x-[calc(-1*var(--scard-pad))]");
    expect(parts).not.toContain("[&>*+*]:border-t ");
    // One icon slot, in `SettingsRow` (and a group's label): a lucide icon at the nav's size, muted.
    expect(parts).toContain("icon?: LucideIcon");
    expect(parts).toContain('className="inline-flex flex-none text-text-muted"');
    expect(parts).toContain("<Icon size={16}");
    expect(settings("SettingsDialog.tsx")).toContain("size={16}");
    // Geral's rows all carry one.
    const general = settings("GeneralSettings.tsx");
    expect(general).toContain("icon={row.icon}");
    const server = settings("ServerGroup.tsx");
    expect(server).toContain("icon={Server}");
    expect(server).toContain("icon={Key}");
  });

  it("Permissões: the mode, three groups of rules you write, the connectors card; no native select", () => {
    const page = settings("PermissionsSettings.tsx");
    for (const text of [
      'label="Aprovações"',
      '"Auto-review"',
      '"Perguntar tudo"',
      "Adicionar regra",
      "Regras exatas (avançado)",
      "Permissões dos conectores",
      "Abrir conectores",
      "<SettingsSelect",
    ])
      expect(page, text).toContain(text);
    // The groups are in the owner's order: Nunca permitir, Sempre perguntar, Permitir sem perguntar.
    const dialog = settings("WrittenRuleDialog.tsx");
    const never = dialog.indexOf('title: "Nunca permitir"');
    const ask = dialog.indexOf('title: "Sempre perguntar"');
    const allow = dialog.indexOf('title: "Permitir sem perguntar"');
    expect(never).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(never);
    expect(allow).toBeGreaterThan(ask);
    const groups = page.indexOf("const GROUPS");
    expect(page.indexOf('kind: "never"', groups)).toBeLessThan(page.indexOf('kind: "ask"', groups));
    expect(page.indexOf('kind: "ask"', groups)).toBeLessThan(page.indexOf('kind: "allow"', groups));
    // The reviewer's truth is told, not hidden; the mode rolls back when the server refuses it.
    expect(page).toContain("reviewer-unavailable");
    expect(page).toContain("setSettings(before)");
    // What left the first view: pending cards (they are in Pendências), the card behaviour (Geral).
    expect(page).not.toContain("pendingApprovals");
    expect(page).not.toContain("ApprovalRow");
    expect(page).not.toContain("BehaviourRow");
    expect(page).not.toContain("<select");
  });

  it("'Adicionar regra' is a written rule: one text area, one dropdown, nothing to hunt for in a menu", () => {
    const dialog = settings("WrittenRuleDialog.tsx");
    expect(dialog).toContain("<textarea");
    expect(dialog).toContain("Aplica-se a");
    expect(dialog).toContain("Diga qual é a ação e quem ou o que ela afeta.");
    expect(dialog).toContain("Para qual bot");
    expect(dialog).toContain("Todos os bots");
    expect(dialog).toContain("<Dropdown");
    expect(dialog).not.toContain("<select");
    // The counter is only near the limit; the text is never parsed here.
    expect(dialog).toContain("COUNTER_FROM");
    expect(dialog).not.toContain("RegExp");
    // The old dialog (a tool menu, exact conditions) is gone.
    expect(files(join(SRC, "features", "settings"), /\.tsx$/).map(rel)).not.toContain(
      join("features", "settings", "RuleDialog.tsx"),
    );
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
    expect(connectors).toContain("useUi((s) => s.settingsConnector)");
    // The list row has a switch and "Abrir"; the grants, network and tools are only in the detail.
    const list = connectors.slice(
      connectors.indexOf("function ConnectorRow"),
      connectors.indexOf("function ConnectorDetail"),
    );
    expect(list).not.toContain("<ConnectorGrants");
    expect(list).not.toContain("<ConnectorNetwork");
  });

  it("there is no back button inside the Settings dialog: the nav item and Esc return to the list", () => {
    for (const name of [...sections, "ConnectorGrants", "ConnectorNetwork", "ToolReview"]) {
      const source = settings(`${name}.tsx`);
      expect(source, name).not.toContain("connectors-back");
      expect(source, name).not.toContain("ChevronLeft");
      expect(source, name).not.toContain('className="sback"');
    }
    const dialog = settings("SettingsDialog.tsx");
    // Esc inside a connector goes back to the list first; the second one closes the dialog.
    expect(dialog).toContain(
      'tab === "connectors" && connector !== null ? setConnector(null) : close()',
    );
    // The store: selecting a section (even the selected one) lands on its first view.
    const store = read(join(SRC, "app", "ui-store.ts"));
    expect(store).toContain(
      "setSettingsTab: (settingsTab) => set({ settingsTab, settingsConnector: null })",
    );
    // The pane title is the connector's name while its details are open.
    expect(settings("ConnectorsSettings.tsx")).toContain("<PaneHead title={connector.name}");
  });

  it("a dialog opened from another is its own modal surface, on top", () => {
    const primitives = read(join(SRC, "ui", "primitives.tsx"));
    expect(primitives).toContain("createPortal(");
    expect(read(join(SRC, "lib", "focus.ts"))).toContain("topModal");
  });
});

describe("o retorno interno do bot não tem marcador próprio na interface (docs/DESIGN.md, Princípios)", () => {
  it("a chamada de `schedule_return` não vira cartão, e nenhuma tela do chat desenha o estado de espera", () => {
    expect(read(join(SRC, "data", "derive.ts"))).toContain('"schedule_return"');
    // O estado `waiting_timer` só é lido onde decide o que NÃO se desenha (avatar calmo, chip vazio, a
    // execução ainda é a ativa para poder ser cancelada) e no inspetor, que é diagnóstico.
    const readers = files(SRC, /\.tsx?$/)
      .filter((f) => read(f).includes("waiting_timer"))
      .map(rel)
      .sort();
    expect(readers).toEqual([
      "data/derive.ts",
      "features/chat/ChatScreen.tsx",
      "features/inspector/InspectorScreen.tsx",
      "lib/avatar-state.ts",
    ]);
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

describe("telas antes do app (docs/DESIGN.md 3d)", () => {
  const screen = (name: string): string => read(join(SRC, "features", "connect", name));

  it("todas usam o cartão calmo de ui/welcome.tsx, sem lista de classes própria", () => {
    for (const name of ["ConnectScreen.tsx", "FirstRunScreen.tsx", "LocalScreen.tsx"]) {
      const source = screen(name);
      expect(source, name).toContain("WelcomeCard");
      expect(source, name).not.toContain("className=");
      expect(source, name).not.toContain("<select");
    }
  });

  it("a primeira abertura tem as duas escolhas e a chave é um campo secreto", () => {
    const first = screen("FirstRunScreen.tsx");
    expect(first).toContain("Usar neste computador");
    expect(first).toContain("Conectar à minha VPS");
    expect(first.split("<ChoiceCard").length - 1).toBe(2);
    expect(screen("LocalScreen.tsx")).toContain("<SecretInput");
  });
});
