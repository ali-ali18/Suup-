// Owns what is kept of a server's tool list in the database: a bounded copy of what the server said,
// so a worker can still offer a connector's tools when the server is down at the start of a run
// (a call then fails as a tool error, with a clear message) and the app can list the tools without a
// live connection. Everything in it is untrusted server text and is cleaned again when it is read.
import {
  cleanDescription,
  MAX_SCHEMA_CHARS,
  MAX_TOOLS,
  type RawTool,
  stripControl,
} from "@suup/connectors";

const MAX_SNAPSHOT_CHARS = 1_500_000;

/**
 * A copy of a JSON value from a server that Postgres will accept: a NUL character in any string or
 * key (a hostile server can send one) is refused by `jsonb`, and would make the whole save fail.
 */
function storable(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === "string") return stripControl(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => storable(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      out[stripControl(key)] = storable(item, depth + 1);
    }
    return out;
  }
  return typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** Bounds a list of tools for storage: oversize schemas are not kept (the tool cannot be offered anyway). */
export function boundSnapshot(tools: readonly RawTool[]): RawTool[] {
  const out: RawTool[] = [];
  let total = 0;
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    let schema: unknown = storable(tool.inputSchema);
    let size = 0;
    try {
      size = JSON.stringify(schema)?.length ?? 0;
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > MAX_SCHEMA_CHARS) {
      schema = null;
      size = 4;
    }
    const entry: RawTool = {
      name: stripControl(tool.name).slice(0, 128),
      description:
        tool.description === undefined ? undefined : cleanDescription(tool.description, 4000),
      inputSchema: schema,
      annotations: tool.annotations,
      taskRequired: tool.taskRequired,
    };
    total += size + (entry.description?.length ?? 0) + entry.name.length + 100;
    if (total > MAX_SNAPSHOT_CHARS) break;
    out.push(entry);
  }
  return out;
}

/** Reads a stored snapshot back, keeping only well-formed entries (the column is just JSON). */
export function readSnapshot(stored: unknown): RawTool[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const out: RawTool[] = [];
  for (const item of stored) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.name !== "string") continue;
    const hints = t.annotations as Record<string, unknown> | null | undefined;
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : undefined,
      inputSchema: t.inputSchema ?? null,
      annotations:
        typeof hints === "object" && hints !== null
          ? {
              ...(typeof hints.readOnlyHint === "boolean"
                ? { readOnlyHint: hints.readOnlyHint }
                : {}),
              ...(typeof hints.destructiveHint === "boolean"
                ? { destructiveHint: hints.destructiveHint }
                : {}),
            }
          : undefined,
      taskRequired: t.taskRequired === true,
    });
  }
  return out;
}
