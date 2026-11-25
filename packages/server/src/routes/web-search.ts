import { setPluginCredentialBodySchema } from "@suup/api";
import { searchPluginOf } from "@suup/connectors";
import { HttpError } from "../errors.js";
import type { Route } from "../http.js";

export const webSearchRoutes: Route[] = [
  {
    // The general search engines of the queue and where each stands. Reads nothing from the web and
    // starts nothing; never a key, never a search text. The key is kept by the engine (the routes below).
    method: "GET",
    pattern: "/v1/web-search",
    async handler(ctx) {
      const status = await ctx.runtime.webStatus();
      const providers = await ctx.runtime.webSearchProviders();
      return {
        body: {
          enabled: status.search !== "off",
          // The gallery's entry of each engine, by its exact id (`SEARCH_PLUGIN_CATALOG`).
          providers: providers.map((p) => {
            const entry = searchPluginOf(p.id);
            return {
              ...p,
              plugin:
                entry === undefined
                  ? null
                  : {
                      id: entry.id,
                      category: entry.category,
                      description: entry.description,
                      notes: [...entry.notes],
                      keySteps: [...entry.keySteps],
                    },
            };
          }),
        },
      };
    },
  },
  {
    // Write-only: the key goes to the engine's own place (marked as the engine's, outside the
    // owner's vault, never granted to a bot) and nothing brings it back.
    method: "PUT",
    pattern: "/v1/web-search/providers/:id/key",
    async handler(ctx) {
      const body = ctx.body(setPluginCredentialBodySchema);
      await ctx.runtime.pluginCredentials.setSearchKey(ctx.params.id ?? "", body.value);
      return { body: { stored: true } };
    },
  },
  {
    // Takes away only what the engine itself keeps.
    method: "DELETE",
    pattern: "/v1/web-search/providers/:id/key",
    async handler(ctx) {
      const gone = await ctx.runtime.pluginCredentials.removeSearchKey(ctx.params.id ?? "");
      if (!gone) throw new HttpError("not_found", "Este motor não tem uma chave guardada.");
      return { body: { deleted: true } };
    },
  },
];
