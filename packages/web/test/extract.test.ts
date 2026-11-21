import { describe, expect, it } from "vitest";
import { extractPage, safeLink, tidy } from "../src/extract.js";
import { ARTICLE_HTML } from "./helpers.js";

describe("extractPage", () => {
  const page = extractPage(ARTICLE_HTML, "https://example.com/post/1");

  it("keeps the main article as Markdown with headings, lists and absolute links", () => {
    expect(page?.extraction).toBe("readability");
    expect(page?.markdown).toContain("The first paragraph of the article");
    expect(page?.markdown).toContain("## Details");
    expect(page?.markdown).toContain("-   First point about the thing");
    expect(page?.markdown).toContain("[relative link](https://example.com/docs/more)");
  });

  it("leaves out menus, footers and every script", () => {
    expect(page?.markdown).not.toContain("Copyright footer");
    expect(page?.markdown).not.toContain("Home");
    expect(page?.markdown).not.toContain("alert");
    expect(page?.markdown).not.toContain("stolen");
    expect(page?.markdown).not.toContain("javascript:");
  });

  it("keeps the text of a link it refuses, and the description of an image", () => {
    expect(page?.markdown).toContain("script link");
    expect(page?.markdown).toContain("[image: a diagram of the system]");
  });

  it("reports title, byline and the date the page declares", () => {
    expect(page?.title).toContain("Fixture article");
    expect(page?.byline).toBe("By Ada Lovelace");
    expect(page?.published).toBe("2026-05-01T10:00:00Z");
    expect(page?.rendered).toBe(false);
  });

  it("collects the addresses of every link of the page, resolved, normalized and without repeats", () => {
    const html = `<html><body><nav><a href="/menu">Menu</a></nav><article><p>${"Text of the article. ".repeat(30)}</p>
      <a href="../up#part">up</a><a href="https://Other.EXAMPLE:443/a?x=1%2F2">other</a>
      <a href="/menu#again">again</a><a href="javascript:void(0)">no</a><a href="mailto:a@b.c">mail</a>
      <a href="/dir/">dir</a><a href="/dir">dirless</a></article></body></html>`;
    const result = extractPage(html, "https://example.com/post/1");
    expect(result?.links).toEqual([
      "https://example.com/menu",
      "https://example.com/up",
      "https://other.example/a?x=1%2F2",
      "https://example.com/dir/",
      "https://example.com/dir",
    ]);
  });

  it("cuts at the limit and says how long the whole text was", () => {
    const cut = extractPage(ARTICLE_HTML, "https://example.com/post/1", { maxChars: 120 });
    expect(cut?.truncated).toBe(true);
    expect(cut?.markdown.length).toBe(120);
    expect(cut?.fullLength).toBeGreaterThan(120);
  });

  it("falls back to the body text when no article is found", () => {
    const small = extractPage(
      "<html><body><p>Just a short note.</p><script>x()</script></body></html>",
      "https://example.com/n",
    );
    expect(small?.extraction).toBe("fallback");
    expect(small?.markdown).toBe("Just a short note.");
  });

  it("returns nothing for a page without text", () => {
    expect(
      extractPage("<html><body><script>x()</script></body></html>", "https://example.com/"),
    ).toBeUndefined();
  });

  it("never runs the page's scripts", () => {
    const html = `<html><body><p id="p">before</p><script>document.getElementById("p").textContent = "RAN"</script></body></html>`;
    const result = extractPage(html, "https://example.com/");
    expect(result?.markdown).toBe("before");
  });
});

describe("safeLink", () => {
  it("accepts only http(s) and makes the address absolute", () => {
    expect(safeLink("/a?b=1", "https://x.test/p/")).toBe("https://x.test/a?b=1");
    expect(safeLink("javascript:alert(1)", "https://x.test/")).toBeUndefined();
    expect(safeLink("data:text/html,hi", "https://x.test/")).toBeUndefined();
    expect(safeLink("mailto:a@b.c", "https://x.test/")).toBeUndefined();
    expect(safeLink("", "https://x.test/")).toBeUndefined();
  });
});

describe("tidy", () => {
  it("keeps at most one blank line", () => {
    expect(tidy("a\n\n\n\nb  \n\n")).toBe("a\n\nb");
  });
});
