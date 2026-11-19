import { Link2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { faviconUrl, parseLink } from "./links.js";

export { parseLink, safeHref } from "./links.js";

// A tiny, safe renderer for the text of a bot: paragraphs, lists, fenced code, `inline code`,
// **bold**, *italic* and [links](https://...). It builds React elements, never HTML strings: there
// is no raw HTML injection path at all, so `<script>` is just text. Links only for http(s) (and
// mailto), opened outside the app.

export type Block =
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "h"; text: string };

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "p", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n"), lang: fence[1] ?? "" });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "h", text: heading[1] ?? "" });
      continue;
    }
    const ul = UL.exec(line);
    const ol = OL.exec(line);
    if (ul !== null || ol !== null) {
      flush();
      const kind = ul !== null ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length) {
        const m = (kind === "ul" ? UL : OL).exec(lines[i] as string);
        if (m === null) break;
        items.push(m[1] ?? "");
        i += 1;
      }
      i -= 1;
      blocks.push({ kind, items });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

/**
 * The mark before a link's text: a neutral glyph (no network request), or, when the person turned
 * "ícone dos sites" on, the site's own icon, fetched from its host only and dropped if it fails.
 */
function LinkMark({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="md__ico mr-1 inline-flex align-[calc(var(--space-1)/-2)] text-text-muted [&_img]:rounded-xs"
      aria-hidden="true"
    >
      {src === null || failed ? (
        <Link2 size={12} />
      ) : (
        <img
          src={src}
          alt=""
          width={14}
          height={14}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function renderInline(
  text: string,
  openUrl?: (url: string) => void,
  favicons = false,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    if (match[1] !== undefined)
      out.push(
        <code key={key++} className="rounded-chip bg-raised px-1.5 py-px">
          {token.slice(1, -1)}
        </code>,
      );
    else if (match[2] !== undefined) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (match[3] !== undefined) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const safe = link?.[2] === undefined ? null : parseLink(link[2]);
      if (safe === null) out.push(token);
      else
        out.push(
          <a
            key={key++}
            className="md__link text-inherit underline underline-offset-3"
            href={safe.href}
            // The real destination, as the browser sees it (a lookalike domain shows its ASCII form).
            title={safe.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (openUrl !== undefined) {
                e.preventDefault();
                openUrl(safe.href);
              }
            }}
          >
            <LinkMark src={favicons ? faviconUrl(safe) : null} />
            {label}
          </a>,
        );
    }
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST = "flex flex-col gap-1 pl-5";

/** The text of a bot message as React elements. */
export function Markdown({
  text,
  openUrl,
  favicons = false,
}: {
  text: string;
  openUrl?: (url: string) => void;
  favicons?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 text-body">
      {parseBlocks(text).map((block, i) => {
        const key = i;
        switch (block.kind) {
          case "p":
            return (
              <p key={key} className="wrap-anywhere whitespace-pre-wrap">
                {renderInline(block.text, openUrl, favicons)}
              </p>
            );
          case "h":
            return (
              <p key={key} className="font-title">
                {renderInline(block.text, openUrl, favicons)}
              </p>
            );
          case "ul":
            return (
              <ul key={key} className={`${LIST} list-disc`}>
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <li key={j}>{renderInline(item, openUrl, favicons)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className={`${LIST} my-[1em] list-decimal`}>
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <li key={j}>{renderInline(item, openUrl, favicons)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre
                key={key}
                className="m-0 max-h-80 overflow-auto rounded-inner border border-border bg-bg px-3.5 py-3"
              >
                <code>{block.text}</code>
              </pre>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

/** The text without its markup, on one line: for previews (the sidebar, the palette). */
export function plainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[*`#]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
