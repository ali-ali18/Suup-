// Owns turning a downloaded page into Markdown: HTML is parsed into a DOM that never runs scripts
// and never loads anything (jsdom's defaults), the main content is picked by Mozilla Readability,
// and Turndown writes Markdown. Nothing here decides what a page "is" by looking at its text with
// patterns: Readability works on the document structure, and a page it cannot read falls back to
// the text of the body.
import { Readability } from "@mozilla/readability";
import type { WebPage } from "@suup/core";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

export const READ_MAX_CHARS = 60_000;

/** Elements whose content is never page text (and, for scripts, never trusted). */
const NOISE = "script, style, noscript, template, iframe, object, embed, canvas, svg, link, meta";
const CHROME = "nav, header, footer, aside, form, dialog";

export interface ExtractOptions {
  maxChars?: number;
  rendered?: boolean;
}

/** The page as Markdown. `undefined` when there is no text in it at all. */
export function extractPage(
  html: string,
  url: string,
  options: ExtractOptions = {},
): Omit<WebPage, "status" | "requestedUrl"> | undefined {
  const maxChars = options.maxChars ?? READ_MAX_CHARS;
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const document = dom.window.document;
  const meta = readMeta(document);
  const title = document.title.trim();
  const turndown = markdownWriter(url);

  let markdown = "";
  let extraction: WebPage["extraction"] = "readability";
  let byline: string | undefined;
  let heading: string | undefined;
  let siteName: string | undefined;
  let published = meta.published;
  try {
    const article = new Readability(document.cloneNode(true) as Document, {
      keepClasses: false,
    }).parse();
    if (article?.content !== undefined && article.content !== null) {
      const text = tidy(turndown.turndown(article.content));
      if (text.length >= 200 || (article.textContent ?? "").trim().length >= 200) {
        markdown = text;
        heading = article.title ?? undefined;
        byline = article.byline ?? undefined;
        siteName = article.siteName ?? undefined;
        published = article.publishedTime ?? published;
      }
    }
  } catch {
    // fall through to the body text
  }
  if (markdown === "") {
    extraction = "fallback";
    for (const node of document.querySelectorAll(`${NOISE}, ${CHROME}`)) node.remove();
    markdown = tidy(turndown.turndown(document.body?.innerHTML ?? ""));
  }
  dom.window.close();
  if (markdown === "") return undefined;

  const fullLength = markdown.length;
  const truncated = fullLength > maxChars;
  const pageTitle = (heading ?? title).trim();
  return {
    url,
    ...(pageTitle === "" ? {} : { title: pageTitle }),
    ...(byline === undefined || byline.trim() === "" ? {} : { byline: byline.trim() }),
    ...(published === undefined || published === "" ? {} : { published }),
    ...(siteName === undefined || siteName.trim() === "" ? {} : { siteName: siteName.trim() }),
    extraction,
    markdown: truncated ? markdown.slice(0, maxChars) : markdown,
    truncated,
    fullLength,
    rendered: options.rendered === true,
  };
}

function readMeta(document: Document): { published?: string } {
  const published =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ??
    document.querySelector('meta[name="date"]')?.getAttribute("content") ??
    document.querySelector('meta[itemprop="datePublished"]')?.getAttribute("content") ??
    document.querySelector("time[datetime]")?.getAttribute("datetime") ??
    undefined;
  return published === undefined ? {} : { published: published.trim() };
}

function markdownWriter(base: string): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    linkStyle: "inlined",
  });
  service.remove(["script", "style", "noscript", "template", "iframe", "object", "embed"]);
  // A link is kept only when it points to an http(s) page; the address is made absolute.
  service.addRule("web-links", {
    filter: "a",
    replacement(content, node) {
      const href = (node as HTMLElement).getAttribute("href") ?? "";
      const target = safeLink(href, base);
      const label = content.trim();
      if (label === "") return "";
      return target === undefined ? label : `[${label}](${target})`;
    },
  });
  // The bot cannot see pictures: the description is what is left of them.
  service.addRule("web-images", {
    filter: "img",
    replacement(_content, node) {
      const alt = ((node as HTMLElement).getAttribute("alt") ?? "").trim();
      return alt === "" ? "" : `[image: ${alt}]`;
    },
  });
  return service;
}

/** An absolute http(s) address for a link, or `undefined` (javascript:, data:, mailto: and the like are dropped). */
export function safeLink(href: string, base: string): string | undefined {
  if (href.trim() === "") return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Trims, and keeps at most one blank line in a row. */
export function tidy(markdown: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      blank += 1;
      if (blank <= 1 && out.length > 0) out.push("");
    } else {
      blank = 0;
      out.push(line);
    }
  }
  return out.join("\n").trim();
}
