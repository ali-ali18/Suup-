import { describe, expect, it } from "vitest";
import { webReadTool } from "../src/web-read.js";

const key = (url: string) => webReadTool.grantKey?.({ url }, {} as never);

describe("web_read: the key of the run's grant is the normalized host", () => {
  it("the accented path and its %-encoded spelling are the same key", () => {
    expect(key("https://pt.wikipedia.org/wiki/Fotossíntese")).toBe(
      key("https://pt.wikipedia.org/wiki/Fotoss%C3%ADntese"),
    );
    expect(key("https://pt.wikipedia.org/wiki/Fotossíntese")).toBe("pt.wikipedia.org");
  });
  it("a different path or query on the host is the same key", () => {
    expect(key("https://pt.wikipedia.org/wiki/Clima?x=1#a")).toBe(key("https://pt.wikipedia.org/"));
  });
  it("an upper-case host and an IDN host equal their normalized form", () => {
    expect(key("https://PT.Wikipedia.ORG/x")).toBe("pt.wikipedia.org");
    expect(key("https://bücher.example/x")).toBe(key("https://xn--bcher-kva.example/y"));
  });
  it("another host is another key: www, a subdomain, a different site", () => {
    expect(key("https://www.example.com/")).not.toBe(key("https://example.com/"));
    expect(key("https://a.example.com/")).not.toBe(key("https://example.com/"));
    expect(key("https://example.com/")).not.toBe(key("https://example.org/"));
  });
  it("an address with no DNS host has no key (no grant)", () => {
    expect(key("http://127.0.0.1/x")).toBeUndefined();
    expect(key("not a url")).toBeUndefined();
  });
});
