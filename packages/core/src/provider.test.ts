import { describe, expect, it } from "vitest";
import { collect, ProviderError, type ProviderEvent } from "./provider.js";

async function* stream(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const e of events) yield e;
}

const done: ProviderEvent = { type: "done", stopReason: "end", modelVersion: "model-x-1" };

describe("collect", () => {
  it("merges consecutive text deltas into one block", async () => {
    const result = await collect(
      stream([
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        { type: "usage", inputTokens: 3, outputTokens: 2 },
        done,
      ]),
    );
    expect(result.blocks).toEqual([{ type: "text", text: "Hello" }]);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(result.stopReason).toBe("end");
    expect(result.modelVersion).toBe("model-x-1");
  });

  it("preserves order around tool calls and provider data", async () => {
    const result = await collect(
      stream([
        { type: "provider_data", data: { r: 1 } },
        { type: "text_delta", text: "a" },
        { type: "tool_call", id: "1", name: "t", args: { x: 1 } },
        { type: "text_delta", text: "b" },
        { type: "text_delta", text: "c" },
        { type: "tool_call", id: "2", name: "t", args: null },
        { type: "done", stopReason: "tool_calls", modelVersion: "v" },
      ]),
      "prov",
    );
    expect(result.blocks).toEqual([
      { type: "provider_data", provider: "prov", data: { r: 1 } },
      { type: "text", text: "a" },
      { type: "tool_call", id: "1", name: "t", args: { x: 1 } },
      { type: "text", text: "bc" },
      { type: "tool_call", id: "2", name: "t", args: null },
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("sums usage events and tracks cached tokens only when reported", async () => {
    const result = await collect(
      stream([
        { type: "usage", inputTokens: 10, outputTokens: 0, cachedInputTokens: 4 },
        { type: "usage", inputTokens: 0, outputTokens: 7 },
        done,
      ]),
    );
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 7, cachedInputTokens: 4 });
  });

  it("fails when the stream ends without done", async () => {
    await expect(collect(stream([{ type: "text_delta", text: "partial" }]))).rejects.toThrow(
      /without a done/,
    );
  });

  it("propagates stream errors", async () => {
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: "text_delta", text: "x" };
      throw new ProviderError("overloaded", "busy", { status: 529 });
    }
    await expect(collect(failing())).rejects.toMatchObject({ kind: "overloaded", retryable: true });
  });
});

describe("ProviderError", () => {
  it("derives retryable from kind unless overridden", () => {
    expect(new ProviderError("rate_limit", "x", { retryAfterMs: 500 }).retryable).toBe(true);
    expect(new ProviderError("auth", "x").retryable).toBe(false);
    expect(new ProviderError("unknown", "x", { retryable: true }).retryable).toBe(true);
    const e = new ProviderError("network", "x");
    expect(e.status).toBeUndefined();
    expect(e).toBeInstanceOf(Error);
  });
});
