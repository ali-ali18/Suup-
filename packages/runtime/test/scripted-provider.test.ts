import { join } from "node:path";
import { collect, type GenerateRequest, type Message, ProviderError } from "@suup/core";
import { describe, expect, it } from "vitest";
import { createScriptedProvider, loadScript } from "../src/index.js";
import { tempDir, writeJson } from "./helpers.js";

const user = (text: string): Message => ({ role: "user", blocks: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  blocks: [{ type: "text", text }],
});

function agentRequest(messages: Message[], extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "model-x",
    system: "s",
    messages,
    tools: [{ name: "shell", description: "d", inputSchema: { type: "object" } }],
    maxOutputTokens: 100,
    ...extra,
  };
}

async function make(script: unknown, options: { textChunkSize?: number } = {}) {
  const dir = await tempDir();
  const scriptPath = join(dir, "script.json");
  await writeJson(scriptPath, script);
  return { scriptPath, provider: createScriptedProvider({ id: "script", scriptPath, ...options }) };
}

const run = (provider: ReturnType<typeof createScriptedProvider>, req: GenerateRequest) =>
  collect(provider.generate(req), provider.id);

describe("scripted provider", () => {
  it("answers an agent turn by the number of assistant messages already in the conversation", async () => {
    const { provider } = await make({
      agent: [
        { text: "first", calls: [{ name: "shell", args: { command: "ls" } }] },
        { text: "second" },
      ],
    });
    const first = await run(provider, agentRequest([user("go")]));
    expect(first.stopReason).toBe("tool_calls");
    expect(first.blocks).toEqual([
      { type: "text", text: "first" },
      { type: "tool_call", id: "a0_1", name: "shell", args: { command: "ls" } },
    ]);
    // A different process, the same conversation: the same answer. A later turn: the next step.
    const again = await run(provider, agentRequest([user("go")]));
    expect(again.blocks).toEqual(first.blocks);
    const second = await run(
      provider,
      agentRequest([user("go"), assistant("first"), user("more")]),
    );
    expect(second.blocks).toEqual([{ type: "text", text: "second" }]);
    expect(second.stopReason).toBe("end");
    expect(second.modelVersion).toBe("scripted-1");
  });

  it("accepts a bare array as the agent list, and raw blocks, usage and a model version", async () => {
    const { provider } = await make([
      {
        blocks: [{ type: "text", text: "raw" }],
        usage: { inputTokens: 7, outputTokens: 3 },
        modelVersion: "scripted-9",
      },
    ]);
    const result = await run(provider, agentRequest([user("x")]));
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.modelVersion).toBe("scripted-9");
  });

  it("serves the reviewer from its own list, in order, repeating the last step", async () => {
    const { provider } = await make({
      agent: [],
      review: [
        { calls: [{ name: "verdict", args: { verdict: "reject", notes: "no" } }] },
        { calls: [{ name: "verdict", args: { verdict: "approve", notes: "yes" } }] },
      ],
    });
    const req = (): GenerateRequest =>
      agentRequest([user("review this")], {
        tools: [{ name: "verdict", description: "d", inputSchema: { type: "object" } }],
        toolChoice: { name: "verdict" },
      });
    const verdicts = [];
    for (let i = 0; i < 3; i++) {
      const result = await run(provider, req());
      const call = result.blocks.find((b) => b.type === "tool_call");
      verdicts.push(call?.type === "tool_call" ? (call.args as { verdict: string }).verdict : "");
    }
    expect(verdicts).toEqual(["reject", "approve", "approve"]);
  });

  it("serves the summarizer (a call without tools) from `compaction`", async () => {
    const { provider } = await make({ agent: [], compaction: [{ text: "summary" }] });
    const result = await run(provider, agentRequest([user("x")], { tools: [] }));
    expect(result.blocks).toEqual([{ type: "text", text: "summary" }]);
  });

  it("fails with a non-retryable provider error when the script runs out", async () => {
    const { provider } = await make({ agent: [{ text: "only" }] });
    const err = await run(provider, agentRequest([user("a"), assistant("b"), user("c")])).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("passo 1");
  });

  it("can script a provider failure", async () => {
    const { provider } = await make({
      agent: [{ error: { kind: "rate_limit", message: "slow down", retryable: false } }],
    });
    const err = await run(provider, agentRequest([user("x")])).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("rate_limit");
    expect(err.retryable).toBe(false);
  });

  it("reports a missing or invalid script file when it is first used, not at creation", async () => {
    const provider = createScriptedProvider({
      id: "script",
      scriptPath: "/nonexistent/script.json",
    });
    const err = await run(provider, agentRequest([user("x")])).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("não foi possível ler o roteiro");

    const bad = await make({ agent: [{ unknown: true }] });
    const err2 = await run(bad.provider, agentRequest([user("x")])).catch((e) => e);
    expect(err2.message).toContain("roteiro inválido");
    expect(() => loadScript(bad.scriptPath)).toThrow(/roteiro inválido/);
  });

  it("waits delayMs and honors an abort", async () => {
    const { provider } = await make({ agent: [{ text: "slow", delayMs: 5000 }] });
    const controller = new AbortController();
    const started = Date.now();
    const pending = run(provider, agentRequest([user("x")], { signal: controller.signal })).catch(
      (e) => e,
    );
    setTimeout(() => controller.abort(), 30);
    const err = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("aborted");
  });
});
