import { describe, expect, it } from "vitest";
import { collect, type GenerateRequest, generateAndCollect, ProviderError } from "../index.js";
import { FakeProvider } from "./index.js";

const req = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: "model-x",
  system: "sys",
  messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxOutputTokens: 100,
  ...overrides,
});

describe("FakeProvider", () => {
  it("plays the script in order and derives defaults", async () => {
    const fake = new FakeProvider([
      { blocks: [{ type: "text", text: "one" }] },
      { blocks: [{ type: "tool_call", id: "c", name: "t", args: {} }] },
    ]);
    const first = await collect(fake.generate(req()));
    const second = await collect(fake.generate(req()));
    expect(first.blocks).toEqual([{ type: "text", text: "one" }]);
    expect(first.stopReason).toBe("end");
    expect(second.stopReason).toBe("tool_calls");
    expect(second.modelVersion).toBe("fake-model-1");
    expect(fake.calls).toBe(2);
    expect(fake.remaining).toBe(0);
  });

  it("records the tool choice it was asked for", async () => {
    const fake = new FakeProvider([{ blocks: [] }, { blocks: [] }]);
    await collect(fake.generate(req()));
    await collect(fake.generate(req({ toolChoice: { name: "verdict" } })));
    expect(fake.requests.map((r) => r.toolChoice)).toEqual([undefined, { name: "verdict" }]);
  });

  it("supports function steps and error steps", async () => {
    const fake = new FakeProvider([
      (r) => ({ blocks: [{ type: "text", text: `saw ${r.messages.length} message(s)` }] }),
      new ProviderError("rate_limit", "slow down"),
    ]);
    expect((await collect(fake.generate(req()))).blocks).toEqual([
      { type: "text", text: "saw 1 message(s)" },
    ]);
    await expect(collect(fake.generate(req()))).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("records deep copies of requests", async () => {
    const fake = new FakeProvider([{ blocks: [] }]);
    const request = req();
    await collect(fake.generate(request));
    request.messages.push({ role: "assistant", blocks: [] });
    request.system = "mutated";
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.messages).toHaveLength(1);
    expect(fake.requests[0]?.system).toBe("sys");
  });

  it("throws a clear error when called more often than scripted", () => {
    const fake = new FakeProvider([]);
    expect(() => fake.generate(req())).toThrow(/only 0 step\(s\) were scripted/);
  });

  it("stamps provider_data with its id via generateAndCollect", async () => {
    const fake = new FakeProvider(
      [{ blocks: [{ type: "provider_data", provider: "ignored", data: { k: 1 } }] }],
      { id: "fake-a" },
    );
    const result = await generateAndCollect(fake, req());
    expect(result.blocks).toEqual([{ type: "provider_data", provider: "fake-a", data: { k: 1 } }]);
  });

  it("honors abort before and during the stream", async () => {
    const fake = new FakeProvider(
      [{ blocks: [{ type: "text", text: "abcdef" }] }, { blocks: [] }],
      { textChunkSize: 2 },
    );
    const controller = new AbortController();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of fake.generate(req({ signal: controller.signal }))) {
          seen.push(event.type);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(seen).toEqual(["text_delta"]);

    const pre = new AbortController();
    pre.abort();
    await expect(collect(fake.generate(req({ signal: pre.signal })))).rejects.toMatchObject({
      kind: "aborted",
    });
  });
});
