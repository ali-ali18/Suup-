import type { Message } from "../messages.js";
import { isReminderBlock } from "./prompts.js";

/**
 * Compact when the next request is estimated above this share of the context window. This is what
 * a run uses when its log does not say otherwise (a run recorded before the setting existed, or one
 * that loads no context, like an evaluation). The user's setting (`memory.compactionThreshold`,
 * default 0.8) is read at the start of a run and recorded in `context_loaded`.
 */
export const COMPACTION_THRESHOLD = 0.7;
/** The default of the user's setting, and the range it may take. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;
export const COMPACTION_THRESHOLD_RANGE = { min: 0.5, max: 0.95 } as const;
/** Messages at the end of the conversation that compaction always keeps verbatim. */
export const MIN_KEPT_MESSAGES = 4;

/**
 * Where to cut the conversation for compaction: the index of the first message that is kept.
 * Everything before it is summarized.
 *
 * The cut is always at an assistant message. The message before it is the user message holding
 * the results of the previous assistant turn, so no tool_call is ever separated from its
 * tool_result, and the kept tail starts with an assistant message right after the summary (which
 * is a user message). The tail has at least `MIN_KEPT_MESSAGES` messages, and the part to
 * summarize at least two (summarizing only an earlier summary would just churn).
 *
 * Returns `null` when no such cut exists.
 */
export function chooseCutIndex(
  messages: readonly Message[],
  minKept = MIN_KEPT_MESSAGES,
): number | null {
  for (let i = messages.length - minKept; i >= 2; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return null;
}

const TEXT_CAP = 4000;
const ARGS_CAP = 800;
const RESULT_CAP = 1600;

function clipMiddle(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.65);
  const tail = cap - head;
  return `${text.slice(0, head)} [... ${text.length - cap} characters omitted ...] ${text.slice(text.length - tail)}`;
}

/**
 * Renders messages as plain text for the summarizer. Long texts and tool results are shortened;
 * when the whole transcript still exceeds `maxChars`, its oldest part is cut.
 */
export function renderTranscript(messages: readonly Message[], maxChars: number): string {
  const lines: string[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      switch (block.type) {
        case "text":
          if (isReminderBlock(block)) break; // stale by now; the current one is re-injected
          lines.push(`[${message.role}] ${clipMiddle(block.text, TEXT_CAP)}`);
          break;
        case "tool_call":
          callNames.set(block.id, block.name);
          lines.push(
            `[assistant called ${block.name}] ${clipMiddle(JSON.stringify(block.args) ?? "null", ARGS_CAP)}`,
          );
          break;
        case "tool_result":
          lines.push(
            `[result of ${callNames.get(block.callId) ?? "a tool"}${block.isError ? ", error" : ""}] ${clipMiddle(block.content, RESULT_CAP)}`,
          );
          break;
        case "provider_data":
          break;
      }
    }
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `[... the oldest part of the transcript is omitted ...]\n${text.slice(text.length - maxChars)}`;
}
