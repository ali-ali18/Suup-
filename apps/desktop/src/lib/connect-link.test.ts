import { describe, expect, it } from "vitest";
import { linkAllowed, linkExpired } from "./connect-link.js";

const HOSTS = ["connect.composio.dev"];

describe("the link of a connect card", () => {
  it("is allowed only for https and a host that is exactly one the connector declares", () => {
    expect(linkAllowed("https://connect.composio.dev/link/lk_abc?x=1", HOSTS)).toBe(true);
    for (const bad of [
      "http://connect.composio.dev/link/abc",
      "https://connect.composio.dev.evil.example/link/abc",
      "https://evil.example/connect.composio.dev/link/x",
      "https://user:pw@connect.composio.dev/link/s",
      "https://accounts.google.com/o/oauth2/auth?x=1",
      "javascript:alert(1)",
      "backend.composio.dev",
      "",
    ]) {
      expect(linkAllowed(bad, HOSTS), bad).toBe(false);
    }
    expect(linkAllowed("https://connect.composio.dev/link/x", [])).toBe(false);
    // With the first segment the service declares: /link/ yes, /mcp and the bare host no.
    expect(linkAllowed("https://connect.composio.dev/link/lk_1", HOSTS, "link")).toBe(true);
    for (const path of ["/mcp", "/", "/linkx/a", "/x/link/a"])
      expect(linkAllowed(`https://connect.composio.dev${path}`, HOSTS, "link"), path).toBe(false);
  });

  it("expires when the service said so, and never when it did not", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(linkExpired(undefined, now)).toBe(false);
    expect(linkExpired("2026-11-24T11:59:00Z", now)).toBe(true);
    expect(linkExpired("2026-11-24T12:01:00Z", now)).toBe(false);
    expect(linkExpired("not a date", now)).toBe(false);
  });
});
