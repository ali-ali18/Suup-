// Owns which URLs a run has seen, for `web_read` (docs/BUSCA.md, "A leitura só abre o que já
// apareceu"): the ones the user wrote, then the ones search results and pages read put in front of
// the model. All of it is derived from the log (`userSaid` and the `webUrls` of tool results), so a
// resumed or replayed run clears exactly the same addresses.
import { urlsInText, type WebUrlSource } from "../web.js";
import type { RunState } from "./state.js";

/** Every normalized URL the run has seen, with where it first appeared (the user's words come first). */
export function webUrlsSeen(
  state: Pick<RunState, "userSaid" | "webSeen">,
): Map<string, WebUrlSource> {
  const seen = new Map<string, WebUrlSource>();
  for (const message of state.userSaid) {
    for (const url of urlsInText(message)) if (!seen.has(url)) seen.set(url, "user_message");
  }
  for (const [url, source] of state.webSeen) if (!seen.has(url)) seen.set(url, source);
  return seen;
}
