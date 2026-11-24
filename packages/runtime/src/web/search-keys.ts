// Owns where the keys of the general search engines come from (docs/BUSCA.md, "A fila da busca
// geral"). Looked up at each search, so a key added to the vault while Suup runs is used at once:
//  1. the environment variable the configuration names (`apiKeyEnv`; by default the engine's own,
//     `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`);
//  2. the vault secret the configuration names (`secret`; by default the same name), the one the
//     app writes from Settings.
// An engine with neither has no key and is skipped. A key is never written to the configuration,
// to a log or to a test; the vault knows it for redaction as soon as it hands it over.
import { engineById, type SearchKeys } from "@suup/web";
import type { Vault } from "../vault/service.js";

type Env = Record<string, string | undefined>;

/** What the configuration says about one engine's key (`web.search.general.<id>`). */
export interface KeySettings {
  apiKeyEnv?: string | undefined;
  secret?: string | undefined;
}

export function createSearchKeys(options: {
  env: Env;
  vault: Vault;
  settings(engineId: string): KeySettings | undefined;
}): SearchKeys {
  const names = (id: string): { env: string; secret: string } | undefined => {
    const key = engineById(id)?.key;
    if (key === undefined) return undefined;
    const settings = options.settings(id);
    return {
      env: settings?.apiKeyEnv ?? key.defaultEnv,
      secret: settings?.secret ?? key.defaultSecret,
    };
  };
  return {
    names,
    async get(id) {
      const where = names(id);
      if (where === undefined) return undefined;
      const fromEnv = options.env[where.env]?.trim();
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      if (!options.vault.status().ok) return undefined;
      try {
        const found = (await options.vault.resolveForConnector([where.secret]))[where.secret];
        return found === undefined || found.trim() === "" ? undefined : found;
      } catch {
        // The secret does not exist, or the vault cannot be read right now: there is no key.
        return undefined;
      }
    },
  };
}
