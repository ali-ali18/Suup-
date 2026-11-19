// Owns what a model call costs: the price list of a model and the arithmetic over a usage.
import type { Usage } from "./provider.js";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  /** Price of tokens written to the prompt cache; defaults to `inputPerMTok`. */
  cacheWriteInputPerMTok?: number;
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
