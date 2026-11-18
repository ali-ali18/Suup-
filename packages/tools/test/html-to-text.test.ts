import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "../src/index.js";

describe("htmlToText", () => {
  it("drops scripts, styles, comments and head, keeps the title separately", () => {
    const { title, text } = htmlToText(`<!doctype html><html><head><title>My &amp; Page</title>
      <style>body{color:red}</style><script>var secret = "x";</script></head>
      <body><!-- hidden --><p>Hello <b>world</b></p><script>alert(1)</script><noscript>enable js</noscript></body></html>`);
    expect(title).toBe("My & Page");
    expect(text).toBe("Hello world");
  });

  it("keeps link targets, resolving relative ones", () => {
    const { text } = htmlToText(
      `<p>See <a href="/docs/start">the docs</a>, <a href='https://x.test/a?b=1&amp;c=2'>link</a>, <a href="#top">top</a> and <a href="javascript:void(0)">js</a>.</p>`,
      "https://example.com/base/page",
    );
    expect(text).toBe(
      "See the docs (https://example.com/docs/start) , link (https://x.test/a?b=1&c=2) , top and js .",
    );
  });

  it("does not repeat a link whose text is its URL, and shows image-only links by URL", () => {
    const { text } = htmlToText(
      `<a href="https://a.test/">https://a.test/</a> <a href="https://b.test/"><img src="x.png" alt=""></a> <img src="y.png" alt="a chart">`,
    );
    expect(text).toBe("https://a.test/ https://b.test/ [image: a chart]");
  });

  it("renders headings, lists, tables and paragraphs with structure", () => {
    const { text } = htmlToText(
      `<h1>Title</h1><p>First   paragraph
        spans lines.</p><h2>List</h2><ul><li>one</li><li>two <em>2</em></li></ul>
        <table><tr><th>Name</th><th>Qty</th></tr><tr><td>apple</td><td>3</td></tr></table><p>Last</p>`,
    );
    expect(text).toBe(
      [
        "# Title",
        "",
        "First paragraph spans lines.",
        "",
        "## List",
        "",
        "- one",
        "- two 2",
        "",
        "Name | Qty",
        "apple | 3",
        "",
        "Last",
      ].join("\n"),
    );
  });

  it("preserves whitespace inside <pre> and decodes its entities", () => {
    const { text } = htmlToText(
      `<p>Code:</p><pre><code>if (a &lt; b) {\n  run();\n}</code></pre><p>done</p>`,
    );
    expect(text).toBe("Code:\n\n```\nif (a < b) {\n  run();\n}\n```\n\ndone");
  });

  it("treats escaped markup as text, not as tags", () => {
    const { text } = htmlToText("<p>Use &lt;script&gt;alert(1)&lt;/script&gt; carefully</p>");
    expect(text).toBe("Use <script>alert(1)</script> carefully");
  });

  it("handles br, hr and collapses blank lines", () => {
    const { text } = htmlToText("<div>a<br>b</div><div></div><div></div><hr><div>c</div>");
    expect(text).toBe("a\nb\n\n---\n\nc");
  });

  it("copes with malformed and empty input", () => {
    expect(htmlToText("").text).toBe("");
    expect(htmlToText("<p>unclosed <b>bold").text).toBe("unclosed bold");
    expect(htmlToText("<<>> a < b > c").text).toContain("a < b > c");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;&gt;&amp;&quot;&#39;&#x41;&#128512;&nbsp;&unknown;&mdash;")).toBe(
      "<>&\"'A\u{1F600} &unknown;—",
    );
  });

  it("does not decode twice", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("replaces invalid code points", () => {
    expect(decodeEntities("&#0; &#xD800; &#1114112;")).toBe("� � �");
  });
});
