import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectModelRequest,
  MAX_RESEND_TIMES,
  type ResendAttempt,
  type ResendResult,
  resendRecordedRequest,
} from "@suup/runtime";
import { posInt, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { formatDuration, formatInt, oneLine } from "../format.js";
import { findRun } from "../lookup.js";

export {
  describeOutcome,
  outcomeKey,
  type ResendAttempt as Attempt,
  type ResendSummary,
  summarizeAttempts,
} from "@suup/runtime";

const NAME = "resend";

function describeAttempt(a: ResendAttempt, total: number): string[] {
  if (!a.ok) {
    return [
      `Tentativa ${a.attempt}/${total} · ${formatDuration(a.latencyMs)}`,
      `  falhou: ${a.error.kind}${a.error.retryable ? " (retentável)" : ""}: ${oneLine(a.error.message, 200)}`,
    ];
  }
  return [
    `Tentativa ${a.attempt}/${total} · ${formatDuration(a.latencyMs)} · versão do modelo: ${a.modelVersion}`,
    `  parada: ${a.stopReason} · tokens: ${formatInt(a.usage.inputTokens)} de entrada, ${formatInt(a.usage.outputTokens)} de saída`,
    ...a.toolCalls.map((c) => `  chamada: ${c.name} ${oneLine(JSON.stringify(c.args) ?? "", 160)}`),
    ...(a.text.trim() === "" ? [] : [`  texto: ${JSON.stringify(oneLine(a.text, 160))}`]),
  ];
}

export const resendCommand: CommandSpec = {
  name: NAME,
  summary:
    "Reenvia um pedido gravado ao modelo (N vezes, ou a outro modelo), sem tocar na execução",
  options: {
    seq: {
      type: "string",
      value: "seq",
      help: "seq do evento model_request a reenviar (veja com suup inspect --type model_request)",
    },
    times: {
      type: "string",
      value: "N",
      help: `Quantas vezes reenviar (padrão 1, máximo ${MAX_RESEND_TIMES})`,
    },
    model: {
      type: "string",
      value: "modelo",
      help: "Reenvia a outro modelo da configuração, em vez do modelo gravado",
    },
  },
  positionals: { names: ["execução"] },
  notes: [
    "O pedido é reenviado exatamente como foi gravado (sistema, mensagens, ferramentas, escolha de ferramenta).",
    "A execução não é alterada e o custo não entra nela; os resultados ficam em .suup/diagnostics/.",
    "  suup resend 3f2a9c1d --seq 14 --times 10      erra sempre ou só às vezes?",
    "  suup resend 3f2a9c1d --seq 14 --model model-y só este modelo erra?",
  ],
  async run(ctx) {
    const seq = posInt(ctx.args, "seq", NAME);
    if (seq === undefined) throw new UsageError("Falta --seq <seq do model_request>.", NAME);
    const times = posInt(ctx.args, "times", NAME) ?? 1;
    if (times > MAX_RESEND_TIMES) {
      throw new UsageError(`--times aceita no máximo ${MAX_RESEND_TIMES}.`, NAME);
    }
    const otherModel = str(ctx.args, "model");

    const runtime = ctx.runtime();
    const run = await findRun(runtime.db, ctx.args.positionals[0] as string);
    // Fails early, with the list of requests the run has, before anything is sent.
    const request = await inspectModelRequest(runtime.db, run.id, seq);
    const purpose = request.purpose;

    if (otherModel !== undefined) runtime.resolveModel(otherModel); // unknown model: fail before sending anything

    const abort = new AbortController();
    const unsubscribe = ctx.io.onInterrupt(() => {
      if (!abort.signal.aborted) {
        ctx.out.err("Interrompendo: as tentativas restantes não serão feitas.");
        abort.abort();
      }
    });
    let doc: ResendResult;
    try {
      const target = otherModel ?? request.request.model;
      ctx.out.line(
        `Reenviando o pedido do evento ${seq} (${purpose === "agent" ? "agente" : purpose === "review" ? "revisor" : purpose === "progress" ? "vigia de progresso" : "compactação"}) da execução ${run.id.slice(0, 8)}: ${times} vez${times === 1 ? "" : "es"} para ${target}${target === request.request.model ? "" : ` (o original usou ${request.request.model})`}`,
      );
      doc = await resendRecordedRequest(runtime, {
        runId: run.id,
        seq,
        times,
        ...(otherModel === undefined ? {} : { model: otherModel }),
        signal: abort.signal,
        onAttempt: (result, total) => {
          if (ctx.json) ctx.out.ndjson({ type: "attempt", ...result });
          else ctx.out.lines(describeAttempt(result, total));
        },
      });
    } finally {
      unsubscribe();
    }

    const { attempts, summary } = doc;
    const dir = join(ctx.io.cwd, ".suup", "diagnostics");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `resend-${run.id.slice(0, 8)}-seq${seq}-${stamp}.json`);
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

    if (ctx.json) {
      ctx.out.ndjson({ type: "summary", file, ...summary });
      return attempts.some((a) => a.ok) ? EXIT_OK : EXIT_FAILED;
    }
    const out = ctx.out;
    out.line("");
    out.line(
      `Resumo: ${summary.attempts} tentativa${summary.attempts === 1 ? "" : "s"}, ${summary.distinct.length} desfecho${summary.distinct.length === 1 ? "" : "s"} distinto${summary.distinct.length === 1 ? "" : "s"}${summary.distinct.length > 0 && summary.sameArguments ? "" : " (e os argumentos das chamadas também variaram)"}.`,
    );
    for (const d of summary.distinct) out.line(`  ${d.count}× ${d.description}`);
    if (summary.recorded !== null) {
      out.line(
        `Desfecho gravado na execução: ${summary.recorded.description}; repetido em ${summary.recordedRepeated} de ${summary.attempts}.`,
      );
    }
    out.line(`Leitura: ${summary.reading}`);
    out.line(`Resultados salvos em ${file}`);
    return attempts.some((a) => a.ok) ? EXIT_OK : EXIT_FAILED;
  },
};
