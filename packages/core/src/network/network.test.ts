import { describe, expect, it } from "vitest";
import { decideHost, isForbiddenAddress, normalizeHost, parseAllowlistHost } from "./index.js";

describe("normalizeHost", () => {
  it("lowers the case and drops one trailing dot", () => {
    expect(normalizeHost("Registry.NPMJS.org.")).toEqual({
      kind: "name",
      name: "registry.npmjs.org",
    });
  });

  it("keeps the exact name: no suffix or wildcard forms", () => {
    expect(normalizeHost("*.npmjs.org").kind).toBe("invalid");
    expect(normalizeHost(".npmjs.org").kind).toBe("invalid");
    expect(normalizeHost("registry.npmjs.org..").kind).toBe("invalid");
  });

  it("recognises IP literals, bracketed or not", () => {
    expect(normalizeHost("1.2.3.4")).toEqual({ kind: "ip", address: "1.2.3.4" });
    expect(normalizeHost("[::1]")).toEqual({ kind: "ip", address: "::1" });
    expect(normalizeHost("::ffff:7f00:1").kind).toBe("ip");
  });

  it("refuses every other spelling of an address: they are not names", () => {
    for (const text of ["127.1", "0x7f.1", "2130706433", "017700000001", "0x7f000001", "1.2.3"]) {
      expect(normalizeHost(text).kind, text).toBe("invalid");
    }
  });

  it("refuses a single label and bad characters", () => {
    for (const text of [
      "localhost",
      "intranet",
      "a b.com",
      "exa_mple.com",
      "-a.com",
      "a-.com",
      "",
      " ",
    ]) {
      expect(normalizeHost(text).kind, text).toBe("invalid");
    }
  });

  it("converts an international name to punycode", () => {
    expect(normalizeHost("bücher.example")).toEqual({
      kind: "name",
      name: "xn--bcher-kva.example",
    });
  });
});

describe("parseAllowlistHost", () => {
  it("accepts a name and normalises it", () => {
    expect(parseAllowlistHost("PyPI.org")).toEqual({ ok: true, host: "pypi.org" });
  });
  it("says why an entry is refused", () => {
    expect(parseAllowlistHost("10.0.0.1")).toMatchObject({ ok: false });
    expect(parseAllowlistHost("localhost")).toMatchObject({ ok: false });
  });
});

describe("isForbiddenAddress (numeric ranges)", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.100.100.200",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:8.8.8.8",
    "fe80::1",
    "fd00:ec2::254",
    "fc00::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])("%s is forbidden", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "2606:4700::1111",
  ])("%s is public", (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it("treats something that is not an address as forbidden", () => {
    expect(isForbiddenAddress("example.com")).toBe(true);
    expect(isForbiddenAddress("")).toBe(true);
  });
});

describe("decideHost", () => {
  const allowed = new Set(["registry.npmjs.org", "pypi.org"]);

  it("allows an exact name on an allowed port, case and trailing dot aside", () => {
    expect(decideHost({ host: "Registry.npmjs.org.", port: 443 }, allowed)).toEqual({
      allow: true,
      host: "registry.npmjs.org",
      port: 443,
    });
  });

  it("refuses a sibling, a parent and a child: equality only", () => {
    for (const host of [
      "evil.registry.npmjs.org",
      "npmjs.org",
      "registry.npmjs.org.evil.com",
      "xregistry.npmjs.org",
    ]) {
      const verdict = decideHost({ host, port: 443 }, allowed);
      expect(verdict, host).toMatchObject({ allow: false, reason: "not_allowed" });
    }
  });

  it("refuses an IP literal and localhost even if somebody listed them", () => {
    const sneaky = new Set(["127.0.0.1", "localhost", "169.254.169.254"]);
    expect(decideHost({ host: "127.0.0.1", port: 80 }, sneaky)).toMatchObject({
      reason: "ip_literal",
    });
    expect(decideHost({ host: "169.254.169.254", port: 80 }, sneaky)).toMatchObject({
      reason: "ip_literal",
    });
    expect(decideHost({ host: "localhost", port: 80 }, sneaky)).toMatchObject({
      reason: "bad_host",
    });
  });

  it("refuses a port outside the list", () => {
    expect(decideHost({ host: "pypi.org", port: 22 }, allowed)).toMatchObject({
      reason: "bad_port",
    });
    expect(decideHost({ host: "pypi.org", port: 8080 }, allowed, [8080])).toMatchObject({
      allow: true,
    });
  });

  it("names the host in the message", () => {
    expect(decideHost({ host: "evil.example", port: 443 }, allowed)).toMatchObject({
      message: "host evil.example is not allowed for this bot",
    });
  });
});
