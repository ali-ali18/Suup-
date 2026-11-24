import { searchPluginOf } from "@suup/connectors";
import type { Route } from "../http.js";

export const webSearchRoutes: Route[] = [
  {
    // The general search engines of the queue and where each stands. Reads nothing from the web and
    // starts nothing; never a key, never a search text. The key is added through `PUT /v1/secrets/{nome}`.
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
];
