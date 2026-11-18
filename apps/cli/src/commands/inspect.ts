import { type Message, RUN_EVENT_TYPES } from "@suup/core";
import { flag, list, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatClockMs, formatDuration, formatInt, indent, oneLine } from "../format.js";
import { findRun, readEvents } from "../lookup.js";
import { type RawEvent, summarizeEvent, typedEvent } from "../render.js";

const NAME = "inspect";

function nonNegativeInt(ctx: Ctx, name: string): number | undefined {
  const raw = str(ctx.args, name);
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new UsageError(
      `--${name} precisa de um número inteiro (recebido ${JSON.stringify(raw)}).`,
      NAME,
    );
  }
  return Number(raw);
}

export const inspectCommand: CommandSpec = {
  name: NAME,
  summary: "Linha do tempo dos eventos crus de uma execução (o que o modelo viu, com --request)",
  options: {
    from: { type: "string", value: "N", help: "Primeiro seq a mostrar" },
    to: { type: "string", value: "N", help: "Último seq a mostrar" },
    type: {
      type: "string",
      value: "t1,t2",
      help: "Só estes tipos de evento (ex.: tool_call,tool_result)",
    },
    full: { type: "boolean", help: "Imprime o conteúdo completo de cada evento" },
    request: {
      type: "string",
      value: "seq",
      help: "Mostra exatamente o que o modelo viu no pedido (model_request) deste seq",
    },
  },
  positionals: { names: ["execução"] },
  notes: [
    `Tipos de evento: ${RUN_EVENT_TYPES.join(", ")}.`,
    "Exemplos:",
    "  suup inspect 3f2a9c1d                      linha do tempo",
    "  suup inspect 3f2a9c1d --type tool_call,tool_result --full",
    "  suup inspect 3f2a9c1d --request 14         o pedido ao modelo que está no evento 14",
  ],
  async run(ctx) {
    const requestSeq = nonNegativeInt(ctx, "request");
    const from = nonNegativeInt(ctx, "from");
    const to = nonNegativeInt(ctx, "to");
    const types = list(ctx.args, "type")
      .flatMap((v) => v.split(","))
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const unknown = types.filter((t) => !(RUN_EVENT_TYPES as string[]).includes(t));
    if (unknown.length > 0) {
      throw new UsageError(
        `Tipo de evento desconhecido: ${unknown.join(", ")}. Tipos: ${RUN_EVENT_TYPES.join(", ")}.`,
        NAME,
      );
    }
    const db = ctx.runtime().db;
    const run = await findRun(db, ctx.args.positionals[0] as string);
    const events = await readEvents(db, run.id);
    if (requestSeq !== undefined) return showRequest(ctx, run.id, events, requestSeq);
    const picked = events.filter(
      (e) =>
        (from === undefined || e.seq >= from) &&
        (to === undefined || e.seq <= to) &&
        (types.length === 0 || types.includes(e.type)),
    );
    if (ctx.json) {
      ctx.out.data(
        picked.map((e) => ({
          seq: e.seq,
          type: e.type,
          createdAt: e.createdAt.toISOString(),
          payload: e.payload,
        })),
      );
      return EXIT_OK;
    }
    ctx.out.line(`Execução ${run.id}: ${picked.length} de ${events.length} eventos`);
    const seqWidth = String(events.at(-1)?.seq ?? 0).length;
    const full = flag(ctx.args, "full");
    for (const e of picked) {
      ctx.out.line(
        `${String(e.seq).padStart(seqWidth)}  ${formatClockMs(e.createdAt)}  ${e.type.padEnd(15)} ${summarizeEvent(e)}`,
      );
      if (full) {
        ctx.out.lines(indent(JSON.stringify(e.payload, null, 2), "      "));
      }
    }
    if (picked.length === 0) ctx.out.line("(nenhum evento neste filtro)");
    return EXIT_OK;
  },
};

function renderMessage(message: Message, index: number): string[] {
  const lines = [`[${index + 1}] ${message.role === "user" ? "usuário" : "assistente"}`];
  for (const block of message.blocks) {
    switch (block.type) {
      case "text":
        lines.push(...indent(block.text, "    "));
        break;
      case "tool_call":
        lines.push(`    → chamada ${block.name} (id ${block.id}): ${JSON.stringify(block.args)}`);
        break;
      case "tool_result":
        lines.push(`    ← resultado da chamada ${block.callId}${block.isError ? " (erro)" : ""}:`);
        lines.push(...indent(block.content, "      "));
        break;
      case "provider_data":
        lines.push(
          `    [dados opacos do provedor ${block.provider}: ${JSON.stringify(block.data).length} caracteres]`,
        );
        break;
    }
  }
  return lines;
}

function showRequest(ctx: Ctx, runId: string, events: RawEvent[], seq: number): number {
  const event = events.find((e) => e.seq === seq);
  if (event === undefined) throw new CommandError(`A execução não tem o evento seq ${seq}.`);
  const typed = typedEvent(event);
  if (event.type !== "model_request" || typed?.type !== "model_request") {
    const near = events
      .filter((e) => e.type === "model_request")
      .map((e) => e.seq)
      .join(", ");
    throw new CommandError(
      `O evento ${seq} é "${event.type}", não um model_request. Pedidos ao modelo desta execução: seq ${near === "" ? "(nenhum)" : near}.`,
    );
  }
  const req = typed.payload;
  const purpose = req.purpose ?? "agent";
  const turn = events.filter(
    (e) =>
      e.seq <= seq &&
      e.type === "model_request" &&
      ((typedEvent(e) as { payload: { purpose?: string } } | undefined)?.payload.purpose ??
        "agent") === "agent",
  ).length;
  const response = events.find((e) => {
    if (e.seq <= seq || e.type !== "model_response") return false;
    const t = typedEvent(e);
    return t?.type === "model_response" && (t.payload.purpose ?? "agent") === purpose;
  });
  const full = flag(ctx.args, "full");

  if (ctx.json) {
    ctx.out.data({
      runId,
      seq,
      request: req,
      response: response === undefined ? null : { seq: response.seq, ...response.payload },
    });
    return EXIT_OK;
  }
  const out = ctx.out;
  out.line(
    `Pedido ao modelo: evento ${seq}${purpose === "agent" ? ` (turno ${turn} do agente)` : ` (${purpose === "review" ? "revisor" : "compactação"})`}`,
  );
  out.line(
    `Provedor: ${req.provider} · Modelo: ${req.model} · Saída máxima: ${formatInt(req.maxOutputTokens)} tokens · Escolha de ferramenta: ${req.toolChoice === undefined ? "auto" : typeof req.toolChoice === "string" ? req.toolChoice : `obrigatória: ${req.toolChoice.name}`}${req.temperature === undefined ? "" : ` · Temperatura: ${req.temperature}`}`,
  );
  out.line("");
  out.line("=== SISTEMA ===");
  out.lines(indent(req.system, "  "));
  out.line("");
  out.line(`=== MENSAGENS (${req.messages.length}) ===`);
  for (const [i, m] of req.messages.entries()) out.lines(renderMessage(m, i));
  out.line("");
  out.line(`=== FERRAMENTAS (${req.tools.length}) ===`);
  for (const tool of req.tools) {
    if (full) {
      out.line(`- ${tool.name}: ${tool.description}`);
      out.lines(indent(JSON.stringify(tool.inputSchema, null, 2), "    "));
    } else {
      out.line(`- ${tool.name}: ${oneLine(tool.description, 110)}`);
    }
  }
  out.line("");
  const answer = response === undefined ? undefined : typedEvent(response);
  if (response !== undefined && answer?.type === "model_response") {
    const r = answer.payload;
    out.line(`=== RESPOSTA GRAVADA (evento ${response.seq}) ===`);
    out.line(
      `Parada: ${r.stopReason} · versão do modelo: ${r.modelVersion} · ${formatInt(r.usage.inputTokens)} tokens de entrada, ${formatInt(r.usage.outputTokens)} de saída · ${formatDuration(r.durationMs)}`,
    );
    for (const b of r.blocks) {
      if (b.type === "text") out.lines(indent(b.text, "  "));
      else if (b.type === "tool_call")
        out.line(`  → chamada ${b.name} (id ${b.id}): ${JSON.stringify(b.args)}`);
    }
  } else {
    out.line("=== RESPOSTA GRAVADA ===");
    out.line(
      "(nenhuma: o pedido falhou ou a execução parou antes da resposta; veja os eventos model_error)",
    );
  }
  return EXIT_OK;
}
