// Owns the vocabulary the harness shares about secrets: the placeholder the model writes, the walk
// that finds and replaces it, the redactor that scrubs known values, and the seam (`SecretAccess`)
// the runtime fills in. Nothing here knows how a secret is stored or encrypted.
import type { JsonValue } from "./messages.js";

/** A secret name: upper case letters, digits and underscores, starting with a letter. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isSecretName(value: string): boolean {
  return SECRET_NAME_PATTERN.test(value);
}

const PLACEHOLDER = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;

/** The placeholder the model writes where the value must go. */
export function placeholderFor(name: string): string {
  return `{{secret:${name}}}`;
}

/** The names of the placeholders in a text, in order of appearance, without repeats. */
export function findPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Where a placeholder was found in a JSON value: the path of keys/indexes and the names. */
export interface PlaceholderSite {
  path: (string | number)[];
  names: string[];
}

/** Every string inside `value` that carries a placeholder. */
export function placeholderSites(value: unknown): PlaceholderSite[] {
  const sites: PlaceholderSite[] = [];
  const walk = (node: unknown, path: (string | number)[]) => {
    if (typeof node === "string") {
      const names = findPlaceholders(node);
      if (names.length > 0) sites.push({ path, names });
    } else if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, [...path, i]);
    } else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) walk(item, [...path, key]);
    }
  };
  walk(value, []);
  return sites;
}

/**
 * Whether a path is covered by one of the declared field patterns (`command`, `headers.*`). `*`
 * stands for any one key or index; a pattern covers the strings at its path and nothing deeper
 * than a leaf (a string inside a declared object is covered only through `*`).
 */
export function pathAllowed(
  path: readonly (string | number)[],
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    const parts = pattern.split(".");
    return (
      parts.length === path.length &&
      parts.every((part, i) => part === "*" || part === String(path[i]))
    );
  });
}

/** Replaces every placeholder in every string of `value` (a copy: the input is untouched). */
export function substituteSecrets<T>(value: T, values: Readonly<Record<string, string>>): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** Thrown when a secret is missing, not granted to the bot, or cannot be read. */
export class SecretUnavailableError extends Error {
  override readonly name = "SecretUnavailableError";
  constructor(readonly secretName: string) {
    super(
      `secret ${secretName} is not available to this bot (it does not exist or was not granted); if request_secret is offered, use it; otherwise explain the task is blocked or offer an alternative without collecting the value`,
    );
  }
}

/** What a run may do with secrets. The runtime provides it; tools never see it. */
export interface SecretAccess {
  /**
   * The values behind these names, for the bot this access belongs to. Rejects with
   * `SecretUnavailableError`. Every value it returns is known to `redactor` from then on.
   */
  resolve(names: readonly string[]): Promise<Record<string, string>>;
  readonly redactor: Redactor;
}

/** Scrubs known secret values (and their common encodings) out of text and JSON. */
export interface Redactor {
  redact(text: string): string;
  /** A copy of `value` with every string (and key) scrubbed. */
  redactJson<T>(value: T): T;
}

/** A redactor that can learn values and be emptied. */
export interface MutableRedactor extends Redactor {
  /** Teaches a value. Values shorter than `MIN_REDACTED_LENGTH` are ignored. */
  add(name: string, value: string): void;
  /** Forgets everything (used before reloading the whole set). */
  clear(): void;
  readonly size: number;
}

/** Shorter values cannot be scrubbed without mangling ordinary text. */
export const MIN_REDACTED_LENGTH = 4;

/** Text that stands in for a scrubbed value. */
export function redactionMark(name: string): string {
  return `[REDACTED:${name}]`;
}

function b64(text: string, offset: number): string {
  const bytes = Buffer.concat([Buffer.alloc(offset), Buffer.from(text, "utf8")]);
  const raw = bytes.toString("base64").replace(/=+$/, "");
  // The first characters depend on the bytes before the value and the last one on the bytes
  // after it; what is left in between is the same wherever the value sits in a larger text.
  const start = offset === 0 ? 0 : offset === 1 ? 2 : 3;
  const end = bytes.length % 3 === 0 ? raw.length : raw.length - 1;
  return raw.slice(start, end);
}

/** The forms a value may take when it passes through a program: raw, encoded, escaped. */
export function secretForms(value: string): string[] {
  const forms = new Set<string>([value]);
  const add = (form: string) => {
    if (form.length >= MIN_REDACTED_LENGTH) forms.add(form);
  };
  for (const offset of [0, 1, 2]) {
    const standard = b64(value, offset);
    add(standard);
    add(standard.replaceAll("+", "-").replaceAll("/", "_"));
  }
  add(encodeURIComponent(value));
  add(encodeURIComponent(value).replaceAll("%20", "+"));
  add(encodeURI(value));
  add(JSON.stringify(value).slice(1, -1));
  const hex = Buffer.from(value, "utf8").toString("hex");
  add(hex);
  add(hex.toUpperCase());
  return [...forms];
}

/** An in-memory redactor. The runtime keeps one up to date with the vault. */
export function createRedactor(initial: Readonly<Record<string, string>> = {}): MutableRedactor {
  // By NAME: two secrets may share a value, and a name that gets a new value drops the old one.
  const entries = new Map<string, string[]>();
  let needles: { needle: string; mark: string }[] = [];

  const rebuild = () => {
    const byNeedle = new Map<string, string>();
    // Each text is marked once, with the first name in alphabetical order that has it: the mark
    // does not depend on the order the secrets were loaded in.
    for (const name of [...entries.keys()].sort()) {
      for (const needle of entries.get(name) ?? []) {
        if (!byNeedle.has(needle)) byNeedle.set(needle, name);
      }
    }
    needles = [...byNeedle.entries()]
      .map(([needle, name]) => ({ needle, mark: redactionMark(name) }))
      .sort((a, b) => b.needle.length - a.needle.length);
  };

  const redact = (text: string): string => {
    let out = text;
    for (const { needle, mark } of needles) {
      if (out.includes(needle)) out = out.split(needle).join(mark);
    }
    return out;
  };

  const redactJson = <T>(value: T): T => {
    if (needles.length === 0) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") return redact(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === "object") {
        // Two keys may become the same text once scrubbed (`tok` and `[REDACTED:X]`): the later
        // one gets `#2`, `#3`... so no entry is lost, in the input's key order.
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          let key = redact(k);
          for (let n = 2; Object.hasOwn(out, key); n++) key = `${redact(k)}#${n}`;
          // `defineProperty`, not `out[key] =`: a `__proto__` key stays a plain key.
          Object.defineProperty(out, key, {
            value: walk(v),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      }
      return node;
    };
    return walk(value) as T;
  };

  const self: MutableRedactor = {
    redact,
    redactJson,
    add(name, value) {
      if (value.length < MIN_REDACTED_LENGTH) {
        if (entries.delete(name)) rebuild();
        return;
      }
      entries.set(name, secretForms(value));
      rebuild();
    },
    clear() {
      entries.clear();
      needles = [];
    },
    get size() {
      return entries.size;
    },
  };
  for (const [name, value] of Object.entries(initial)) self.add(name, value);
  return self;
}

/** A redactor that scrubs nothing. */
export const noRedaction: Redactor = {
  redact: (text) => text,
  redactJson: (value) => value,
};

export type { JsonValue };
