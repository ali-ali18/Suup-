// Reads the Markdown the bot wrote with a real parser (CommonMark + GFM tables, by
// mdast-util-from-markdown) and turns the tree into `Block`s. Only nodes the parser declared are
// looked at (`node.type`); no pattern is used to decide what a piece of text is (docs/REGRAS.md).

import { PAGE_BREAK_MARK } from "@suup/core";
import type { Content, PhrasingContent, Root, Table, TableCell } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Align, Block, Inline } from "./model.js";
import { plain, walk } from "./model.js";

/** The URL schemes a link may have; the `URL` class tells the scheme, we compare it exactly. */
const LINK_PROTOCOLS: readonly string[] = ["http:", "https:", "mailto:"];

/** Texts that, alone in a block or a cell, are a placeholder left in (exact, case-folded). */
const PLACEHOLDERS: readonly string[] = [
  "todo",
  "tbd",
  "tba",
  "xxx",
  "...",
  "…",
  "[...]",
  "[…]",
  "placeholder",
  "[placeholder]",
  "lorem ipsum",
  "texto aqui",
  "a definir",
];

export interface ParsedMarkdown {
  blocks: Block[];
  /** Problems the bot must fix (English). */
  problems: string[];
  /** Things Suup changed on its own (English). */
  notes: string[];
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const notes: string[] = [];
  const blocks = convertBlocks(tree.children, notes);
  // A page break at the very end would leave an empty page.
  while (blocks.length > 0 && blocks[blocks.length - 1]?.kind === "pagebreak") blocks.pop();
  const problems = checkBlocks(blocks);
  return { blocks, problems, notes: [...new Set(notes)] };
}

/** The images the blocks show (their workspace paths), in order, without repeats. */
export function imagePathsOf(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of walk(blocks)) if (b.kind === "figure" && !out.includes(b.path)) out.push(b.path);
  return out;
}

function convertBlocks(nodes: readonly Content[], notes: string[]): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        out.push({
          kind: "heading",
          depth: node.depth,
          inlines: convertInlines(node.children, notes, {}),
        });
        break;
      case "paragraph": {
        const only = node.children.length === 1 ? node.children[0] : undefined;
        if (only?.type === "image") {
          out.push({
            kind: "figure",
            path: only.url,
            alt: only.alt ?? "",
            source: only.title ?? undefined,
          });
        } else {
          out.push({ kind: "paragraph", inlines: convertInlines(node.children, notes, {}) });
        }
        break;
      }
      case "list":
        out.push({
          kind: "list",
          ordered: node.ordered === true,
          start: node.start ?? 1,
          items: node.children.map((item) => convertBlocks(item.children, notes)),
        });
        break;
      case "table":
        out.push(convertTable(node, notes));
        break;
      case "blockquote":
        out.push({ kind: "quote", blocks: convertBlocks(node.children, notes) });
        break;
      case "code":
        out.push({ kind: "code", text: node.value });
        break;
      case "thematicBreak":
        out.push({ kind: "rule" });
        break;
      case "html":
        if (node.value.trim() === PAGE_BREAK_MARK) {
          out.push({ kind: "pagebreak" });
        } else {
          // Raw HTML is never interpreted: it is shown as the text it is.
          out.push({ kind: "paragraph", inlines: [{ text: node.value }] });
          notes.push("Raw HTML in the content is shown as plain text, not interpreted.");
        }
        break;
      default:
        // Definitions, footnotes and other nodes that have no page form: their text, if any.
        if ("children" in node) {
          const text = collectText(node);
          if (text !== "") out.push({ kind: "paragraph", inlines: [{ text }] });
        }
    }
  }
  return out;
}

function convertTable(node: Table, notes: string[]): Block {
  const [head, ...rows] = node.children;
  const cells = (row: { children: TableCell[] } | undefined): Inline[][] =>
    (row?.children ?? []).map((cell) => convertInlines(cell.children, notes, {}));
  return {
    kind: "table",
    align: (node.align ?? []).map((a): Align => a ?? null),
    head: cells(head),
    rows: rows.map((row) => cells(row)),
  };
}

interface Marks {
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

function convertInlines(
  nodes: readonly PhrasingContent[],
  notes: string[],
  marks: Marks,
): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out.push({ text: node.value, ...marks });
        break;
      case "strong":
        out.push(...convertInlines(node.children, notes, { ...marks, bold: true }));
        break;
      case "emphasis":
        out.push(...convertInlines(node.children, notes, { ...marks, italic: true }));
        break;
      case "delete":
        out.push(...convertInlines(node.children, notes, marks));
        break;
      case "inlineCode":
        out.push({ text: node.value, code: true, ...marks });
        break;
      case "break":
        out.push({ text: "\n", ...marks });
        break;
      case "link": {
        const url = linkTarget(node.url);
        if (url === undefined) {
          notes.push(
            "A link whose address is not http, https or mailto was written as plain text.",
          );
          out.push(...convertInlines(node.children, notes, marks));
        } else {
          out.push(...convertInlines(node.children, notes, { ...marks, link: url }));
        }
        break;
      }
      case "image":
        // An image in the middle of a text is its description (nothing is fetched).
        out.push({ text: node.alt ?? "", ...marks });
        notes.push(
          "An image must be alone in its paragraph to be shown; inside a text only its description is kept.",
        );
        break;
      case "html":
        out.push({ text: node.value, ...marks });
        break;
      default:
        out.push({ text: collectText(node), ...marks });
    }
  }
  return out;
}

function linkTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return LINK_PROTOCOLS.includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function collectText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  return (n.children ?? []).map(collectText).join("");
}

function isPlaceholder(text: string): boolean {
  return PLACEHOLDERS.includes(text.trim().toLowerCase());
}

/** The checks on the structure: empty or placeholder pieces are the bot's to fix. */
function checkBlocks(blocks: readonly Block[]): string[] {
  const problems: string[] = [];
  const bad = (what: string, text: string): void => {
    problems.push(`${what} ${JSON.stringify(text.slice(0, 60))}`);
  };
  if (blocks.length === 0) problems.push("The content is empty.");
  for (const block of walk(blocks)) {
    switch (block.kind) {
      case "heading": {
        const text = plain(block.inlines);
        if (text.trim() === "") problems.push("A heading is empty: give it a title or remove it.");
        else if (isPlaceholder(text)) bad("A heading is a placeholder:", text);
        break;
      }
      case "paragraph": {
        const text = plain(block.inlines);
        if (text.trim() === "") problems.push("A paragraph is empty: remove it.");
        else if (isPlaceholder(text)) bad("A paragraph is a placeholder:", text);
        else if (text.trim().toLowerCase().startsWith("lorem ipsum"))
          bad("Filler text left in:", text);
        break;
      }
      case "list":
        for (const item of block.items) {
          if (item.length === 0) problems.push("A list item is empty: remove it.");
        }
        break;
      case "table": {
        if (block.head.every((c) => plain(c).trim() === "")) {
          problems.push("A table has an empty header row: name every column.");
        }
        for (const cell of [...block.head, ...block.rows.flat()]) {
          if (isPlaceholder(plain(cell))) bad("A table cell is a placeholder:", plain(cell));
        }
        break;
      }
      case "code":
        if (block.text.trim() === "") problems.push("A code block is empty: remove it.");
        break;
      case "figure":
        if (block.path.trim() === "") problems.push("An image has no path.");
        if (block.alt.trim() === "") {
          problems.push(
            `The image ${JSON.stringify(block.path)} has no description: write it in the brackets, ![description](path).`,
          );
        }
        break;
      default:
    }
  }
  return problems;
}
