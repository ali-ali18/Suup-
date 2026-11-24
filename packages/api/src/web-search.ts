import { z } from "zod";

/**
 * Where one general web search engine of the queue stands, for Settings (`GET /v1/web-search`).
 * Never a key and never a search text: only the engine, its place in the queue, its state and how
 * many searches it answered this month.
 */
export const SEARCH_PROVIDER_STATES = [
  "ready",
  "no_key",
  "quota",
  "key_rejected",
  "unavailable",
  "off",
] as const;

/**
 * How the gallery presents an engine as a plugin (the category "Pesquisa na web"), declared in
 * `packages/connectors/src/catalog.ts` (`SEARCH_PLUGIN_CATALOG`) and pointing at the engine by its
 * exact id. Not a connector: the engine stays a built-in one.
 */
export const searchPluginSchema = z.object({
  /** The plugin's id in the gallery. */
  id: z.string(),
  /** The gallery section ("Pesquisa na web"). */
  category: z.string(),
  /** One line, pt-BR. */
  description: z.string(),
  /** Plain facts to show on its page, one friendly sentence each (pt-BR). */
  notes: z.array(z.string()),
  /** Where the person creates the key, step by step (pt-BR): shown in the secure form. */
  keySteps: z.array(z.string()),
});
export type SearchPlugin = z.infer<typeof searchPluginSchema>;

export const searchProviderSchema = z.object({
  id: z.string(),
  /** The name the person sees ("Tavily", "Brave Search"). */
  label: z.string(),
  /** 1 is tried first. Engines that are turned off come last. */
  position: z.number().int(),
  /**
   * `ready`: has a key and can answer. `no_key`: there is no key (the app offers to add one to the
   * vault). `quota`: the month's credits are used up. `key_rejected`: the service did not accept the
   * key. `unavailable`: it did not answer. `off`: turned off in the configuration.
   */
  state: z.enum(SEARCH_PROVIDER_STATES),
  /** For `quota`, `key_rejected` and `unavailable`: in how many seconds Suup tries it again, when known. */
  retryInSeconds: z.number().int().optional(),
  /** Searches this engine answered this calendar month (UTC). The text of a search is never kept. */
  searchesThisMonth: z.number().int(),
  /**
   * What a key is called: the vault secret the app writes (`PUT /v1/secrets/{secret}`) and the
   * environment variable the server also reads. Absent for an engine that needs no key.
   */
  keyNames: z.object({ secret: z.string(), env: z.string() }).optional(),
  /** How the gallery shows this engine as a plugin; `null` for an engine with no gallery entry. */
  plugin: searchPluginSchema.nullable(),
});
export type SearchProvider = z.infer<typeof searchProviderSchema>;

export const webSearchSchema = z.object({
  /** Whether web search is turned on in the configuration. */
  enabled: z.boolean(),
  /** The general engines in the order they are tried. */
  providers: z.array(searchProviderSchema),
});
export type WebSearchSettings = z.infer<typeof webSearchSchema>;
