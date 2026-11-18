import { z } from "zod";
import {
  type Block,
  blockSchema,
  type JsonValue,
  jsonObjectSchema,
  type Message,
} from "./messages.js";

/** What the model sees about a tool. `inputSchema` is a JSON Schema document (type "object"). */
export const toolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: jsonObjectSchema,
});
export type ToolSpec = z.infer<typeof toolSpecSchema>;

/**
 * Whether the model may, must, or must not skip calling tools:
 * `auto` (default) the model decides; `required` it must call some tool; `{ name }` it must call
 * that specific tool. Adapters whose vendor cannot express an option document their fallback.
 */
export const toolChoiceSchema = z.union([
  z.enum(["auto", "required"]),
  z.object({ name: z.string().min(1) }),
]);
export type ToolChoice = z.infer<typeof toolChoiceSchema>;

export interface GenerateRequest {
  /** Model id as the provider knows it. */
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Default `auto`. Ignored when `tools` is empty. */
  toolChoice?: ToolChoice;
  maxOutputTokens: number;
  temperature?: number;
  /** Aborting must cancel the in-flight request; the stream then fails with kind "aborted". */
  signal?: AbortSignal;
}

export const STOP_REASONS = ["end", "tool_calls", "max_tokens", "refusal", "other"] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
/**
 * Why generation stopped, normalized across providers:
 * `end` natural stop, `tool_calls` the model asked for tools, `max_tokens` output was cut by the
 * token limit, `refusal` a provider-side filter or refusal, `other` anything else.
 */
export type StopReason = z.infer<typeof stopReasonSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Part of `inputTokens` served from the prompt cache. */
  cachedInputTokens: z.exactOptional(z.number().int().nonnegative()),
  /** Part of `inputTokens` written to the prompt cache on this call (billed above the plain rate). */
  cacheWriteInputTokens: z.exactOptional(z.number().int().nonnegative()),
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * Normalized stream of a model response.
 *
 * Contract for adapters:
 * - `text_delta`: a chunk of visible text, in order.
 * - `tool_call`: emitted ONCE per call, complete, with `args` already parsed (never partial JSON).
 * - `provider_data`: opaque content to echo back to the same provider (see `ProviderDataBlock`).
 * - `usage`: additive. Each event is a delta that `collect` sums; most adapters emit exactly one.
 * - `done`: always the last event of a successful stream. `modelVersion` is the version the
 *   provider reports having served (not just the name requested).
 * Failures are signalled by the stream throwing a `ProviderError`, never by an event.
 */
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: JsonValue }
  | { type: "provider_data"; data: JsonValue }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteInputTokens?: number;
    }
  | { type: "done"; stopReason: StopReason; modelVersion: string };

export interface GenerateResult {
  blocks: Block[];
  stopReason: StopReason;
  usage: Usage;
  modelVersion: string;
}

export interface ProviderCapabilities {
  promptCache: boolean;
  parallelTools: boolean;
  vision: boolean;
}

export interface Provider {
  /** Stable id, also used as the `provider` of `provider_data` blocks (e.g. "anthropic"). */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * Starts a generation. Transient failures (rate limit, overload) are retried inside the adapter
   * before surfacing; what reaches the caller is a `ProviderError`.
   */
  generate(req: GenerateRequest): AsyncIterable<ProviderEvent>;
}

export const PROVIDER_ERROR_KINDS = [
  "rate_limit",
  "overloaded",
  "auth",
  "invalid_request",
  "context_overflow",
  "network",
  "aborted",
  "unknown",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderErrorOptions {
  /** Defaults to true for `rate_limit`, `overloaded` and `network`, false otherwise. */
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ProviderErrorKind;
  /** Whether trying the same request again may succeed. */
  readonly retryable: boolean;
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /** Server-suggested wait before retrying. */
  readonly retryAfterMs?: number;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.retryable =
      options.retryable ?? (kind === "rate_limit" || kind === "overloaded" || kind === "network");
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Folds a provider stream into a `GenerateResult`.
 *
 * Consecutive `text_delta` events become one text block; any other event closes the current text
 * block, so order is preserved. `usage` events are summed. Stops reading at `done`. A stream that
 * ends without `done` is an error (a truncated stream must never look like a finished answer).
 *
 * `provider` is the id stamped on `provider_data` blocks; pass `provider.id`
 * (or use `generateAndCollect`).
 */
export async function collect(
  stream: AsyncIterable<ProviderEvent>,
  provider = "unknown",
): Promise<GenerateResult> {
  const blocks: Block[] = [];
  let text = "";
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  let sawCached = false;
  let sawCacheWrite = false;

  const flushText = () => {
    if (text !== "") blocks.push({ type: "text", text });
    text = "";
  };

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_call":
        flushText();
        blocks.push({ type: "tool_call", id: event.id, name: event.name, args: event.args });
        break;
      case "provider_data":
        flushText();
        blocks.push({ type: "provider_data", provider, data: event.data });
        break;
      case "usage":
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
        if (event.cachedInputTokens !== undefined) {
          usage.cachedInputTokens += event.cachedInputTokens;
          sawCached = true;
        }
        if (event.cacheWriteInputTokens !== undefined) {
          usage.cacheWriteInputTokens += event.cacheWriteInputTokens;
          sawCacheWrite = true;
        }
        break;
      case "done": {
        flushText();
        return {
          blocks,
          stopReason: event.stopReason,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(sawCached ? { cachedInputTokens: usage.cachedInputTokens } : {}),
            ...(sawCacheWrite ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
          },
          modelVersion: event.modelVersion,
        };
      }
    }
  }
  throw new Error("provider stream ended without a done event");
}

/** `collect(provider.generate(req), provider.id)`. */
export function generateAndCollect(
  provider: Provider,
  req: GenerateRequest,
): Promise<GenerateResult> {
  return collect(provider.generate(req), provider.id);
}

export const generateResultSchema = z.object({
  blocks: z.array(blockSchema),
  stopReason: stopReasonSchema,
  usage: usageSchema,
  modelVersion: z.string(),
});
