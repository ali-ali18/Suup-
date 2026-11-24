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
      return { body: { enabled: status.search !== "off", providers } };
    },
  },
];
