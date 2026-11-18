import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider, createProvider } from "../src/index.js";
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

const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  sseEvent(undefined, {
    id: "chatcmpl-7",
    model: "model-x-2026-01-01",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
const done = sseEvent(undefined, "[DONE]");

function make(steps: Parameters<typeof scriptedFetch>[0], extra = {}) {
  const script = scriptedFetch(steps);
  const sleeper = instantSleep();
  const provider = createOpenAICompatibleProvider({
    id: "compat",
    apiKey: API_KEY,
    fetch: script.fetch,
    sleep: sleeper.sleep,
    ...extra,
  });
  return { script, sleeper, provider };
}

describe("openai-compatible adapter", () => {
  it("posts to <baseUrl>/chat/completions with a bearer token", async () => {
    const { provider, script } = make([{ body: chunk({ content: "a" }, "stop") + done }], {
      baseUrl: "http://localhost:8080/v1/",
      headers: { "X-Org": "o" },
    });
    await run(provider, baseRequest());
    expect(script.calls[0]?.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(script.calls[0]?.headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      "x-org": "o",
    });
  });

  it("defaults to the public endpoint, and omits Authorization for an empty key", async () => {
    const { provider, script } = make([{ body: chunk({ content: "a" }, "stop") + done }], {
      apiKey: "",
    });
    await run(provider, baseRequest());
    expect(script.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(script.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("requests usage by default and lets that be turned off; limit field is configurable", async () => {
    const on = make([{ body: chunk({ content: "a" }, "stop") + done }]);
    await run(on.provider, baseRequest());
    expect(on.script.calls[0]?.body).toMatchObject({
      stream_options: { include_usage: true },
      max_tokens: 256,
    });

    const off = make([{ body: chunk({ content: "a" }, "stop") + done }], {
      includeUsage: false,
      maxTokensParam: "max_completion_tokens",
    });
    await run(off.provider, baseRequest());
    const body = off.script.calls[0]?.body ?? {};
    expect("stream_options" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect(body.max_completion_tokens).toBe(256);
  });

  it("orders tool messages like the calls, then the user text, and keeps content null for call-only turns", async () => {
    const { provider, script } = make([{ body: chunk({ content: "a" }, "stop") + done }]);
    await run(
      provider,
      baseRequest({
        tools: [weatherSpec],
        messages: [
          { role: "user", blocks: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            blocks: [
              { type: "tool_call", id: "a", name: "get_weather", args: {} },
              { type: "tool_call", id: "b", name: "get_weather", args: {} },
              { type: "tool_call", id: "c", name: "get_weather", args: {} },
            ],
          },
          {
            role: "user",
            blocks: [
              { type: "tool_result", callId: "c", content: "3" },
              { type: "tool_result", callId: "a", content: "1" },
              { type: "tool_result", callId: "b", content: "2" },
            ],
          },
        ],
      }),
    );
    const messages = script.calls[0]?.body.messages as Record<string, unknown>[];
    expect(messages.map((m) => [m.role, m.tool_call_id ?? m.content])).toEqual([
      ["user", "go"],
      ["assistant", null],
      ["tool", "a"],
      ["tool", "b"],
      ["tool", "c"],
    ]);
  });

  it("reports vendor capabilities that can be overridden", () => {
    const base = createOpenAICompatibleProvider({ id: "x", apiKey: "" });
    expect(base.capabilities).toEqual({ promptCache: false, parallelTools: true, vision: false });
    const vision = createProvider({
      kind: "openai-compatible",
      id: "x",
      apiKey: "",
      capabilities: { vision: true },
    });
    expect(vision.capabilities.vision).toBe(true);
  });

  describe("streaming quirks", () => {
    it("assembles argument fragments by index, even interleaved and with fragments in odd places", async () => {
      const body =
        chunk({ role: "assistant", content: null }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }) +
        chunk({
          tool_calls: [
            { index: 1, id: "call_b", type: "function", function: { name: "now", arguments: "" } },
          ],
        }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }) +
        chunk({ tool_calls: [{ index: 1, function: { arguments: "{" } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Lis' } }] }) +
        chunk({ tool_calls: [{ index: 1, function: { arguments: "}" } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'bon"}' } }] }) +
        chunk({}, "tool_calls") +
        done;
      const { provider } = make([{ body }]);
      const { events } = await drain(provider, baseRequest());
      expect(events.filter((e) => e.type === "tool_call")).toEqual([
        { type: "tool_call", id: "call_a", name: "get_weather", args: { city: "Lisbon" } },
        { type: "tool_call", id: "call_b", name: "now", args: {} },
      ]);
    });

    it("keeps the id from the first fragment when later fragments repeat the name or omit the id", async () => {
      const body =
        chunk({
          tool_calls: [{ index: 0, id: "call_a", function: { name: "now", arguments: "{" } }],
        }) +
        chunk({ tool_calls: [{ index: 0, id: "", function: { name: "now", arguments: "}" } }] }) +
        chunk({}, "tool_calls") +
        done;
      const { provider } = make([{ body }]);
      const result = await run(provider, baseRequest());
      expect(result.blocks).toEqual([{ type: "tool_call", id: "call_a", name: "now", args: {} }]);
    });

    it("synthesizes an id when the server never sends one, and handles missing indexes", async () => {
      const body =
        chunk({ tool_calls: [{ function: { name: "now", arguments: "{" } }] }) +
        chunk({ tool_calls: [{ function: { arguments: "}" } }] }) +
        chunk({}, "tool_calls") +
        done;
      const { provider } = make([{ body }]);
      const result = await run(provider, baseRequest());
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]).toMatchObject({ type: "tool_call", name: "now", args: {} });
      expect((result.blocks[0] as { id: string }).id).toMatch(/^call_.+_0$/);

      const second =
        chunk({ tool_calls: [{ id: "x1", function: { name: "now", arguments: "{}" } }] }) +
        chunk({ tool_calls: [{ id: "x2", function: { name: "other", arguments: "{}" } }] }) +
        chunk({}, "tool_calls") +
        done;
      const again = make([{ body: second }]);
      const names = (await run(again.provider, baseRequest())).blocks.map((b) =>
        b.type === "tool_call" ? [b.id, b.name] : [],
      );
      expect(names).toEqual([
        ["x1", "now"],
        ["x2", "other"],
      ]);
    });

    it("treats empty arguments as {} and still answers tool_calls when the server says stop", async () => {
      const body =
        chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "now", arguments: "" } }] }) +
        chunk({}, "stop") +
        done;
      const { provider } = make([{ body }]);
      const result = await run(provider, baseRequest());
      expect(result.blocks).toEqual([{ type: "tool_call", id: "c1", name: "now", args: {} }]);
      expect(result.stopReason).toBe("tool_calls");
    });

    it("accepts a stream that ends without [DONE] once finish_reason arrived", async () => {
      const body =
        chunk({ content: "Hi" }) +
        chunk({}, "stop") +
        sseEvent(undefined, {
          model: "model-x-2026-01-01",
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        });
      const { provider } = make([{ body }]);
      const result = await run(provider, baseRequest());
      expect(result).toEqual({
        blocks: [{ type: "text", text: "Hi" }],
        stopReason: "end",
        usage: { inputTokens: 4, outputTokens: 2 },
        modelVersion: "model-x-2026-01-01",
      });
    });

    it("accepts a final event without its trailing blank line", async () => {
      const body = `${chunk({ content: "Hi" })}${chunk({}, "stop")}data: [DONE]`;
      const { provider } = make([{ body }]);
      expect((await run(provider, baseRequest())).stopReason).toBe("end");
    });

    it("reports zero usage and nothing cached when the server sends no usage", async () => {
      const { provider } = make([{ body: chunk({ content: "Hi" }) + chunk({}, "stop") + done }]);
      const result = await run(provider, baseRequest());
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect("cachedInputTokens" in result.usage).toBe(false);
    });

    it("does not sum usage that is repeated on every chunk", async () => {
      const body =
        chunk({ content: "a" }, null, { usage: { prompt_tokens: 10, completion_tokens: 1 } }) +
        chunk({ content: "b" }, null, { usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
        chunk({}, "stop", {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            prompt_cache_hit_tokens: 8,
          },
        }) +
        done;
      const { provider } = make([{ body }]);
      expect((await run(provider, baseRequest())).usage).toEqual({
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 8,
      });
    });

    it("maps finish reasons", async () => {
      const cases: [string, string][] = [
        ["stop", "end"],
        ["tool_calls", "tool_calls"],
        ["function_call", "tool_calls"],
        ["length", "max_tokens"],
        ["content_filter", "refusal"],
        ["eos", "other"],
      ];
      for (const [wire, expected] of cases) {
        const { provider } = make([{ body: chunk({ content: "x" }, wire) + done }]);
        expect((await run(provider, baseRequest())).stopReason).toBe(expected);
      }
    });

    it("answers other for [DONE] without any finish_reason, but fails on a stream that just stops", async () => {
      const a = make([{ body: chunk({ content: "x" }) + done }]);
      expect((await run(a.provider, baseRequest())).stopReason).toBe("other");

      const b = make([{ body: chunk({ content: "x" }) }]);
      const { events, error } = await drain(b.provider, baseRequest());
      expect(events).toEqual([{ type: "text_delta", text: "x" }]);
      expect(error).toMatchObject({ kind: "network", retryable: false });
    });

    it("only reads choice 0 and ignores keep-alive comments and empty data", async () => {
      const body =
        ": keep-alive\n\n" +
        "data: \n\n" +
        sseEvent(undefined, {
          model: "model-x",
          choices: [
            { index: 1, delta: { content: "NO" }, finish_reason: null },
            { index: 0, delta: { content: "yes" }, finish_reason: null },
          ],
        }) +
        chunk({}, "stop") +
        done;
      const { provider } = make([{ body }]);
      expect((await run(provider, baseRequest())).blocks).toEqual([{ type: "text", text: "yes" }]);
    });

    it("ignores reasoning_content deltas (they are not part of the contract)", async () => {
      const { provider } = make([
        { body: chunk({ reasoning_content: "thinking" }) + chunk({ content: "a" }, "stop") + done },
      ]);
      expect((await run(provider, baseRequest())).blocks).toEqual([{ type: "text", text: "a" }]);
    });

    it("falls back to the requested model when the server names none", async () => {
      const body =
        sseEvent(undefined, {
          choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }],
        }) + done;
      const { provider } = make([{ body }]);
      expect((await run(provider, baseRequest())).modelVersion).toBe("model-x");
    });

    it("rejects malformed arguments for a truncated call and names the tool", async () => {
      const body =
        chunk({
          tool_calls: [
            { index: 0, id: "c", function: { name: "get_weather", arguments: '{"city":' } },
          ],
        }) +
        chunk({}, "length") +
        done;
      const { provider } = make([{ body }]);
      const { events, error } = await drain(provider, baseRequest());
      expect(error?.message).toContain("get_weather");
      expect(events).toEqual([]);
    });
  });

  describe("errors", () => {
    it("maps an in-stream error chunk by code and retries it before the first event", async () => {
      const rateLimited = sseEvent(undefined, {
        error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" },
      });
      const { provider, script } = make([
        { body: rateLimited },
        { body: chunk({ content: "a" }, "stop") + done },
      ]);
      expect((await run(provider, baseRequest())).blocks).toEqual([{ type: "text", text: "a" }]);
      expect(script.calls).toHaveLength(2);
    });

    it("maps in-stream errors with numeric codes and context overflow messages", async () => {
      const numeric = make(
        [{ body: sseEvent(undefined, { error: { message: "busy", code: 503 } }) }],
        {
          maxRetries: 0,
        },
      );
      expect(await expectProviderError(run(numeric.provider, baseRequest()))).toMatchObject({
        kind: "overloaded",
      });
      const overflow = make(
        [
          {
            body: sseEvent(undefined, {
              error: { message: "the request exceeds the available context size" },
            }),
          },
        ],
        { maxRetries: 0 },
      );
      expect(await expectProviderError(run(overflow.provider, baseRequest()))).toMatchObject({
        kind: "context_overflow",
        retryable: false,
      });
    });

    it("treats insufficient_quota as a non-retryable rate_limit", async () => {
      const body = JSON.stringify({
        error: {
          message: "You exceeded your current quota",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      });
      const { provider, script } = make([{ status: 429, body }]);
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error).toMatchObject({ kind: "rate_limit", retryable: false });
      expect(script.calls).toHaveLength(1);
    });

    it("reads retry-after-ms and understands plain-text and array error bodies", async () => {
      const a = make([{ status: 429, headers: { "retry-after-ms": "250" }, body: "Too many" }], {
        maxRetries: 0,
      });
      expect((await expectProviderError(run(a.provider, baseRequest()))).retryAfterMs).toBe(250);
      const b = make([
        { status: 400, body: JSON.stringify([{ error: { message: "bad things" } }]) },
      ]);
      expect((await expectProviderError(run(b.provider, baseRequest()))).message).toContain(
        "bad things",
      );
    });
  });

  it("sends a conformance conversation that a strict server would accept (spot check)", async () => {
    const { provider, script } = make([{ body: chunk({ content: "a" }, "stop") + done }]);
    await run(provider, conformanceRequest());
    const messages = script.calls[0]?.body.messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
  });
});
