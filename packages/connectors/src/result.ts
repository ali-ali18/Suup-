// Owns turning what a server returned from a tool call into the text handed to the model. All of
// it is external content: the registry labels it as untrusted (the tool declares `externalOutput`),
// redacts known secret values and truncates it. Here it is only flattened to text, cleaned of
// control characters and bounded, so a hostile server cannot make us hold an unbounded string.
import { clip, stripControl } from "./text.js";

/** The most characters of a result kept before the registry applies its own limit and spills to a file. */
export const MAX_RESULT_CHARS = 1_000_000;

interface Block {
  type?: unknown;
  text?: unknown;
  mimeType?: unknown;
  data?: unknown;
  uri?: unknown;
  name?: unknown;
  resource?: unknown;
  blob?: unknown;
}

const asText = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function describeBlock(block: Block): string {
  switch (block.type) {
    case "text":
      return asText(block.text) ?? "";
    case "image":
    case "audio": {
      const size = typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0;
      return `[${String(block.type)} omitted: ${stripControl(asText(block.mimeType) ?? "unknown type")}, about ${size} bytes]`;
    }
    case "resource_link":
      return `[resource link: ${stripControl(asText(block.uri) ?? "?")}${asText(block.name) === undefined ? "" : ` (${stripControl(asText(block.name) as string)})`}]`;
    case "resource": {
      const r = (block.resource ?? {}) as Block;
      const uri = stripControl(asText(r.uri) ?? "?");
      if (typeof r.text === "string") return `[resource ${uri}]\n${r.text}`;
      const size = typeof r.blob === "string" ? Math.floor((r.blob.length * 3) / 4) : 0;
      return `[resource ${uri} omitted: binary, about ${size} bytes]`;
    }
    default:
      return `[content of an unknown kind omitted: ${stripControl(String(block.type)).slice(0, 40)}]`;
  }
}

export interface FlatResult {
  text: string;
  isError: boolean;
  /** The text was cut at `MAX_RESULT_CHARS`. */
  cut: boolean;
}

/** `result` is the `CallToolResult` of the protocol, taken as untrusted data. */
export function flattenResult(result: unknown): FlatResult {
  const r = (typeof result === "object" && result !== null ? result : {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content.slice(0, 200)) {
      if (typeof block === "object" && block !== null) parts.push(describeBlock(block as Block));
    }
  }
  let text = parts.join("\n\n");
  if (text.trim() === "" && r.structuredContent !== undefined) {
    try {
      text = JSON.stringify(r.structuredContent, null, 2) ?? "";
    } catch {
      text = "[structured content could not be read]";
    }
  }
  const cut = text.length > MAX_RESULT_CHARS;
  const body = stripControl(cut ? text.slice(0, MAX_RESULT_CHARS) : text);
  return {
    text: cut
      ? `${clip(body, MAX_RESULT_CHARS)}\n[... the connector returned more than ${MAX_RESULT_CHARS} characters; the rest was dropped ...]`
      : body,
    isError: r.isError === true,
    cut,
  };
}
