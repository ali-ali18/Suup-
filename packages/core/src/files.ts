// Owns what a file the bot sends to the user IS, decided by structure and never by a pattern
// (docs/REGRAS.md §1): the first bytes compared with fixed signatures (WHATWG MIME Sniffing), then
// the extension of the name looked up in a table, both by exact equality. Also the seam through
// which the `send_file` tool hands a file to whoever stores it (the runtime binds the bot and run).

/** The tool's name. The prompt mentions it, and the runtime offers it on a guarded run. */
export const SEND_FILE_TOOL_NAME = "send_file";

/** The largest file the bot may send to the chat: 25 MB. */
export const MAX_SENT_FILE_BYTES = 25 * 1024 * 1024;

/** The longest file name kept (the rest of the name is cut, the extension kept). */
export const MAX_FILE_NAME_LENGTH = 255;

/** What the app draws a file as (its icon). Declared from the MIME type by an exact table. */
export const FILE_KINDS = [
  "pdf",
  "image",
  "document",
  "spreadsheet",
  "presentation",
  "text",
  "archive",
  "audio",
  "video",
  "other",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const OCTET = "application/octet-stream";

/** Extension (lower case, without the dot) to MIME type. Exact lookup. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/vnd.microsoft.icon",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odp: "application/vnd.oasis.opendocument.presentation",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** MIME type to kind. Exact lookup; a type that is not here is `other`. */
const KIND_BY_MIME: Readonly<Record<string, FileKind>> = {
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/svg+xml": "image",
  "image/bmp": "image",
  "image/vnd.microsoft.icon": "image",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/rtf": "document",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheet",
  "text/csv": "spreadsheet",
  "text/tab-separated-values": "spreadsheet",
  "application/vnd.ms-powerpoint": "presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.oasis.opendocument.presentation": "presentation",
  "text/plain": "text",
  "text/markdown": "text",
  "application/json": "text",
  "application/xml": "text",
  "text/html": "text",
  "application/zip": "archive",
  "application/gzip": "archive",
  "application/x-tar": "archive",
  "application/x-7z-compressed": "archive",
  "application/vnd.rar": "archive",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/mp4": "audio",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
};

/**
 * Signatures at the start of a file (mimesniff, "Matching an image type pattern" and "an archive
 * type pattern"). `null` in a pattern is a byte that may be anything. A ZIP is only "a ZIP": the
 * Office formats (docx, xlsx, pptx, odt...) are ZIPs, so the extension says which one.
 */
const SIGNATURES: readonly { bytes: readonly (number | null)[]; mime: string }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mime: "application/pdf" },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], mime: "image/gif" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mime: "image/gif" },
  {
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
    mime: "image/webp",
  },
  {
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45],
    mime: "audio/wav",
  },
  { bytes: [0x42, 0x4d], mime: "image/bmp" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip" },
  { bytes: [0x1f, 0x8b, 0x08], mime: "application/gzip" },
  { bytes: [0x52, 0x61, 0x72, 0x20, 0x1a, 0x07], mime: "application/vnd.rar" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], mime: "application/x-7z-compressed" },
  { bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg" },
  { bytes: [0x4f, 0x67, 0x67, 0x53, 0x00], mime: "audio/ogg" },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/webm" },
  { bytes: [null, null, null, null, 0x66, 0x74, 0x79, 0x70], mime: "video/mp4" },
];

/** The extension of a file name: what follows the last dot, in lower case ("" for none). */
export function fileExtension(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** The last segment of a path, split on "/" (the workspace is POSIX). */
export function baseName(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? "";
}

function matches(bytes: Uint8Array, pattern: readonly (number | null)[]): boolean {
  if (bytes.length < pattern.length) return false;
  return pattern.every((b, i) => b === null || bytes[i] === b);
}

/** The kind the app draws for a MIME type (exact table; anything else is `other`). */
export function fileKindOf(mime: string): FileKind {
  return KIND_BY_MIME[mime] ?? "other";
}

/**
 * The MIME type and kind of a file, from its first bytes and its name. A signature that the
 * extension refines (a ZIP named `.docx`, an MP4 container named `.m4a` or `.mov`) takes the
 * extension's type; a signature that disagrees with the extension wins (the bytes are what the
 * file is). With no signature, the extension decides; with neither, `application/octet-stream`.
 */
export function detectFileType(bytes: Uint8Array, name: string): { mime: string; kind: FileKind } {
  const byName = BY_EXTENSION[fileExtension(name)];
  const signature = SIGNATURES.find((s) => matches(bytes, s.bytes))?.mime;
  let mime: string;
  if (signature === undefined) mime = byName ?? OCTET;
  else if (byName !== undefined && refines(signature, byName)) mime = byName;
  else mime = signature;
  return { mime, kind: fileKindOf(mime) };
}

/** Containers whose extension says what is inside: ZIP (Office, OpenDocument) and MP4 (audio, mov). */
function refines(signature: string, byName: string): boolean {
  if (signature === "application/zip") {
    const kind = KIND_BY_MIME[byName];
    return kind === "document" || kind === "spreadsheet" || kind === "presentation";
  }
  if (signature === "video/mp4") return byName === "audio/mp4" || byName === "video/quicktime";
  return false;
}

/**
 * The name a sent file gets: the last segment of what the bot gave, without control characters,
 * cut to `MAX_FILE_NAME_LENGTH` keeping the extension. `""` when nothing is left.
 */
export function cleanFileName(raw: string): string {
  let out = "";
  for (const ch of baseName(raw.trim())) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === "\\") continue;
    out += ch;
  }
  out = out.trim();
  if (out === "." || out === "..") return "";
  if (out.length <= MAX_FILE_NAME_LENGTH) return out;
  const ext = fileExtension(out);
  const tail = ext === "" || ext.length > 16 ? "" : `.${ext}`;
  return `${out.slice(0, MAX_FILE_NAME_LENGTH - tail.length)}${tail}`;
}

/** What `send_file` hands over: the bytes, the cleaned name and the detected type. */
export interface OutgoingFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * Where the files a run sends go, with the bot and the run already bound in by whoever provides it
 * (the runtime). The file shows under the bot's next message of the run, in the user's chat.
 * Idempotent by `callId`: the same call, run again after a crash, stores the file once.
 */
export interface FileSender {
  send(file: OutgoingFile, callId: string): Promise<{ id: string }>;
}
