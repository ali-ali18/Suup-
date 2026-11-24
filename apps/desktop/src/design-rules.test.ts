import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    for (const prefix of [
      "--color-",
      "--radius-",
      "--shadow-",
      "--font-sans",
      "--font-heading",
      "--font-mono",
    ]) {
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

  it("no shadcn name survives in a copied piece: its classes were rewritten to our theme (docs/DESIGN.md §2a)", () => {
    // The colours, radii, sizes and shadows of the shadcn styles. None exists in our theme, so a
    // class with one of them would silently draw nothing.
    const SHADCN_COLOURS = new Set([
      "popover",
      "popover-foreground",
      "foreground",
      "background",
      "accent",
      "accent-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "destructive",
      "input",
      "ring",
      "card",
      "card-foreground",
    ]);
    const SHADCN_SCALE = new Set([
      "rounded-sm",
      "rounded-md",
      "rounded-lg",
      "rounded-xl",
      "rounded-2xl",
      "rounded-3xl",
      "rounded-4xl",
      "text-xs",
      "text-sm",
      "text-base",
      "text-lg",
      "shadow-sm",
      "shadow-md",
      "shadow-lg",
      "shadow-xl",
      "shadow-2xl",
      "backdrop-blur",
      "backdrop-blur-sm",
    ]);
    const offenders: string[] = [];
    for (const file of components) {
      for (const word of words(read(file))) {
        let utility = word.slice(word.lastIndexOf(":") + 1);
        while (utility.startsWith("-") || utility.startsWith("!")) utility = utility.slice(1);
        if (SHADCN_SCALE.has(utility)) offenders.push(`${rel(file)}: ${word}`);
        const prefix = COLOUR_PREFIXES.find((p) => utility.startsWith(p));
        // `shadow-popover` is OUR shadow token: a shadow names a size here, never a colour
        if (prefix === undefined || prefix === "shadow-") continue;
        const name = utility.slice(prefix.length).split("/")[0] ?? "";
        if (SHADCN_COLOURS.has(name)) offenders.push(`${rel(file)}: ${word}`);
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

describe("a base dos componentes: cópias do shadcn base-maia sobre Base UI (docs/DESIGN.md §2a, dono 24/11/2026)", () => {
  const pkg = JSON.parse(read(join(SRC, "..", "package.json"))) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  it("só o Base UI entra como dependência: nada do shadcn em tempo de execução nem config do CLI", () => {
    expect(deps["@base-ui/react"]).toBeDefined();
    for (const name of [
      "shadcn",
      "cn",
      "class-variance-authority",
      "tailwind-merge",
      "clsx",
      "tw-animate-css",
      "@radix-ui/react-slot",
    ])
      expect(deps[name], name).toBeUndefined();
    expect(existsSync(join(SRC, "..", "components.json"))).toBe(false);
  });

  it("as fontes vêm embutidas (Outfit no texto, Geist nos títulos) e nunca do Google", () => {
    const app = read(join(SRC, "styles", "app.css"));
    expect(app).toContain('@import "@fontsource-variable/outfit"');
    expect(app).toContain('@import "@fontsource-variable/geist"');
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain('"Outfit Variable", ui-sans-serif');
    expect(tokens).toContain('"Geist Variable", ui-sans-serif');
    expect(read(join(SRC, "styles", "base.css"))).toContain("font-family: var(--font-heading);");
    const html = read(join(SRC, "..", "index.html"));
    for (const text of [html, app, tokens]) expect(text).not.toContain("fonts.googleapis");
  });

  it("lote 1: o interruptor, a dica e o popover são as cópias sobre o Base UI", () => {
    const sw = read(join(SRC, "ui", "switch.tsx"));
    expect(sw).toContain('from "@base-ui/react/switch"');
    expect(sw).toContain("nativeButton");
    expect(read(join(SRC, "ui", "primitives.tsx"))).toContain(
      'export { Toggle } from "./switch.js";',
    );
    expect(read(join(SRC, "ui", "tooltip.tsx"))).toContain('from "@base-ui/react/tooltip"');
    expect(read(join(SRC, "ui", "popover.tsx"))).toContain('from "@base-ui/react/popover"');
    // the round icon button shows its name as the app's tip, not the native title
    const primitives = read(join(SRC, "ui", "primitives.tsx"));
    const round = primitives.slice(primitives.indexOf("export function RoundButton"));
    const body = round.slice(0, round.indexOf("\n}\n"));
    expect(body).toContain("<Tip label={label}>");
    expect(body).not.toContain("title=");
    expect(read(join(SRC, "main.tsx"))).toContain("<TipProvider>");
  });

  it("lote 2: os menus e o dropdown são as cópias sobre o Base UI, e o menu da conta é um MenuButton", () => {
    const menu = read(join(SRC, "ui", "menu.tsx"));
    expect(menu).toContain('from "@base-ui/react/menu"');
    expect(menu).toContain("export function MenuButton");
    expect(menu).toContain("export function PopupMenu");
    expect(menu).toContain('data-testid="menu-icon"');
    expect(menu).toContain('data-testid="menu-label"');
    expect(existsSync(join(SRC, "ui", "popup-menu.tsx"))).toBe(false);
    // every popup draws the one surface of ui/popover.tsx
    for (const file of ["menu.tsx", "dropdown.tsx", "popover.tsx"])
      expect(read(join(SRC, "ui", file)), file).toContain("POPUP_SURFACE");
    const sidebar = read(join(SRC, "features", "shell", "Sidebar.tsx"));
    expect(sidebar).toContain('label="Sua conta"');
    expect(sidebar.indexOf("<MenuButton")).toBeLessThan(
      sidebar.indexOf('data-testid="owner-menu"'),
    );
    // each opening of a menu at a point is a new menu
    for (const file of [
      join("features", "shell", "Sidebar.tsx"),
      join("features", "chat", "ChatScreen.tsx"),
    ])
      expect(read(join(SRC, file)), file).toContain("key={menu.key}");
  });

  it("o menu do dono (24/11/2026): linhas de ícone e rótulo, grupos com Separator e Label, dica e submenu; nome curto do modelo", () => {
    const menu = read(join(SRC, "ui", "menu.tsx"));
    for (const part of [
      "<Menu.Separator",
      "<Menu.GroupLabel",
      "<Menu.SubmenuTrigger",
      "<ChevronRight",
      'data-testid="menu-hint"',
      "font-normal",
    ])
      expect(menu, part).toContain(part);
    expect(read(join(SRC, "ui", "separator.tsx"))).toContain('from "@base-ui/react/separator"');
    // no hand-made divider
    const hr = files(SRC, /\.tsx$/).filter((f) => read(f).includes("<hr"));
    expect(hr.map(rel)).toEqual([]);
    // the model is shown by the short name the server declares, never the id with the provider
    for (const file of [
      join("features", "panel", "ActivityTab.tsx"),
      join("features", "new-bot", "NewBotDialog.tsx"),
      join("features", "inspector", "InspectorScreen.tsx"),
    ]) {
      const source = read(join(SRC, file));
      expect(source, file).toContain("label: m.name");
      expect(source, file).not.toContain("m.provider}");
    }
    // the account menu: its groups, the pending count as a hint
    const sidebar = read(join(SRC, "features", "shell", "Sidebar.tsx"));
    expect(sidebar).toContain("const ownerItems: MenuSection[]");
    expect(sidebar).toContain("hint: String(pending)");
  });

  it("a raiz isola o empilhamento, para os popups no body ficarem por cima", () => {
    expect(read(join(SRC, "styles", "base.css"))).toContain("isolation: isolate;");
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

  it("the team card is one decision card on the shared chrome (title, light line, rows, two buttons), decided into one collapsed row", () => {
    const source = ui("team-card.tsx");
    expect(source).toContain('from "./decision-card.js"');
    expect(source).toContain('from "./action-card.js"');
    expect(source).not.toMatch(/className="ui-action[ "]/);
    // The footer: "Agora não" as plain text (quiet) and "Criar selecionados" as the pill (primary).
    expect(source).toContain('tone="quiet"');
    expect(source).toContain('tone="primary"');
    expect(source).toContain("Agora não");
    expect(source).toContain("Criar selecionados");
    // A tick per proposed bot, the mascot of the bot, and nothing created without a tick.
    expect(source).toContain("CheckInput");
    expect(source).toContain("<Avatar");
    expect(source).toContain("ticked.size === 0");
  });

  it("the chat shows results only: no tool row, no fold of actions, no steps (owner, 24/11/2026)", () => {
    // "Por mim nem precisa do panel atividade ou avisar os passos deles, quero o resultado com
    // excelência e nada mais!" The calls and the steps live in the Inspector.
    expect(existsSync(join(SRC, "features", "chat", "ActionRow.tsx"))).toBe(false);
    expect(existsSync(join(SRC, "data", "actions.ts"))).toBe(false);
    const timeline = read(join(SRC, "features", "chat", "timeline.ts"));
    expect(timeline).not.toContain('kind: "actions"');
    expect(timeline).not.toContain("mergeApprovals");
    const list = read(join(SRC, "features", "chat", "MessageList.tsx"));
    expect(list).not.toContain('case "actions"');
    expect(list).not.toContain("ActionFold");
    expect(list).not.toContain("CallRow");
    expect(read(join(SRC, "ui", "action-card.tsx"))).not.toContain("ActionFold");
    // No setting to fold what is no longer there.
    expect(read(join(SRC, "lib", "settings.ts"))).not.toContain("fold");
    // Nothing is "silent" any more: there is nothing to be loud about.
    for (const file of files(SRC, /\.tsx?$/))
      expect(read(file).includes("SILENT_TOOLS"), rel(file)).toBe(false);
  });

  it("one tool vocabulary: the decision card and the decided approval read the label and icon from toolCategory", () => {
    for (const name of ["approval-card.tsx"])
      expect(ui(name), name).toContain("categoryGlyph(category.icon)");
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

  it("dynamic bubbles: the outer radius is the bubble's own 24 px (apart from the card's), the linking one is a smaller token, and only bubbles carry the position", () => {
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain("--radius-bubble: 24px;");
    expect(tokens).toContain("--radius-card: 18px;");
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

  it("another conversation starts with nothing open", () => {
    expect(read(join(SRC, "features", "chat", "ChatScreen.tsx"))).toContain(
      "setExpanded(new Set());",
    );
  });

  it("a file the bot handed over is a card apart, under its message: the shared chrome, icon by the declared kind, no MIME, no path", () => {
    const card = read(join(SRC, "ui", "file-card.tsx"));
    expect(card).toContain("className={CARD_CHROME}");
    // The icon and the words come from the kind the server declared, by exact tables.
    expect(card).toContain("FILE_ICON[file.kind]");
    expect(card).toContain("FILE_KIND_LABEL[file.kind]");
    // Nothing technical: the MIME type is never drawn.
    expect(card).not.toContain("file.mime");
    // The app opens and saves; the browser only downloads (no "Abrir" without `open`).
    const rows = read(join(SRC, "features", "chat", "FileRows.tsx"));
    expect(rows).toContain("canOpen={platform.files.open !== undefined}");
    expect(read(join(SRC, "lib", "platform.ts"))).toContain(
      "files: { save: (file) => browserDownload(file) }",
    );
    // The chat draws the files in their own row, after the message, never inside the bubble.
    const list = read(join(SRC, "features", "chat", "MessageList.tsx"));
    expect(list).toContain('case "files":');
    expect(read(join(SRC, "features", "chat", "timeline.ts"))).toContain(
      'items.push({ kind: "files"',
    );
  });

  it("a question with options is ALWAYS a card apart whose visible title is the question; never shown twice; titles only", () => {
    const card = read(join(SRC, "ui", "question-card.tsx"));
    // HARD RULE (owner, 24/11/2026): the card's title is ALWAYS the question, visible, on every
    // page; nothing hides it.
    expect(card).toContain('data-testid="question-text"');
    expect(card).toContain("{q.question}");
    expect(card).not.toContain("sr-only");
    // The card draws the title of an option and never its description.
    expect(card).not.toContain(".description");
    // No hard ring on an option at load: the card takes the focus, the option's is a soft fill for the keyboard.
    expect(card).toContain("focusOnAppearance(ref.current)");
    expect(card).toContain("focus-visible:outline-none");
    expect(card).toContain("focus-visible:bg-hover");
    const list = read(join(SRC, "features", "chat", "MessageList.tsx"));
    const at = list.indexOf("isChoiceCard(item) && item.ask !== undefined");
    const branch = list.slice(at, list.indexOf("</Fragment>", at));
    // A bubble only with what the bot wrote BESIDES the question, as the server declares it
    // (`question.lead`): the app never compares texts to hide anything.
    expect(branch).toContain("item.ask.lead !== undefined &&");
    expect(branch).toContain("text={item.ask.lead}");
    expect(branch).not.toContain("text={item.text}");
    expect(branch.indexOf("text={item.ask.lead}")).toBeLessThan(branch.indexOf("<QuestionCard"));
    const timeline = read(join(SRC, "features", "chat", "timeline.ts"));
    expect(timeline).toContain("message.question.lead");
    expect(timeline).not.toContain("questionLead");
    // The same in Pendências.
    const pending = read(join(SRC, "features", "pending", "PendingScreen.tsx"));
    expect(pending).toContain("ask.question.lead !== undefined &&");
    // The X at the top right: close the card and answer in the chat (only an open card has it).
    expect(card).toContain('aria-label="Fechar e responder no chat"');
    expect(card).toContain("!readOnly && onDismiss !== undefined");
    // Under the card, OUTSIDE it: a plain muted line, not a button nor a link.
    const hint = list.slice(
      list.indexOf('data-testid="question-hint"') - 120,
      list.indexOf("Ou responda no chat abaixo") + 40,
    );
    expect(hint).toContain("<p");
    expect(hint).toContain("text-text-muted");
    expect(hint).not.toContain("onClick");
    expect(hint).not.toContain("<button");
    expect(hint).not.toContain("tabIndex");
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
      .map((f) => rel(f).split("\\").join("/"));
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
    // the modal of ui/dialog.tsx (Base UI: role="dialog", the focus trapped, Escape, the focus back)
    expect(dialog).toContain("<Modal");
    expect(dialog).toContain('role="tablist"');
    const parts = settings("parts.tsx");
    expect(parts).toContain('label="Fechar as configurações"');
    expect(parts).toContain("<DialogClose");
    // It is a dialog over the screen, not a screen of its own.
    expect(read(join(SRC, "app", "ui-store.ts"))).not.toContain('"settings"');
    expect(read(join(SRC, "features", "shell", "Shell.tsx"))).toContain("<SettingsDialog />");
    // Every modal is the one of ui/dialog.tsx: the base-maia copy on Base UI's Dialog, marked
    // aria-modal for the focus rule of lib/focus.ts; no hand-made scrim or focus trap is left.
    const modal = read(join(SRC, "ui", "dialog.tsx"));
    expect(modal).toContain('from "@base-ui/react/dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain("<DialogPrimitive.Backdrop");
    expect(modal).toContain("MODAL_MOTION");
    expect(read(join(SRC, "ui", "primitives.tsx"))).toContain(
      'export { Dialog } from "./dialog.js";',
    );
    for (const file of files(SRC, /\.tsx$/)) {
      const source = read(file);
      expect(source.includes("useModalFocus"), rel(file)).toBe(false);
      expect(source.includes("<Scrim"), rel(file)).toBe(false);
    }
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
    // The dropdown is the base-maia copy on Base UI: the ARIA listbox pattern (its role, keys and
    // focus are Base UI's, tested by behaviour in ui/dropdown.test.tsx), in a portal, and a long
    // list is a Combobox whose filter is a substring of the labels: no pattern matching.
    for (const part of [
      'from "@base-ui/react/select"',
      'from "@base-ui/react/combobox"',
      "<Select.Portal>",
      "<Combobox.Portal>",
      "<Combobox.Input",
      "aria-label={`Filtrar: ",
      ".toLowerCase().includes(text.trim().toLowerCase())",
      "DROPDOWN_FILTER_AFTER",
      "props.options.length > filterAfter",
      "alignItemWithTrigger={false}",
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
      'if (reason !== "escape" || tab !== "connectors" || connector === null) return true;',
    );
    expect(dialog).toContain("setConnector(null);");
    // The store: selecting a section (even the selected one) lands on its first view.
    const store = read(join(SRC, "app", "ui-store.ts"));
    expect(store).toContain(
      "setSettingsTab: (settingsTab) => set({ settingsTab, settingsConnector: null })",
    );
    // The pane title is the connector's name while its details are open.
    expect(settings("ConnectorsSettings.tsx")).toContain("<PaneHead title={connector.name}");
  });

  it("a dialog opened from another is its own modal surface, on top", () => {
    // each dialog has its own portal on the body (Base UI's), the last one on top
    expect(read(join(SRC, "ui", "dialog.tsx"))).toContain("<DialogPrimitive.Portal>");
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
      "lib/chat-activity.ts",
    ]);
  });
});

describe("o Principal é o supervisor: a estrela, a revisão e o silêncio sobre a memória (docs/DESIGN.md §5 e §3c)", () => {
  const avatar = read(join(SRC, "ui", "avatar.tsx"));

  it("a estrela é a única marca de um avatar além do rosto, desenhada só por ui/avatar.tsx, por tokens", () => {
    expect(avatar).toContain("supervisor");
    expect(avatar).toContain('data-testid="supervisor-star"');
    expect(avatar).toContain("size-star-badge");
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain("--size-star-badge:");
    expect(tokens).toContain("--size-star-badge-lg:");
    // nenhuma outra peça desenha uma estrela sobre um avatar (nem a do lucide)
    const drawers = files(SRC, /\.tsx$/)
      .filter(
        (f) =>
          read(f).includes("STAR_PATH") ||
          (/\bStar\b/.test(read(f)) && /from "lucide-react"/.test(read(f))),
      )
      .map(rel);
    expect(drawers).toEqual([join("ui", "avatar.tsx")]);
  });

  it("quem desenha o bot na barra lateral, no cabeçalho do chat, no painel e na paleta diz se é o principal pelo dado do bot", () => {
    for (const file of [
      join("features", "shell", "Sidebar.tsx"),
      join("features", "chat", "ChatScreen.tsx"),
      join("features", "panel", "Panel.tsx"),
      join("features", "palette", "CommandPalette.tsx"),
    ]) {
      expect(read(join(SRC, file)), file).toContain("supervisor={bot.isDefault}");
    }
  });

  it("Configurações > Memória tem o grupo Principal e o das revisões, com as peças de Geral e sem select nativo", () => {
    const page = read(join(SRC, "features", "settings", "SupervisorSettings.tsx"));
    expect(page).toContain('from "./parts.js"');
    expect(page).toContain('<SettingsGroup label="Principal"');
    expect(page).toContain('<SettingsGroup label="Revisões da equipe"');
    expect(page).toContain("<SettingsSelect");
    expect(page).toContain("<Toggle");
    expect(page).not.toContain("<select");
    expect(page).not.toContain("<input");
    expect(read(join(SRC, "features", "settings", "MemorySettings.tsx"))).toContain(
      "<SupervisorSettings />",
    );
  });

  it("salvar e esquecer uma memória não aparecem no chat como linha (decisão do dono): nenhuma ferramenta aparece", () => {
    const list = read(join(SRC, "features", "chat", "MessageList.tsx"));
    expect(list).not.toContain('case "actions"');
    // O avatar vivo diz no máximo "Usando a memória", uma frase fixa: nunca o que foi guardado.
    expect(read(join(SRC, "lib", "chat-activity.ts"))).toContain('memory: "Usando a memória"');
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

describe("routines: no schedule form, rows edge to edge, the detail in the panel, Editar in the chat", () => {
  const panel = read(join(SRC, "features", "panel", "ActivityTab.tsx"));
  const detail = read(join(SRC, "features", "panel", "RoutineDetail.tsx"));
  const chip = read(join(SRC, "ui", "source-chip.tsx"));
  const chat = read(join(SRC, "features", "chat", "ChatScreen.tsx"));
  const lib = read(join(SRC, "lib", "routines.ts"));

  it("the app has no form for WHEN: routines are created and changed by asking the bot", () => {
    expect(existsSync(join(SRC, "features", "panel", "RoutineDialogs.tsx"))).toBe(false);
    const sources = files(SRC, /\.tsx?$/);
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toContain("RoutineEditDialog");
      expect(text, file).not.toContain('testId="routine-kind"');
    }
    // the words come from the shared function, never written by the screen
    expect(panel).toContain("describeSchedule(routine.schedule)");
  });

  it("the cards of the panel have NO rule between their rows (owner, 22/11/2026); the rows open the detail, which replaces the list in the panel", () => {
    expect(panel).not.toContain("[&>*+*]:border-t");
    expect(panel).not.toContain("divide-");
    expect(panel).not.toContain("<MenuButton");
    expect(panel).toContain("openPanelRoutine(r.id)");
    expect(detail).toContain('label="Voltar às rotinas"');
    expect(detail).not.toContain("[&>*+*]:border-t");
  });

  it("the detail is built as the Grok Bot's (read with the REA, 23/11/2026): header, Instrução and Quando executar, one row of actions at the foot", () => {
    expect(detail).toContain("<Markdown");
    expect(detail).toContain("routine.instruction");
    expect(detail).toContain('settings.favicons === "on"');
    expect(detail).toContain('className="flex-1"');
    for (const word of [
      "Instrução",
      "Quando executar",
      "Pausar",
      "Retomar",
      "Editar",
      "Excluir rotina",
      "describeSchedule",
    ]) {
      expect(detail, word).toContain(word);
    }
    for (const gone of ["<SourceChip", "routines.fires", "routines.run", "Testar", "nextText"]) {
      expect(detail, gone).not.toContain(gone);
    }
    expect(chip).toContain("faviconUrl(safe)");
    expect(chip).toContain("categoryGlyph(fallback");
  });

  it("Editar is a draft in the chat with the routine as data; Remover asks first", () => {
    expect(lib).toContain("export function editDraft");
    expect(lib.slice(lib.indexOf("export function editDraft"))).not.toContain("routine.id");
    expect(chat).toContain("routineRef: { id: ref.id }");
    expect(detail).toContain("<Dialog");
    expect(detail).toContain('title="Remover a rotina?"');
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

describe("avatares: dois estilos, desenhados só pelo motor (docs/DESIGN.md, Mascotes)", () => {
  it("o mascote pixel só é montado por `ui/avatar.tsx` e pelo seletor do bot", () => {
    const users = files(SRC, /\.tsx$/)
      .filter((f) => !f.endsWith("pixel-mascot.tsx") && read(f).includes("<PixelMascot"))
      .map(rel)
      .sort();
    expect(users).toEqual(["features/new-bot/NewBotDialog.tsx", "ui/avatar.tsx"]);
  });

  it("o 3D é um botão ao lado do estilo, só no pixel, fora do radiogroup, e a prévia o mostra", () => {
    const code = read(join(SRC, "features", "new-bot", "NewBotDialog.tsx"));
    expect(code).toContain('data-testid="newbot-pixel3d"');
    expect(code).toContain('{style === "pixel" && (');
    expect(code).toContain("avatarPixel3d: style === ");
    expect(code).toContain("pixel3d={pixel3d}");
    for (const f of [
      "shell/Sidebar",
      "chat/ChatScreen",
      "panel/Panel",
      "pending/PendingScreen",
      "palette/CommandPalette",
    ])
      expect(read(join(SRC, "features", `${f}.tsx`)), f).toContain("pixel3d={bot.avatarPixel3d}");
  });

  it("o pixel é desenhado em escala inteira, sem suavização, e movido pelo relógio compartilhado", () => {
    const code = read(join(SRC, "ui", "pixel-mascot.tsx"));
    expect(code).toContain("layoutPixels(");
    expect(code).toContain("devicePixelRatio");
    expect(code).toContain('imageRendering: "pixelated"');
    expect(code).toContain("getPixelClock()");
    // nenhum laço próprio: nem rAF nem timer por avatar
    expect(code).not.toContain("requestAnimationFrame");
    expect(code).not.toContain("setInterval");
  });

  it("o estilo vem do bot (`avatarStyle`) em toda tela que desenha o avatar de um bot", () => {
    for (const file of [
      "features/shell/Sidebar.tsx",
      "features/chat/ChatScreen.tsx",
      "features/panel/Panel.tsx",
      "features/palette/CommandPalette.tsx",
      "features/pending/PendingScreen.tsx",
    ])
      expect(read(join(SRC, file)), file).toContain("avatarStyle={bot.avatarStyle}");
  });
});

describe("o texto não rola para o lado e nenhuma barra de rolagem aparece (docs/DESIGN.md, Rolagem)", () => {
  it("o base.css esconde as barras de rolagem de tudo (a roda, o toque e o teclado continuam rolando)", () => {
    const base = read(join(SRC, "styles", "base.css"));
    expect(base).toContain("scrollbar-width: none;");
    expect(base).toContain("::-webkit-scrollbar");
  });

  it("o Markdown quebra o texto e o bloco de código, e não rola para o lado", () => {
    const markdown = read(join(SRC, "lib", "markdown.tsx"));
    expect(markdown).toContain("wrap-anywhere");
    expect(markdown).not.toContain("overflow-auto");
    expect(markdown).toContain("overflow-x-hidden");
  });

  it("a pílula do bot mostra só o nome (a descrição fica na barra lateral e no painel)", () => {
    const chat = read(join(SRC, "features", "chat", "ChatScreen.tsx"));
    expect(chat).toContain("{bot.name}</span>");
    expect(chat).not.toContain("<BotTitle");
  });
});

describe("a janela não tem barra do sistema: os controles são do app (docs/DESIGN.md, Janela)", () => {
  const TAURI = join(SRC, "..", "src-tauri");

  it("o Windows e o Linux abrem sem barra, o macOS mantém a nativa, e as permissões da janela estão liberadas", () => {
    const conf = JSON.parse(read(join(TAURI, "tauri.conf.json")));
    expect(conf.app.windows[0].decorations).toBe(false);
    const macos = JSON.parse(read(join(TAURI, "tauri.macos.conf.json")));
    expect(macos.app.windows[0].decorations).toBe(true);
    const capabilities = read(join(TAURI, "capabilities", "default.json"));
    for (const permission of [
      "core:window:allow-minimize",
      "core:window:allow-toggle-maximize",
      "core:window:allow-close",
      "core:window:allow-start-dragging",
    ])
      expect(capabilities).toContain(permission);
  });

  it("os controles só existem quando o Tauri diz que a janela não tem barra, e o fechar do painel os deixa livres", () => {
    const app = read(join(SRC, "app", "App.tsx"));
    expect(app).toContain("customFrame && platform?.frame !== undefined");
    const panel = read(join(SRC, "features", "panel", "Panel.tsx"));
    // the close sits on the strip of the window buttons, just left of them (docs/DESIGN.md §4c)
    expect(panel).toContain("framed:right-window-controls");
    expect(panel).toContain('tone="outline"');
    expect(read(join(SRC, "styles", "theme.css"))).toContain(
      '@custom-variant framed (:root[data-frame="custom"] &);',
    );
    expect(app).toContain('root.dataset.frame = "custom"');
    // every screen head keeps the corner of the window buttons free
    expect(read(join(SRC, "ui", "screen.tsx"))).toContain("framed:pr-head-end");
    const controls = read(join(SRC, "ui", "window-controls.tsx"));
    for (const label of ["Minimizar", "Fechar a janela"]) expect(controls).toContain(label);
  });
});

describe("conectores: o ícone do serviço (docs/DESIGN.md 5c, plug-ins)", () => {
  const brand = read(join(SRC, "ui", "brand-icons.tsx"));

  it("só ui/brand-icons.tsx importa o simple-icons, na versão fixa, e só ícones pelo nome", () => {
    const users = files(SRC, /\.tsx?$/)
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => read(f).includes('from "simple-icons"'))
      .map((f) => rel(f).split("\\").join("/"));
    expect(users).toEqual(["ui/brand-icons.tsx"]);
    expect(brand).not.toContain("import * as");
    expect(brand).not.toContain("import simple");
    const pkg = JSON.parse(read(join(SRC, "..", "package.json"))) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["simple-icons"]).toBe("16.38.1");
  });

  it("o glifo é de uma cor só, a do texto apagado da linha; a escolha é por nome exato, numa tabela", () => {
    expect(brand).toContain('"currentColor"');
    expect(brand).toContain("new Map<string, Glyph>");
    expect(brand).toContain("BY_NAME.get(connectorName)");
    for (const searching of [".includes(", ".startsWith(", ".match(", ".test(", "RegExp"]) {
      expect(brand, searching).not.toContain(searching);
    }
  });

  it("a linha do conector usa o glifo da marca ou o plug, e a pesquisa está escrita", () => {
    const row = read(join(SRC, "features", "settings", "ConnectorsSettings.tsx"));
    expect(row).toContain("icon={brandGlyphFor(connector.name) ?? Plug}");
    const root = join(SRC, "..", "..", "..");
    expect(existsSync(join(root, "docs", "pesquisas", "icones-de-marca-dos-conectores.md"))).toBe(
      true,
    );
    expect(read(join(root, "docs", "DESIGN.md"))).toContain("## 5c. Conectores");
  });
});

describe("conectores: a tela da vitrine (docs/DESIGN.md 5d)", () => {
  const screen = read(join(SRC, "features", "plugins", "ConnectorsScreen.tsx"));
  const palette = read(join(SRC, "features", "palette", "CommandPalette.tsx"));
  const shell = read(join(SRC, "features", "shell", "Shell.tsx"));

  it("é uma tela no lugar do chat e do painel, não um diálogo (dono, 23/11/2026), e o detalhe é uma página da mesma tela", () => {
    expect(existsSync(join(SRC, "features", "plugins", "PluginsDialog.tsx"))).toBe(false);
    // the only dialog of the screen is the confirmation of Desconectar (and the secure form)
    expect(screen.split("<Dialog").length - 1).toBe(1);
    expect(screen).toContain("Seus bots deixam de usar o {name} até você entrar de novo.");
    expect(screen).toContain("<Screen");
    expect(screen).toContain("<ScreenHead");
    expect(shell).toContain("<ConnectorsScreen />");
    expect(shell).toContain('view === "connectors"');
    expect(screen).toContain("function ConnectorPage");
    expect(screen).toContain('aria-label="Caminho"');
  });

  it("título, busca, seções com contagem, duas colunas, o logo ao lado do nome com a linha apagada embaixo, + Conectar em cada linha", () => {
    // the search is an input group with the magnifier INSIDE it, and its width is limited (owner: "limita o tamanho do input")
    expect(screen).toContain("<SearchField");
    // the search and the blocks of the page take the colour of the chat input (bg-raised), not a bordered surface
    expect(read(join(SRC, "ui", "primitives.tsx"))).toContain(
      "fieldControlClass({ search: true, raised: true })",
    );
    expect(screen).not.toContain("border border-border bg-surface");
    expect(screen).toContain('className="max-w-search"');
    expect(read(join(SRC, "ui", "primitives.tsx"))).toContain("export function SearchField");
    expect(screen).toContain("grid-cols-2");
    expect(screen).toContain("narrow:grid-cols-1");
    expect(screen).toContain("Conector personalizado");
    expect(screen).toContain("text-small text-text-muted");
    // the logo: thesvg, as an <img>, on the project's grey, white ones inverted in the light theme
    expect(screen).toContain("<img");
    expect(screen).toContain("data-logo={id}");
    // the band of a page: one of twelve gradients, a class for each (owner: "cadê o bg do gradiente que falamos?")
    for (const name of [
      "ink",
      "slate",
      "navy",
      "plum",
      "paper",
      "sky",
      "mint",
      "sun",
      "coral",
      "amber",
      "indigo",
      "lilac",
    ]) {
      expect(screen, name).toContain(`from-banner-${name}-from to-banner-${name}-to`);
    }
    expect(screen).toContain("BANNER_BG[look.banner]");
    // neutral backgrounds only (owner, 23/11/2026): the project's grey, or the black or the white a brand's own icon has
    expect(screen).toContain("bg-raised");
    expect(screen).toContain("bg-tile-black");
    expect(screen).toContain("bg-tile-white");
    for (const colour of ["bg-tile-sky", "bg-tile-mint", "bg-tile-sun"]) {
      expect(screen, colour).not.toContain(colour);
    }
    expect(screen).not.toContain("invert");
    expect(screen).not.toContain("bg-brand-tile");
    expect(screen).not.toContain("bg-logo-tile");
    // a one-colour brand: its OWN colour (from the package) as the tile, the mark in white over it
    expect(screen).toContain("solidMarkFor(id)");
    expect(screen).toContain("backgroundColor:");
    expect(screen).toContain("solid.hex");
    expect(screen).toContain("text-tile-white");
    // the body takes the whole width, like the head with its buttons at the right edge: no empty strip
    expect(screen).not.toContain("limit=");
    // no box around a line (owner: "cada um ser um card pesa muito")
    expect(screen).not.toContain("rounded-card border border-border bg-transparent");
  });

  it("a página: o caminho, o estado, a ação de verdade, os exemplos, Conexão e Bom saber; nada técnico (dono, 23/11/2026)", () => {
    for (const word of [
      'aria-label="Caminho"',
      "<StateTag state={state} />",
      "<MainAction",
      "Exemplos do que você poderá pedir",
      "Conexão",
      "Bom saber",
    ]) {
      expect(screen, word).toContain(word);
    }
    // "Informações" with the address, the licence, the hosts, the date and the login jargon is gone
    for (const technical of [
      "Informações",
      "Categoria",
      "Disponibilidade",
      '"Fonte"',
      "Licença",
      "Fala com",
      "Conferido em",
      "entry.source",
      "entry.license",
      "entry.egressHosts",
      "entry.checkedAt",
      "item.detail",
      "<MonoText",
      "A confirmar",
    ]) {
      expect(screen, technical).not.toContain(technical);
    }
    expect(screen).toContain('unverified: "Em breve"');
    // "Meus conectores" is real now: a button with the logos of what is connected, stacked
    expect(screen).toContain("flex-row-reverse");
    expect(screen).toContain('e.item.status === "connected"');
    expect(screen).not.toContain("opacity-60");
    expect(screen).not.toContain('title="Em breve"');
  });

  it('liga ao servidor (dono, 23/11/2026: "Liga"): a lista é a do servidor, a aparência é só por id', () => {
    // which connectors exist, in the server's order
    expect(screen).toContain("api.connectorCatalog.list()");
    expect(existsSync(join(SRC, "features", "plugins", "catalog.ts"))).toBe(false);
    const look = read(join(SRC, "features", "plugins", "appearance.ts"));
    // the look is found by the EXACT id, never by a search in the text (docs/REGRAS.md §1)
    expect(look).toContain("BY_ID.get(id) ?? NEUTRAL");
    for (const searching of [".includes(", ".startsWith(", ".match(", ".test(", "RegExp"]) {
      expect(look, searching).not.toContain(searching);
    }
    // the look does not repeat what the server says (name, line, how it logs in)
    for (const field of ["  name:", "  about:", "  developer:", "  site:"]) {
      expect(look, field).not.toContain(field);
    }
    expect(screen).toContain("appearanceOf(item.entry.id)");
    const flow = read(join(SRC, "features", "plugins", "use-connect.ts"));
    // the flows: install and follow next; OAuth in the system browser with polling
    for (const call of [
      "api.connectorCatalog.install(",
      "api.connectors.oauthStart(",
      "platform.openUrl(start.authorizationUrl)",
      "api.connectors.oauthStatus(",
      "api.connectors.oauthDisconnect(",
    ]) {
      expect(flow, call).toContain(call);
    }
    // never an address to paste (owner, 23/11/2026: "Mas por que raios eu colaria um link?"): the
    // browser comes back to the server (its loopback, or its public address); a VPS without one
    // does not offer the login
    expect(flow).not.toContain("oauthComplete");
    expect(screen).not.toContain("connector-paste");
    expect(screen).not.toContain("<TextField");
    expect(screen).toContain("api.info()");
    expect(screen).toContain('mode === "local" || callback === "public"');
    // the token goes through the secure form of the vault, never a plain field of the screen
    expect(screen).toContain("<SecretDialog");
    expect(screen).not.toContain("<SecretInput");
    expect(screen).not.toContain('type="password"');
  });

  it("abre pela paleta de ações e pelo menu do dono", () => {
    expect(palette).toContain('go("connectors")');
    expect(read(join(SRC, "features", "shell", "Sidebar.tsx"))).toContain('go("connectors")');
  });
});

describe('amigável: nada de log para o usuário (dono, 23/11/2026: "a ideia é ser friendly")', () => {
  const sources = files(SRC, /\.tsx?$/).filter(
    (f) =>
      !f.endsWith("design-rules.test.ts") &&
      // the one place that turns an error into words, and the diagnostic screen
      !f.endsWith(join("lib", "friendly-error.ts")) &&
      // the transport of the shell: its text becomes a network ApiError, whose kind is what is shown
      !f.endsWith(join("lib", "tauri.ts")) &&
      !f.includes(join("features", "inspector")),
  );

  it("nenhuma tela lê o texto cru de um erro: a frase vem do tipo declarado (friendlyError/formError)", () => {
    for (const f of sources) {
      const text = read(f);
      for (const raw of [
        "instanceof Error ?",
        " e.message",
        "(e.message",
        "error.message",
        "err.message",
        "String(e)",
      ]) {
        expect(text.includes(raw), `${rel(f)}: ${raw}`).toBe(false);
      }
    }
    const friendly = read(join(SRC, "lib", "friendly-error.ts"));
    // by the kind the API declares, compared exactly: never by the text
    expect(friendly).toContain("BY_CODE[error.code]");
    expect(friendly).toContain('"Algo deu errado. Tenta de novo?"');
    for (const searching of [".includes(", ".startsWith(", ".match(", ".test(", "RegExp"]) {
      expect(friendly, searching).not.toContain(searching);
    }
    expect(read(join(SRC, "data", "sync.ts"))).toContain("export const messageOf = friendlyError;");
  });

  it("a página de um conector não mostra endereço, licença, hosts, data, detalhe cru nem o nome do segredo", () => {
    const screen = read(join(SRC, "features", "plugins", "ConnectorsScreen.tsx"));
    for (const technical of [
      "entry.source",
      "entry.license",
      "entry.egressHosts",
      "entry.checkedAt",
      "item.detail",
      "status.error",
    ]) {
      expect(screen, technical).not.toContain(technical);
    }
    // the secure form never shows the name the token is kept under
    const vault = read(join(SRC, "features", "settings", "VaultSettings.tsx"));
    expect(vault).not.toContain("{preset.name}");
    expect(vault).not.toContain("vault.keyEnv");
    expect(vault).not.toContain("{vault.reason}");
  });

  it("nunca há campo para colar o endereço de retorno de um login (dono: “por que raios eu colaria um link?”)", () => {
    for (const f of sources) {
      const text = read(f);
      for (const paste of ["oauthComplete", "callbackUrl", "connector-paste"]) {
        expect(text.includes(paste), `${rel(f)}: ${paste}`).toBe(false);
      }
    }
  });

  it("as telas antes do app e o Servidor não mostram caminho de arquivo nem nome de variável", () => {
    const local = read(join(SRC, "features", "connect", "LocalScreen.tsx"));
    expect(local).not.toContain("{status.logsDir}");
    expect(local).not.toContain("{status.message");
    expect(local).toContain("Abrir a pasta de registros");
    const server = read(join(SRC, "features", "settings", "ServerGroup.tsx"));
    expect(server).not.toContain("description={status.logsDir}");
    expect(server).not.toContain("description={connection.serverUrl}");
    for (const f of [
      join(SRC, "features", "connect", "ConnectScreen.tsx"),
      join(SRC, "app", "connect.ts"),
    ]) {
      for (const name of ["SUUP_", "allowedOrigins", "tokenEnv"]) {
        expect(read(f).includes(name), `${rel(f)}: ${name}`).toBe(false);
      }
    }
  });

  it("o chat não mostra o nome interno de uma ferramenta de conector nem o detalhe cru de uma falha", () => {
    // The live avatar's phrase is one of a fixed table: never a tool's name, a command or a path.
    const activity = read(join(SRC, "lib", "chat-activity.ts"));
    expect(activity).toContain("ACTIVITY_PHRASE[activity]");
    expect(activity).not.toContain("${tool");
    const list = read(join(SRC, "features", "chat", "MessageList.tsx"));
    expect(list).not.toContain("failureDetail");
    expect(list).toContain("FRIENDLY_FAILURE[");
    // the motives a server sends without a kind stay out of the screens: a fixed sentence
    for (const [file, raw] of [
      [join(SRC, "features", "settings", "PermissionsSettings.tsx"), "reviewer.reason"],
      [join(SRC, "features", "settings", "MemorySettings.tsx"), "reviewer.reason"],
      [join(SRC, "features", "settings", "SupervisorSettings.tsx"), "model.reason"],
      [join(SRC, "features", "settings", "GeneralSettings.tsx"), "{m.unavailableReason}"],
    ] as const) {
      expect(read(file).includes(raw), `${rel(file)}: ${raw}`).toBe(false);
    }
  });
});

describe("nada seco: nada aparece, some ou corta de repente (docs/DESIGN.md §1, dono 23/11/2026)", () => {
  const components = files(SRC, /\.tsx$/);
  /** Every quoted class list of a file (the text between double quotes that has a space). */
  const classLists = (text: string): string[] =>
    text
      .split('"')
      .filter((_, i) => i % 2 === 1)
      .filter((chunk) => chunk.includes(" ") || chunk.includes(":"));

  it("as áreas que rolam têm degradê nas bordas", () => {
    expect(read(join(SRC, "ui", "screen.tsx"))).toContain("<ScrollFade />");
    expect(read(join(SRC, "features", "chat", "MessageList.tsx"))).toContain("<ScrollFade");
    expect(read(join(SRC, "features", "chat", "MessageList.tsx"))).toContain(
      "bg-linear-to-b from-bg",
    );
    const sidebar = read(join(SRC, "features", "shell", "Sidebar.tsx"));
    expect(sidebar.split('<ScrollFade tone="sidebar" />').length - 1).toBe(2);
  });

  it("nada surge no hover com hidden/block, e o que muda de opacidade no hover tem transição", () => {
    const offenders: string[] = [];
    for (const file of components) {
      const lists = classLists(read(file));
      // a variant map (a tone) carries the hover; the piece's base class carries the transition
      const baseFades = lists.some(
        (l) =>
          l.includes("transition-all") || (l.includes("transition-[") && l.includes("opacity")),
      );
      for (const [index, list] of lists.entries()) {
        const words = list.split(" ");
        // the same piece's classes are often split in a few strings of one cx(...) (base + tone)
        const near = lists
          .slice(Math.max(0, index - 3), index + 4)
          .join(" ")
          .split(" ");
        const showsOnHover = words.some(
          (w) =>
            (w.includes("hover") || w.includes("focus")) &&
            (w.endsWith(":block") || w.endsWith(":flex") || w.endsWith(":inline-flex")),
        );
        const fadesOnHover = words.some(
          (w) => (w.includes("hover") || w.includes("focus")) && w.includes(":opacity-"),
        );
        if (showsOnHover) offenders.push(`${rel(file)}: ${list}`);
        if (fadesOnHover && !baseFades && !near.some((w) => w.includes("transition")))
          offenders.push(`${rel(file)}: ${list}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("o que aparece entra esmaecendo e a barra lateral anima a largura (sem transição no arrasto)", () => {
    expect(read(join(SRC, "styles", "theme.css"))).toContain("@keyframes ui-fade-in");
    expect(read(join(SRC, "features", "shell", "Sidebar.tsx"))).toContain(
      "transition-[width] duration-(--duration-base)",
    );
    expect(read(join(SRC, "styles", "base.css"))).toContain("transition: none !important;");
  });
});

describe("ajustes do dono de 23/11/2026 (docs/DESIGN.md §2, §4a, §4c, §5, §6)", () => {
  const sidebar = read(join(SRC, "features", "shell", "Sidebar.tsx"));

  it("telas cheias: coluna centralizada de largura máxima, e o cabeçalho guarda o canto dos botões da janela", () => {
    const screen = read(join(SRC, "ui", "screen.tsx"));
    expect(screen).toContain("max-w-screen-max");
    expect(screen).toContain("mx-auto");
    expect(screen).toContain("framed:pr-head-end");
    expect(read(join(SRC, "styles", "tokens.css"))).toContain("--width-screen-max:");
    // a página de um conector usa o mesmo cabeçalho; nenhuma tela desenha <header> próprio
    const connectors = read(join(SRC, "features", "plugins", "ConnectorsScreen.tsx"));
    expect(connectors).toContain("<ScreenHeader>");
    expect(connectors).not.toContain("<header");
  });

  it("barra lateral: sem bot marcado sem escolha, só o nome no trilho, 'Sem interação', nada selecionável", () => {
    expect(sidebar).toContain('view === "chat" && picked ? selected : null');
    // the name of the rail is the app's tip (ui/tooltip.tsx), with only the bot's name in it
    expect(sidebar).toContain('<Tip label={bot.name} side="right" delay={0} testId="rail-tip">');
    expect(sidebar).toContain('"Sem interação"');
    expect(sidebar).not.toContain("Sem mensagens");
    expect(sidebar).toContain("select-none");
    // o rodapé tem só a conta; o menu dela tem ícones
    expect(sidebar).not.toContain("Buscar e ações");
    for (const icon of ["Inbox", "Brain", "Plug", "Settings", "Keyboard", "LogOut"])
      expect(sidebar).toContain(`icon: ${icon}`);
  });

  it("a pílula do chat flutua num degradê e o chevron entra animado", () => {
    const chat = read(join(SRC, "features", "chat", "ChatScreen.tsx"));
    expect(chat).toContain("head={");
    expect(chat).toContain("group-hover/chip:opacity-100");
    expect(chat).not.toContain("hidden flex-none group-hover");
  });

  it("criar bot: branco por padrão e contorno discreto do escolhido", () => {
    const dialog = read(join(SRC, "features", "new-bot", "NewBotDialog.tsx"));
    expect(dialog).toContain('DEFAULT_NEW_COLOR: BotColor = "branco"');
    expect(dialog).not.toContain("ring-text");
    // the mascot grid: no box behind the chosen one or on hover, wide cells (6 columns)
    expect(dialog).toContain("grid grid-cols-6");
    expect(dialog).not.toContain('? "bg-raised" : "bg-transparent hover:bg-hover"');
    expect(dialog).toContain("hover:scale-105");
    expect(read(join(SRC, "styles", "tokens.css"))).toContain("var(--color-picked-ring)");
  });

  it("a estrela do Principal é o marcador laranja do desenho do dono, com o rosto recortado em volta", () => {
    const avatar = read(join(SRC, "ui", "avatar.tsx"));
    const tokens = read(join(SRC, "styles", "tokens.css"));
    for (const token of [
      "--color-star-badge: #ff9800",
      "--color-star-glyph: #fcfcfc",
      "--color-status-working: #22c55e",
      "--color-status-unread: #2496e8",
    ])
      expect(tokens).toContain(token);
    expect(avatar).toContain("bg-star-badge text-star-glyph");
    expect(avatar).toContain("maskImage: notch");
    // the corner: working > unread > the star, and the sidebar feeds the first two
    expect(avatar).toContain('if (s.working === true) return "working";');
    const sidebar = read(join(SRC, "features", "shell", "Sidebar.tsx"));
    expect(sidebar).toContain("working={working}");
    expect(sidebar).toContain("unread={unread > 0}");
    expect(avatar).not.toContain("border-2 border-bg");
  });
});

describe("o avatar vivo no chat (docs/DESIGN.md §3, dono 24/11/2026)", () => {
  it("o bot trabalhando é o avatar dele, não os três pontinhos", () => {
    const lines = read(join(SRC, "ui", "chat-lines.tsx"));
    expect(lines).not.toContain("dots-dot");
    expect(lines).not.toContain("animate-dot");
    expect(read(join(SRC, "styles", "theme.css"))).not.toContain("ui-dot");
    // A linha leva o rosto que a conversa entrega e é anunciada com calma (role="status").
    expect(lines).toContain('{ role: "status" }');
    expect(read(join(SRC, "features", "chat", "MessageList.tsx"))).toContain(
      "liveFace(ACTIVITY_AVATAR[live.shown.activity])",
    );
  });

  it("o rosto é o do bot: o estilo, o 3D e a cor dele, pelo ui/avatar.tsx, vivo", () => {
    const chat = read(join(SRC, "features", "chat", "ChatScreen.tsx"));
    const face = chat.slice(chat.indexOf("liveFace={"));
    const tag = face.slice(0, face.indexOf("/>"));
    for (const prop of [
      "avatarStyle={bot.avatarStyle}",
      "pixel3d={bot.avatarPixel3d}",
      "color={bot.color}",
      "state={state}",
      "lively",
    ])
      expect(tag).toContain(prop);
  });

  it("a expressão vem de uma tabela exata por atividade declarada, nunca do texto", () => {
    const activity = read(join(SRC, "lib", "chat-activity.ts"));
    expect(activity).toContain("ACTIVITY_AVATAR: Readonly<Record<ChatActivity, AvatarStateId>>");
    expect(activity).toContain("toolCategory(tool).icon");
    expect(activity).not.toContain("RegExp");
  });

  it("sai com transição, sem pulo, e o movimento reduzido zera a saída", () => {
    const tokens = read(join(SRC, "styles", "tokens.css"));
    expect(tokens).toContain("--duration-leave:");
    expect(tokens.split("--duration-leave: 0ms;").length - 1).toBe(2);
    const lines = read(join(SRC, "ui", "chat-lines.tsx"));
    expect(lines).toContain("grid-rows-[0fr]");
    expect(lines).toContain("duration-(--duration-leave)");
  });
});

describe("atualização do app: um aviso calmo e uma linha em Geral (docs/DESIGN.md 3e)", () => {
  const notice = read(join(SRC, "features", "shell", "UpdateNotice.tsx"));
  const row = read(join(SRC, "features", "settings", "UpdateGroup.tsx"));
  const store = read(join(SRC, "app", "update-store.ts"));

  it("o aviso é um cartão no canto, nunca um diálogo, com 'Depois' e uma ação primária", () => {
    expect(notice).toContain('role="status"');
    expect(notice).not.toContain("<Dialog");
    expect(notice).not.toContain("aria-modal");
    expect(notice).toContain("Nova versão do Suup disponível");
    expect(notice).toContain("Depois");
    for (const action of ["Atualizar agora", "Reiniciar para concluir", "Tentar de novo"])
      expect(notice, action).toContain(action);
    expect(notice).toContain('tone="primary"');
    expect(notice).toContain('role="progressbar"');
    expect(read(join(SRC, "features", "shell", "Shell.tsx"))).toContain("<UpdateNotice />");
  });

  it("a linha de Geral usa as peças de Configurações e um só controle (RowAction)", () => {
    expect(row).toContain('from "./parts.js"');
    expect(row).toContain("<SettingsRow");
    expect(row).toContain("<RowAction");
    expect(row).not.toContain("<Pill");
    expect(row).toContain("Procurar atualização");
    expect(read(join(SRC, "features", "settings", "GeneralSettings.tsx"))).toContain(
      "<UpdateGroup />",
    );
  });

  it("nada técnico: nem GitHub, nem latest.json, nem assinatura; o erro só vai para o registro", () => {
    for (const [name, source] of [
      ["UpdateNotice.tsx", notice],
      ["UpdateGroup.tsx", row],
    ] as const) {
      for (const technical of ["github", "latest.json", "assinatura", "pubkey", ".message"]) {
        expect(source.toLowerCase().includes(technical), `${name}: ${technical}`).toBe(false);
      }
    }
    // the store logs the detail and keeps only which step failed
    expect(store).toContain("console.warn(");
    expect(store).toContain('failure: "download"');
    expect(store).toContain('failure: "install"');
  });

  it("o servidor embutido para antes do instalador, e a chave de marcador desliga tudo", () => {
    const rust = read(join(SRC, "..", "src-tauri", "src", "update.rs"));
    expect(rust).toContain("local::stop(&local, local::GRACEFUL_STOP).await;");
    expect(rust.indexOf("local::stop(")).toBeLessThan(rust.indexOf("update.install(&bytes)"));
    expect(rust).toContain("key != PLACEHOLDER_PUBKEY");
    const conf = JSON.parse(read(join(SRC, "..", "src-tauri", "tauri.conf.json"))) as {
      plugins: { updater: { pubkey: string } };
    };
    // The owner's public key is in place (23/11/2026): not the marker, so the updater is on.
    expect(conf.plugins.updater.pubkey).not.toBe("SUBSTITUA-PELA-CHAVE-PUBLICA-DO-SUUP");
    expect(conf.plugins.updater.pubkey.length).toBeGreaterThan(40);
    expect(rust).toContain('"SUBSTITUA-PELA-CHAVE-PUBLICA-DO-SUUP"');
  });
});
