export type DiffLine = { kind: "context" | "removed" | "added"; text: string };

/**
 * A read-only diff of one replacement (`edit_file`): the lines both texts share at the start and at
 * the end are context (one line of it is kept), what differs in between is removed/added.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out: DiffLine[] = [];
  if (start > 0) out.push({ kind: "context", text: a[start - 1] as string });
  for (const text of a.slice(start, endA)) out.push({ kind: "removed", text });
  for (const text of b.slice(start, endB)) out.push({ kind: "added", text });
  if (endA < a.length) out.push({ kind: "context", text: a[endA] as string });
  return out;
}
