import type { Tool, ToolRegistry } from "@suup/core";
import { editFileTool } from "./edit-file.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { searchFilesTool } from "./search-files.js";
import { shellTool } from "./shell.js";
import { webFetchTool } from "./web-fetch.js";
import { writeFileTool } from "./write-file.js";

export { editFileTool } from "./edit-file.js";
export { decodeEntities, type HtmlText, htmlToText } from "./html-to-text.js";
export { listFilesTool } from "./list-files.js";
export { readFileTool } from "./read-file.js";
export { buildSearchCommand, searchFilesTool } from "./search-files.js";
export { shellTool } from "./shell.js";
export { shellJoin, shellQuote } from "./shell-quote.js";
export { buildCurlCommand, webFetchTool } from "./web-fetch.js";
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
];

function erase<I>(tool: Tool<I>): Tool<unknown> {
  return tool as Tool<unknown>;
}

/** Registers all built-in tools. Throws if one of the names is already taken. */
export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  for (const tool of builtinTools) registry.register(tool);
  return registry;
}
