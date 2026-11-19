import type {
  Connector,
  ConnectorToolEvent,
  ConnectorToolReview,
  PinnedDefinition,
} from "@suup/api";

// The review of a tool whose definition changed (or that is new): the notice on the connector, the
// "before / now" comparison of two definitions, and the words of the history. Pure. The text of a
// definition is written by the connector's server: it is shown as a quote, never as the app's own.

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The calm sentence on a connector that has tools waiting for a review, or `null` when none is.
 * "2 ferramentas mudaram e estão desligadas até você revisar".
 */
export function reviewNotice(
  connector: Pick<Connector, "tools" | "pendingReviews">,
): string | null {
  const tools = connector.tools ?? [];
  const changed = tools.filter((t) => t.pin === "changed").length;
  const fresh = tools.filter((t) => t.pin === "new").length;
  if (connector.pendingReviews <= 0 && changed + fresh === 0) return null;
  if (changed + fresh !== connector.pendingReviews) {
    const n = connector.pendingReviews;
    return `${n} ${plural(n, "ferramenta espera", "ferramentas esperam")} a sua revisão e ${plural(n, "está desligada", "estão desligadas")} até lá`;
  }
  const parts: string[] = [];
  if (changed > 0) {
    parts.push(
      `${changed} ${plural(changed, "ferramenta mudou e está desligada", "ferramentas mudaram e estão desligadas")} até você revisar`,
    );
  }
  if (fresh > 0) {
    parts.push(
      `${fresh} ${plural(fresh, "ferramenta nova está desligada", "ferramentas novas estão desligadas")} até você revisar`,
    );
  }
  return parts.join(". ");
}

// ------------------------------------------------------------------ comparison

/** One cell of the comparison: the text, and what it is next to the other side. */
export interface Cell {
  text: string;
  mark: "same" | "removed" | "added";
  /** For a line that changed in place: its words, with the ones that differ marked. */
  parts?: { text: string; changed: boolean }[];
}

/** A row of the comparison: the line of the definition before (left) and now (right). */
export interface Row {
  left: Cell | null;
  right: Cell | null;
}

export interface Section {
  id: "description" | "schema" | "hints";
  title: string;
  rows: Row[];
  /** Nothing differs in this section. */
  same: boolean;
}

type Op = { kind: "same" | "removed" | "added"; a?: number; b?: number };

/** The longest common subsequence of two lists, as the operations that turn `a` into `b`. */
function align(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // Too big for the table: keep what both share at the start and at the end, the rest changed.
  if (n * m > 400_000) {
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) start += 1;
    let endA = n;
    let endB = m;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA -= 1;
      endB -= 1;
    }
    const ops: Op[] = [];
    for (let i = 0; i < start; i++) ops.push({ kind: "same", a: i, b: i });
    for (let i = start; i < endA; i++) ops.push({ kind: "removed", a: i });
    for (let j = start; j < endB; j++) ops.push({ kind: "added", b: j });
    for (let k = 0; k < n - endA; k++) ops.push({ kind: "same", a: endA + k, b: endB + k });
    return ops;
  }
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (table[i] as number[])[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as number[])[j] as number,
              (table[i] as number[])[j + 1] as number,
            );
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", a: i, b: j });
      i += 1;
      j += 1;
    } else if (
      ((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)
    ) {
      ops.push({ kind: "removed", a: i });
      i += 1;
    } else {
      ops.push({ kind: "added", b: j });
      j += 1;
    }
  }
  for (; i < n; i++) ops.push({ kind: "removed", a: i });
  for (; j < m; j++) ops.push({ kind: "added", b: j });
  return ops;
}

/** The words of a line that differ from the other line (words are split at single spaces). */
export function wordParts(
  before: string,
  after: string,
): { left: { text: string; changed: boolean }[]; right: { text: string; changed: boolean }[] } {
  const a = before.split(" ");
  const b = after.split(" ");
  const flagsA: boolean[] = a.map(() => false);
  const flagsB: boolean[] = b.map(() => false);
  for (const op of align(a, b)) {
    if (op.kind === "removed") flagsA[op.a as number] = true;
    else if (op.kind === "added") flagsB[op.b as number] = true;
  }
  // Neighbouring words that differ are one stretch (the spaces between them go with it); a space
  // between a stretch and the rest stays plain, so a mark never starts or ends on a space.
  const build = (words: string[], flags: boolean[]) => {
    const parts: { text: string; changed: boolean }[] = [];
    words.forEach((word, i) => {
      const changed = flags[i] as boolean;
      const last = parts[parts.length - 1];
      if (last !== undefined && last.changed === changed) last.text += ` ${word}`;
      else {
        if (last !== undefined) parts.push({ text: " ", changed: false });
        parts.push({ text: word, changed });
      }
    });
    return parts;
  };
  return { left: build(a, flagsA), right: build(b, flagsB) };
}

/** Lines before and now, side by side: a removed run is paired with the added run that follows it. */
export function alignLines(before: readonly string[], after: readonly string[]): Row[] {
  const rows: Row[] = [];
  const ops = align(before, after);
  let k = 0;
  while (k < ops.length) {
    const op = ops[k] as Op;
    if (op.kind === "same") {
      const text = before[op.a as number] as string;
      rows.push({ left: { text, mark: "same" }, right: { text, mark: "same" } });
      k += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && (ops[k] as Op).kind !== "same") {
      const current = ops[k] as Op;
      if (current.kind === "removed") removed.push(before[current.a as number] as string);
      else added.push(after[current.b as number] as string);
      k += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let r = 0; r < count; r++) {
      const l = removed[r];
      const rt = added[r];
      const both = l !== undefined && rt !== undefined;
      const parts = both ? wordParts(l, rt) : undefined;
      rows.push({
        left:
          l === undefined
            ? null
            : { text: l, mark: "removed", ...(parts === undefined ? {} : { parts: parts.left }) },
        right:
          rt === undefined
            ? null
            : { text: rt, mark: "added", ...(parts === undefined ? {} : { parts: parts.right }) },
      });
    }
  }
  return rows;
}

const linesOf = (text: string): string[] => text.split("\n");

const NO_DESCRIPTION = "(sem descrição)";

function descriptionLines(def: PinnedDefinition | null): string[] | null {
  if (def === null) return null;
  return linesOf(
    def.description === null || def.description === "" ? NO_DESCRIPTION : def.description,
  );
}

/** The input schema as indented JSON, one line per row, in the order the server gave it. */
export function schemaLines(def: PinnedDefinition | null): string[] | null {
  if (def === null) return null;
  return linesOf(JSON.stringify(def.inputSchema ?? null, null, 2) ?? "null");
}

function hintLines(def: PinnedDefinition | null): string[] | null {
  if (def === null) return null;
  if (def.annotations === null) return ["(nenhuma)"];
  return linesOf(JSON.stringify(def.annotations, null, 2));
}

/**
 * The comparison of the definition the person approved and the one the server shows now, as
 * sections (description, input schema, hints) of rows. A new tool has nothing on the left.
 */
export function compareDefinitions(review: ConnectorToolReview): Section[] {
  const build = (
    id: Section["id"],
    title: string,
    before: string[] | null,
    after: string[],
  ): Section => {
    const rows = alignLines(before ?? [], after);
    return {
      id,
      title,
      rows,
      same:
        before !== null && rows.every((r) => r.left?.mark === "same" && r.right?.mark === "same"),
    };
  };
  return [
    build(
      "description",
      "Descrição",
      descriptionLines(review.approved),
      descriptionLines(review.current) as string[],
    ),
    build(
      "schema",
      "Esquema de entrada",
      schemaLines(review.approved),
      schemaLines(review.current) as string[],
    ),
    build(
      "hints",
      "Dicas do servidor",
      hintLines(review.approved),
      hintLines(review.current) as string[],
    ),
  ];
}

/** "2 linhas mudaram" for a section, for people who do not read the marks. */
export function changeSummary(section: Section): string {
  if (section.same) return "sem mudança";
  const changed = section.rows.filter(
    (r) => r.left?.mark === "removed" || r.right?.mark === "added",
  ).length;
  return `${changed} ${plural(changed, "linha difere", "linhas diferem")}`;
}

// --------------------------------------------------------------------- history

export const EVENT_LABEL: Record<ConnectorToolEvent["kind"], string> = {
  baseline: "Definição fixada na primeira listagem",
  pinned_on_grant: "Definição fixada ao dar a ferramenta a um bot",
  changed: "A definição mudou",
  new: "Ferramenta nova",
  restored: "Voltou à definição aprovada",
  approved: "Você aprovou a definição",
};

/** `409`: the definition changed again after the person looked at it. */
export const CHANGED_AGAIN =
  "A definição mudou de novo enquanto você olhava. Recarregamos: leia a nova versão antes de aprovar.";
