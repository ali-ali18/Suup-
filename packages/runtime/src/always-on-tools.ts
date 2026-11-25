import { MEMORY_TOOL_NAMES, WEB_READ_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "@suup/core";

/** The tools every bot is always aware of, in a fixed order: memory first, then the web. */
export const ALWAYS_ON_TOOL_NAMES: readonly string[] = [
  ...MEMORY_TOOL_NAMES,
  WEB_SEARCH_TOOL_NAME,
  WEB_READ_TOOL_NAME,
];

/**
 * Memory and web search are things a bot should always know it has, whatever its grant list says
 * (a bot made before the tools existed has them too). Appends, at the end of `allowedTools`, the
 * always-on tools that the registry of this run really has (`available`: the registered names), in
 * a fixed order and without duplicates. A name the registry lacks (for example `web_search` with no
 * search engine configured) is never added. Shell, file tools and `web_fetch` stay by grant. Pure,
 * and one function for the run, the measurement and the replay, so all three offer the same tools in
 * the same order. The caller applies it only to a run that is not isolated.
 */
export function withAlwaysOnTools<C extends { allowedTools: string[] }>(
  botCfg: C,
  available: Iterable<string>,
): C {
  const registered = new Set(available);
  const tools = botCfg.allowedTools;
  const missing = ALWAYS_ON_TOOL_NAMES.filter((n) => registered.has(n) && !tools.includes(n));
  return missing.length === 0 ? botCfg : { ...botCfg, allowedTools: [...tools, ...missing] };
}
