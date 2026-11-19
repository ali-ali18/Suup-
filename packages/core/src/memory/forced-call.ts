// The one way the memory code asks a model for a structured answer: a single forced tool call, a
// timeout, no retries, and a result that says what it cost. The same plumbing as the approvals
// reviewer (`createModelReviewer`): an error, a timeout or an answer it cannot read is a FAILURE,
// never a guess, and the caller decides what a failure means (here: nothing is written).
import { computeCost, type ModelPricing } from "../pricing.js";
import {
  type GenerateResult,
  generateAndCollect,
  type Provider,
  ProviderError,
  type ToolSpec,
  type Usage,
} from "../provider.js";

export interface ForcedCallModel {
  id: string;
  maxOutputTokens: number;
  pricing?: ModelPricing | undefined;
  /** Default true. With false the answer is asked for by instruction only. */
  supportsForcedToolChoice?: boolean | undefined;
}

export type ForcedCallResult =
  | {
      ok: true;
      args: Record<string, unknown>;
      usage: Usage;
      costUsd: number;
      latencyMs: number;
    }
  | {
      ok: false;
      failure: "error" | "timeout" | "invalid_output";
      detail: string;
      usage: Usage;
      costUsd: number;
      latencyMs: number;
    };

const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };

/** Asks `model` once, forcing the call of `tool`; the arguments of that call are the answer. */
export async function askForcedTool(options: {
  provider: Provider;
  model: ForcedCallModel;
  system: string;
  user: string;
  tool: ToolSpec;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  now?: () => Date;
}): Promise<ForcedCallResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const latency = () => Math.max(0, now().getTime() - startedAt.getTime());
  const forced = options.model.supportsForcedToolChoice !== false;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, options.timeoutMs);
  });
  const ask = (toolChoice: "auto" | { name: string }) =>
    generateAndCollect(options.provider, {
      model: options.model.id,
      system: options.system,
      messages: [{ role: "user", blocks: [{ type: "text", text: options.user }] }],
      tools: [options.tool],
      toolChoice,
      maxOutputTokens: Math.min(options.model.maxOutputTokens, options.maxOutputTokens),
      signal: controller.signal,
    });
  const fail = (
    failure: "error" | "timeout" | "invalid_output",
    detail: string,
    usage: Usage = ZERO,
  ): ForcedCallResult => ({
    ok: false,
    failure,
    detail,
    usage,
    costUsd: computeCost(usage, options.model.pricing),
    latencyMs: latency(),
  });
  try {
    const attempt: Promise<GenerateResult> = (async () => {
      try {
        return await ask(forced ? { name: options.tool.name } : "auto");
      } catch (error) {
        // A model that refuses a forced choice is asked once more by instruction only.
        if (forced && error instanceof ProviderError && error.kind === "invalid_request") {
          return await ask("auto");
        }
        throw error;
      }
    })();
    attempt.catch(() => undefined); // the answer that loses the race is dropped quietly
    const outcome = await Promise.race([attempt, timeout]);
    if (outcome === "timeout") return fail("timeout", "o modelo demorou demais");
    const call = outcome.blocks.find((b) => b.type === "tool_call" && b.name === options.tool.name);
    if (call === undefined || call.type !== "tool_call") {
      return fail("invalid_output", "o modelo não chamou a ferramenta pedida", outcome.usage);
    }
    const args = call.args;
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return fail("invalid_output", "os argumentos não são um objeto", outcome.usage);
    }
    return {
      ok: true,
      args: args as Record<string, unknown>,
      usage: outcome.usage,
      costUsd: computeCost(outcome.usage, options.model.pricing),
      latencyMs: latency(),
    };
  } catch (error) {
    return fail("error", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** JSON for a prompt: `<` is written as `<` (still valid JSON), so a value cannot close its block. */
export function quotedForPrompt(text: string): string {
  return JSON.stringify(text).replaceAll("<", "\\u003c");
}

/** Cuts text to `max` characters, saying how much went. */
export function clipText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)} [cut: ${text.length - max} more characters]`;
}
