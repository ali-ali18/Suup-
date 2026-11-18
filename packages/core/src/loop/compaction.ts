// Owns compaction orchestration: deciding when the next request is too large, and summarizing
// the oldest part of the conversation through a model call (the cut and the transcript rendering
// themselves live in context.ts).
import { COMPACTION_THRESHOLD, chooseCutIndex, renderTranscript } from "./context.js";
import { callModel } from "./model-call.js";
import { COMPACTION_SYSTEM } from "./prompts.js";
import { record } from "./recording.js";
import { fixedParts } from "./request.js";
import { Interrupted, type LoopContext } from "./run-context.js";
import { estimateTokens } from "./state.js";

const SUMMARY_MAX_OUTPUT_TOKENS = 4096;

/** Compacts when the next request is estimated above the threshold of the context window. */
export async function compactIfNeeded(ctx: LoopContext): Promise<void> {
  const { system, tools } = fixedParts(ctx);
  const estimate = estimateTokens(ctx.state, system.length + JSON.stringify(tools).length);
  if (estimate > COMPACTION_THRESHOLD * ctx.deps.bot.model.contextWindow) {
    await compact(ctx);
  }
}

/** Summarizes the oldest part of the conversation. Returns false when there is nothing to cut. */
export async function compact(ctx: LoopContext): Promise<boolean> {
  const { bot, provider } = ctx.deps;
  const state = ctx.state;
  const cut = chooseCutIndex(state.messages);
  const uptoSeq = cut === null ? undefined : state.messageSeqs[cut - 1];
  if (cut === null || uptoSeq === undefined) return false;

  const dropped = state.messages.slice(0, cut);
  const transcript = renderTranscript(dropped, Math.floor(bot.model.contextWindow * 4 * 0.5));
  const outcome = await callModel(ctx, {
    purpose: "compaction",
    provider,
    model: {
      ...bot.model,
      maxOutputTokens: Math.min(bot.model.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS),
    },
    system: COMPACTION_SYSTEM,
    messages: [
      {
        role: "user",
        blocks: [
          {
            type: "text",
            text: `Summarize this earlier part of the conversation:\n\n${transcript}`,
          },
        ],
      },
    ],
    tools: [],
    retries: 0,
  });
  if (outcome.kind === "aborted") throw new Interrupted();

  let summary = "";
  let warning = "";
  if (outcome.kind === "error") {
    warning = `summarizing failed (${outcome.error.kind}: ${outcome.error.message})`;
  } else {
    summary = outcome.result.blocks
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n")
      .trim();
    if (summary === "") warning = "the summarizer returned no text";
  }

  if (warning === "") {
    await record(ctx, {
      type: "compacted",
      payload: { summary, uptoSeq, droppedMessages: dropped.length },
    });
  } else {
    await record(ctx, {
      type: "compacted",
      payload: {
        summary: `[The earlier part of the conversation (${dropped.length} messages) was dropped because it could not be summarized. Do not rely on what it contained: check the actual state (files, tool results) before acting on anything done earlier.]`,
        uptoSeq,
        droppedMessages: dropped.length,
        degraded: true,
        warning,
      },
    });
  }
  return true;
}
