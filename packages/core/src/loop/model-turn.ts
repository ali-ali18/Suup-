// Owns the agent's model turn: building the request, calling the model, and turning provider
// errors into run outcomes (one compaction-and-retry on context overflow, otherwise failure).
import { compact } from "./compaction.js";
import { callModel, MAX_MODEL_RETRIES } from "./model-call.js";
import { fail } from "./recording.js";
import { buildRequest, fixedParts } from "./request.js";
import { Interrupted, type LoopContext } from "./run-context.js";
import type { RunStatus } from "./store.js";

/** `undefined` means a response was recorded and the loop should go on. */
export async function modelTurn(ctx: LoopContext): Promise<RunStatus | undefined> {
  const { bot, provider } = ctx.deps;
  let overflowRetried = false;
  for (;;) {
    const { system, systemCacheBreak, tools, hostedToolSearch } = fixedParts(ctx);
    // Read once: the time in the reminder is the one recorded with the request (`model_request.at`).
    const at = ctx.deps.now();
    const { messages, problems } = buildRequest(ctx, at);
    if (problems.length > 0) {
      return fail(
        ctx,
        "harness",
        `the rebuilt conversation is invalid, so no request was sent: ${problems.join("; ")}`,
      );
    }
    const outcome = await callModel(ctx, {
      purpose: "agent",
      at,
      provider,
      model: bot.model,
      system,
      systemCacheBreak,
      messages,
      tools,
      ...(hostedToolSearch === undefined ? {} : { hostedToolSearch }),
      retries: MAX_MODEL_RETRIES,
    });
    if (outcome.kind === "ok") return undefined;
    if (outcome.kind === "aborted") throw new Interrupted();

    const { error } = outcome;
    if (error.kind === "context_overflow" && !overflowRetried) {
      overflowRetried = true;
      if (await compact(ctx)) continue;
      return fail(
        ctx,
        "limit",
        "Parei porque a conversa ficou grande demais para o modelo e não dá para resumi-la mais.",
      );
    }
    return fail(ctx, "provider", `${error.kind}: ${error.message}`);
  }
}
