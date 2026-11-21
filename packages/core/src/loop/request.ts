// Owns assembling the agent request: the fixed parts (system prompt and tool specs) and the
// conversation rebuilt from the log with the current STATE REMINDER appended to its tail.

import type { Message } from "../messages.js";
import { validateConversation } from "../messages.js";
import type { ToolSpec } from "../provider.js";
import { CONTROL_TOOL_NAMES, controlToolSpecs } from "./control-tools.js";
import {
  buildSystemPrompt,
  formatClock,
  isReminderBlock,
  MEMORY_TOOL_NAMES,
  renderStateReminder,
} from "./prompts.js";
import type { LoopContext } from "./run-context.js";

/** Whether this run may come back by itself: a conversation run of the user, not an evaluation. */
export function canScheduleReturn(ctx: LoopContext): boolean {
  return ctx.deps.allowReturns === true && ctx.run.origin === "user";
}

export function fixedParts(ctx: LoopContext): {
  system: string;
  tools: ToolSpec[];
  hostedToolSearch?: "bm25" | "regex";
} {
  const { bot, tools } = ctx.deps;
  const control = new Set<string>(CONTROL_TOOL_NAMES);
  // How the connector tools are offered was decided once and written to the log; here it is only
  // read, so every request of the run carries the same tools in the same order.
  const catalog = ctx.state.toolCatalog;
  const deferred = new Set(catalog?.deferred.map((d) => d.name) ?? []);
  const offered = [
    ...controlToolSpecs({
      secrets: ctx.deps.secrets !== undefined,
      scheduleReturn: canScheduleReturn(ctx),
      toolSearch: catalog?.mode,
    }),
    ...tools
      .specs(bot.allowedTools)
      .filter((spec) => !control.has(spec.name) && !deferred.has(spec.name)),
    // `hosted` and `client`: the definitions go in the request, last, marked as deferred. With
    // `meta` they are not sent at all (the model gets them from `search_tools`).
    ...(catalog !== null && (catalog.mode === "hosted" || catalog.mode === "client")
      ? catalog.deferred.map((d) => structuredClone(d.spec))
      : []),
  ];
  const memoryTools = offered.some((spec) =>
    (MEMORY_TOOL_NAMES as readonly string[]).includes(spec.name),
  );
  return {
    system: buildSystemPrompt(bot, ctx.state.context ?? undefined, {
      memoryTools,
      returns: canScheduleReturn(ctx),
      secrets: ctx.deps.secrets !== undefined,
      approvals: ctx.deps.gate.allowsEverything !== true,
      toolIndex: catalog?.index,
    }),
    tools: offered,
    ...(catalog?.mode === "hosted" && catalog.variant !== undefined
      ? { hostedToolSearch: catalog.variant }
      : {}),
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
        // The live time of this turn, in the time zone the run recorded at its start. It lives
        // here, in the last user turn, so the system prompt never changes during the run.
        ...(state.context?.now === undefined
          ? {}
          : { now: formatClock(ctx.deps.now(), state.context.now.timeZone) }),
      }),
    });
  }
  return { messages, problems };
}
