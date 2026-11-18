import { type ComparableEvent, type ReplayReport, type RequestChange, replayRun } from "@suup/core";
import { getBot } from "@suup/db";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK } from "../errors.js";
import { oneLine, statusPt } from "../format.js";
import { findRun, readEvents, toRecorded } from "../lookup.js";

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

/** The one-paragraph reading of a replay report, in plain Portuguese. */
export function explainReplay(
  report: ReplayReport,
  seqOf: (index: number) => number | undefined,
): string {
  const diffs = report.requestDiffs;
  if (report.identical && diffs.length === 0) {
    return "O loop atual reproduz a execução: com as mesmas respostas do modelo e das ferramentas, o harness tomou as mesmas decisões e montou os mesmos pedidos. Se o resultado foi ruim, o problema não está no código do harness: está no modelo ou nas instruções que ele recebeu (veja o que ele viu com `suup inspect --request` e teste com `suup resend`).";
  }
  if (report.identical) {
    return `Só o que é enviado ao modelo mudou: o harness toma as mesmas decisões com as respostas gravadas, mas ${diffs.length === 1 ? "um pedido" : `${diffs.length} pedidos`} que o código atual monta ${diffs.length === 1 ? "é diferente do gravado" : "são diferentes dos gravados"} (prompt, contexto ou descrição de ferramentas). Os modelos poderiam responder de outro jeito agora; confira com \`suup resend\`.`;
  }
  const divergence = report.firstDivergence;
  const where =
    divergence === undefined
      ? "em algum ponto"
      : `no evento ${seqOf(divergence.index) ?? divergence.index + 1}`;
  const stopped =
    report.stoppedBecause === undefined
      ? ""
      : ` A reexecução parou porque a gravação não tinha o que ela pediu (${report.stoppedBecause}); isso quer dizer que o código atual faz uma chamada que a execução original não fez.`;
  return `O comportamento do harness mudou ${where}: com as mesmas respostas gravadas, o código atual decide de outro jeito que o código que rodou a execução.${stopped}${diffs.length > 0 ? " Além disso, parte do que é enviado ao modelo também mudou." : ""} Se a mudança foi proposital, esta execução deixou de ser um teste de regressão válido; se não foi, é uma regressão do harness.`;
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
    const bot = await getBot(runtime.db, run.botId);
    if (bot === null) throw new CommandError(`O bot ${run.botId} desta execução não existe mais.`);
    const events = toRecorded(await readEvents(runtime.db, run.id));
    if (events.length === 0) throw new CommandError("Esta execução não tem eventos gravados.");
    let report: ReplayReport;
    try {
      report = await replayRun(events, { bot: runtime.botConfig(bot), tools: runtime.tools });
    } catch (error) {
      throw new CommandError(
        `Não foi possível reexecutar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const seqOf = (index: number) => events[index]?.seq;
    const reading = explainReplay(report, seqOf);

    if (ctx.json) {
      ctx.out.data({
        runId: run.id,
        identical: report.identical,
        finalStatus: report.finalStatus,
        firstDivergence:
          report.firstDivergence === undefined
            ? null
            : { ...report.firstDivergence, seq: seqOf(report.firstDivergence.index) ?? null },
        requestDiffs: report.requestDiffs.map((d) => ({ ...d, seq: seqOf(d.index) ?? null })),
        stoppedBecause: report.stoppedBecause ?? null,
        reading,
      });
      return report.identical ? EXIT_OK : EXIT_FAILED;
    }
    const out = ctx.out;
    out.line(`Replay da execução ${run.id} (${events.length} eventos gravados)`);
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
