import {
  type GenerateRequest,
  type JsonValue,
  type Message,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  type ProviderEvent,
  type StopReason,
  validateConversation,
} from "@suup/core";
import {
  asNumber,
  asRecord,
  asString,
  buildError,
  classifyStatus,
  type ErrorClass,
  looksLikeContextOverflow,
  malformedEvent,
  parseRetryAfter,
  prematureEnd,
  truncate,
} from "./common.js";
import type { SseMessage } from "./sse.js";
import {
  type BaseProviderConfig,
  mergeHeaders,
  resolveTransport,
  streamWithRetry,
  type WireHooks,
} from "./transport.js";

export interface AnthropicProviderConfig extends BaseProviderConfig {
  /** Default "https://api.anthropic.com". A trailing "/v1" is accepted. */
  baseUrl?: string;
  /** `anthropic-version` header. Default "2023-06-01". */
  anthropicVersion?: string;
  /** Sent as the comma-separated `anthropic-beta` header. */
  betas?: string[];
  /**
   * Mark the system prompt, the last tool and the last user block with `cache_control`
   * (ephemeral). Default true.
   */
  promptCache?: boolean;
}

const VENDOR = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const CACHE = { type: "ephemeral" } as const;

type Wire = Record<string, unknown>;

export function createAnthropicProvider(config: AnthropicProviderConfig): Provider {
  const transport = resolveTransport(config);
  const promptCache = config.promptCache ?? true;
  const capabilities: ProviderCapabilities = { promptCache, parallelTools: true, vision: true };
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const headers = mergeHeaders(
    {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": config.apiKey,
      "anthropic-version": config.anthropicVersion ?? "2023-06-01",
      ...(config.betas !== undefined && config.betas.length > 0
        ? { "anthropic-beta": config.betas.join(",") }
        : {}),
    },
    config.headers,
  );

  return {
    id: config.id,
    capabilities,
    async *generate(req: GenerateRequest): AsyncGenerator<ProviderEvent> {
      const problems = validateConversation(req.messages);
      if (problems.length > 0) {
        throw new ProviderError("invalid_request", `invalid conversation: ${problems.join("; ")}`);
      }
      const body = buildAnthropicBody(req, config.id, promptCache, config.extraBody);
      const hooks: WireHooks = {
        mapHttpError: mapAnthropicHttpError,
        parse: (messages) => parseAnthropicStream(messages, req.model),
      };
      yield* streamWithRetry(transport, { url, headers, body }, req.signal, hooks);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Request

export function buildAnthropicBody(
  req: GenerateRequest,
  providerId: string,
  promptCache: boolean,
  extraBody: Record<string, unknown> | undefined,
): Wire {
  const messages = toAnthropicMessages(req.messages, providerId);
  const tools: Wire[] = req.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  if (promptCache) {
    const lastTool = tools[tools.length - 1];
    if (lastTool !== undefined) lastTool.cache_control = CACHE;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const content = lastMessage.content as Wire[];
      const lastBlock = content[content.length - 1];
      if (lastBlock !== undefined) lastBlock.cache_control = CACHE;
    }
  }
  const system =
    req.system === ""
      ? undefined
      : promptCache
        ? [{ type: "text", text: req.system, cache_control: CACHE }]
        : req.system;
  return {
    ...extraBody,
    model: req.model,
    max_tokens: req.maxOutputTokens,
    stream: true,
    ...(system !== undefined ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    messages,
  };
}

function toAnthropicMessages(messages: readonly Message[], providerId: string) {
  const out: { role: "user" | "assistant"; content: Wire[] }[] = [];
  for (const message of messages) {
    const results: Wire[] = [];
    const rest: Wire[] = [];
    for (const block of message.blocks) {
      switch (block.type) {
        case "text":
          // The API rejects empty text blocks.
          if (block.text !== "") rest.push({ type: "text", text: block.text });
          break;
        case "tool_call":
          rest.push({ type: "tool_use", id: block.id, name: block.name, input: block.args });
          break;
        case "tool_result":
          results.push({
            type: "tool_result",
            tool_use_id: block.callId,
            content: block.content,
            ...(block.isError === true ? { is_error: true } : {}),
          });
          break;
        case "provider_data": {
          const data = asRecord(block.data);
          if (block.provider === providerId && data !== undefined) rest.push({ ...data });
          break;
        }
      }
    }
    // tool_result blocks must come first in a user message.
    const content = [...results, ...rest];
    if (content.length > 0) out.push({ role: message.role, content });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Errors

const ERROR_TYPE_KIND: Record<string, ErrorClass> = {
  authentication_error: { kind: "auth" },
  permission_error: { kind: "auth" },
  billing_error: { kind: "auth" },
  not_found_error: { kind: "invalid_request" },
  request_too_large: { kind: "context_overflow" },
  rate_limit_error: { kind: "rate_limit" },
  overloaded_error: { kind: "overloaded" },
  api_error: { kind: "unknown", retryable: true },
};

function classifyAnthropic(
  status: number | undefined,
  type: string | undefined,
  message: string,
): ErrorClass {
  const overflow = looksLikeContextOverflow(message);
  if (status !== undefined) return classifyStatus(status, overflow);
  if (type === "invalid_request_error") {
    return { kind: overflow ? "context_overflow" : "invalid_request" };
  }
  return (type !== undefined ? ERROR_TYPE_KIND[type] : undefined) ?? { kind: "unknown" };
}

export function mapAnthropicHttpError(status: number, headers: Headers, bodyText: string) {
  let type: string | undefined;
  let message = bodyText.trim();
  try {
    const error = asRecord(asRecord(JSON.parse(bodyText))?.error);
    type = asString(error?.type);
    message = asString(error?.message) ?? message;
  } catch {
    // not JSON; keep the raw text
  }
  if (message === "") message = "(empty response body)";
  const cls = { ...classifyAnthropic(status, type, message) };
  const shouldRetry = headers.get("x-should-retry");
  if (shouldRetry === "false") cls.retryable = false;
  else if (shouldRetry === "true" && status >= 429) cls.retryable = true;
  const retryAfterMs = parseRetryAfter(headers);
  return buildError({
    vendor: VENDOR,
    cls,
    message: type !== undefined ? `${type}: ${message}` : message,
    status,
    retryAfterMs,
  });
}

// ---------------------------------------------------------------------------------------------
// Stream

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_calls",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
  pause_turn: "other",
};

export function mapAnthropicStopReason(reason: string | undefined): StopReason {
  return (reason !== undefined ? STOP_REASONS[reason] : undefined) ?? "other";
}

type BlockState =
  | { kind: "text" }
  | { kind: "tool"; id: string; name: string; startInput: unknown; json: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; block: Wire }
  | { kind: "ignored" };

function parseData(message: SseMessage): Wire {
  try {
    const record = asRecord(JSON.parse(message.data));
    if (record !== undefined) return record;
  } catch (error) {
    throw malformedEvent(VENDOR, error);
  }
  throw malformedEvent(VENDOR);
}

export async function* parseAnthropicStream(
  messages: AsyncIterable<SseMessage>,
  requestedModel: string,
): AsyncGenerator<ProviderEvent> {
  const blocks = new Map<number, BlockState>();
  const usage: Record<string, number | undefined> = {};
  let model: string | undefined;
  let stopReason: string | undefined;
  let complete = false;

  const mergeUsage = (raw: unknown) => {
    const record = asRecord(raw);
    if (record === undefined) return;
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]) {
      const value = asNumber(record[key]);
      if (value !== undefined) usage[key] = value; // cumulative: latest wins
    }
  };

  for await (const message of messages) {
    const data = parseData(message);
    const type = asString(data.type) ?? message.event;
    const index = asNumber(data.index) ?? 0;
    switch (type) {
      case "message_start": {
        const m = asRecord(data.message);
        model = asString(m?.model) ?? model;
        mergeUsage(m?.usage);
        break;
      }
      case "content_block_start": {
        const block = asRecord(data.content_block) ?? {};
        switch (block.type) {
          case "text": {
            blocks.set(index, { kind: "text" });
            const text = asString(block.text);
            if (text !== undefined && text !== "") yield { type: "text_delta", text };
            break;
          }
          case "tool_use": {
            const id = asString(block.id);
            const name = asString(block.name);
            if (id === undefined || id === "" || name === undefined) {
              throw new ProviderError("unknown", "anthropic: tool_use block without id or name", {
                retryable: false,
              });
            }
            blocks.set(index, { kind: "tool", id, name, startInput: block.input, json: "" });
            break;
          }
          case "thinking":
            blocks.set(index, {
              kind: "thinking",
              thinking: asString(block.thinking) ?? "",
              signature: asString(block.signature) ?? "",
            });
            break;
          case "redacted_thinking":
            blocks.set(index, { kind: "redacted", block: block as Wire });
            break;
          default:
            blocks.set(index, { kind: "ignored" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = asRecord(data.delta) ?? {};
        const state = blocks.get(index);
        if (delta.type === "text_delta") {
          const text = asString(delta.text);
          if (text !== undefined && text !== "") yield { type: "text_delta", text };
        } else if (delta.type === "input_json_delta" && state?.kind === "tool") {
          state.json += asString(delta.partial_json) ?? "";
        } else if (delta.type === "thinking_delta" && state?.kind === "thinking") {
          state.thinking += asString(delta.thinking) ?? "";
        } else if (delta.type === "signature_delta" && state?.kind === "thinking") {
          state.signature += asString(delta.signature) ?? "";
        }
        break;
      }
      case "content_block_stop": {
        const state = blocks.get(index);
        blocks.delete(index);
        if (state?.kind === "tool") {
          yield { type: "tool_call", id: state.id, name: state.name, args: toolArgs(state) };
        } else if (state?.kind === "thinking") {
          yield {
            type: "provider_data",
            data: { type: "thinking", thinking: state.thinking, signature: state.signature },
          };
        } else if (state?.kind === "redacted") {
          yield { type: "provider_data", data: state.block as JsonValue };
        }
        break;
      }
      case "message_delta": {
        const delta = asRecord(data.delta);
        stopReason = asString(delta?.stop_reason) ?? stopReason;
        mergeUsage(data.usage);
        break;
      }
      case "message_stop":
        complete = true;
        break;
      case "error": {
        const error = asRecord(data.error);
        const errType = asString(error?.type);
        const text = asString(error?.message) ?? "stream error";
        throw buildError({
          vendor: VENDOR,
          cls: classifyAnthropic(undefined, errType, text),
          message: errType !== undefined ? `${errType}: ${text}` : text,
        });
      }
      default:
        break; // ping and unknown event types
    }
    if (complete) break;
  }

  if (!complete) throw prematureEnd(VENDOR, "no message_stop event");

  const cacheRead = usage.cache_read_input_tokens;
  yield {
    type: "usage",
    // Anthropic reports cached and cache-write tokens separately from `input_tokens`; the
    // contract's inputTokens is the whole prompt.
    inputTokens:
      (usage.input_tokens ?? 0) + (cacheRead ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
  };
  yield {
    type: "done",
    stopReason: mapAnthropicStopReason(stopReason),
    modelVersion: model ?? requestedModel,
  };
}

function toolArgs(state: Extract<BlockState, { kind: "tool" }>): JsonValue {
  if (state.json.trim() === "") {
    const start = asRecord(state.startInput);
    return (start ?? {}) as JsonValue;
  }
  try {
    return JSON.parse(state.json) as JsonValue;
  } catch {
    throw new ProviderError(
      "unknown",
      `anthropic: tool call "${state.name}" has invalid JSON arguments: ${truncate(state.json, 200)}`,
      { retryable: false },
    );
  }
}
