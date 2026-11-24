import { CREATE_DOCUMENT_TOOL_NAME, SEND_FILE_TOOL_NAME } from "@suup/core";

/** The built-in tools that give a bot files on its machine (with `shell`, "a machine"). */
export const FILE_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
];

/**
 * A bot with a machine (a terminal or files) can always hand a file it made to the user's chat
 * (`send_file`, a read: the file goes to the user's own chat). Built in and always loaded, like the
 * network tool, so a bot created before the tool existed has it too. One function for the run, the
 * measurement and the replay, so all three offer the same tools in the same order.
 */
export function withSendFileTool<C extends { allowedTools: string[] }>(botCfg: C): C {
  const tools = botCfg.allowedTools;
  const hasMachine =
    tools.includes("shell") ||
    tools.includes(SEND_FILE_TOOL_NAME) ||
    FILE_TOOL_NAMES.some((n) => tools.includes(n));
  if (!hasMachine) return botCfg;
  // `create_document` builds a PDF, Word or Excel file and delivers it by the same seam, so every
  // bot that can send a file is offered it too (the bot's own images come from its workspace).
  const missing = [SEND_FILE_TOOL_NAME, CREATE_DOCUMENT_TOOL_NAME].filter(
    (n) => !tools.includes(n),
  );
  return missing.length === 0 ? botCfg : { ...botCfg, allowedTools: [...tools, ...missing] };
}
