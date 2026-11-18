import { describe, expect, it } from "vitest";
import { faviconUrl, parseLink } from "./links.js";

describe("parseLink: only real http(s) and mailto links, shown as the browser sees them", () => {
  it("accepts http, https and mailto, normalised", () => {
    expect(parseLink("https://example.com/a?b=1")).toEqual({
      href: "https://example.com/a?b=1",
      host: "example.com",
      scheme: "https",
    });
    expect(parseLink("http://example.com")).toMatchObject({
      scheme: "http",
      href: "http://example.com/",
    });
    expect(parseLink("mailto:a@b.co")).toMatchObject({ scheme: "mailto", href: "mailto:a@b.co" });
  });

  it("mixed-case schemes and hosts are normalised, not trusted as typed", () => {
    expect(parseLink("HtTpS://Example.COM/Path")).toMatchObject({
      href: "https://example.com/Path",
      host: "example.com",
    });
    expect(parseLink("MAILTO:x@y.zz")).toMatchObject({ scheme: "mailto" });
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "blob:https://example.com/uuid",
    "about:blank",
    "//evil.example/x",
    "/relative/path",
    "example.com",
    "",
    "https://",
    "https://exa mple.com",
  ])("refuses %j", (url) => {
    expect(parseLink(url)).toBeNull();
  });

  it("refuses userinfo tricks: the text says one host and the link goes to another", () => {
    expect(parseLink("https://google.com@evil.example/")).toBeNull();
    expect(parseLink("https://user:pass@example.com/")).toBeNull();
    expect(parseLink("http://trusted.example:443@evil.example/")).toBeNull();
    expect(parseLink("https://evil.example/?u=google.com@x")).not.toBeNull(); // an @ in the query is harmless
  });

  it("a lookalike (punycode) domain is shown in its ASCII form", () => {
    const link = parseLink("https://аррӏе.com/login");
    expect(link?.host).toMatch(/^xn--/);
    expect(link?.href).toMatch(/^https:\/\/xn--[a-z0-9-]+\.com\/login$/);
    expect(link?.href).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("faviconUrl: the host only, and only where it is safe to ask", () => {
  const icon = (url: string) => {
    const link = parseLink(url);
    return link === null ? null : faviconUrl(link);
  };

  it("https://<host>/favicon.ico, never a path, a query or a fragment of the message", () => {
    expect(icon("https://example.com/a/b?token=secret#frag")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(icon("https://Sub.Example.com:8443/x")).toBe("https://sub.example.com/favicon.ico");
    expect(icon("https://аррӏе.com/")).toMatch(/^https:\/\/xn--[a-z0-9-]+\.com\/favicon\.ico$/);
  });

  it.each([
    "http://example.com/",
    "mailto:a@b.co",
    "https://127.0.0.1/",
    "https://10.0.0.5/x",
    "https://[::1]/",
    "https://[2001:db8::1]/",
    "https://localhost/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://intranet/",
    "https://192.168.1.1:8080/",
  ])("no request for %s", (url) => {
    expect(icon(url)).toBeNull();
  });
});
