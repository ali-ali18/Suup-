import { describe, expect, it } from "vitest";
import { createAnthropicProvider, createProvider } from "../src/index.js";
import {
  baseRequest,
  drain,
  expectProviderError,
  instantSleep,
  run,
  scriptedFetch,
  sseEvent,
} from "./helpers.js";
import { API_KEY, conformanceRequest, weatherSpec } from "./wire-fixtures.js";

const start = (usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }) =>
  sseEvent("message_start", {
    type: "message_start",
    message: { id: "m", model: "model-x-2026-01-01", usage },
  });
const textBlock = (text: string, index = 0) =>
  sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  }) +
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  }) +
  sseEvent("content_block_stop", { type: "content_block_stop", index });
const end = (stop = "end_turn", output = 3) =>
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: output },
  }) + sseEvent("message_stop", { type: "message_stop" });

function make(steps: Parameters<typeof scriptedFetch>[0], extra = {}) {
  const script = scriptedFetch(steps);
  const sleeper = instantSleep();
  const provider = createAnthropicProvider({
    id: "anthropic",
    apiKey: API_KEY,
    fetch: script.fetch,
    sleep: sleeper.sleep,
    ...extra,
  });
  return { script, sleeper, provider };
}

describe("anthropic adapter", () => {
  it("sends the key, version and beta headers to /v1/messages", async () => {
    const { provider, script } = make([{ body: start() + textBlock("a") + end() }], {
      betas: ["beta-one", "beta-two"],
      headers: { "X-Custom": "1" },
    });
    await run(provider, baseRequest());
    const call = script.calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.headers).toMatchObject({
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "beta-one,beta-two",
      "x-custom": "1",
      "content-type": "application/json",
    });
  });

  it("accepts a base url with or without /v1 and a trailing slash", async () => {
    for (const baseUrl of [
      "http://proxy.local/",
      "http://proxy.local/v1",
      "http://proxy.local/v1/",
    ]) {
      const { provider, script } = make([{ body: start() + textBlock("a") + end() }], { baseUrl });
      await run(provider, baseRequest());
      expect(script.calls[0]?.url).toBe("http://proxy.local/v1/messages");
    }
  });

  it("marks the system prompt, last tool and last user block for caching by default", async () => {
    const script = scriptedFetch([{ body: start() + textBlock("a") + end() }]);
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: API_KEY,
      fetch: script.fetch,
    });
    await run(provider, conformanceRequest());
    const body = script.calls[0]?.body as {
      system: unknown;
      tools: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    const cc = { type: "ephemeral" };
    expect(body.system).toEqual([{ type: "text", text: "You are terse.", cache_control: cc }]);
    expect(body.tools[0]?.cache_control).toEqual(cc);
    const lastUser = body.messages.at(-1)?.content ?? [];
    expect(lastUser.at(-1)).toEqual({ type: "text", text: "Summarize please.", cache_control: cc });
    expect(lastUser[0]?.cache_control).toBeUndefined();
    expect(provider.capabilities.promptCache).toBe(true);
  });

  it("omits system, tools and empty text blocks when there is nothing to send", async () => {
    const { provider, script } = make([{ body: start() + textBlock("a") + end() }], {
      promptCache: false,
    });
    await run(
      provider,
      baseRequest({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "" }] },
          { role: "user", blocks: [{ type: "text", text: "hello" }] },
        ],
      }),
    );
    const body = script.calls[0]?.body as Record<string, unknown>;
    expect("system" in body).toBe(false);
    expect("tools" in body).toBe(false);
    expect("temperature" in body).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("merges extraBody but lets adapter fields win", async () => {
    const { provider, script } = make([{ body: start() + textBlock("a") + end() }], {
      extraBody: { thinking: { type: "adaptive" }, model: "ignored", stream: false },
    });
    await run(provider, baseRequest());
    const body = script.calls[0]?.body;
    expect(body).toMatchObject({ thinking: { type: "adaptive" }, model: "model-x", stream: true });
  });

  it("emits thinking blocks as provider_data and echoes them in place", async () => {
    const thinking =
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "let me " },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "think" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 1 });
    const { provider, script } = make([
      { body: start() + thinking + textBlock("answer", 2) + end() },
      { body: start() + textBlock("ok") + end() },
    ]);
    const first = await run(provider, baseRequest());
    expect(first.blocks).toEqual([
      {
        type: "provider_data",
        provider: "anthropic",
        data: { type: "thinking", thinking: "let me think", signature: "sig-abc" },
      },
      {
        type: "provider_data",
        provider: "anthropic",
        data: { type: "redacted_thinking", data: "opaque" },
      },
      { type: "text", text: "answer" },
    ]);
    await run(
      provider,
      baseRequest({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "q" }] },
          { role: "assistant", blocks: first.blocks },
          { role: "user", blocks: [{ type: "text", text: "next" }] },
        ],
      }),
    );
    const sentMessages = (script.calls[1]?.body.messages ?? []) as { content: unknown[] }[];
    const sent = sentMessages[1]?.content;
    expect(sent).toEqual([
      { type: "thinking", thinking: "let me think", signature: "sig-abc" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "answer" },
    ]);
  });

  it("assembles tool input from many partial_json fragments", async () => {
    const pieces = ['{"ci', 'ty": "Lis', 'bon", "n": ', "[1, 2]}"];
    const body =
      start() +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }) +
      pieces
        .map((p) =>
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: p },
          }),
        )
        .join("") +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      end("tool_use");
    const { provider } = make([{ body }]);
    const result = await run(provider, baseRequest({ tools: [weatherSpec] }));
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        id: "toolu_1",
        name: "get_weather",
        args: { city: "Lisbon", n: [1, 2] },
      },
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("sums input, cache-read and cache-write tokens and keeps output cumulative", async () => {
    const body =
      start({
        input_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 40,
        output_tokens: 1,
      }) +
      textBlock("a") +
      end("end_turn", 77);
    const { provider } = make([{ body }]);
    const result = await run(provider, baseRequest());
    expect(result.usage).toEqual({ inputTokens: 990, outputTokens: 77, cachedInputTokens: 900 });
  });

  it("reports no cached tokens when the server does not send the field", async () => {
    const { provider } = make([{ body: start() + textBlock("a") + end() }]);
    expect((await run(provider, baseRequest())).usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
    });
  });

  it("maps stop reasons, defaulting to other", async () => {
    const reasons: [string, string][] = [
      ["end_turn", "end"],
      ["stop_sequence", "end"],
      ["tool_use", "tool_calls"],
      ["max_tokens", "max_tokens"],
      ["model_context_window_exceeded", "max_tokens"],
      ["refusal", "refusal"],
      ["pause_turn", "other"],
      ["something_new", "other"],
    ];
    for (const [wire, expected] of reasons) {
      const { provider } = make([{ body: start() + textBlock("a") + end(wire) }]);
      expect((await run(provider, baseRequest())).stopReason).toBe(expected);
    }
  });

  it("treats an in-stream overloaded error as retryable before the first event", async () => {
    const errorEvent = sseEvent("error", {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
    const { provider, script } = make([
      { body: start() + errorEvent },
      { body: start() + textBlock("a") + end() },
    ]);
    expect((await run(provider, baseRequest())).blocks).toEqual([{ type: "text", text: "a" }]);
    expect(script.calls).toHaveLength(2);
  });

  it("does not retry an in-stream error after text was delivered", async () => {
    const errorEvent = sseEvent("error", {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
    const { provider, script } = make([
      {
        body:
          start() +
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "Hi" },
          }) +
          errorEvent,
      },
    ]);
    const { events, error } = await drain(provider, baseRequest());
    expect(events).toEqual([{ type: "text_delta", text: "Hi" }]);
    expect(error).toMatchObject({ kind: "overloaded", retryable: false });
    expect(script.calls).toHaveLength(1);
  });

  it("honors x-should-retry and billing/size statuses", async () => {
    const body = JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } });
    const noRetry = make([{ status: 500, headers: { "x-should-retry": "false" }, body }]);
    expect(await expectProviderError(run(noRetry.provider, baseRequest()))).toMatchObject({
      kind: "unknown",
      retryable: false,
    });
    const big = make([{ status: 413, body: "{}" }]);
    expect(await expectProviderError(run(big.provider, baseRequest()))).toMatchObject({
      kind: "context_overflow",
    });
    const billing = make([{ status: 402, body: "{}" }]);
    expect(await expectProviderError(run(billing.provider, baseRequest()))).toMatchObject({
      kind: "auth",
    });
  });

  it("copes with a non-JSON error body and an HTTP-date retry-after", async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const { provider } = make(
      [{ status: 429, headers: { "retry-after": date }, body: "upstream busy" }],
      {
        maxRetries: 0,
      },
    );
    const error = await expectProviderError(run(provider, baseRequest()));
    expect(error.kind).toBe("rate_limit");
    expect(error.message).toContain("upstream busy");
    expect(error.retryAfterMs).toBeGreaterThan(2000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("fails on malformed event JSON as a network error", async () => {
    const { provider } = make([{ body: "event: message_start\ndata: {oops\n\n" }], {
      maxRetries: 0,
    });
    expect(await expectProviderError(run(provider, baseRequest()))).toMatchObject({
      kind: "network",
    });
  });

  it("validates its config", () => {
    expect(() => createAnthropicProvider({ id: "", apiKey: "k" })).toThrow(
      /Invalid provider config/,
    );
    expect(() => createAnthropicProvider({ id: "a", apiKey: "k", maxRetries: -1 })).toThrow(
      /maxRetries/,
    );
  });

  it("is built by createProvider and exposes its id and capabilities", () => {
    const provider = createProvider({ kind: "anthropic", id: "primary", apiKey: "k" });
    expect(provider.id).toBe("primary");
    expect(provider.capabilities).toEqual({ promptCache: true, parallelTools: true, vision: true });
  });
});
