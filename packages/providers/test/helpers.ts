import {
  collect,
  type GenerateRequest,
  type GenerateResult,
  type Provider,
  ProviderError,
  type ProviderEvent,
} from "@suup/core";

const encoder = new TextEncoder();

export interface StreamControl {
  /** Set when the consumer cancelled the stream. */
  canceled: boolean;
}

/**
 * A response body made of the given chunks. After the chunks the stream closes (`end`),
 * errors like a dropped connection (`error`), or stays open until cancelled (`hang`).
 */
export function streamOf(
  chunks: (string | Uint8Array)[],
  ending: "end" | "error" | "hang" = "end",
  control: StreamControl = { canceled: false },
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk !== undefined) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        return;
      }
      if (ending === "end") controller.close();
      else if (ending === "error") controller.error(new TypeError("terminated"));
      else return new Promise<void>(() => {}); // hang
    },
    cancel() {
      control.canceled = true;
    },
  });
}

export function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** One SSE event. `data` objects are JSON-encoded. */
export function sseEvent(event: string | undefined, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `${event !== undefined ? `event: ${event}\n` : ""}data: ${payload}\n\n`;
}

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Text (sent as one chunk), a list of chunks, or a ready-made stream. */
  body?: string | string[] | ReadableStream<Uint8Array>;
  /** How a chunk list ends. Default "end". */
  ending?: "end" | "error" | "hang";
  control?: StreamControl;
}

export type FetchStep = ScriptedResponse | Error;

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON request body. */
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

export function scriptedFetch(steps: FetchStep[]) {
  const calls: RecordedCall[] = [];
  let next = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal,
    });
    const step = steps[next++];
    if (step === undefined)
      throw new Error(`fetch called ${next} times, only ${steps.length} scripted`);
    if (step instanceof Error) throw step;
    const status = step.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body =
      step.body instanceof ReadableStream
        ? step.body
        : typeof step.body === "string" || Array.isArray(step.body)
          ? streamOf(
              typeof step.body === "string" ? [step.body] : step.body,
              step.ending,
              step.control,
            )
          : null;
    return new Response(body, {
      status,
      headers: { ...(ok ? { "content-type": "text/event-stream" } : {}), ...step.headers },
    });
  };
  return {
    fetch: impl as typeof fetch,
    calls,
    get used() {
      return next;
    },
  };
}

export function baseRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "model-x",
    system: "",
    messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 256,
    ...overrides,
  };
}

export function run(provider: Provider, req: GenerateRequest): Promise<GenerateResult> {
  return collect(provider.generate(req), provider.id);
}

/** Drains a stream, returning the events seen and the error that ended it (if any). */
export async function drain(
  provider: Provider,
  req: GenerateRequest,
): Promise<{ events: ProviderEvent[]; error: ProviderError | undefined }> {
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.generate(req)) events.push(event);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { events, error };
  }
  return { events, error: undefined };
}

export async function expectProviderError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a ProviderError, but the call succeeded");
}

/** Records requested waits without waiting. */
export function instantSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}
