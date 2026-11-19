// Owns one logical model call: recording the request once, each failed attempt as `model_error`
// and the response, adding usage and cost to the run, and retrying retryable provider errors with
// backoff. Used for the agent turn, the reviewer and the compaction summarizer alike.
import type { Message } from "../messages.js";
import {
  type GenerateResult,
  generateAndCollect,
  type Provider,
  ProviderError,
  type ToolChoice,
  type ToolSpec,
  type Usage,
} from "../provider.js";
import { record } from "./recording.js";
import type { ModelPricing } from "./reviewer.js";
import type { LoopContext } from "./run-context.js";

/** Loop-level retries of a retryable provider error (the adapter already retried). */
export const MAX_MODEL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

export type CallOutcome =
  | { kind: "ok"; result: GenerateResult }
  | { kind: "aborted" }
  | { kind: "error"; error: ProviderError };

export interface CallSpec {
  purpose: "agent" | "review" | "compaction";
  provider: Provider;
  model: { id: string; maxOutputTokens: number; pricing?: ModelPricing };
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  toolChoice?: ToolChoice;
  retries: number;
  /**
   * Counts as a turn against the run's limit. The agent's calls always do; a review or
   * summarizer call does not, except the extra calls of the reviewer's evidence rounds.
   */
  countsAsTurn?: boolean;
}

/**
 * One logical model call. Records the request once, then each failed attempt as a
 * `model_error`, and the response; adds usage to the run. Retries retryable errors with backoff.
 */
export async function callModel(ctx: LoopContext, spec: CallSpec): Promise<CallOutcome> {
  const { store, now, sleep } = ctx.deps;
  const reusable = ctx.state.sideResponse;
  if (
    spec.purpose !== "agent" &&
    reusable !== null &&
    reusable.purpose === spec.purpose &&
    reusable.seq === ctx.state.lastSeq
  ) {
    // A previous process got this answer and died before using it.
    return { kind: "ok", result: reusable.result };
  }
  const purposeField = spec.purpose === "agent" ? {} : { purpose: spec.purpose };
  const choiceField = spec.toolChoice === undefined ? {} : { toolChoice: spec.toolChoice };
  await record(ctx, {
    type: "model_request",
    payload: {
      provider: spec.provider.id,
      model: spec.model.id,
      system: spec.system,
      messages: spec.messages,
      tools: spec.tools,
      ...choiceField,
      maxOutputTokens: spec.model.maxOutputTokens,
      ...purposeField,
    },
  });

  for (let attempt = 1; ; attempt++) {
    const startedAt = now();
    let result: GenerateResult | undefined;
    let failure: ProviderError | undefined;
    try {
      result = await generateAndCollect(spec.provider, {
        model: spec.model.id,
        system: spec.system,
        messages: spec.messages,
        tools: spec.tools,
        ...choiceField,
        maxOutputTokens: spec.model.maxOutputTokens,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    } catch (caught) {
      failure = toProviderError(caught);
    }

    if (result !== undefined) {
      // Usage first: if the process dies before the response is logged, the money was still
      // spent, so over-counting is the right way to be wrong.
      await store.addUsage(ctx.runId, {
        turns: spec.purpose === "agent" || spec.countsAsTurn === true ? 1 : 0,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: computeCost(result.usage, spec.model.pricing),
      });
      await record(ctx, {
        type: "model_response",
        payload: {
          blocks: result.blocks,
          stopReason: result.stopReason,
          usage: result.usage,
          modelVersion: result.modelVersion,
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          ...purposeField,
        },
      });
      return { kind: "ok", result };
    }

    const error = failure as ProviderError;
    await record(ctx, {
      type: "model_error",
      payload: {
        kind: error.kind,
        message: error.message,
        retryable: error.retryable,
        attempt,
        ...purposeField,
      },
    });
    if (error.kind === "aborted" && ctx.signal?.aborted) return { kind: "aborted" };
    if (!error.retryable || attempt > spec.retries) return { kind: "error", error };
    await sleep(error.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    if (ctx.signal?.aborted) return { kind: "aborted" };
  }
}

export function computeCost(usage: Usage, pricing: ModelPricing | undefined): number {
  if (pricing === undefined) return 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const writeRate = pricing.cacheWriteInputPerMTok ?? pricing.inputPerMTok;
  return (
    ((usage.inputTokens - cached - written) * pricing.inputPerMTok +
      cached * cachedRate +
      written * writeRate +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("unknown", error instanceof Error ? error.message : String(error), {
    retryable: false,
    cause: error,
  });
}
