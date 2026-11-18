import type { Block, GenerateRequest, GenerateResult, Provider, StopReason } from "@suup/core";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createOpenAICompatibleProvider } from "../src/openai-compatible.js";
import type { BaseProviderConfig } from "../src/transport.js";
import { sseEvent } from "./helpers.js";

/** A vendor-neutral scripted model response. */
export type AbstractPart =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; args: unknown };

export interface AbstractResponse {
  parts: AbstractPart[];
  stop: StopReason;
  usage: { input: number; output: number; cached?: number };
  model?: string;
}

export const API_KEY = "test-key-0123456789";
export const SERVED_MODEL = "model-x-2026-01-01";

export function expectedResult(r: AbstractResponse): GenerateResult {
  const blocks: Block[] = r.parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "tool_call", id: p.id, name: p.name, args: p.args as never },
  );
  return {
    blocks,
    stopReason: r.stop,
    usage: {
      inputTokens: r.usage.input,
      outputTokens: r.usage.output,
      ...(r.usage.cached !== undefined ? { cachedInputTokens: r.usage.cached } : {}),
    },
    modelVersion: r.model ?? SERVED_MODEL,
  };
}

export type ErrorCase =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "context_overflow"
  | "server_error"
  | "not_found";

export interface WireError {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** What each adapter has to provide so the conformance suite can drive it. */
export interface WireFixture {
  name: string;
  providerId: string;
  create(fetchImpl: typeof fetch, extra?: Partial<BaseProviderConfig>): Provider;
  /** Renders the full SSE stream for an abstract response. */
  render(r: AbstractResponse): string;
  /** A stream that carries one tool call whose arguments are not valid JSON. */
  renderBrokenToolArgs(name: string): string;
  /**
   * Text "Let me check.", a complete call (call_1, get_weather {city:"Lisbon"}) and, when
   * `withText`/`withComplete` are set, a last call whose arguments are cut off, then a
   * max-tokens stop (usage 20 in / 256 out).
   */
  renderTruncated(opts: { withText: boolean; withComplete: boolean }): string;
  /** A stream that has produced the text "Hel" and then simply stops (no terminal event). */
  renderTextPrefix(): string;
  /** A stream that has produced no content yet (only the opening event) and stops. */
  renderOpeningOnly(): string;
  httpError(kind: ErrorCase, echo?: string): WireError;
  /** Wire body expected for `conformanceRequest()` (the full tool round trip). */
  expectedRoundTripBody(): Record<string, unknown>;
  /** Block whose echo/drop is checked, and a predicate on the request body. */
  echoData: Record<string, unknown>;
  bodyEchoes(body: Record<string, unknown>): boolean;
}

export const weatherSpec = {
  name: "get_weather",
  description: "Weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

/** System prompt + tool spec + a conversation with two parallel calls answered out of order. */
export function conformanceRequest(): GenerateRequest {
  return {
    model: "model-x",
    system: "You are terse.",
    messages: [
      { role: "user", blocks: [{ type: "text", text: "Weather in Lisbon and Porto?" }] },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Checking." },
          { type: "tool_call", id: "call_1", name: "get_weather", args: { city: "Lisbon" } },
          { type: "tool_call", id: "call_2", name: "get_weather", args: { city: "Porto" } },
        ],
      },
      {
        role: "user",
        blocks: [
          { type: "tool_result", callId: "call_2", content: "boom", isError: true },
          { type: "tool_result", callId: "call_1", content: "rainy" },
          { type: "text", text: "Summarize please." },
        ],
      },
    ],
    tools: [weatherSpec],
    maxOutputTokens: 256,
    temperature: 0.2,
  };
}

const halves = (text: string): string[] => {
  const mid = Math.ceil(text.length / 2);
  return text.length < 2 ? [text] : [text.slice(0, mid), text.slice(mid)];
};
const thirds = (text: string): string[] => {
  const n = Math.ceil(text.length / 3);
  return [text.slice(0, n), text.slice(n, 2 * n), text.slice(2 * n)].filter((s) => s !== "");
};

// ---------------------------------------------------------------------------------------------
// Anthropic

const ANTHROPIC_STOP: Record<StopReason, string> = {
  end: "end_turn",
  tool_calls: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  other: "pause_turn",
};

const anthropicStart = (model: string, usage: Record<string, number>) =>
  sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage,
    },
  });

function anthropicToolBlock(index: number, id: string, name: string, json: string[]): string {
  let out = sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  });
  for (const piece of json) {
    out += sseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: piece },
    });
  }
  return out + sseEvent("content_block_stop", { type: "content_block_stop", index });
}

export const anthropicFixture: WireFixture = {
  name: "anthropic",
  providerId: "anthropic",
  create: (fetchImpl, extra) =>
    createAnthropicProvider({
      id: "anthropic",
      apiKey: API_KEY,
      fetch: fetchImpl,
      promptCache: false,
      ...extra,
    }),
  render(r) {
    const cached = r.usage.cached;
    let out = anthropicStart(r.model ?? SERVED_MODEL, {
      input_tokens: r.usage.input - (cached ?? 0),
      output_tokens: 1,
      ...(cached !== undefined
        ? { cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }
        : {}),
    });
    out += sseEvent("ping", { type: "ping" });
    r.parts.forEach((part, index) => {
      if (part.type === "text") {
        out += sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        });
        for (const piece of halves(part.text)) {
          out += sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: piece },
          });
        }
        out += sseEvent("content_block_stop", { type: "content_block_stop", index });
      } else {
        out += anthropicToolBlock(index, part.id, part.name, thirds(JSON.stringify(part.args)));
      }
    });
    out += sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: ANTHROPIC_STOP[r.stop], stop_sequence: null },
      usage: { output_tokens: r.usage.output },
    });
    return out + sseEvent("message_stop", { type: "message_stop" });
  },
  renderBrokenToolArgs: (name) =>
    anthropicStart(SERVED_MODEL, { input_tokens: 1, output_tokens: 1 }) +
    anthropicToolBlock(0, "call_x", name, ['{"city": "Lis', "bon"]) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 2 },
    }) +
    sseEvent("message_stop", { type: "message_stop" }),
  renderTruncated({ withText, withComplete }) {
    let out = anthropicStart(SERVED_MODEL, { input_tokens: 20, output_tokens: 1 });
    let index = 0;
    if (withText) {
      out +=
        sseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }) +
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: "Let me check." },
        }) +
        sseEvent("content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    if (withComplete) {
      out += anthropicToolBlock(index++, "call_1", "get_weather", ['{"city":', '"Lisbon"}']);
    }
    out += anthropicToolBlock(index, "call_2", "get_weather", ['{"city": "Po']);
    return (
      out +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 256 },
      }) +
      sseEvent("message_stop", { type: "message_stop" })
    );
  },
  renderTextPrefix: () =>
    anthropicStart(SERVED_MODEL, { input_tokens: 1, output_tokens: 1 }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    }),
  renderOpeningOnly: () => anthropicStart(SERVED_MODEL, { input_tokens: 1, output_tokens: 1 }),
  httpError(kind, echo = "") {
    const body = (type: string, message: string) =>
      JSON.stringify({ type: "error", error: { type, message }, request_id: "req_1" });
    switch (kind) {
      case "auth":
        return {
          status: 401,
          headers: {},
          body: body("authentication_error", `invalid x-api-key ${echo}`),
        };
      case "forbidden":
        return { status: 403, headers: {}, body: body("permission_error", "not allowed") };
      case "rate_limit":
        return {
          status: 429,
          headers: { "retry-after": "2" },
          body: body("rate_limit_error", "slow down"),
        };
      case "overloaded":
        return { status: 529, headers: {}, body: body("overloaded_error", "Overloaded") };
      case "invalid_request":
        return { status: 400, headers: {}, body: body("invalid_request_error", "messages: bad") };
      case "context_overflow":
        return {
          status: 400,
          headers: {},
          body: body("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"),
        };
      case "server_error":
        return { status: 500, headers: {}, body: body("api_error", "Internal server error") };
      case "not_found":
        return { status: 404, headers: {}, body: body("not_found_error", "model: model-x") };
    }
  },
  expectedRoundTripBody: () => ({
    model: "model-x",
    max_tokens: 256,
    stream: true,
    system: "You are terse.",
    temperature: 0.2,
    tools: [
      {
        name: "get_weather",
        description: "Weather for a city",
        input_schema: weatherSpec.inputSchema,
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Weather in Lisbon and Porto?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Lisbon" } },
          { type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Porto" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true },
          { type: "tool_result", tool_use_id: "call_1", content: "rainy" },
          { type: "text", text: "Summarize please." },
        ],
      },
    ],
  }),
  echoData: { type: "thinking", thinking: "hmm", signature: "sig-1" },
  bodyEchoes(body) {
    const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
    return messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (b) => b.type === "thinking" && b.signature === "sig-1" && b.thinking === "hmm",
        ),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible

const CHAT_FINISH: Record<StopReason, string> = {
  end: "stop",
  tool_calls: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
  other: "stop",
};

const chatChunk = (model: string, delta: unknown, finish: string | null = null) =>
  sseEvent(undefined, {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

export const openaiFixture: WireFixture = {
  name: "openai-compatible",
  providerId: "compat",
  create: (fetchImpl, extra) =>
    createOpenAICompatibleProvider({
      id: "compat",
      apiKey: API_KEY,
      baseUrl: "http://localhost:9999/v1",
      fetch: fetchImpl,
      ...extra,
    }),
  render(r) {
    const model = r.model ?? SERVED_MODEL;
    let out = chatChunk(model, { role: "assistant", content: "" });
    const tools = r.parts.filter((p) => p.type === "tool");
    for (const part of r.parts) {
      if (part.type !== "text") continue;
      for (const piece of halves(part.text)) out += chatChunk(model, { content: piece });
    }
    const pieces = tools.map((t) => thirds(JSON.stringify(t.args)));
    tools.forEach((t, k) => {
      out += chatChunk(model, {
        tool_calls: [
          { index: k, id: t.id, type: "function", function: { name: t.name, arguments: "" } },
        ],
      });
    });
    // Argument fragments interleaved across the parallel calls; only the index identifies them.
    for (let round = 0; round < 3; round++) {
      pieces.forEach((p, k) => {
        const piece = p[round];
        if (piece !== undefined) {
          out += chatChunk(model, { tool_calls: [{ index: k, function: { arguments: piece } }] });
        }
      });
    }
    out += chatChunk(model, {}, CHAT_FINISH[r.stop]);
    out += sseEvent(undefined, {
      id: "chatcmpl-1",
      model,
      choices: [],
      usage: {
        prompt_tokens: r.usage.input,
        completion_tokens: r.usage.output,
        total_tokens: r.usage.input + r.usage.output,
        ...(r.usage.cached !== undefined
          ? { prompt_tokens_details: { cached_tokens: r.usage.cached } }
          : {}),
      },
    });
    return out + sseEvent(undefined, "[DONE]");
  },
  renderBrokenToolArgs: (name) =>
    chatChunk(SERVED_MODEL, {
      tool_calls: [
        {
          index: 0,
          id: "call_x",
          type: "function",
          function: { name, arguments: '{"city": "Lis' },
        },
      ],
    }) +
    chatChunk(SERVED_MODEL, { tool_calls: [{ index: 0, function: { arguments: "bon" } }] }) +
    chatChunk(SERVED_MODEL, {}, "tool_calls") +
    sseEvent(undefined, "[DONE]"),
  renderTruncated({ withText, withComplete }) {
    let out = chatChunk(SERVED_MODEL, { role: "assistant", content: "" });
    if (withText) out += chatChunk(SERVED_MODEL, { content: "Let me check." });
    let index = 0;
    if (withComplete) {
      out += chatChunk(SERVED_MODEL, {
        tool_calls: [
          {
            index: index++,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
          },
        ],
      });
    }
    out += chatChunk(SERVED_MODEL, {
      tool_calls: [
        {
          index,
          id: "call_2",
          type: "function",
          function: { name: "get_weather", arguments: '{"city": "Po' },
        },
      ],
    });
    out += chatChunk(SERVED_MODEL, {}, "length");
    out += sseEvent(undefined, {
      model: SERVED_MODEL,
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 256 },
    });
    return out + sseEvent(undefined, "[DONE]");
  },
  renderTextPrefix: () =>
    chatChunk(SERVED_MODEL, { role: "assistant", content: "" }) +
    chatChunk(SERVED_MODEL, { content: "Hel" }),
  renderOpeningOnly: () => chatChunk(SERVED_MODEL, { role: "assistant", content: "" }),
  httpError(kind, echo = "") {
    const body = (message: string, type: string, code: string | null) =>
      JSON.stringify({ error: { message, type, code, param: null } });
    switch (kind) {
      case "auth":
        return {
          status: 401,
          headers: {},
          body: body(
            `Incorrect API key provided: ${echo}`,
            "invalid_request_error",
            "invalid_api_key",
          ),
        };
      case "forbidden":
        return { status: 403, headers: {}, body: body("not allowed", "permission_error", null) };
      case "rate_limit":
        return {
          status: 429,
          headers: { "retry-after": "2" },
          body: body("Rate limit reached", "requests", "rate_limit_exceeded"),
        };
      case "overloaded":
        return {
          status: 503,
          headers: {},
          body: body("The engine is currently overloaded", "server_error", null),
        };
      case "invalid_request":
        return {
          status: 400,
          headers: {},
          body: body("Invalid value for 'messages'", "invalid_request_error", null),
        };
      case "context_overflow":
        return {
          status: 400,
          headers: {},
          body: body(
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
            "invalid_request_error",
            "context_length_exceeded",
          ),
        };
      case "server_error":
        return {
          status: 500,
          headers: {},
          body: body("The server had an error", "server_error", null),
        };
      case "not_found":
        return {
          status: 404,
          headers: {},
          body: body(
            "The model `model-x` does not exist",
            "invalid_request_error",
            "model_not_found",
          ),
        };
    }
  },
  expectedRoundTripBody: () => ({
    model: "model-x",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 256,
    temperature: 0.2,
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather for a city",
          parameters: weatherSpec.inputSchema,
        },
      },
    ],
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "Weather in Lisbon and Porto?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Porto"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "rainy" },
      { role: "tool", tool_call_id: "call_2", content: "Error: boom" },
      { role: "user", content: "Summarize please." },
    ],
  }),
  echoData: { reasoning_content: "hmm" },
  bodyEchoes(body) {
    const messages = body.messages as Record<string, unknown>[];
    return messages.some((m) => m.role === "assistant" && m.reasoning_content === "hmm");
  },
};

export const fixtures: WireFixture[] = [anthropicFixture, openaiFixture];

export const scenarios: Record<string, AbstractResponse> = {
  text: {
    parts: [{ type: "text", text: "Hello there, friend." }],
    stop: "end",
    usage: { input: 12, output: 5 },
  },
  "one tool call": {
    parts: [{ type: "tool", id: "call_a", name: "get_weather", args: { city: "Lisbon" } }],
    stop: "tool_calls",
    usage: { input: 30, output: 14 },
  },
  "two parallel tool calls": {
    parts: [
      { type: "tool", id: "call_a", name: "get_weather", args: { city: "Lisbon" } },
      {
        type: "tool",
        id: "call_b",
        name: "get_weather",
        args: { city: "Porto", opts: { units: "c", days: [1, 2, 3], note: null } },
      },
    ],
    stop: "tool_calls",
    usage: { input: 31, output: 22 },
  },
  "text then tool call": {
    parts: [
      { type: "text", text: "Let me check." },
      { type: "tool", id: "call_a", name: "get_weather", args: { city: "Lisbon" } },
    ],
    stop: "tool_calls",
    usage: { input: 40, output: 18 },
  },
  "no-argument tool call": {
    parts: [{ type: "tool", id: "call_a", name: "now", args: {} }],
    stop: "tool_calls",
    usage: { input: 9, output: 3 },
  },
  "max tokens stop": {
    parts: [{ type: "text", text: "A long answer that got cut" }],
    stop: "max_tokens",
    usage: { input: 20, output: 256 },
  },
  "refusal stop": {
    parts: [{ type: "text", text: "I can't help with that." }],
    stop: "refusal",
    usage: { input: 20, output: 7 },
  },
  "usage with cached tokens": {
    parts: [{ type: "text", text: "cached" }],
    stop: "end",
    usage: { input: 1000, output: 4, cached: 900 },
  },
};
