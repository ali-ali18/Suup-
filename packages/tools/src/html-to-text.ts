/**
 * Small, dependency-free HTML to readable text converter. Not a browser: it aims at "good enough
 * for a model to read an article or documentation page". Drops script/style/head content, keeps
 * headings, lists, tables (as `a | b`) and link targets (`text (url)`), decodes entities and
 * collapses whitespace.
 */
export interface HtmlText {
  title: string | undefined;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  shy: "",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return "�";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|body|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|header|html|main|nav|ol|p|section|summary|table|tbody|tfoot|thead|ul";

export function htmlToText(html: string, baseUrl?: string): HtmlText {
  let s = html;

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1] ?? ""))) : undefined;

  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  s = s.replace(/<![^>]*>/g, " ");
  s = s.replace(/<\?[\s\S]*?\?>/g, " ");
  s = s.replace(
    /<(script|style|noscript|template|svg|head|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi,
    " ",
  );

  // <pre> keeps its whitespace: park it behind placeholders until the end.
  const parked: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    parked.push(
      decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n")))
        .replace(/^\n/, "")
        .replace(/\s+$/, ""),
    );
    return `\n\n\uE000PRE${parked.length - 1}\uE001\n\n`;
  });

  s = s.replace(/\s+/g, " ");

  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
    const label = collapse(decodeEntities(stripTags(imagesToAlt(inner))));
    const href = attributeValue(attrs, "href");
    const url = href === undefined ? undefined : resolveUrl(decodeEntities(href), baseUrl);
    if (url === undefined) return ` ${label} `;
    if (label === "") return ` ${url} `;
    if (label === url) return ` ${url} `;
    return ` ${label} (${url}) `;
  });
  s = imagesToAlt(s);

  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_w, level: string) => `\n\n${"#".repeat(Number(level))} `);
  s = s.replace(/<\/h[1-6]\s*>/gi, "\n\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");
  s = s.replace(/<\/(tr|caption)\s*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " | ");
  s = s.replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n");
  s = stripTags(s);
  s = decodeEntities(s);

  s = s
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t ]+/g, " ")
        .replace(/(?: \| )+$/, "")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  s = s.replace(
    /\uE000PRE(\d+)\uE001/g,
    (_w, i: string) => `\`\`\`\n${parked[Number(i)] ?? ""}\n\`\`\``,
  );
  return { title: title === "" ? undefined : title, text: s };
}

function stripTags(html: string): string {
  return html.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function imagesToAlt(html: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (_w, attrs: string) => {
    const alt = attributeValue(attrs, "alt");
    return alt === undefined || alt.trim() === ""
      ? " "
      : ` [image: ${collapse(decodeEntities(alt))}] `;
  });
}

function attributeValue(attrs: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function resolveUrl(href: string, baseUrl: string | undefined): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  if (/^(javascript|data|mailto|tel):/i.test(trimmed))
    return /^(mailto|tel):/i.test(trimmed) ? trimmed : undefined;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return undefined;
  }
}
