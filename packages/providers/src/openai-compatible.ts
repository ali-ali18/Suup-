import { randomUUID } from "node:crypto";
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

export interface OpenAICompatibleProviderConfig extends BaseProviderConfig {
  /** Default "https://api.openai.com/v1". Requests go to `<baseUrl>/chat/completions`. */
  baseUrl?: string;
  /**
   * Send `stream_options: { include_usage: true }` so the server reports token usage in a final
   * chunk. Default true. Turn off for servers that reject the option (usage is then zeros).
   */
  includeUsage?: boolean;
  /** Which field carries the output limit. Default "max_tokens". */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Overrides for the advertised capabilities (defaults: no cache, parallel tools, no vision). */
  capabilities?: Partial<ProviderCapabilities>;
}

const VENDOR = "chat-completions";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

type Wire = Record<string, unknown>;

export function createOpenAICompatibleProvider(config: OpenAICompatibleProviderConfig): Provider {
  const transport = resolveTransport(config);
  const capabilities: ProviderCapabilities = {
    promptCache: false,
    parallelTools: true,
    vision: false,
    ...config.capabilities,
  };
  const url = `${(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const headers = mergeHeaders(
    {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(config.apiKey !== "" ? { authorization: `Bearer ${config.apiKey}` } : {}),
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
      const body = buildChatBody(req, config);
      const hooks: WireHooks = {
        mapHttpError: mapChatHttpError,
        parse: (messages) => parseChatStream(messages, req.model),
      };
      yield* streamWithRetry(transport, { url, headers, body }, req.signal, hooks);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Request

export function buildChatBody(req: GenerateRequest, config: OpenAICompatibleProviderConfig): Wire {
  const tools = req.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  return {
    ...config.extraBody,
    model: req.model,
    stream: true,
    ...((config.includeUsage ?? true) ? { stream_options: { include_usage: true } } : {}),
    [config.maxTokensParam ?? "max_tokens"]: req.maxOutputTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    messages: toChatMessages(req, config.id),
  };
}

const RESERVED_ASSISTANT_FIELDS = new Set(["role", "content", "tool_calls"]);

function toChatMessages(req: GenerateRequest, providerId: string): Wire[] {
  const out: Wire[] = [];
  if (req.system !== "") out.push({ role: "system", content: req.system });

  let previousCallOrder: string[] = [];
  for (const message of req.messages as readonly Message[]) {
    if (message.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: Wire[] = [];
      const extra: Wire = {};
      for (const block of message.blocks) {
        if (block.type === "text") {
          if (block.text !== "") texts.push(block.text);
        } else if (block.type === "tool_call") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.args) },
          });
        } else if (block.type === "provider_data" && block.provider === providerId) {
          // Echoed unchanged: an object's fields are merged into the assistant message.
          const data = asRecord(block.data);
          if (data !== undefined) {
            for (const [key, value] of Object.entries(data)) {
              if (!RESERVED_ASSISTANT_FIELDS.has(key)) extra[key] = value;
            }
          }
        }
      }
      previousCallOrder = toolCalls.map((c) => c.id as string);
      if (texts.length === 0 && toolCalls.length === 0 && Object.keys(extra).length === 0) continue;
      out.push({
        ...extra,
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // User message: tool results become separate `tool` messages (in the order of the calls),
    // followed by the remaining text.
    const results = message.blocks.filter((b) => b.type === "tool_result");
    const order = (id: string) => {
      const i = previousCallOrder.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const sorted = results
      .map((r, i) => ({ r, i }))
      .sort((a, b) => order(a.r.callId) - order(b.r.callId) || a.i - b.i);
    for (const { r } of sorted) {
      out.push({
        role: "tool",
        tool_call_id: r.callId,
        content: r.isError === true ? `Error: ${r.content}` : r.content,
      });
    }
    const texts = message.blocks.flatMap((b) =>
      b.type === "text" && b.text !== "" ? [b.text] : [],
    );
    if (texts.length > 0) out.push({ role: "user", content: texts.join("\n\n") });
    previousCallOrder = [];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Errors

function classifyChatError(
  status: number | undefined,
  type: string | undefined,
  code: string | number | undefined,
  message: string,
): ErrorClass {
  const codeText = typeof code === "string" ? code : undefined;
  const overflow =
    looksLikeContextOverflow(message, codeText) || codeText === "context_length_exceeded";
  if (status !== undefined) {
    if (status === 429 && (codeText === "insufficient_quota" || type === "insufficient_quota")) {
      return { kind: "rate_limit", retryable: false }; // out of credit: waiting does not help
    }
    return classifyStatus(status, overflow);
  }
  if (typeof code === "number") return classifyChatError(code, type, undefined, message);
  if (overflow) return { kind: "context_overflow" };
  const hint = `${type ?? ""} ${codeText ?? ""}`.toLowerCase();
  if (/insufficient_quota/.test(hint)) return { kind: "rate_limit", retryable: false };
  if (/rate_limit|too_many_requests/.test(hint)) return { kind: "rate_limit" };
  if (/overload|unavailable|server_error|engine_overloaded/.test(hint))
    return { kind: "overloaded" };
  if (/auth|api_key|permission/.test(hint)) return { kind: "auth" };
  if (/invalid_request|not_found/.test(hint)) return { kind: "invalid_request" };
  return { kind: "unknown" };
}

function errorFields(raw: unknown) {
  const error = asRecord(raw);
  const code = error?.code;
  return {
    message: asString(error?.message),
    type: asString(error?.type),
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
  };
}

export function mapChatHttpError(status: number, headers: Headers, bodyText: string) {
  let message = bodyText.trim();
  let type: string | undefined;
  let code: string | number | undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const root = Array.isArray(parsed) ? asRecord(parsed[0]) : asRecord(parsed);
    const fields = errorFields(root?.error ?? root);
    message = fields.message ?? (typeof root?.error === "string" ? root.error : message);
    type = fields.type;
    code = fields.code;
  } catch {
    // not JSON
  }
  if (message === "") message = "(empty response body)";
  return buildError({
    vendor: VENDOR,
    cls: classifyChatError(status, type, code, message),
    message: type !== undefined ? `${type}: ${message}` : message,
    status,
    retryAfterMs: parseRetryAfter(headers),
  });
}

// ---------------------------------------------------------------------------------------------
// Stream

export function mapChatFinishReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

interface ToolSlot {
  id: string | undefined;
  name: string;
  args: string;
}

export async function* parseChatStream(
  messages: AsyncIterable<SseMessage>,
  requestedModel: string,
): AsyncGenerator<ProviderEvent> {
  const slots = new Map<number, ToolSlot>();
  let lastSlot = -1;
  let responseId: string | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  let finished = false;
  let sawDone = false;
  let callsEmitted = 0;
  let usage: { input: number; output: number; cached?: number } | undefined;

  const flushToolCalls = function* (): Generator<ProviderEvent> {
    const ordered = [...slots.entries()].sort((a, b) => a[0] - b[0]);
    slots.clear();
    for (const [index, slot] of ordered) {
      if (slot.name === "") {
        throw new ProviderError("unknown", "chat-completions: tool call without a function name", {
          retryable: false,
        });
      }
      let args: JsonValue = {};
      if (slot.args.trim() !== "") {
        try {
          args = JSON.parse(slot.args) as JsonValue;
        } catch {
          throw new ProviderError(
            "unknown",
            `chat-completions: tool call "${slot.name}" has invalid JSON arguments: ${truncate(slot.args, 200)}`,
            { retryable: false },
          );
        }
      }
      const id = slot.id ?? `call_${responseId ?? randomUUID().slice(0, 8)}_${index}`;
      callsEmitted++;
      yield { type: "tool_call", id, name: slot.name, args };
    }
  };

  for await (const message of messages) {
    const raw = message.data.trim();
    if (raw === "[DONE]") {
      sawDone = true;
      break;
    }
    if (raw === "") continue;
    let chunk: Wire;
    try {
      const parsed = asRecord(JSON.parse(raw));
      if (parsed === undefined) throw malformedEvent(VENDOR);
      chunk = parsed;
    } catch (error) {
      throw error instanceof ProviderError ? error : malformedEvent(VENDOR, error);
    }

    if (chunk.error !== undefined && chunk.error !== null) {
      const fields = errorFields(chunk.error);
      const text =
        fields.message ?? (typeof chunk.error === "string" ? chunk.error : "stream error");
      throw buildError({
        vendor: VENDOR,
        cls: classifyChatError(undefined, fields.type, fields.code, text),
        message: fields.type !== undefined ? `${fields.type}: ${text}` : text,
      });
    }

    responseId = responseId ?? asString(chunk.id);
    model = asString(chunk.model) ?? model;

    const u = asRecord(chunk.usage);
    if (u !== undefined) {
      const details = asRecord(u.prompt_tokens_details);
      const cached = asNumber(details?.cached_tokens) ?? asNumber(u.prompt_cache_hit_tokens);
      // Some servers repeat cumulative usage on every chunk: latest wins, never summed.
      usage = {
        input: asNumber(u.prompt_tokens) ?? usage?.input ?? 0,
        output: asNumber(u.completion_tokens) ?? usage?.output ?? 0,
        ...(cached !== undefined
          ? { cached }
          : usage?.cached !== undefined
            ? { cached: usage.cached }
            : {}),
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice =
      choices.map(asRecord).find((c) => c !== undefined && (asNumber(c.index) ?? 0) === 0) ??
      undefined;
    if (choice === undefined) continue;

    const delta = asRecord(choice.delta) ?? {};
    const text = asString(delta.content);
    if (text !== undefined && text !== "") yield { type: "text_delta", text };

    const fragments = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const fragmentRaw of fragments) {
      const fragment = asRecord(fragmentRaw);
      if (fragment === undefined) continue;
      const id = asString(fragment.id);
      let index = asNumber(fragment.index);
      if (index === undefined) {
        // No index: a fragment with an id starts a new call, one without continues the last.
        index = id !== undefined && id !== "" ? lastSlot + 1 : Math.max(lastSlot, 0);
      }
      lastSlot = Math.max(lastSlot, index);
      let slot = slots.get(index);
      if (slot === undefined) {
        slot = { id: undefined, name: "", args: "" };
        slots.set(index, slot);
      }
      if (slot.id === undefined && id !== undefined && id !== "") slot.id = id;
      const fn = asRecord(fragment.function);
      const name = asString(fn?.name);
      if (slot.name === "" && name !== undefined) slot.name = name;
      slot.args += asString(fn?.arguments) ?? "";
    }

    const reason = asString(choice.finish_reason);
    if (reason !== undefined && reason !== "" && !finished) {
      finished = true;
      finishReason = reason;
      yield* flushToolCalls();
    }
  }

  if (!finished) {
    if (!sawDone) throw prematureEnd(VENDOR, "no finish_reason and no [DONE]");
    yield* flushToolCalls();
  }

  yield {
    type: "usage",
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    ...(usage?.cached !== undefined ? { cachedInputTokens: usage.cached } : {}),
  };
  let stopReason = mapChatFinishReason(finishReason);
  // Some servers answer "stop" even though the message carries tool calls.
  if (callsEmitted > 0 && stopReason === "end") stopReason = "tool_calls";
  yield { type: "done", stopReason, modelVersion: model ?? requestedModel };
}
