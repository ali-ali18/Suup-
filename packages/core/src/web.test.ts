import { describe, expect, it } from "vitest";
import { normalizeWebUrl, urlsInText } from "./web.js";

describe("normalizeWebUrl", () => {
  it("writes scheme and host in lower case, leaves out the default port and drops the fragment", () => {
    expect(normalizeWebUrl("HTTPS://Example.COM:443/Path#section")).toBe(
      "https://example.com/Path",
    );
    expect(normalizeWebUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeWebUrl("https://example.com:8443/a")).toBe("https://example.com:8443/a");
    expect(normalizeWebUrl("https://example.com/a#")).toBe("https://example.com/a");
  });

  it("keeps path and query exactly: a trailing slash makes another URL, and percent-encoding is not touched", () => {
    expect(normalizeWebUrl("https://example.com/a")).not.toBe(
      normalizeWebUrl("https://example.com/a/"),
    );
    expect(normalizeWebUrl("https://example.com/a?x=1%2F2")).toBe("https://example.com/a?x=1%2F2");
    expect(normalizeWebUrl("https://example.com/a?x=1%2f2")).toBe("https://example.com/a?x=1%2f2");
    expect(normalizeWebUrl("https://example.com/a?b=2&a=1")).toBe("https://example.com/a?b=2&a=1");
    // The standard itself writes an empty path as "/": both spellings are the same address.
    expect(normalizeWebUrl("https://example.com")).toBe("https://example.com/");
  });

  it("is only for http and https", () => {
    expect(normalizeWebUrl("ftp://example.com/a")).toBeUndefined();
    expect(normalizeWebUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeWebUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeWebUrl("example.com/a")).toBeUndefined();
    expect(normalizeWebUrl("")).toBeUndefined();
  });
});

describe("urlsInText", () => {
  it("finds the addresses a person wrote, normalized", () => {
    expect(urlsInText("leia https://Example.com/a#x e depois http://other.org:80/b")).toEqual([
      "https://example.com/a",
      "http://other.org/b",
    ]);
  });

  it("offers an address with and without the mark of the sentence around it", () => {
    const found = urlsInText("Veja (https://example.com/wiki/Foo_(bar)). Obrigado!");
    expect(found).toContain("https://example.com/wiki/Foo_(bar)");
    expect(found).toContain("https://example.com/wiki/Foo_(bar");
    const plain = urlsInText("Entre em https://example.com/a, por favor.");
    expect(plain).toContain("https://example.com/a");
    expect(plain).toContain("https://example.com/a,");
  });

  it("reads an address inside Markdown, angle brackets and quotes", () => {
    expect(
      urlsInText(
        "[site](https://example.com/a) e <https://example.com/b> e 'https://example.com/c'",
      ),
    ).toEqual(
      expect.arrayContaining([
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ]),
    );
  });

  it("does not take an address nobody wrote", () => {
    expect(urlsInText("sem nenhum endereço aqui, só example.com e www.example.org")).toEqual([]);
    expect(urlsInText("ftp://example.com/a mailto:a@b.com")).toEqual([]);
    // Only the written host: the neighbours of that address are other addresses.
    const found = urlsInText("https://example.com/a");
    expect(found).not.toContain("https://example.com/");
    expect(found).not.toContain("https://example.com/a/");
  });
});
