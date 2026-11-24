// The document the Markdown becomes: a small tree of declared kinds that the PDF and Word builders
// both walk. Nothing here is guessed from text: every kind comes from a node the parser declared.

/** A run of text with the marks the Markdown gave it. `link` is set only for http, https, mailto. */
export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export type Align = "left" | "right" | "center" | null;

export type Block =
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "pagebreak" }
  | { kind: "figure"; path: string; alt: string; source: string | undefined };

/** The plain text of some inlines. */
export function plain(inlines: readonly Inline[]): string {
  return inlines.map((i) => i.text).join("");
}

/** Every block of the tree, depth first (list items and quotes included). */
export function* walk(blocks: readonly Block[]): Generator<Block> {
  for (const block of blocks) {
    yield block;
    if (block.kind === "list") for (const item of block.items) yield* walk(item);
    if (block.kind === "quote") yield* walk(block.blocks);
  }
}
