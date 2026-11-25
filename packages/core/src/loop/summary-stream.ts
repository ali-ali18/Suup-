// Reads the `summary` argument of a tool call out of its JSON while the model is still writing it,
// so the chat can type the end message as it comes (KOD-34). The JSON arrives in pieces cut at any
// character, so this is a small state machine over the JSON grammar: it follows the top-level
// object, the strings (with their escapes, `\uXXXX` and surrogate pairs included), and skips every
// other value. It compares characters exactly and uses no pattern. What it returns is only ever
// shown on screen: the recorded call is still parsed whole by the provider.

/** Characters of the first top-level `"summary": "<text>"` of the object, decoded, as they arrive. */
export interface SummaryStream {
  /** Feeds the next piece of the JSON text; returns the new decoded characters (maybe empty). */
  feed(piece: string): string;
}

type Mode =
  | "start" // before the opening brace
  | "key_or_end" // after `{` or `,`: a key or the closing brace
  | "key" // inside a key string
  | "colon" // after a key
  | "value" // before a value
  | "target" // inside the summary string
  | "skip_string" // inside a string value we ignore
  | "skip_nested" // inside an object or array we ignore
  | "skip_primitive" // a number, true, false or null
  | "after" // after a value: a comma or the closing brace
  | "done"; // the summary ended, or it cannot be read: nothing more is shown

const HEX = "0123456789abcdef";

function isSpace(c: string): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t";
}

export function createSummaryStream(): SummaryStream {
  let mode: Mode = "start";
  let key = "";
  let depth = 0; // nesting inside a skipped value
  let inNestedString = false;
  let escaped = false; // after a backslash in a string we skip
  // Escapes of the strings we decode (keys and the summary).
  let esc: "none" | "slash" | "hex" = "none";
  let hex = "";

  /** Decodes one character of a string we read; returns what it adds, `undefined` when it ends. */
  const stringChar = (c: string): string | undefined | null => {
    if (esc === "slash") {
      esc = "none";
      switch (c) {
        case '"':
          return '"';
        case "\\":
          return "\\";
        case "/":
          return "/";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "u":
          esc = "hex";
          hex = "";
          return "";
        default:
          return null; // not valid JSON
      }
    }
    if (esc === "hex") {
      if (HEX.indexOf(c.toLowerCase()) < 0 || c.length !== 1) return null;
      hex += c;
      if (hex.length < 4) return "";
      esc = "none";
      // One UTF-16 unit; a surrogate pair is two escapes in a row, which concatenate to the
      // same text `JSON.parse` gives.
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    if (c === "\\") {
      esc = "slash";
      return "";
    }
    if (c === '"') return undefined;
    return c;
  };

  const feedChar = (c: string): string => {
    switch (mode) {
      case "start":
        if (isSpace(c)) return "";
        mode = c === "{" ? "key_or_end" : "done";
        return "";
      case "key_or_end":
        if (isSpace(c)) return "";
        if (c === '"') {
          mode = "key";
          key = "";
          esc = "none";
        } else mode = "done"; // `}` (no summary) or garbage
        return "";
      case "key": {
        const out = stringChar(c);
        if (out === null) mode = "done";
        else if (out === undefined) mode = "colon";
        else key += out;
        return "";
      }
      case "colon":
        if (isSpace(c)) return "";
        mode = c === ":" ? "value" : "done";
        return "";
      case "value":
        if (isSpace(c)) return "";
        if (key === "summary") {
          // Only a string is shown: any other kind of summary is left to the recorded message.
          mode = c === '"' ? "target" : "done";
          esc = "none";
          return "";
        }
        if (c === '"') {
          mode = "skip_string";
          escaped = false;
        } else if (c === "{" || c === "[") {
          mode = "skip_nested";
          depth = 1;
          inNestedString = false;
          escaped = false;
        } else mode = "skip_primitive";
        return "";
      case "target": {
        const out = stringChar(c);
        if (out === null) {
          mode = "done";
          return "";
        }
        if (out === undefined) {
          mode = "done";
          return "";
        }
        return out;
      }
      case "skip_string":
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') mode = "after";
        return "";
      case "skip_nested":
        if (inNestedString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inNestedString = false;
        } else if (c === '"') inNestedString = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) mode = "after";
        }
        return "";
      case "skip_primitive":
        if (c === "," || c === "}") return feedAfter(c);
        if (isSpace(c)) mode = "after";
        return "";
      case "after":
        return feedAfter(c);
      case "done":
        return "";
    }
  };

  const feedAfter = (c: string): string => {
    if (isSpace(c)) {
      mode = "after";
      return "";
    }
    mode = c === "," ? "key_or_end" : "done";
    return "";
  };

  return {
    feed(piece) {
      let out = "";
      // `for...of` walks code points: a surrogate pair stays whole, as it came in the text.
      for (const c of piece) {
        if (mode === "done") break;
        out += feedChar(c);
      }
      return out;
    },
  };
}
