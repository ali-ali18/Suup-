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

describe("scripted provider: the draft of a bot", () => {
  const draftCall = (name: string) => ({
    calls: [{ name: "propose_bot", args: { name, description: "d", personality: "p".repeat(30) } }],
  });
  const draftRequest = (brief: string): GenerateRequest =>
    agentRequest([user(brief)], {
      tools: [{ name: "propose_bot", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { name: "propose_bot" },
    });

  it("answers the drafts from the `draft` list, in order, whatever the agent list holds", async () => {
    const { provider } = await make({
      agent: [{ text: "agent step" }],
      draft: [draftCall("Um"), draftCall("Dois")],
    });
    const one = await run(provider, draftRequest("a"));
    const two = await run(provider, draftRequest("b"));
    expect(one.blocks[0]).toMatchObject({ type: "tool_call", args: { name: "Um" } });
    expect(two.blocks[0]).toMatchObject({ type: "tool_call", args: { name: "Dois" } });
  });

  it("a script without a `draft` list answers the draft from `agent`, as it always did", async () => {
    const { provider } = await make({ agent: [draftCall("Antigo")] });
    const answer = await run(provider, draftRequest("a"));
    expect(answer.blocks[0]).toMatchObject({ type: "tool_call", args: { name: "Antigo" } });
  });
});

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

  it("picks the script of a case by the text of the conversation, with its own review counter", async () => {
    const { provider } = await make({
      cases: [
        {
          whenObjectiveContains: "capital",
          agent: [{ text: "Brasília" }],
          review: [{ text: "r1" }, { text: "r2" }],
        },
        { whenObjectiveContains: "bissexto", agent: [{ text: "366" }], review: [{ text: "x1" }] },
      ],
    });
    const a = await run(provider, agentRequest([user("Qual a capital?")]));
    expect(a.blocks).toEqual([{ type: "text", text: "Brasília" }]);
    const b = await run(provider, agentRequest([user("Ano bissexto?")]));
    expect(b.blocks).toEqual([{ type: "text", text: "366" }]);
    const verdict = { toolChoice: { name: "verdict" } } as const;
    const r1 = await run(provider, agentRequest([user("capital")], verdict));
    const x1 = await run(provider, agentRequest([user("bissexto")], verdict));
    const r2 = await run(provider, agentRequest([user("capital")], verdict));
    expect([r1, x1, r2].map((r) => r.blocks)).toEqual([
      [{ type: "text", text: "r1" }],
      [{ type: "text", text: "x1" }],
      [{ type: "text", text: "r2" }],
    ]);
    const none = await run(provider, agentRequest([user("outra coisa")])).catch((e) => e);
    expect(none).toBeInstanceOf(ProviderError);
    expect(none.message).toContain("nenhum caso do roteiro corresponde");
  });

  it("refuses a script with neither agent nor cases", async () => {
    const bad = await make({ review: [{ text: "x" }] });
    expect(() => loadScript(bad.scriptPath)).toThrow(/"agent" ou de "cases"/);
  });
});
