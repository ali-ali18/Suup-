import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, parseBlocks, plainText, safeHref } from "./markdown.js";

const html = (text: string) => {
  const { container } = render(<Markdown text={text} />);
  return container;
};

describe("safe markdown", () => {
  it("renders paragraphs, lists, code, bold, italic and inline code", () => {
    const c = html(
      "Olá **mundo** e *você*, use `ls -la`.\n\n- um\n- dois\n\n1. a\n2. b\n\n```sh\necho oi\n```",
    );
    expect(c.querySelectorAll("p")).toHaveLength(1);
    expect(c.querySelector("strong")?.textContent).toBe("mundo");
    expect(c.querySelector("em")?.textContent).toBe("você");
    expect(c.querySelector("p code")?.textContent).toBe("ls -la");
    expect(Array.from(c.querySelectorAll("ul li")).map((l) => l.textContent)).toEqual([
      "um",
      "dois",
    ]);
    expect(Array.from(c.querySelectorAll("ol li")).map((l) => l.textContent)).toEqual(["a", "b"]);
    expect(c.querySelector("pre code")?.textContent).toBe("echo oi");
  });

  it("raw HTML is text: no element is created from it", () => {
    const c = html('<img src=x onerror="alert(1)"> <script>alert(1)</script> <b>negrito</b>');
    expect(c.querySelector("img, script, b")).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(c.textContent).toContain("<script>alert(1)</script>");
  });

  it("only http(s) and mailto links are links; others stay as text", () => {
    const c = html(
      "[ok](https://example.com/a?b=1) [mau](javascript:alert(1)) [dados](data:text/html,<b>) [arq](file:///etc/passwd)",
    );
    const links = Array.from(c.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1"]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(c.textContent).toContain("[mau](javascript:alert(1))");
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });

  it("opens links through the platform when given a handler", () => {
    const openUrl = vi.fn();
    const { container } = render(<Markdown text="[x](https://example.com)" openUrl={openUrl} />);
    container.querySelector("a")?.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/");
  });

  it("hostile input does not break out: unterminated fences, nested markers, huge lines", () => {
    expect(() => html("```\nsem fim\n**a *b* c\n[x](")).not.toThrow();
    expect(html("**".repeat(5000)).textContent?.length).toBeGreaterThan(0);
    const blocks = parseBlocks("```js\nconst a = '<script>';\n```");
    expect(blocks).toEqual([{ kind: "code", text: "const a = '<script>';", lang: "js" }]);
  });

  it("attributes in the label cannot inject: the label is a text node", () => {
    const c = html('[" onmouseover="alert(1)](https://example.com)');
    const a = c.querySelector("a");
    expect(a?.getAttribute("onmouseover")).toBeNull();
    expect(a?.textContent).toBe('" onmouseover="alert(1)');
  });
});

describe("plainText", () => {
  it("drops the markup so a preview reads as text", () => {
    expect(
      plainText(
        "Resumo:\n\n- primeiro **item**\n- com `código`\n\nVeja [a doc](https://x.co) ```\ncode\n```",
      ),
    ).toBe("Resumo: primeiro item com código Veja a doc");
  });
});

describe("links in a message", () => {
  const links = (text: string, favicons = false) => {
    const { container } = render(<Markdown text={text} favicons={favicons} />);
    return { container, anchors: Array.from(container.querySelectorAll("a")) };
  };

  it("hostile links stay as text: javascript:, data:, mixed-case schemes, tabs inside the scheme", () => {
    const { container, anchors } = links(
      "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) [d](DATA:text/html;base64,AA==) [e](java\tscript:alert(1)) [f](vbscript:x) [g](file:///etc/passwd)",
    );
    expect(anchors).toHaveLength(0);
    expect(container.textContent).toContain("[a](javascript:alert(1))");
    expect(container.querySelector("[href^='javascript' i], [href^='data' i]")).toBeNull();
  });

  it("a link that hides its host behind userinfo is not a link", () => {
    const { anchors, container } = links("[google.com](https://google.com@evil.example/login)");
    expect(anchors).toHaveLength(0);
    expect(container.textContent).toContain("https://google.com@evil.example/login");
  });

  it("mixed-case http(s) is a link, normalised; the title is the real destination, whatever the label says", () => {
    const { anchors } = links("[apple.com](HTTPS://Evil.Example/Path)");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe("https://evil.example/Path");
    expect(anchors[0]?.getAttribute("title")).toBe("https://evil.example/Path");
    expect(anchors[0]?.textContent).toBe("apple.com");
  });

  it("a punycode lookalike shows its ASCII form in the title", () => {
    const { anchors } = links("[apple.com](https://аррӏе.com/)");
    expect(anchors[0]?.getAttribute("title")).toMatch(/^https:\/\/xn--[a-z0-9-]+\.com\/$/);
    expect(anchors[0]?.getAttribute("href")).toBe(anchors[0]?.getAttribute("title"));
  });

  it("no accent colour: the link is the text colour, underlined, with a neutral glyph and NO image", () => {
    const { container, anchors } = links("[doc](https://example.com/docs)");
    expect(anchors[0]?.className).toBe("md__link");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".md__ico svg")).not.toBeNull();
  });

  it("with site icons on: https://<host>/favicon.ico only, no referrer, lazy; nothing for unsafe hosts", () => {
    const { container } = links(
      "[a](https://example.com/p?q=secret#f) [b](http://example.org/) [c](https://127.0.0.1/) [d](https://printer.local/) [e](mailto:a@b.co) [f](https://localhost/)",
      true,
    );
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    expect(imgs[0]?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(imgs[0]?.getAttribute("loading")).toBe("lazy");
    expect(container.querySelectorAll("a")).toHaveLength(6);
  });

  it("a failed icon is dropped and the glyph stays", () => {
    const { container } = links("[a](https://example.com/)", true);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".md__ico svg")).not.toBeNull();
  });

  it("an image in the text is never loaded: off, no image at all; on, only the site's own icon", () => {
    const text = "![x](https://evil.example/pixel.png) <img src='https://evil.example/p.png'>";
    expect(links(text, false).container.querySelector("img")).toBeNull();
    const sources = Array.from(links(text, true).container.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    expect(sources).toEqual(["https://evil.example/favicon.ico"]);
  });
});
