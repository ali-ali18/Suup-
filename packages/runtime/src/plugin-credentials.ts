// Owns where the credentials of PLUGINS live (docs/COFRE.md, "Credencial de plugin"): the token of
// a gallery connector and the key of a general search engine are kept WITH the plugin, in the
// vault's table but marked `managed_by` its owner, so they are never listed with the owner's
// secrets, never granted to a bot, and only Suup itself reads them (to open the connection, to
// ask the engine). The owner's name is exact, never guessed from a text:
//  - a connector's token: the connector's id (`github`), the name the installed connector has;
//  - a search engine's key: `search:<engine id>` (`search:tavily`), a space of its own so it can
//    never collide with a connector's name (the column holds up to 64 characters).
import { adoptSecret, type Db } from "@suup/db";
import { ENGINES, engineById } from "@suup/web";
import type { ConnectorGallery } from "./connectors/gallery.js";
import { RuntimeError } from "./errors.js";
import type { Vault } from "./vault/service.js";

/** The mark a search engine's key carries. */
export const searchKeyOwner = (engineId: string): string => `search:${engineId}`;

export interface PluginCredentials {
  /**
   * The plugin that owns a credential with exactly this vault name, as `{ owner, kind, pluginId }`, or
   * `undefined` when the name is not a plugin's. Exact comparison with the names the catalog and
   * the configuration declare.
   */
  ownerOf(
    name: string,
  ): { owner: string; kind: "connector" | "search"; pluginId: string } | undefined;
  /** Keeps a plugin credential by the vault name it is declared under. `false`: not a plugin's. */
  setByName(name: string, value: string): Promise<boolean>;
  /** Keeps the key of a general search engine with the engine. */
  setSearchKey(engineId: string, value: string): Promise<void>;
  /** Forgets the key the engine keeps (only that one). */
  removeSearchKey(engineId: string): Promise<boolean>;
  /**
   * Hands every credential that already exists over to its plugin (the migration, run at start-up
   * and idempotent): the key of each search engine that has a vault secret name, the token of each
   * installed token connector. Returns the owners that were adopted now.
   */
  adoptAll(): Promise<string[]>;
}

export function createPluginCredentials(options: {
  db: () => Db;
  vault: Vault;
  gallery: () => ConnectorGallery;
  /** The vault secret the key of an engine is kept under (the configuration's `secret`, or the default). */
  searchSecret(engineId: string): string | undefined;
}): PluginCredentials {
  const { vault } = options;
  /** The engines that take a key, each with its secret name. */
  const searchKeys = (): { id: string; secret: string }[] =>
    ENGINES.flatMap((e) => {
      if (!e.general || e.key === undefined) return [];
      const secret = options.searchSecret(e.id);
      return secret === undefined ? [] : [{ id: e.id, secret }];
    });
  const keyOf = (engineId: string): { id: string; secret: string } => {
    const found = searchKeys().find((k) => k.id === engineId);
    if (found === undefined) {
      throw new RuntimeError(
        "connector_not_found",
        `O motor de busca ${engineId} não existe ou não usa chave.`,
      );
    }
    return found;
  };

  const credentials: PluginCredentials = {
    ownerOf(name) {
      const connector = options.gallery().tokenOwner(name);
      if (connector !== undefined)
        return { owner: connector, kind: "connector", pluginId: connector };
      const engine = searchKeys().find((k) => k.secret === name);
      return engine === undefined
        ? undefined
        : { owner: searchKeyOwner(engine.id), kind: "search", pluginId: engine.id };
    },
    async setByName(name, value) {
      const found = credentials.ownerOf(name);
      if (found === undefined) return false;
      if (found.kind === "connector") await options.gallery().setToken(found.pluginId, value);
      else await credentials.setSearchKey(found.pluginId, value);
      return true;
    },
    async setSearchKey(engineId, value) {
      const { id, secret } = keyOf(engineId);
      const label = engineById(id)?.label ?? id;
      await adoptSecret(options.db(), secret, searchKeyOwner(id));
      await vault.set(secret, value, {
        description: `Chave do motor de busca ${label}, guardada pelo próprio plugin.`,
        managedBy: searchKeyOwner(id),
      });
    },
    async removeSearchKey(engineId) {
      const { id, secret } = keyOf(engineId);
      return vault.remove(secret, { managedBy: searchKeyOwner(id) });
    },
    async adoptAll() {
      const adopted: string[] = [];
      for (const { id, secret } of searchKeys()) {
        if (await adoptSecret(options.db(), secret, searchKeyOwner(id))) {
          adopted.push(searchKeyOwner(id));
        }
      }
      adopted.push(...(await options.gallery().adoptTokens()));
      return adopted;
    },
  };
  return credentials;
}
