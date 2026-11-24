import { describe, expect, it } from "vitest";
import type { Vault } from "../src/vault/service.js";
import { createSearchKeys } from "../src/web/search-keys.js";

// Made-up keys, only for these tests.
const ENV_KEY = "tvly-env-key-not-real-0001";
const VAULT_KEY = "tvly-vault-key-not-real-0002";

/** A vault with the secrets it is given; `ok` false is a vault whose master key is not set. */
function fakeVault(secrets: Record<string, string>, ok = true): Vault & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    status: () => ({ configured: ok, keyEnv: "SUUP_VAULT_KEY", ok, keyId: null, reason: "" }),
    async resolveForConnector(names: readonly string[]) {
      asked.push([...names]);
      const out: Record<string, string> = {};
      for (const name of names) {
        const value = secrets[name];
        if (value === undefined) throw new Error(`o segredo ${name} não existe no cofre`);
        out[name] = value;
      }
      return out;
    },
  } as unknown as Vault & { asked: string[][] };
}

describe("where the keys of the general engines come from", () => {
  it("the environment variable first (the engine's own name by default), then the vault", async () => {
    const vault = fakeVault({ TAVILY_API_KEY: VAULT_KEY });
    const keys = createSearchKeys({
      env: { TAVILY_API_KEY: ENV_KEY },
      vault,
      settings: () => undefined,
    });
    expect(await keys.get("tavily")).toBe(ENV_KEY);
    expect(vault.asked).toEqual([]);
    const onlyVault = createSearchKeys({ env: {}, vault, settings: () => undefined });
    expect(await onlyVault.get("tavily")).toBe(VAULT_KEY);
    expect(vault.asked).toEqual([["TAVILY_API_KEY"]]);
  });

  it("the configuration names another variable and another vault secret", async () => {
    const vault = fakeVault({ MINHA_BRAVE: VAULT_KEY });
    const keys = createSearchKeys({
      env: { OUTRA_VARIAVEL: ENV_KEY },
      vault,
      settings: (id) =>
        id === "brave" ? { apiKeyEnv: "OUTRA_VARIAVEL", secret: "MINHA_BRAVE" } : undefined,
    });
    expect(await keys.get("brave")).toBe(ENV_KEY);
    expect(keys.names?.("brave")).toEqual({ env: "OUTRA_VARIAVEL", secret: "MINHA_BRAVE" });
    expect(keys.names?.("tavily")).toEqual({ env: "TAVILY_API_KEY", secret: "TAVILY_API_KEY" });
    const viaVault = createSearchKeys({
      env: {},
      vault,
      settings: () => ({ secret: "MINHA_BRAVE" }),
    });
    expect(await viaVault.get("brave")).toBe(VAULT_KEY);
  });

  it("no key anywhere is no key: an empty variable, a secret that does not exist, a vault that is not set up", async () => {
    expect(
      await createSearchKeys({
        env: { TAVILY_API_KEY: "   " },
        vault: fakeVault({}),
        settings: () => undefined,
      }).get("tavily"),
    ).toBeUndefined();
    expect(
      await createSearchKeys({
        env: {},
        vault: fakeVault({ TAVILY_API_KEY: VAULT_KEY }, false),
        settings: () => undefined,
      }).get("tavily"),
    ).toBeUndefined();
  });

  it("an engine that has no key at all (Wikipedia) has none to look for", async () => {
    const vault = fakeVault({});
    const keys = createSearchKeys({ env: {}, vault, settings: () => undefined });
    expect(await keys.get("wikipedia")).toBeUndefined();
    expect(keys.names?.("wikipedia")).toBeUndefined();
    expect(vault.asked).toEqual([]);
  });

  it("a vault that throws is no key, not an error in the search", async () => {
    const vault = {
      status: () => ({ ok: true }),
      resolveForConnector: async () => {
        throw new Error("a chave do cofre mudou");
      },
    } as unknown as Vault;
    expect(
      await createSearchKeys({ env: {}, vault, settings: () => undefined }).get("brave"),
    ).toBeUndefined();
  });
});
