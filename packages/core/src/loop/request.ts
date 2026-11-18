// Owns assembling the agent request: the fixed parts (system prompt and tool specs) and the
// conversation rebuilt from the log with the current STATE REMINDER appended to its tail.

import type { Message } from "../messages.js";
import { validateConversation } from "../messages.js";
import type { ToolSpec } from "../provider.js";
import { CONTROL_TOOL_NAMES, controlToolSpecs } from "./control-tools.js";
import { buildSystemPrompt, isReminderBlock, renderStateReminder } from "./prompts.js";
import type { LoopContext } from "./run-context.js";

export function fixedParts(ctx: LoopContext): { system: string; tools: ToolSpec[] } {
  const { bot, tools } = ctx.deps;
  const control = new Set<string>(CONTROL_TOOL_NAMES);
  return {
    system: buildSystemPrompt(bot),
    tools: [
      ...controlToolSpecs(),
      ...tools.specs(bot.allowedTools).filter((spec) => !control.has(spec.name)),
    ],
  };
}

/** The request for the next turn: the rebuilt conversation plus the STATE REMINDER. */
export function buildRequest(ctx: LoopContext): { messages: Message[]; problems: string[] } {
  const state = ctx.state;
  const problems = validateConversation(state.messages);
  const last = state.messages[state.messages.length - 1];
  if (last === undefined || last.role !== "user") {
    problems.push("the conversation does not end with a user message");
  }
  const messages = structuredClone(state.messages);
  const tail = messages[messages.length - 1];
  if (tail !== undefined && tail.role === "user") {
    // A reminder already in the tail belongs to a request that was never answered (it failed
    // and is being rebuilt, or the process died): replace it with the current one.
    tail.blocks = tail.blocks.filter((b) => !isReminderBlock(b));
    tail.blocks.push({
      type: "text",
      text: renderStateReminder({
        objective: ctx.run.objective,
        acceptanceCriteria: ctx.run.acceptanceCriteria,
        plan: state.plan,
      }),
    });
  }
  return { messages, problems };
}
