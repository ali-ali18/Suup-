import type { ComparableEvent, RequestChange } from "@suup/core";
import { replayRecordedRun } from "@suup/runtime";

export { explainReplay } from "@suup/runtime";

import type { CommandSpec } from "../context.js";
import { EXIT_FAILED, EXIT_OK } from "../errors.js";
import { oneLine, statusPt } from "../format.js";
import { findRun } from "../lookup.js";

const FIELD_PT: Record<RequestChange["field"], string> = {
  provider: "provedor",
  model: "modelo",
  system: "prompt do sistema",
  messages: "mensagens",
  tools: "ferramentas",
  toolChoice: "escolha de ferramenta",
  maxOutputTokens: "limite de saída",
  temperature: "temperatura",
};

function describeEvent(event: ComparableEvent | undefined): string {
  if (event === undefined) return "(nada: a gravação ou a reexecução já tinha acabado)";
  return `${event.type} ${oneLine(JSON.stringify(event.payload), 160)}`;
}

function describeChange(change: RequestChange): string {
  const name = FIELD_PT[change.field];
  if (change.field === "messages") {
    return `${name} (a primeira diferença está na mensagem ${(change.firstMessage ?? 0) + 1})`;
  }
  if (change.field === "system" || change.field === "tools") return name;
  return `${name}: gravado ${oneLine(JSON.stringify(change.recorded) ?? "nada", 40)}, agora ${oneLine(JSON.stringify(change.replayed) ?? "nada", 40)}`;
}

export const replayCommand: CommandSpec = {
  name: "replay",
  summary:
    "Reexecuta o loop atual com as respostas gravadas do modelo e das ferramentas, sem chamar nada de verdade",
  options: {},
  positionals: { names: ["execução"] },
  notes: [
    "Nenhuma ferramenta é executada e nenhum modelo é chamado: tudo vem da gravação.",
    "Idêntico: o harness atual reproduz a execução. Divergência: o harness decide diferente com as mesmas respostas",
    "(código de saída 1, para servir de teste de regressão).",
  ],
  async run(ctx) {
    const runtime = ctx.runtime();
    const run = await findRun(runtime.db, ctx.args.positionals[0] as string);
    const { view, report, seqOf, eventCount } = await replayRecordedRun(runtime, run.id);
    const reading = view.reading;

    if (ctx.json) {
      ctx.out.data(view);
      return report.identical ? EXIT_OK : EXIT_FAILED;
    }
    const out = ctx.out;
    out.line(`Replay da execução ${run.id} (${eventCount} eventos gravados)`);
    out.line(
      `Resultado: ${report.identical && report.requestDiffs.length === 0 ? "IDÊNTICO" : report.identical ? "IDÊNTICO nas decisões, com pedidos diferentes" : "DIFERENTE"}`,
    );
    out.line(
      `Situação final: gravada ${report.finalStatus.recorded === null ? "—" : statusPt(report.finalStatus.recorded)}, reexecutada ${report.finalStatus.replayed === null ? "—" : statusPt(report.finalStatus.replayed)}`,
    );
    const d = report.firstDivergence;
    if (d !== undefined) {
      out.line("");
      out.line(`Primeira divergência: posição ${d.index} (evento seq ${seqOf(d.index) ?? "?"})`);
      out.line(`  gravado:     ${describeEvent(d.recorded)}`);
      out.line(`  reexecutado: ${describeEvent(d.replayed)}`);
      if (d.changedFields !== undefined && d.changedFields.length > 0)
        out.line(`  campos diferentes: ${d.changedFields.join(", ")}`);
      if (d.reason !== undefined) out.line(`  motivo: ${d.reason}`);
    }
    if (report.requestDiffs.length > 0) {
      out.line("");
      out.line("Pedidos ao modelo que o código atual monta de outro jeito:");
      for (const diff of report.requestDiffs) {
        const purpose =
          diff.purpose === "agent"
            ? "agente"
            : diff.purpose === "review"
              ? "revisor"
              : "compactação";
        out.line(
          `  evento seq ${seqOf(diff.index) ?? "?"} (${purpose}): ${diff.changes.map(describeChange).join("; ")}`,
        );
      }
    }
    out.line("");
    out.line(`Leitura: ${reading}`);
    return report.identical ? EXIT_OK : EXIT_FAILED;
  },
};
