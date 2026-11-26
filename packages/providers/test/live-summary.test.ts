import { describe, expect, it } from "vitest";
import { createAnthropicProvider, createOpenAICompatibleProvider } from "../src/index.js";
import { baseRequest, drain, instantSleep, scriptedFetch, sseEvent } from "./helpers.js";
import { API_KEY } from "./wire-fixtures.js";

// The `summary` of the call that ends the run is typed as the model writes it (KOD-34): the adapter
// reads it out of the partial JSON and sends it as `summary_delta`, after `finish_start` (decided by
// the name of the call, compared exactly). The complete call still arrives whole, as before.

const SUMMARY = 'Feito: "três" arquivos\nconferidos, ação ok \u{1F600}';
const ARGS = JSON.stringify({
  summary: SUMMARY,
  evidence: [{ criterion: "1", evidence: 'disse "summary": "x"' }],
});

function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const typedOf = (events: { type: string; text?: string }[]) =>
  events
    .filter((e) => e.type === "summary_delta")
    .map((e) => e.text)
    .join("");

function anthropicBody(name: string, args: string[]): string {
  const start = sseEvent("message_start", {
    type: "message_start",
    message: { id: "m", model: "model-x", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  return (
    start +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Terminei." },
    }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t1", name, input: {} },
    }) +
    args
      .map((p) =>
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: p },
        }),
      )
      .join("") +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3 },
    }) +
    sseEvent("message_stop", { type: "message_stop" })
  );
}

describe("anthropic: the summary of finish, typed", () => {
  const run = async (name: string, size: number) => {
    const script = scriptedFetch([{ body: anthropicBody(name, pieces(ARGS, size)) }]);
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: API_KEY,
      fetch: script.fetch,
      sleep: instantSleep().sleep,
    });
    return (await drain(provider, baseRequest())).events;
  };

  for (const size of [1, 2, 3, 7, 50, 1000]) {
    it(`pieces of ${size} characters: the typed summary is exactly the one in the call`, async () => {
      const events = await run("finish", size);
      expect(events.filter((e) => e.type === "finish_start")).toHaveLength(1);
      expect(typedOf(events as never)).toBe(SUMMARY);
      const call = events.find((e) => e.type === "tool_call");
      expect(call).toMatchObject({ name: "finish", args: JSON.parse(ARGS) });
      // The name comes before any character of the summary.
      const first = events.findIndex((e) => e.type === "summary_delta");
      expect(events.findIndex((e) => e.type === "finish_start")).toBeLessThan(first);
    });
  }

  it("another tool never types anything, whatever its arguments say", async () => {
    const events = await run("finish_later", 5);
    expect(events.some((e) => e.type === "finish_start" || e.type === "summary_delta")).toBe(false);
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ name: "finish_later" });
  });
});

function chatBody(name: string, args: string[]): string {
  const chunk = (delta: unknown, finish: string | null = null) =>
    sseEvent(undefined, {
      id: "c1",
      model: "model-x",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  return (
    chunk({ content: "Terminei." }) +
    chunk({
      tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args[0] ?? "" } }],
    }) +
    args
      .slice(1)
      .map((p) => chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] }))
      .join("") +
    chunk({}, "tool_calls") +
    sseEvent(undefined, "[DONE]")
  );
}

describe("openai-compatible: the summary of finish, typed", () => {
  const run = async (name: string, size: number) => {
    const script = scriptedFetch([{ body: chatBody(name, pieces(ARGS, size)) }]);
    const provider = createOpenAICompatibleProvider({
      id: "compat",
      apiKey: API_KEY,
      fetch: script.fetch,
      sleep: instantSleep().sleep,
    });
    return (await drain(provider, baseRequest())).events;
  };

  for (const size of [1, 2, 3, 7, 50, 1000]) {
    it(`pieces of ${size} characters: the typed summary is exactly the one in the call`, async () => {
      const events = await run("finish", size);
      expect(events.filter((e) => e.type === "finish_start")).toHaveLength(1);
      expect(typedOf(events as never)).toBe(SUMMARY);
      expect(events.find((e) => e.type === "tool_call")).toMatchObject({
        name: "finish",
        args: JSON.parse(ARGS),
      });
    });
  }

  it("another tool never types anything", async () => {
    const events = await run("finish_later", 5);
    expect(events.some((e) => e.type === "finish_start" || e.type === "summary_delta")).toBe(false);
  });
});
