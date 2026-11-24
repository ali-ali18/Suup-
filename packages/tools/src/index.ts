import type { Tool, ToolRegistry } from "@suup/core";
import { editFileTool } from "./edit-file.js";
import { forgetTool } from "./forget.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { recallTool } from "./recall.js";
import { rememberTool } from "./remember.js";
import { requestNetworkAccessTool } from "./request-network-access.js";
import { searchConversationsTool } from "./search-conversations.js";
import { searchFilesTool } from "./search-files.js";
import { shellTool } from "./shell.js";
import { webFetchTool } from "./web-fetch.js";
import { webReadTool } from "./web-read.js";
import { webSearchTool } from "./web-search.js";
import { writeFileTool } from "./write-file.js";

export { createDocumentTool } from "./create-document.js";
export { editFileTool } from "./edit-file.js";
export { forgetTool } from "./forget.js";
export { decodeEntities, type HtmlText, htmlToText } from "./html-to-text.js";
export { listFilesTool } from "./list-files.js";
export { readFileTool } from "./read-file.js";
export { recallTool } from "./recall.js";
export { rememberTool } from "./remember.js";
export { requestNetworkAccessTool } from "./request-network-access.js";
export { searchConversationsTool } from "./search-conversations.js";
export { buildSearchCommand, searchFilesTool } from "./search-files.js";
export { sendFileTool } from "./send-file.js";
export { shellTool } from "./shell.js";
export { shellJoin, shellQuote } from "./shell-quote.js";
export { buildCurlCommand, webFetchTool } from "./web-fetch.js";
export { formatRead, webReadTool } from "./web-read.js";
export { formatSearch, webSearchTool } from "./web-search.js";
export { writeFileTool } from "./write-file.js";

/** Every built-in tool, in the order they are shown to the model. */
export const builtinTools: readonly Tool<unknown>[] = [
  erase(shellTool),
  erase(readFileTool),
  erase(writeFileTool),
  erase(editFileTool),
  erase(listFilesTool),
  erase(searchFilesTool),
  erase(webFetchTool),
  erase(webSearchTool),
  erase(webReadTool),
];

/**
 * The tool that asks the user for a network host. Only the isolated machine has a proxy to allow
 * hosts on, so the runtime registers it for the docker sandbox only (a local machine and the
 * evaluations never see it).
 */
export const networkTools: readonly Tool<unknown>[] = [erase(requestNetworkAccessTool)];

/**
 * The memory tools (plan section 4.4, phase 2). They only work in a run whose context carries a
 * `MemoryService`; without one each returns an error result saying memory is unavailable.
 */
export const memoryTools: readonly Tool<unknown>[] = [
  erase(rememberTool),
  erase(recallTool),
  erase(forgetTool),
  erase(searchConversationsTool),
];

function erase<I>(tool: Tool<I>): Tool<unknown> {
  return tool as Tool<unknown>;
}

/** Registers the built-in tools and the memory tools. Throws if one of the names is already taken. */
export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of [...builtinTools, ...memoryTools]) registry.register(tool);
  return registry;
}
