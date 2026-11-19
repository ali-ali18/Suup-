import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, HOSTED_TOOL_SEARCH } from "../src/index.js";
import { baseRequest, drain, run, scriptedFetch, sseEvent } from "./helpers.js";
import { API_KEY, weatherSpec } from "./wire-fixtures.js";

// The shapes tested here come from the documentation of the tool search tool (see
// recorded/DOC-DERIVED-README.md): they are NOT captured from a live call.

const fixture = (name: string) =>
  readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8");

function make(body: string, extra: Record<string, unknown> = {}) {
  const script = scriptedFetch([{ body }]);
  const provider = createAnthropicProvider({
    id: "anthropic",
    apiKey: API_KEY,
    fetch: script.fetch,
    maxRetries: 0,
    ...extra,
  });
  return { provider, script };
}

const plainEnd =
  sseEvent("message_start", {
    type: "message_start",
    message: { id: "m", model: "model-x", usage: { input_tokens: 1, output_tokens: 1 } },
  }) +
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  }) +
  sseEvent("message_stop", { type: "message_stop" });

const toolsOf = (call: { body: Record<string, unknown> } | undefined): Record<string, unknown>[] =>
  ((call?.body ?? {}) as { tools?: Record<string, unknown>[] }).tools ?? [];

const lookup = { ...weatherSpec, name: "lookup", description: "Looks something up" };
const deferred = (name: string) => ({
  ...weatherSpec,
  name,
  description: `deferred ${name}`,
  deferLoading: true as const,
});

describe("anthropic tool search: the request", () => {
  it("declares the variants it implements", () => {
    const { provider } = make(plainEnd);
    expect(provider.capabilities.toolSearch).toEqual(["bm25", "regex", "client"]);
  });

  it("hosted bm25: the search tool after the loaded tools, deferred ones last with defer_loading, no beta header", async () => {
    const { provider, script } = make(plainEnd);
    await run(
      provider,
      baseRequest({
        tools: [lookup, deferred("get_weather"), deferred("search_files")],
        hostedToolSearch: "bm25",
      }),
    );
    const call = script.calls[0];
    expect(call?.headers["anthropic-beta"]).toBeUndefined();
    const tools = toolsOf(call);
    expect(tools.map((t) => t.name)).toEqual([
      "lookup",
      "tool_search_tool_bm25",
      "get_weather",
      "search_files",
    ]);
    expect(tools[1]).toMatchObject({ type: "tool_search_tool_bm25_20251119" });
    expect(tools[1]).toEqual({ ...HOSTED_TOOL_SEARCH.bm25 });
    expect(tools[2]).toMatchObject({ defer_loading: true });
    expect(tools[0]?.defer_loading).toBeUndefined();
  });

  it("hosted regex uses the regex tool type", async () => {
    const { provider, script } = make(plainEnd);
    await run(
      provider,
      baseRequest({ tools: [lookup, deferred("get_weather")], hostedToolSearch: "regex" }),
    );
    const tools = toolsOf(script.calls[0]);
    expect(tools[1]).toEqual({
      type: "tool_search_tool_regex_20251119",
      name: "tool_search_tool_regex",
    });
  });

  it("a deferred tool never carries cache_control: the breakpoint is on the last loaded tool", async () => {
    const { provider, script } = make(plainEnd, { promptCache: true });
    await run(
      provider,
      baseRequest({
        tools: [lookup, deferred("get_weather")],
        hostedToolSearch: "bm25",
      }),
    );
    const tools = toolsOf(script.calls[0]);
    expect(tools.find((t) => t.name === "lookup")?.cache_control).toEqual({ type: "ephemeral" });
    expect(tools.find((t) => t.name === "get_weather")?.cache_control).toBeUndefined();
    expect(tools.find((t) => t.name === "tool_search_tool_bm25")?.cache_control).toBeUndefined();
  });

  it("without hosted search nothing is added (client variant: only defer_loading)", async () => {
    const { provider, script } = make(plainEnd);
    await run(provider, baseRequest({ tools: [lookup, deferred("get_weather")] }));
    const tools = toolsOf(script.calls[0]);
    expect(tools.map((t) => t.name)).toEqual(["lookup", "get_weather"]);
    expect(tools[1]?.defer_loading).toBe(true);
  });

  it("a client-side search answer goes back as tool_reference blocks", async () => {
    const { provider, script } = make(plainEnd);
    await run(
      provider,
      baseRequest({
        tools: [lookup, deferred("get_weather")],
        messages: [
          { role: "user", blocks: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_call",
                id: "toolu_1",
                name: "search_tools",
                args: { words: "weather" },
              },
            ],
          },
          {
            role: "user",
            blocks: [
              {
                type: "tool_result",
                callId: "toolu_1",
                content: "Loaded 1 tool(s): get_weather.",
                toolReferences: ["get_weather"],
              },
            ],
          },
        ],
      }),
    );
    const body = script.calls[0]?.body as {
      messages: { content: Record<string, unknown>[] }[];
    };
    const result = body.messages[2]?.content[0];
    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "tool_reference", tool_name: "get_weather" }],
    });
  });
});

describe("anthropic tool search: the response (doc-derived fixture)", () => {
  it("keeps the server tool blocks as provider data, in order, and calls the discovered tool", async () => {
    const { provider } = make(fixture("DOC-DERIVED-tool-search-bm25.sse"));
    const result = await run(provider, baseRequest());
    expect(result.stopReason).toBe("tool_calls");
    expect(result.blocks.map((b) => b.type)).toEqual([
      "text",
      "provider_data",
      "provider_data",
      "text",
      "tool_call",
    ]);
    expect(result.blocks[1]).toMatchObject({
      type: "provider_data",
      provider: "anthropic",
      data: {
        type: "server_tool_use",
        id: "srvtoolu_01ABC123",
        name: "tool_search_tool_bm25",
        input: { query: "weather", limit: 10 },
      },
    });
    expect(result.blocks[2]).toMatchObject({
      data: {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_01ABC123",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
        },
      },
    });
    expect(result.blocks[4]).toMatchObject({
      type: "tool_call",
      id: "toolu_01XYZ789",
      name: "get_weather",
      args: { location: "San Francisco", unit: "fahrenheit" },
    });
  });

  it("sends those blocks back unchanged on the next request, with no result for the srvtoolu id", async () => {
    const first = make(fixture("DOC-DERIVED-tool-search-bm25.sse"));
    const result = await run(first.provider, baseRequest());
    const second = make(plainEnd);
    await drain(
      second.provider,
      baseRequest({
        tools: [lookup, deferred("get_weather")],
        hostedToolSearch: "bm25",
        messages: [
          { role: "user", blocks: [{ type: "text", text: "weather?" }] },
          { role: "assistant", blocks: result.blocks },
          {
            role: "user",
            blocks: [{ type: "tool_result", callId: "toolu_01XYZ789", content: "sunny" }],
          },
        ],
      }),
    );
    const body = second.script.calls[0]?.body as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    const assistant = body.messages[1]?.content ?? [];
    expect(assistant.map((b) => b.type)).toEqual([
      "text",
      "server_tool_use",
      "tool_search_tool_result",
      "text",
      "tool_use",
    ]);
    expect(assistant[1]).toMatchObject({ id: "srvtoolu_01ABC123", input: { query: "weather" } });
    const userBlocks = body.messages[2]?.content ?? [];
    expect(userBlocks.map((b) => b.tool_use_id)).toEqual(["toolu_01XYZ789"]);
  });
});
