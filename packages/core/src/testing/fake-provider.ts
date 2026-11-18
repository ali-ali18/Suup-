import type { Block } from "../messages.js";
import {
  type GenerateRequest,
  type GenerateResult,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  type ProviderEvent,
  type StopReason,
  type Usage,
} from "../provider.js";

/** A scripted response. Omitted fields get defaults. */
export interface FakeResponse {
  blocks: Block[];
  /** Default: "tool_calls" if the blocks contain a tool call, else "end". */
  stopReason?: StopReason;
  /** Default: `{ inputTokens: 10, outputTokens: 5 }`. */
  usage?: Usage;
  /** Default: "fake-model-1". */
  modelVersion?: string;
}

export type FakeStep =
  | FakeResponse
  | GenerateResult
  | ((req: RecordedRequest) => FakeResponse | Promise<FakeResponse>)
  | Error;

/** A request as received, deep-copied. The abort signal is not recorded. */
export type RecordedRequest = Omit<GenerateRequest, "signal">;

export interface FakeProviderOptions {
  id?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Split text blocks into deltas of this many characters (default: one delta per block). */
  textChunkSize?: number;
}

/**
 * Deterministic scripted provider for tests. Each `generate` call consumes the next step:
 * a response, a function of the request, or an `Error` to throw from the stream.
 * Calling `generate` more times than there are steps throws synchronously.
 */
export class FakeProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[] = [];
  readonly #steps: FakeStep[];
  readonly #textChunkSize: number | undefined;
  #next = 0;

  constructor(steps: FakeStep[], options: FakeProviderOptions = {}) {
    this.#steps = [...steps];
    this.id = options.id ?? "fake";
    this.capabilities = {
      promptCache: false,
      parallelTools: true,
      vision: false,
      ...options.capabilities,
    };
    this.#textChunkSize = options.textChunkSize;
  }

  /** Number of `generate` calls so far. */
  get calls(): number {
    return this.#next;
  }

  /** Number of scripted steps not consumed yet. */
  get remaining(): number {
    return this.#steps.length - this.#next;
  }

  generate(req: GenerateRequest): AsyncIterable<ProviderEvent> {
    const { signal, ...rest } = req;
    const recorded: RecordedRequest = structuredClone(rest);
    this.requests.push(recorded);
    const step = this.#steps[this.#next];
    if (step === undefined) {
      throw new Error(
        `FakeProvider called ${this.#next + 1} time(s) but only ${this.#steps.length} step(s) were scripted`,
      );
    }
    this.#next += 1;
    return this.#stream(step, recorded, signal);
  }

  async *#stream(
    step: FakeStep,
    recorded: RecordedRequest,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ProviderEvent> {
    const checkAbort = () => {
      if (signal?.aborted) throw new ProviderError("aborted", "request aborted");
    };
    checkAbort();

    if (step instanceof Error) throw step;
    const response = typeof step === "function" ? await step(structuredClone(recorded)) : step;
    checkAbort();

    const hasToolCall = response.blocks.some((b) => b.type === "tool_call");
    for (const block of response.blocks) {
      switch (block.type) {
        case "text":
          for (const chunk of chunks(block.text, this.#textChunkSize)) {
            yield { type: "text_delta", text: chunk };
            checkAbort();
          }
          break;
        case "tool_call":
          yield { type: "tool_call", id: block.id, name: block.name, args: block.args };
          break;
        case "provider_data":
          yield { type: "provider_data", data: block.data };
          break;
        case "tool_result":
          throw new Error("FakeProvider: a scripted response cannot contain tool_result blocks");
      }
      checkAbort();
    }

    const usage = response.usage ?? { inputTokens: 10, outputTokens: 5 };
    yield { type: "usage", ...usage };
    checkAbort();
    yield {
      type: "done",
      stopReason: response.stopReason ?? (hasToolCall ? "tool_calls" : "end"),
      modelVersion: response.modelVersion ?? "fake-model-1",
    };
  }
}

function chunks(text: string, size: number | undefined): string[] {
  if (size === undefined || size <= 0 || text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
