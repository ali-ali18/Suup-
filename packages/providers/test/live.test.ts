import type { Provider } from "@suup/core";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, createOpenAICompatibleProvider } from "../src/index.js";
import { baseRequest, run } from "./helpers.js";
import { weatherSpec } from "./wire-fixtures.js";

// Live tests talk to real servers and may cost money. They are OFF by default and also refuse to
// run on CI unless SUUP_LIVE_ALLOW_CI=1. See packages/providers/README.md for the variables.

const env = process.env;
const onCi = env.CI !== undefined && env.CI !== "" && env.SUUP_LIVE_ALLOW_CI !== "1";

function gate(flag: string, required: string[]): { enabled: boolean; why: string } {
  if (env[flag] !== "1") return { enabled: false, why: `set ${flag}=1 to enable` };
  if (onCi) return { enabled: false, why: "CI detected; set SUUP_LIVE_ALLOW_CI=1 to override" };
  const missing = required.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) return { enabled: false, why: `missing ${missing.join(", ")}` };
  return { enabled: true, why: "" };
}

function liveSuite(
  title: string,
  g: { enabled: boolean; why: string },
  make: () => Provider,
  model: () => string,
) {
  const name = g.enabled ? title : `${title} (skipped: ${g.why})`;
  describe.skipIf(!g.enabled)(name, () => {
    it("answers a tiny text request", async () => {
      const result = await run(
        make(),
        baseRequest({
          model: model(),
          system: "Answer with one word.",
          maxOutputTokens: 64,
          messages: [{ role: "user", blocks: [{ type: "text", text: "Say hello." }] }],
        }),
      );
      expect(result.blocks.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.modelVersion).not.toBe("");
    }, 60_000);

    it("completes a one-tool round trip", async () => {
      const provider = make();
      const first = await run(
        provider,
        baseRequest({
          model: model(),
          system: "Always use the tool to get weather. Do not guess.",
          tools: [weatherSpec],
          maxOutputTokens: 512,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "What is the weather in Lisbon?" }] },
          ],
        }),
      );
      expect(first.stopReason).toBe("tool_calls");
      const call = first.blocks.find((b) => b.type === "tool_call");
      expect(call).toBeDefined();
      if (call?.type !== "tool_call") return;
      expect(call.name).toBe("get_weather");

      const second = await run(
        provider,
        baseRequest({
          model: model(),
          system: "Always use the tool to get weather. Do not guess.",
          tools: [weatherSpec],
          maxOutputTokens: 512,
          messages: [
            { role: "user", blocks: [{ type: "text", text: "What is the weather in Lisbon?" }] },
            { role: "assistant", blocks: first.blocks },
            {
              role: "user",
              blocks: [{ type: "tool_result", callId: call.id, content: "sunny, 24C" }],
            },
          ],
        }),
      );
      expect(second.blocks.some((b) => b.type === "text" && b.text.length > 0)).toBe(true);
    }, 120_000);
  });
}

liveSuite(
  "live: anthropic",
  gate("SUUP_LIVE_ANTHROPIC", ["SUUP_LIVE_ANTHROPIC_API_KEY", "SUUP_LIVE_ANTHROPIC_MODEL"]),
  () =>
    createAnthropicProvider({
      id: "anthropic",
      apiKey: env.SUUP_LIVE_ANTHROPIC_API_KEY ?? "",
      ...(env.SUUP_LIVE_ANTHROPIC_BASE_URL ? { baseUrl: env.SUUP_LIVE_ANTHROPIC_BASE_URL } : {}),
    }),
  () => env.SUUP_LIVE_ANTHROPIC_MODEL ?? "",
);

liveSuite(
  "live: openai-compatible",
  gate("SUUP_LIVE_OPENAI_COMPAT", [
    "SUUP_LIVE_OPENAI_COMPAT_BASE_URL",
    "SUUP_LIVE_OPENAI_COMPAT_MODEL",
  ]),
  () =>
    createOpenAICompatibleProvider({
      id: "compat",
      apiKey: env.SUUP_LIVE_OPENAI_COMPAT_API_KEY ?? "",
      baseUrl: env.SUUP_LIVE_OPENAI_COMPAT_BASE_URL ?? "",
    }),
  () => env.SUUP_LIVE_OPENAI_COMPAT_MODEL ?? "",
);
