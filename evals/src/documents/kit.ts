import { CREATE_DOCUMENT_TOOL_NAME, type StoredEvent } from "@suup/core";
import { eventsOf, toolCalls } from "../kit.js";
import type { DeliveredFile, EvalCheck, EvalTask, VerifyContext, VerifyResult } from "../types.js";

/** How the bot is asked to make the file: with the dedicated tool, or with its own script. */
export type DocumentMode = "tool" | "script";

export const MODE_SUFFIX: Readonly<Record<DocumentMode, string>> = {
  tool: "tool",
  script: "script",
};

export interface DocumentTaskSpec {
  /** The id without the mode: `doc-<name>`. The task id is `doc-<name>-tool` or `-script`. */
  name: string;
  title: string;
  objective: string;
  criteria: string[];
  /** The file extension the bot must deliver, with the dot. */
  extension: ".pdf" | ".xlsx";
  limits: EvalTask["limits"];
  setup?: EvalTask["setup"];
  /** Judges the delivered file (and may add measurements to the report). */
  judge(file: DeliveredFile): Promise<{
    checks: EvalCheck[];
    observations?: Record<string, string | number | boolean>;
  }>;
}

/** The last file the run delivered with this extension, if any. */
export function deliveredWith(files: readonly DeliveredFile[], extension: string) {
  return files.filter((f) => f.name.toLowerCase().endsWith(extension)).at(-1);
}

/** Text the bot wrote in its own words: the final summary and every text block of its turns. */
export function botText(events: readonly StoredEvent[]): { final: string; all: string } {
  let final = "";
  for (const event of [...events].reverse()) {
    if (event.type === "status_changed" && event.payload.to === "done") {
      final = event.payload.result?.summary ?? "";
      break;
    }
  }
  const spoken: string[] = [];
  for (const event of eventsOf(events, "model_response")) {
    if ((event.payload.purpose ?? "agent") !== "agent") continue;
    for (const block of event.payload.blocks) {
      if (block.type === "text") spoken.push(block.text);
    }
  }
  return { final, all: [final, ...spoken].join("\n") };
}

/** Tokens and tool use of the run, for the report (the cost is the run's own). */
export function runObservations(
  events: readonly StoredEvent[],
): Record<string, string | number | boolean> {
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const event of eventsOf(events, "model_response")) {
    cacheRead += event.payload.usage.cachedInputTokens ?? 0;
    cacheWrite += event.payload.usage.cacheWriteInputTokens ?? 0;
  }
  const calls = toolCalls(events);
  return {
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    createDocumentCalls: calls.filter((c) => c.name === CREATE_DOCUMENT_TOOL_NAME).length,
    createDocumentErrors: calls.filter(
      (c) => c.name === CREATE_DOCUMENT_TOOL_NAME && c.result?.isError === true,
    ).length,
    shellCalls: calls.filter((c) => c.name === "shell").length,
    sendFileCalls: calls.filter((c) => c.name === "send_file").length,
  };
}

/** One task of a pair: the same objective and the same judge, with or without the tool. */
export function documentTask(spec: DocumentTaskSpec, mode: DocumentMode): EvalTask {
  return {
    id: `${spec.name}-${MODE_SUFFIX[mode]}`,
    title: `${spec.title} (${mode === "tool" ? "com a ferramenta de documento" : "com script do bot"})`,
    category: "files",
    objective: spec.objective,
    criteria: spec.criteria,
    limits: spec.limits,
    expect: { status: "done" },
    deliverFiles: true,
    ...(mode === "script" ? { withoutTools: [CREATE_DOCUMENT_TOOL_NAME] } : {}),
    async setup(ws) {
      await spec.setup?.(ws);
    },
    // The product is the delivered file, not the workspace: there is nothing to do in the workspace
    // that a verifier would look at. The unit tests judge files built with the dedicated maker.
    async reference() {},
    async verify(ctx: VerifyContext): Promise<VerifyResult> {
      const files = ctx.files ?? [];
      const file = deliveredWith(files, spec.extension);
      let judged: Record<string, string | number | boolean> = {};
      const checks: EvalCheck[] = [
        {
          name: `entregou um arquivo ${spec.extension}`,
          pass: file !== undefined,
          detail:
            file === undefined
              ? `entregues: ${files.map((f) => f.name).join(", ") || "nenhum"}`
              : file.name,
        },
      ];
      if (file !== undefined) {
        try {
          const verdict = await spec.judge(file);
          checks.push(...verdict.checks);
          judged = verdict.observations ?? {};
        } catch (error) {
          checks.push({
            name: "o arquivo abre",
            pass: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const text = botText(ctx.events);
      const names = files.map((f) => f.name);
      const observations: Record<string, string | number | boolean> = {
        ...runObservations(ctx.events),
        ...judged,
        arquivosEntregues: names.join(", "),
        nomeRepetidoNoTexto: names.some((n) => text.all.includes(n)),
        mensagemFinal: text.final,
      };
      const pass = checks.every((c) => c.pass);
      return { pass, checks, observations };
    },
  };
}
