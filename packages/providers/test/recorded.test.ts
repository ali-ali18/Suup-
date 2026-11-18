import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/index.js";
import { baseRequest, drain, run, scriptedFetch } from "./helpers.js";
import { API_KEY } from "./wire-fixtures.js";

// Streams recorded from the real Messages API (only the response body; no request headers, no
// key; thinking signatures replaced). They pin the adapter to what the API really sends, which
// the hand-written fixtures in anthropic.test.ts could only guess at.

const fixture = (name: string) =>
  readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");

function make(body: string, status = 200) {
  const script = scriptedFetch([{ body, status }]);
  const provider = createAnthropicProvider({
    id: "anthropic",
    apiKey: API_KEY,
    fetch: script.fetch,
    maxRetries: 0,
  });
  return { provider, script };
}

describe("anthropic adapter against recorded real streams", () => {
  it("parses a tool call with nested objects, arrays and enums", async () => {
    const { provider } = make(fixture("nested-tool-call.sse"));
    const result = await run(provider, baseRequest());
    expect(result.stopReason).toBe("tool_calls");
    expect(result.modelVersion).toBe("model-x");
    expect(result.blocks).toEqual([
      {
        type: "tool_call",
        id: expect.stringMatching(/^toolu_/),
        name: "register_order",
        args: {
          customer: { name: "Ana Souza", address: { city: "Recife", zip: "50000-000" } },
          items: [
            { sku: "SKU-1", qty: 2, priority: "high" },
            { sku: "SKU-2", qty: 5, priority: "low" },
          ],
        },
      },
    ]);
  });

  it("parses two tool calls in one response, in order", async () => {
    const { provider } = make(fixture("two-tool-calls.sse"));
    const result = await run(provider, baseRequest());
    expect(result.stopReason).toBe("tool_calls");
    const calls = result.blocks.filter((b) => b.type === "tool_call");
    expect(calls.map((c) => (c.type === "tool_call" ? c.args : null))).toEqual([
      { city: "Lisbon" },
      { city: "Recife" },
    ]);
    expect(new Set(calls.map((c) => (c.type === "tool_call" ? c.id : ""))).size).toBe(2);
  });

  it("a response cut by the output limit in the middle of a tool call ends as max_tokens, without the incomplete call and without an error", async () => {
    const { provider } = make(fixture("max-tokens-mid-tool-call.sse"));
    const { events, error } = await drain(provider, baseRequest());
    expect(error).toBeUndefined();
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.find((e) => e.type === "done")).toMatchObject({ stopReason: "max_tokens" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: 419,
      outputTokens: 60,
    });
  });

  it("keeps a thinking block (empty text, signature) as provider data before the text", async () => {
    const { provider } = make(fixture("thinking-then-text.sse"));
    const result = await run(provider, baseRequest());
    expect(result.blocks[0]).toEqual({
      type: "provider_data",
      provider: "anthropic",
      data: { type: "thinking", thinking: "", signature: "SIGNATURE" },
    });
    expect(result.blocks[1]?.type).toBe("text");
    expect(result.stopReason).toBe("end");
  });

  it("counts cache reads and cache writes as part of the whole prompt, and reports both parts", async () => {
    const { provider } = make(fixture("cache-read-and-creation.sse"));
    const result = await run(provider, baseRequest());
    // input_tokens 2 + cache_creation 173 + cache_read 626
    expect(result.usage).toEqual({
      inputTokens: 801,
      outputTokens: 110,
      cachedInputTokens: 626,
      cacheWriteInputTokens: 173,
    });
  });

  for (const [file, status, kind] of [
    ["error-forced-tool-choice.json", 400, "invalid_request"],
    ["error-unknown-model.json", 404, "invalid_request"],
  ] as const) {
    it(`maps the real HTTP ${status} body of ${file} to ${kind}, not retryable`, async () => {
      const recorded = JSON.parse(fixture(file)) as { status: number; body: string };
      expect(recorded.status).toBe(status);
      const { provider } = make(recorded.body, status);
      const { error } = await drain(provider, baseRequest());
      expect(error).toMatchObject({ kind, retryable: false, status });
    });
  }

  it("the error text keeps the API's message (tool_choice) so the cause is readable", async () => {
    const recorded = JSON.parse(fixture("error-forced-tool-choice.json")) as { body: string };
    const { provider } = make(recorded.body, 400);
    const { error } = await drain(provider, baseRequest());
    expect(error?.message).toContain("tool_choice");
  });
});
