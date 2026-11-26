import { describe, expect, it } from "vitest";
import { checkSecretHost, destinationHost, SecretDestinationRefusedError } from "./secrets.js";

// KOD-36: the check a connector's address goes through before a user's secret is read for it.
describe("checkSecretHost", () => {
  const refusal = (fn: () => void): SecretDestinationRefusedError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretDestinationRefusedError);
      return error as SecretDestinationRefusedError;
    }
    throw new Error("it was not refused");
  };

  it("lets a host in the list through, by exact equality", () => {
    expect(() =>
      checkSecretHost("API_TOKEN", ["api.exemplo.test", "outro.test"], "api.exemplo.test"),
    ).not.toThrow();
  });

  it("refuses a host outside the list, naming the allowed ones and the whole list to declare", () => {
    const error = refusal(() =>
      checkSecretHost("API_TOKEN", ["api.exemplo.test"], "mcp.outro.test"),
    );
    expect(error.secretName).toBe("API_TOKEN");
    expect(error.host).toBe("mcp.outro.test");
    expect(error.message).toContain("só pode ir para api.exemplo.test, não para mcp.outro.test");
    // `suup vault hosts` replaces the list: the suggestion keeps what was there.
    expect(error.message).toContain(
      "suup vault hosts API_TOKEN --host api.exemplo.test --host mcp.outro.test",
    );
  });

  it("refuses look-alikes: a subdomain, a longer name, a parent", () => {
    for (const url of [
      "https://sub.api.exemplo.test/mcp",
      "https://api.exemplo.test.atacante.test/mcp",
      "https://api.exemplo.test@atacante.test/mcp",
      "https://exemplo.test/mcp",
    ]) {
      refusal(() => checkSecretHost("API_TOKEN", ["api.exemplo.test"], destinationHost(url)));
    }
    // The same site written differently is the same host (the URL API normalizes it).
    expect(() =>
      checkSecretHost(
        "API_TOKEN",
        ["api.exemplo.test"],
        destinationHost("HTTPS://API.Exemplo.TEST./mcp"),
      ),
    ).not.toThrow();
  });

  it("refuses a secret with no hosts declared (it is blocked)", () => {
    const error = refusal(() => checkSecretHost("API_TOKEN", [], "api.exemplo.test"));
    expect(error.message).toContain("ainda não tem endereços declarados");
  });

  it("refuses an address with no site name (an IP address)", () => {
    expect(destinationHost("http://127.0.0.1:8080/mcp")).toBeUndefined();
    const error = refusal(() => checkSecretHost("API_TOKEN", ["api.exemplo.test"], undefined));
    expect(error.message).toContain("não tem um nome de site");
  });
});
