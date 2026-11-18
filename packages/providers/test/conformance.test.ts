import { type GenerateRequest, type Message, ProviderError } from "@suup/core";
import { describe, expect, it } from "vitest";
import type { ExchangeInfo } from "../src/index.js";
import {
  baseRequest,
  drain,
  expectProviderError,
  instantSleep,
  run,
  type StreamControl,
  scriptedFetch,
  splitEvery,
  streamOf,
} from "./helpers.js";
import {
  API_KEY,
  conformanceRequest,
  type ErrorCase,
  expectedResult,
  fixtures,
  SERVED_MODEL,
  scenarios,
  type WireFixture,
} from "./wire-fixtures.js";

const deliveries: Record<string, (wire: string) => string[]> = {
  "whole, LF": (w) => [w],
  "5-char chunks, LF": (w) => splitEvery(w, 5),
  "3-char chunks, CRLF": (w) => splitEvery(w.replaceAll("\n", "\r\n"), 3),
};

const okBody = (fx: WireFixture) => fx.render(scenarios.text ?? never());
function never(): never {
  throw new Error("missing scenario");
}
const errorBody = (fx: WireFixture, kind: ErrorCase, echo?: string) => {
  const e = fx.httpError(kind, echo);
  return { status: e.status, headers: e.headers, body: e.body };
};

describe.each(fixtures)("conformance: $name", (fx) => {
  const make = (steps: Parameters<typeof scriptedFetch>[0], extra = {}) => {
    const script = scriptedFetch(steps);
    const sleeper = instantSleep();
    const provider = fx.create(script.fetch, {
      sleep: sleeper.sleep,
      random: () => 0.5,
      retryBaseDelayMs: 100,
      ...extra,
    });
    return { script, sleeper, provider };
  };

  describe("responses", () => {
    for (const [scenario, abstract] of Object.entries(scenarios)) {
      for (const [delivery, chunker] of Object.entries(deliveries)) {
        it(`${scenario} (${delivery})`, async () => {
          const { provider } = make([{ body: chunker(fx.render(abstract)) }]);
          expect(await run(provider, baseRequest())).toEqual(expectedResult(abstract));
        });
      }
    }

    it("reports the model the server answered with, falling back to the requested one", async () => {
      const abstract = { ...(scenarios.text ?? never()), model: "model-y-2026-02-02" };
      const { provider } = make([{ body: fx.render(abstract) }]);
      expect((await run(provider, baseRequest())).modelVersion).toBe("model-y-2026-02-02");
    });

    it("emits a tool call once, complete, before usage and done", async () => {
      const { provider } = make([
        { body: fx.render(scenarios["two parallel tool calls"] ?? never()) },
      ]);
      const { events } = await drain(provider, baseRequest());
      expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "usage", "done"]);
    });
  });

  describe("request translation", () => {
    it("sends the system prompt, tool specs and a full tool round trip", async () => {
      const { provider, script } = make([{ body: okBody(fx) }]);
      await run(provider, conformanceRequest());
      expect(script.calls[0]?.body).toEqual(fx.expectedRoundTripBody());
    });

    it("posts with the vendor's auth header and no api key in the body", async () => {
      const { provider, script } = make([{ body: okBody(fx) }]);
      await run(provider, baseRequest());
      const call = script.calls[0];
      expect(JSON.stringify(call?.headers)).toContain(API_KEY);
      expect(JSON.stringify(call?.body)).not.toContain(API_KEY);
    });

    it("echoes provider_data of its own provider and drops the others", async () => {
      const messages: Message[] = [
        { role: "user", blocks: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          blocks: [
            { type: "provider_data", provider: "someone-else", data: { secret: "must-not-leak" } },
            { type: "provider_data", provider: fx.providerId, data: fx.echoData as never },
            { type: "text", text: "hello" },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "again" }] },
      ];
      const { provider, script } = make([{ body: okBody(fx) }]);
      await run(provider, baseRequest({ messages }));
      const body = script.calls[0]?.body ?? {};
      expect(fx.bodyEchoes(body)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("must-not-leak");
    });

    describe("tool choice", () => {
      const sentBody = async (req: GenerateRequest) => {
        const { provider, script } = make([{ body: okBody(fx) }]);
        await run(provider, req);
        return script.calls[0]?.body ?? {};
      };
      const withTools = (toolChoice?: GenerateRequest["toolChoice"]) =>
        conformanceRequest().tools.length > 0
          ? { ...conformanceRequest(), ...(toolChoice === undefined ? {} : { toolChoice }) }
          : never();

      it("sends nothing for the default and for auto", async () => {
        const plain = await sentBody(withTools());
        const auto = await sentBody(withTools("auto"));
        expect(plain).not.toHaveProperty("tool_choice");
        expect(auto).toEqual(plain);
      });

      it("maps required to the vendor's must-call-a-tool field", async () => {
        const body = await sentBody(withTools("required"));
        expect(body).toMatchObject(fx.forcedToolChoiceWire("required"));
      });

      it("maps a named tool to the vendor's must-call-this-tool field", async () => {
        const body = await sentBody(withTools({ name: "get_weather" }));
        expect(body).toMatchObject(fx.forcedToolChoiceWire({ name: "get_weather" }));
      });

      it("changes nothing else in the body", async () => {
        const plain = await sentBody(withTools());
        const forced = await sentBody(withTools({ name: "get_weather" }));
        const { tool_choice: _ignored, ...rest } = forced;
        expect(rest).toEqual(plain);
      });

      it("sends no tool choice when there are no tools", async () => {
        const body = await sentBody(baseRequest({ toolChoice: "required" }));
        expect(body).not.toHaveProperty("tool_choice");
      });
    });

    it("rejects an invalid conversation before calling fetch", async () => {
      const { provider, script } = make([{ body: okBody(fx) }]);
      const messages: Message[] = [
        { role: "user", blocks: [{ type: "text", text: "hi" }] },
        { role: "assistant", blocks: [{ type: "tool_call", id: "c1", name: "t", args: {} }] },
      ];
      const error = await expectProviderError(run(provider, baseRequest({ messages })));
      expect(error.kind).toBe("invalid_request");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("c1");
      expect(script.calls).toHaveLength(0);
    });
  });

  describe("errors", () => {
    const table: [ErrorCase, string, boolean, number][] = [
      ["auth", "auth", false, 401],
      ["forbidden", "auth", false, 403],
      ["rate_limit", "rate_limit", true, 429],
      ["overloaded", "overloaded", true, fx.httpError("overloaded").status],
      ["invalid_request", "invalid_request", false, 400],
      ["context_overflow", "context_overflow", false, 400],
      ["not_found", "invalid_request", false, 404],
      ["server_error", "unknown", true, 500],
    ];
    for (const [kind, expectedKind, retryable, status] of table) {
      it(`maps ${kind} to ${expectedKind} (retryable: ${retryable})`, async () => {
        const { provider } = make([errorBody(fx, kind)], { maxRetries: 0 });
        const error = await expectProviderError(run(provider, baseRequest()));
        expect(error).toMatchObject({ kind: expectedKind, retryable, status });
        expect(error.message.length).toBeGreaterThan(10);
      });
    }

    it("reads retryAfterMs from the retry-after header", async () => {
      const { provider } = make([errorBody(fx, "rate_limit")], { maxRetries: 0 });
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error.retryAfterMs).toBe(2000);
    });

    it("maps a failing fetch to a retryable network error", async () => {
      const { provider } = make([new TypeError("fetch failed")], { maxRetries: 0 });
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error).toMatchObject({ kind: "network", retryable: true });
    });

    it("never leaks the api key, even when the server echoes it", async () => {
      const { provider } = make([errorBody(fx, "auth", API_KEY)], { maxRetries: 0 });
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).toContain("[redacted]");
    });

    it("fails with a network error when the request goes silent past requestTimeoutMs", async () => {
      const { provider } = make([{ body: [], ending: "hang" }], {
        maxRetries: 0,
        requestTimeoutMs: 20,
      });
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error).toMatchObject({ kind: "network", retryable: true });
      expect(error.message).toContain("timed out");
    });

    it("drops a tool call cut off by max tokens and keeps the text and complete calls", async () => {
      const { provider, script } = make([
        { body: fx.renderTruncated({ withText: true, withComplete: true }) },
      ]);
      const { events, error } = await drain(provider, baseRequest());
      expect(error).toBeUndefined();
      expect(events.filter((e) => e.type === "tool_call")).toEqual([
        { type: "tool_call", id: "call_1", name: "get_weather", args: { city: "Lisbon" } },
      ]);
      const result = await run(
        make([{ body: fx.renderTruncated({ withText: true, withComplete: true }) }]).provider,
        baseRequest(),
      );
      expect(result).toEqual({
        blocks: [
          { type: "text", text: "Let me check." },
          { type: "tool_call", id: "call_1", name: "get_weather", args: { city: "Lisbon" } },
        ],
        stopReason: "max_tokens",
        usage: { inputTokens: 20, outputTokens: 256 },
        modelVersion: SERVED_MODEL,
      });
      expect(script.calls).toHaveLength(1);
    });

    it("finishes with max_tokens when the only call is cut off", async () => {
      const { provider } = make([
        { body: fx.renderTruncated({ withText: false, withComplete: false }) },
      ]);
      const result = await run(provider, baseRequest());
      expect(result.blocks).toEqual([]);
      expect(result.stopReason).toBe("max_tokens");
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 256 });
    });

    it("fails with unknown (not retryable) and names the tool when arguments are not JSON", async () => {
      const { provider, script } = make([{ body: fx.renderBrokenToolArgs("get_weather") }]);
      const { events, error } = await drain(provider, baseRequest());
      expect(error).toMatchObject({ kind: "unknown", retryable: false });
      expect(error?.message).toContain("get_weather");
      expect(events.some((e) => e.type === "tool_call")).toBe(false);
      expect(script.calls).toHaveLength(1);
    });
  });

  describe("retries", () => {
    it("retries a retryable error and then succeeds, with jittered backoff", async () => {
      const { provider, script, sleeper } = make([
        errorBody(fx, "overloaded"),
        errorBody(fx, "server_error"),
        { body: okBody(fx) },
      ]);
      const result = await run(provider, baseRequest());
      expect(result.stopReason).toBe("end");
      expect(script.calls).toHaveLength(3);
      // random() = 0.5, base 100: exp 100 -> 75, exp 200 -> 150
      expect(sleeper.waits).toEqual([75, 150]);
    });

    it("honors retry-after instead of the backoff", async () => {
      const { provider, sleeper } = make([errorBody(fx, "rate_limit"), { body: okBody(fx) }]);
      await run(provider, baseRequest());
      expect(sleeper.waits).toEqual([2000]);
    });

    it("does not wait for a retry-after longer than the backoff cap", async () => {
      const { provider, script, sleeper } = make(
        [errorBody(fx, "rate_limit"), { body: okBody(fx) }],
        {
          retryMaxDelayMs: 1000,
        },
      );
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error).toMatchObject({ kind: "rate_limit", retryAfterMs: 2000 });
      expect(script.calls).toHaveLength(1);
      expect(sleeper.waits).toEqual([]);
    });

    it("stops after maxRetries and surfaces the last error", async () => {
      const { provider, script } = make(
        [errorBody(fx, "overloaded"), errorBody(fx, "overloaded"), errorBody(fx, "overloaded")],
        { maxRetries: 2 },
      );
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error.kind).toBe("overloaded");
      expect(script.calls).toHaveLength(3);
    });

    it("defaults to 3 retries", async () => {
      const steps = Array.from({ length: 5 }, () => errorBody(fx, "overloaded"));
      const { provider, script } = make(steps);
      await expectProviderError(run(provider, baseRequest()));
      expect(script.calls).toHaveLength(4);
    });

    it("does not retry non-retryable errors", async () => {
      const { provider, script, sleeper } = make([
        errorBody(fx, "invalid_request"),
        { body: okBody(fx) },
      ]);
      await expectProviderError(run(provider, baseRequest()));
      expect(script.calls).toHaveLength(1);
      expect(sleeper.waits).toEqual([]);
    });

    it("retries a network failure", async () => {
      const { provider, script } = make([new TypeError("fetch failed"), { body: okBody(fx) }]);
      await run(provider, baseRequest());
      expect(script.calls).toHaveLength(2);
    });

    it("retries a stream that ended before any event reached the caller", async () => {
      const { provider, script } = make([{ body: fx.renderOpeningOnly() }, { body: okBody(fx) }]);
      const result = await run(provider, baseRequest());
      expect(result.blocks).toEqual([{ type: "text", text: "Hello there, friend." }]);
      expect(script.calls).toHaveLength(2);
    });

    it("never retries once an event was delivered (connection drops mid-stream)", async () => {
      const { provider, script, sleeper } = make([
        { body: [fx.renderTextPrefix()], ending: "error" },
        { body: okBody(fx) },
      ]);
      const { events, error } = await drain(provider, baseRequest());
      expect(events).toEqual([{ type: "text_delta", text: "Hel" }]);
      expect(error).toMatchObject({ kind: "network", retryable: false });
      expect(script.calls).toHaveLength(1);
      expect(sleeper.waits).toEqual([]);
    });

    it("never retries a stream cut after text, and says it is not retryable", async () => {
      const { provider, script } = make([{ body: fx.renderTextPrefix() }, { body: okBody(fx) }]);
      const { events, error } = await drain(provider, baseRequest());
      expect(events).toEqual([{ type: "text_delta", text: "Hel" }]);
      expect(error).toMatchObject({ kind: "network", retryable: false });
      expect(script.calls).toHaveLength(1);
    });

    it("a stream cut with nothing delivered is a retryable network error when retries are off", async () => {
      const { provider } = make([{ body: fx.renderOpeningOnly() }], { maxRetries: 0 });
      const error = await expectProviderError(run(provider, baseRequest()));
      expect(error).toMatchObject({ kind: "network", retryable: true });
    });
  });

  describe("abort", () => {
    it("fails with aborted and does not call fetch when already aborted", async () => {
      const { provider, script } = make([{ body: okBody(fx) }]);
      const controller = new AbortController();
      controller.abort();
      const error = await expectProviderError(
        run(provider, baseRequest({ signal: controller.signal })),
      );
      expect(error).toMatchObject({ kind: "aborted", retryable: false });
      expect(script.calls).toHaveLength(0);
    });

    it("aborts the in-flight request (fetch never answers)", async () => {
      const controller = new AbortController();
      const fetchImpl = ((_: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch;
      const provider = fx.create(fetchImpl);
      const pending = expectProviderError(
        run(provider, baseRequest({ signal: controller.signal })),
      );
      controller.abort();
      expect(await pending).toMatchObject({ kind: "aborted", retryable: false });
    });

    it("aborts during the stream, cancels the body and does not retry", async () => {
      const control: StreamControl = { canceled: false };
      const body = streamOf([fx.renderTextPrefix()], "hang", control);
      const { provider, script } = make([{ body }, { body: okBody(fx) }]);
      const controller = new AbortController();
      const seen: string[] = [];
      let caught: unknown;
      try {
        for await (const event of provider.generate(baseRequest({ signal: controller.signal }))) {
          seen.push(event.type);
          controller.abort();
        }
      } catch (error) {
        caught = error;
      }
      expect(seen).toEqual(["text_delta"]);
      expect(caught).toBeInstanceOf(ProviderError);
      expect(caught).toMatchObject({ kind: "aborted", retryable: false });
      expect(script.calls).toHaveLength(1);
      await Promise.resolve();
      expect(control.canceled).toBe(true);
    });

    it("aborts while waiting to retry", async () => {
      const controller = new AbortController();
      const script = scriptedFetch([errorBody(fx, "overloaded"), { body: okBody(fx) }]);
      const provider = fx.create(script.fetch, {
        sleep: (_ms: number, signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("sleep aborted")));
            queueMicrotask(() => controller.abort());
          }),
      });
      const error = await expectProviderError(
        run(provider, baseRequest({ signal: controller.signal })),
      );
      expect(error.kind).toBe("aborted");
      expect(script.calls).toHaveLength(1);
    });

    it("stops reading when the consumer abandons the stream", async () => {
      const control: StreamControl = { canceled: false };
      const body = streamOf([fx.renderTextPrefix()], "hang", control);
      const { provider } = make([{ body }]);
      for await (const _event of provider.generate(baseRequest())) break;
      await Promise.resolve();
      expect(control.canceled).toBe(true);
    });
  });

  describe("onExchange", () => {
    it("is called once per attempt with the exact body, status and headers", async () => {
      const exchanges: ExchangeInfo[] = [];
      const { provider, script } = make(
        [errorBody(fx, "rate_limit"), { body: okBody(fx), headers: { "x-request-id": "req_9" } }],
        { onExchange: (x: ExchangeInfo) => exchanges.push(x) },
      );
      await run(provider, baseRequest());
      expect(exchanges).toHaveLength(2);
      expect(exchanges[0]).toMatchObject({ attempt: 1, status: 429 });
      expect(exchanges[0]?.error).toContain("429");
      expect(exchanges[0]?.responseHeaders["retry-after"]).toBe("2");
      expect(exchanges[1]).toMatchObject({ attempt: 2, status: 200 });
      expect(exchanges[1]?.error).toBeUndefined();
      expect(exchanges[1]?.responseHeaders["x-request-id"]).toBe("req_9");
      expect(exchanges[1]?.requestBody).toEqual(script.calls[1]?.body);
      expect(JSON.stringify(exchanges)).not.toContain(API_KEY);
    });

    it("reports a null status when no response arrived, and mid-stream failures", async () => {
      const exchanges: ExchangeInfo[] = [];
      const { provider } = make(
        [new TypeError("fetch failed"), { body: [fx.renderTextPrefix()], ending: "error" }],
        { onExchange: (x: ExchangeInfo) => exchanges.push(x) },
      );
      await drain(provider, baseRequest());
      expect(exchanges.map((x) => [x.attempt, x.status])).toEqual([
        [1, null],
        [2, 200],
      ]);
      expect(exchanges[0]?.error).toContain("fetch failed");
      expect(exchanges[1]?.error).toBeDefined();
    });

    it("is not called for a rejected conversation, and a throwing hook is harmless", async () => {
      const calls: ExchangeInfo[] = [];
      const bad = make([{ body: okBody(fx) }], { onExchange: (x: ExchangeInfo) => calls.push(x) });
      const invalid: GenerateRequest = baseRequest({
        messages: [
          { role: "assistant", blocks: [{ type: "tool_call", id: "c", name: "t", args: {} }] },
        ],
      });
      await expectProviderError(run(bad.provider, invalid));
      expect(calls).toHaveLength(0);

      const throwing = make([{ body: okBody(fx) }], {
        onExchange: () => {
          throw new Error("hook bug");
        },
      });
      expect((await run(throwing.provider, baseRequest())).stopReason).toBe("end");
    });
  });
});

describe("conformance: adapters agree", () => {
  for (const [scenario, abstract] of Object.entries(scenarios)) {
    it(`identical GenerateResult for "${scenario}"`, async () => {
      const results = await Promise.all(
        fixtures.map((fx) => {
          const script = scriptedFetch([{ body: splitEvery(fx.render(abstract), 7) }]);
          return run(fx.create(script.fetch), baseRequest());
        }),
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toEqual(expectedResult(abstract));
    });
  }
});
