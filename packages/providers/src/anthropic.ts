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

/**
 * The server tool of the API's own tool search, as the documentation of the tool search tool gives
 * it (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): no beta
 * header, `defer_loading: true` on the tools to keep out of the context, and this entry in `tools`
 * (never deferred itself).
 */
export const HOSTED_TOOL_SEARCH = {
  bm25: { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
  regex: { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
} as const;

type Wire = Record<string, unknown>;

export function createAnthropicProvider(config: AnthropicProviderConfig): Provider {
  const transport = resolveTransport(config);
  const promptCache = config.promptCache ?? true;
  const capabilities: ProviderCapabilities = {
    promptCache,
    parallelTools: true,
    vision: true,
    // Deferred loading with the search the API runs (bm25, regex) or one the harness runs (client).
    // Which models take it is the configuration's call (docs list them); the adapter never guesses.
    toolSearch: ["bm25", "regex", "client"],
  };
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
    ...(tool.deferLoading === true ? { defer_loading: true } : {}),
  }));
  if (req.hostedToolSearch !== undefined) {
    // After the tools that load, before the deferred ones: the order never changes in a run.
    const firstDeferred = tools.findIndex((t) => t.defer_loading === true);
    const entry: Wire = { ...HOSTED_TOOL_SEARCH[req.hostedToolSearch] };
    if (firstDeferred === -1) tools.push(entry);
    else tools.splice(firstDeferred, 0, entry);
  }
  if (promptCache) {
    // The breakpoint goes on the last tool that loads: a deferred tool cannot carry one (the API
    // answers 400), and the search tool is a server tool.
    let lastTool: Wire | undefined;
    for (const t of tools) if (t.defer_loading !== true && t.type === undefined) lastTool = t;
    if (lastTool !== undefined) lastTool.cache_control = CACHE;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "user") {
      const content = lastMessage.content as Wire[];
      const lastBlock = content[content.length - 1];
      if (lastBlock !== undefined) lastBlock.cache_control = CACHE;
    }
  }
  const toolChoice = anthropicToolChoice(req, extraBody);
  const system =
    req.system === ""
      ? undefined
      : promptCache
        ? systemBlocks(req.system, req.systemCacheBreak)
        : req.system;
  return {
    ...extraBody,
    model: req.model,
    max_tokens: req.maxOutputTokens,
    stream: true,
    ...(system !== undefined ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    messages,
  };
}

/**
 * The system prompt with its cache breakpoints: one at the end, and one where the part shared by
 * every bot and run ends (`systemCacheBreak`), so a new bot or a new run (another name, another
 * time) reads that part from the cache instead of writing it again. Four breakpoints at most per
 * request: the last tool, these two and the last user block. The two blocks join to exactly the
 * same text.
 */
function systemBlocks(system: string, cacheBreak: number | undefined): Wire[] {
  if (cacheBreak === undefined || cacheBreak <= 0 || cacheBreak >= system.length) {
    return [{ type: "text", text: system, cache_control: CACHE }];
  }
  return [
    { type: "text", text: system.slice(0, cacheBreak), cache_control: CACHE },
    { type: "text", text: system.slice(cacheBreak), cache_control: CACHE },
  ];
}

/**
 * Wire mapping of `GenerateRequest.toolChoice`: `required` -> `{type:"any"}`, `{name}` ->
 * `{type:"tool", name}`; `auto` (the default) is left out, since it is the API's default too.
 *
 * Fallback: the API rejects a forced choice (`any`/`tool`) while extended thinking is on, so when
 * `extraBody.thinking` enables it the field is omitted and the request behaves as `auto`. The
 * caller must then cope with a response that has no tool call (the loop's reviewer already
 * treats that as an approval with a warning).
 */
function anthropicToolChoice(
  req: GenerateRequest,
  extraBody: Record<string, unknown> | undefined,
): Wire | undefined {
  const choice = req.toolChoice;
  if (choice === undefined || choice === "auto" || req.tools.length === 0) return undefined;
  const thinking = asRecord(extraBody?.thinking);
  if (thinking !== undefined && thinking.type !== "disabled") return undefined;
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
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
            // Client-side tool search: the answer names the tools to load (`tool_reference`).
            content:
              block.toolReferences === undefined || block.toolReferences.length === 0
                ? block.content
                : block.toolReferences.map((tool_name) => ({ type: "tool_reference", tool_name })),
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
  /** A server tool call (the API's tool search) or its result: echoed back unchanged. */
  | { kind: "server"; block: Wire; json: string }
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
  // An incomplete tool call is only an error unless the output limit cut it off; that is
  // known once the stop reason arrives, so the error is held back until then.
  let broken: ProviderError | undefined;

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
        if (broken !== undefined) throw broken; // the broken call was not the last one
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
          case "server_tool_use":
          case "tool_search_tool_result":
            // Kept as the API sent them: the next request must carry them back unchanged.
            blocks.set(index, { kind: "server", block: block as Wire, json: "" });
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
        } else if (delta.type === "input_json_delta" && state?.kind === "server") {
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
          let args: JsonValue | undefined;
          try {
            args = toolArgs(state);
          } catch (error) {
            if (!(error instanceof ProviderError)) throw error;
            broken = error;
          }
          if (args !== undefined) yield { type: "tool_call", id: state.id, name: state.name, args };
        } else if (state?.kind === "thinking") {
          yield {
            type: "provider_data",
            data: { type: "thinking", thinking: state.thinking, signature: state.signature },
          };
        } else if (state?.kind === "redacted") {
          yield { type: "provider_data", data: state.block as JsonValue };
        } else if (state?.kind === "server") {
          yield { type: "provider_data", data: serverBlock(state) as JsonValue };
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

  // Tool blocks that never got their content_block_stop (cut off by the output limit).
  for (const state of blocks.values()) {
    if (state.kind !== "tool") continue;
    if (broken !== undefined) throw broken;
    try {
      const args = toolArgs(state);
      yield { type: "tool_call", id: state.id, name: state.name, args };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      broken = error;
    }
  }
  const mapped = mapAnthropicStopReason(stopReason);
  // Cut off by the output limit mid-call: drop the incomplete call, keep everything else.
  if (broken !== undefined && mapped !== "max_tokens") throw broken;

  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  yield {
    type: "usage",
    // Anthropic reports cached and cache-write tokens separately from `input_tokens`; the
    // contract's inputTokens is the whole prompt.
    inputTokens:
      (usage.input_tokens ?? 0) + (cacheRead ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {}),
  };
  yield {
    type: "done",
    stopReason: mapped,
    modelVersion: model ?? requestedModel,
  };
}

/** The server tool block with its streamed `input` filled in. */
function serverBlock(state: Extract<BlockState, { kind: "server" }>): Wire {
  if (state.json.trim() === "") return state.block;
  try {
    return { ...state.block, input: JSON.parse(state.json) };
  } catch {
    throw new ProviderError(
      "unknown",
      `anthropic: server tool call has invalid JSON input: ${truncate(state.json, 200)}`,
      { retryable: false },
    );
  }
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
