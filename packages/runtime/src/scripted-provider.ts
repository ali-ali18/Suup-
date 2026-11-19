// NOT FOR PRODUCTION. A provider that answers from a JSON file, for end-to-end tests and demos
// that must run without any API key. It never talks to a model: whatever the file says is what
// "the model" does. Built on core's `FakeProvider`.
import { readFileSync } from "node:fs";
import {
  type Block,
  blockSchema,
  type GenerateRequest,
  PROVIDER_ERROR_KINDS,
  type Provider,
  ProviderError,
  type ProviderEvent,
  REVIEW_TOOL_NAME,
  stopReasonSchema,
  usageSchema,
} from "@suup/core";
import { FakeProvider, type FakeStep } from "@suup/core/testing";
import { z } from "zod";

const stepSchema = z.strictObject({
  /** Text of the answer (comes before the calls). */
  text: z.exactOptional(z.string()),
  /** Tool calls of the answer. `id` defaults to a stable one derived from the step. */
  calls: z.exactOptional(
    z.array(
      z.strictObject({
        id: z.exactOptional(z.string().min(1)),
        name: z.string().min(1),
        args: z.exactOptional(z.json()),
      }),
    ),
  ),
  /** Raw blocks, instead of `text` and `calls`. */
  blocks: z.exactOptional(z.array(blockSchema)),
  stopReason: z.exactOptional(stopReasonSchema),
  usage: z.exactOptional(usageSchema),
  modelVersion: z.exactOptional(z.string().min(1)),
  /** Wait this long before answering (honors an abort). Lets a demo be interrupted mid-turn. */
  delayMs: z.exactOptional(z.number().int().min(0)),
  /** Fail the call with this error instead of answering. */
  error: z.exactOptional(
    z.strictObject({
      kind: z.enum(PROVIDER_ERROR_KINDS),
      message: z.string(),
      retryable: z.exactOptional(z.boolean()),
    }),
  ),
});

export type ScriptStep = z.infer<typeof stepSchema>;

const sectionsShape = {
  review: z.exactOptional(z.array(stepSchema)),
  compaction: z.exactOptional(z.array(stepSchema)),
  /** The answers of the model reviewer of "Auto-review" (the `review_call` tool), in order. */
  autoReview: z.exactOptional(z.array(stepSchema)),
};

/** One script per task, chosen by the objective (see `ScriptFile.cases`). */
const caseSchema = z.strictObject({
  /** The case applies to requests whose conversation contains this text (the objective). */
  whenObjectiveContains: z.string().min(1),
  agent: z.array(stepSchema),
  ...sectionsShape,
});

const scriptSchema = z
  .strictObject({
    agent: z.exactOptional(z.array(stepSchema)),
    ...sectionsShape,
    /**
     * Several scripts in one file, for a provider that serves many tasks (the evaluation suite):
     * the first case whose `whenObjectiveContains` appears in the conversation answers. The
     * top-level `agent`, `review` and `compaction` are then ignored.
     */
    cases: z.exactOptional(z.array(caseSchema).min(1)),
  })
  .refine((file) => file.agent !== undefined || file.cases !== undefined, {
    message: 'o roteiro precisa de "agent" ou de "cases"',
  });

export type ScriptCase = z.infer<typeof caseSchema>;
/** `agent` is `[]` for a file that only has `cases`. */
export type ScriptFile = Omit<z.infer<typeof scriptSchema>, "agent"> & { agent: ScriptStep[] };

/** Reads and validates a script. A bare array is the `agent` list. Throws a plain `Error`. */
export function loadScript(path: string): ScriptFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`não foi possível ler o roteiro ${path}: ${(error as Error).message}`);
  }
  const parsed = scriptSchema.safeParse(Array.isArray(raw) ? { agent: raw } : raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new Error(`roteiro inválido em ${path}: ${issues}`);
  }
  return { ...parsed.data, agent: parsed.data.agent ?? [] };
}

export interface ScriptedProviderOptions {
  id: string;
  /** Absolute path of the JSON script. Read at the first call, so a missing file is a run error. */
  scriptPath: string;
  textChunkSize?: number;
}

type Section = "agent" | "review" | "compaction" | "autoReview";

/** The text of the whole conversation, to find the case a request belongs to. */
function conversationText(req: GenerateRequest): string {
  return req.messages
    .flatMap((m) => m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])))
    .join("\n");
}

/**
 * Which section of the script a request belongs to: the reviewer forces the `verdict` tool, the
 * Auto-review reviewer forces `review_call`, the compaction summarizer has no tools, everything
 * else is an agent turn.
 */
function sectionOf(req: GenerateRequest): Section {
  if (req.tools.length === 0) return "compaction";
  const choice = req.toolChoice;
  if (typeof choice === "object" && choice.name === "verdict") return "review";
  if (typeof choice === "object" && choice.name === REVIEW_TOOL_NAME) return "autoReview";
  return "agent";
}

/**
 * Answers come from the script, deterministically:
 *
 * - `agent`: the answer to a turn is `agent[n]`, where `n` is the number of assistant messages
 *   already in the conversation (the assistant turns of a conversation's history count too, so
 *   the second turn of a chat starts its script after the first one). It depends only on the request, so a run resumed in another
 *   process (after a pause, an escalation or a crash) goes on from the right step, and re-sending
 *   a recorded request (`suup resend`) gets the same answer again.
 * - `review`, `autoReview` and `compaction`: consumed in order within the process; the last step
 *   repeats when the list runs out.
 *
 * A file with `cases` holds one such script per task: the case whose `whenObjectiveContains` is in
 * the conversation answers (the objective is in the first message and in the reviewer's request).
 * A request that matches no case fails the call.
 *
 * Running past the end of `agent` fails the call (non-retryable), which makes a script that is too
 * short show up as a provider failure instead of hanging.
 */
export function createScriptedProvider(options: ScriptedProviderOptions): Provider {
  let script: ScriptFile | undefined;
  const consumed = new Map<string, number>();
  const fakeOptions = {
    id: options.id,
    ...(options.textChunkSize === undefined ? {} : { textChunkSize: options.textChunkSize }),
  };

  const load = (): ScriptFile => {
    script ??= loadScript(options.scriptPath);
    return script;
  };

  return {
    id: options.id,
    capabilities: { promptCache: false, parallelTools: true, vision: false },
    generate(req: GenerateRequest): AsyncIterable<ProviderEvent> {
      const fake = (step: FakeStep) => new FakeProvider([step], fakeOptions).generate(req);
      let section: Section;
      let index: number;
      let step: ScriptStep | undefined;
      try {
        const file = load();
        section = sectionOf(req);
        let key = "";
        let sections: Pick<ScriptFile, "agent" | "review" | "compaction" | "autoReview"> = file;
        if (file.cases !== undefined) {
          const text = conversationText(req);
          const found = file.cases.findIndex((c) => text.includes(c.whenObjectiveContains));
          const chosen = file.cases[found];
          if (chosen === undefined) {
            throw new Error(
              `nenhum caso do roteiro corresponde a este pedido (casos: ${file.cases.map((c) => JSON.stringify(c.whenObjectiveContains)).join(", ")})`,
            );
          }
          key = `c${found}:`;
          sections = chosen;
        }
        if (section === "agent") {
          index = req.messages.filter((m) => m.role === "assistant").length;
          step = sections.agent[index];
        } else {
          const list = sections[section] ?? [];
          index = consumed.get(`${key}${section}`) ?? 0;
          consumed.set(`${key}${section}`, index + 1);
          step = list[Math.min(index, list.length - 1)];
        }
      } catch (error) {
        return fake(
          new ProviderError(
            "unknown",
            `provedor scripted "${options.id}": ${(error as Error).message}`,
            {
              retryable: false,
            },
          ),
        );
      }
      if (step === undefined) {
        return fake(
          new ProviderError(
            "unknown",
            `provedor scripted "${options.id}": o roteiro não tem resposta para o passo ${index} de "${section}" (${options.scriptPath})`,
            { retryable: false },
          ),
        );
      }
      return fake(toFakeStep(step, `${section[0]}${index}`, req.signal));
    },
  };
}

function toFakeStep(step: ScriptStep, tag: string, signal: AbortSignal | undefined): FakeStep {
  if (step.error !== undefined) {
    const { kind, message, retryable } = step.error;
    return new ProviderError(kind, message, retryable === undefined ? {} : { retryable });
  }
  const blocks: Block[] = step.blocks ?? [
    ...(step.text === undefined || step.text === ""
      ? []
      : [{ type: "text" as const, text: step.text }]),
    ...(step.calls ?? []).map(
      (call, n): Block => ({
        type: "tool_call",
        id: call.id ?? `${tag}_${n + 1}`,
        name: call.name,
        args: (call.args ?? {}) as never,
      }),
    ),
  ];
  const response = {
    blocks,
    ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
    ...(step.usage === undefined ? {} : { usage: step.usage }),
    modelVersion: step.modelVersion ?? "scripted-1",
  };
  if (step.delayMs === undefined || step.delayMs === 0) return response;
  return async () => {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, step.delayMs);
      signal?.addEventListener("abort", done, { once: true });
    });
    return response; // the provider checks the abort right after this and fails the call if set
  };
}
