// A tiny reader of the XML inside a docx or xlsx, for the checks only: it finds the opening tags of
// an element and the text of an element by exact scanning (no pattern), and unescapes the five
// predefined entities. The files it reads were just written by Suup's own builders.

/** The attributes of every `<tag ...>` in `xml`, each as a name-to-value map. */
export function tagAttributes(xml: string, tag: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const open = `<${tag}`;
  let from = 0;
  for (;;) {
    const at = xml.indexOf(open, from);
    if (at === -1) return out;
    const after = xml[at + open.length];
    const end = xml.indexOf(">", at);
    from = at + open.length;
    if (end === -1) return out;
    if (after !== " " && after !== ">" && after !== "/") continue; // another tag with this prefix
    out.push(parseAttributes(xml.slice(at + open.length, end)));
  }
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < source.length) {
    const eq = source.indexOf("=", i);
    if (eq === -1) break;
    const name = source.slice(i, eq).trim();
    const quote = source[eq + 1];
    if (quote !== '"' && quote !== "'") break;
    const close = source.indexOf(quote, eq + 2);
    if (close === -1) break;
    attrs[name] = unescapeXml(source.slice(eq + 2, close));
    i = close + 1;
  }
  return attrs;
}

/** The text content of every `<tag>...</tag>` (the tag may carry attributes). */
export function tagTexts(xml: string, tag: string): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let from = 0;
  for (;;) {
    const at = xml.indexOf(open, from);
    if (at === -1) return out;
    const after = xml[at + open.length];
    from = at + open.length;
    if (after !== " " && after !== ">") continue;
    const start = xml.indexOf(">", at) + 1;
    const end = xml.indexOf(close, start);
    if (end === -1) return out;
    out.push(unescapeXml(xml.slice(start, end)));
    from = end;
  }
}

export function countTags(xml: string, tag: string): number {
  return tagAttributes(xml, tag).length;
}

function unescapeXml(text: string): string {
  return text
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">")
    .split("&quot;")
    .join('"')
    .split("&apos;")
    .join("'")
    .split("&amp;")
    .join("&");
}
