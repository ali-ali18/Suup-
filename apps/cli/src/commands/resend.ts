import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GenerateRequest,
  type GenerateResult,
  generateAndCollect,
  type Provider,
  ProviderError,
  type ProviderErrorKind,
  type StopReason,
} from "@suup/core";
import { RuntimeError } from "@suup/runtime";
import { posInt, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, UsageError } from "../errors.js";
import { formatDuration, formatInt, oneLine } from "../format.js";
import { findRun, readEvents } from "../lookup.js";
import { typedEvent } from "../render.js";

const NAME = "resend";
const MAX_TIMES = 100;

export type Attempt =
  | {
      attempt: number;
      ok: true;
      latencyMs: number;
      stopReason: StopReason;
      toolCalls: { name: string; args: unknown }[];
      text: string;
      usage: GenerateResult["usage"];
      modelVersion: string;
    }
  | {
      attempt: number;
      ok: false;
      latencyMs: number;
      error: { kind: ProviderErrorKind | "other"; message: string; retryable: boolean };
    };

/** What the model did, reduced to the decision: why it stopped and which tools it called. */
export function outcomeKey(a: Attempt): string {
  if (!a.ok) return `erro:${a.error.kind}`;
  const names = a.toolCalls.map((c) => c.name);
  return `${a.stopReason}|${names.length === 0 ? "só texto" : names.join("+")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function describeOutcome(key: string): string {
  if (key.startsWith("erro:")) return `falha do provedor (${key.slice(5)})`;
  const [stop = "", what = ""] = key.split("|");
  return what === "só texto"
    ? `respondeu só com texto (parada: ${stop})`
    : `chamou ${what.replaceAll("+", " + ")} (parada: ${stop})`;
}

export interface ResendSummary {
  attempts: number;
  distinct: { outcome: string; description: string; count: number }[];
  /** Whether every attempt with the same tools also had the same arguments. */
  sameArguments: boolean;
  recorded: { outcome: string; description: string } | null;
  recordedRepeated: number | null;
  reading: string;
}

export function summarizeAttempts(
  attempts: readonly Attempt[],
  recorded: Attempt | null,
  target: { sameModel: boolean; model: string },
): ResendSummary {
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(outcomeKey(a), (counts.get(outcomeKey(a)) ?? 0) + 1);
  const distinct = [...counts].map(([outcome, count]) => ({
    outcome,
    description: describeOutcome(outcome),
    count,
  }));
  const argsByOutcome = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (!a.ok) continue;
    const set = argsByOutcome.get(outcomeKey(a)) ?? new Set<string>();
    set.add(canonical(a.toolCalls.map((c) => c.args)));
    argsByOutcome.set(outcomeKey(a), set);
  }
  const sameArguments = [...argsByOutcome.values()].every((s) => s.size === 1);
  const recordedKey = recorded === null ? null : outcomeKey(recorded);
  const recordedRepeated = recordedKey === null ? null : (counts.get(recordedKey) ?? 0);
  const n = attempts.length;

  let reading: string;
  if (recordedKey === null || recordedRepeated === null) {
    reading =
      distinct.length === 1
        ? `Todas as ${n} tentativas deram o mesmo desfecho: com este pedido o modelo faz sempre a mesma coisa.`
        : `As ${n} tentativas deram ${distinct.length} desfechos diferentes: o modelo varia com este pedido.`;
  } else if (target.sameModel) {
    if (recordedRepeated === n) {
      reading = `O desfecho gravado se repetiu em ${n} de ${n} tentativas: com este pedido o modelo faz sempre a mesma coisa. Se esse desfecho está errado, o problema está no que foi enviado (instruções ou contexto), não em variação do modelo: ele errou sempre.`;
    } else if (recordedRepeated === 0) {
      reading = `Nenhuma das ${n} tentativas repetiu o desfecho gravado: o modelo normalmente faz outra coisa com este pedido, e o que foi gravado foi exceção.`;
    } else {
      reading = `O desfecho gravado se repetiu em ${recordedRepeated} de ${n} tentativas: o modelo varia com este pedido. Se esse desfecho está errado, ele errou às vezes: é variação do modelo (ainda assim, instruções mais claras podem reduzi-la).`;
    }
  } else {
    reading = `Com ${target.model}, o desfecho gravado (do modelo original) se repetiu em ${recordedRepeated} de ${n} tentativas. Se ${target.model} acerta onde o original errou, só o modelo original erra; se erra igual, o problema está no que foi enviado.`;
  }
  return {
    attempts: n,
    distinct,
    sameArguments,
    recorded:
      recordedKey === null
        ? null
        : { outcome: recordedKey, description: describeOutcome(recordedKey) },
    recordedRepeated,
    reading,
  };
}

async function attemptOnce(
  provider: Provider,
  request: GenerateRequest,
  attempt: number,
): Promise<Attempt> {
  const startedAt = Date.now();
  try {
    const result = await generateAndCollect(provider, request);
    return {
      attempt,
      ok: true,
      latencyMs: Date.now() - startedAt,
      stopReason: result.stopReason,
      toolCalls: result.blocks.flatMap((b) =>
        b.type === "tool_call" ? [{ name: b.name, args: b.args }] : [],
      ),
      text: result.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
      usage: result.usage,
      modelVersion: result.modelVersion,
    };
  } catch (error) {
    const known = error instanceof ProviderError;
    return {
      attempt,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: {
        kind: known ? error.kind : "other",
        message: error instanceof Error ? error.message : String(error),
        retryable: known ? error.retryable : false,
      },
    };
  }
}

function describeAttempt(a: Attempt, total: number): string[] {
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
      help: `Quantas vezes reenviar (padrão 1, máximo ${MAX_TIMES})`,
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
    if (times > MAX_TIMES) throw new UsageError(`--times aceita no máximo ${MAX_TIMES}.`, NAME);
    const otherModel = str(ctx.args, "model");

    const runtime = ctx.runtime();
    const run = await findRun(runtime.db, ctx.args.positionals[0] as string);
    const events = await readEvents(runtime.db, run.id);
    const event = events.find((e) => e.seq === seq);
    if (event === undefined) throw new CommandError(`A execução não tem o evento seq ${seq}.`);
    const typed = typedEvent(event);
    if (typed?.type !== "model_request") {
      const near = events
        .filter((e) => e.type === "model_request")
        .map((e) => e.seq)
        .join(", ");
      throw new CommandError(
        `O evento ${seq} é "${event.type}", não um model_request. Pedidos ao modelo: seq ${near === "" ? "(nenhum)" : near}.`,
      );
    }
    const recordedReq = typed.payload;
    const purpose = recordedReq.purpose ?? "agent";

    // Where to send it: the recorded model, or the one asked for.
    let provider: Provider;
    let model: string;
    let maxOutputTokens = recordedReq.maxOutputTokens;
    if (otherModel !== undefined) {
      const resolved = runtime.resolveModel(otherModel);
      provider = runtime.getProvider(resolved.provider.id);
      model = resolved.model.id;
      maxOutputTokens = Math.min(maxOutputTokens, resolved.model.maxOutputTokens);
    } else {
      model = recordedReq.model;
      try {
        provider = runtime.getProvider(runtime.resolveModel(model).provider.id);
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.code !== "unknown_model") throw error;
        provider = runtime.getProvider(recordedReq.provider); // the model left the catalog; its provider may still be there
      }
    }
    const sameModel = model === recordedReq.model;

    // What the recorded request got back, to compare with.
    const answerEvent = events.find((e) => {
      if (e.seq <= seq) return false;
      const t = typedEvent(e);
      return t?.type === "model_response" && (t.payload.purpose ?? "agent") === purpose;
    });
    const answer = answerEvent === undefined ? undefined : typedEvent(answerEvent);
    const recorded: Attempt | null =
      answer?.type === "model_response"
        ? {
            attempt: 0,
            ok: true,
            latencyMs: answer.payload.durationMs,
            stopReason: answer.payload.stopReason,
            toolCalls: answer.payload.blocks.flatMap((b) =>
              b.type === "tool_call" ? [{ name: b.name, args: b.args }] : [],
            ),
            text: answer.payload.blocks
              .flatMap((b) => (b.type === "text" ? [b.text] : []))
              .join("\n"),
            usage: answer.payload.usage,
            modelVersion: answer.payload.modelVersion,
          }
        : null;

    const abort = new AbortController();
    const unsubscribe = ctx.io.onInterrupt(() => {
      if (!abort.signal.aborted) {
        ctx.out.err("Interrompendo: as tentativas restantes não serão feitas.");
        abort.abort();
      }
    });
    const attempts: Attempt[] = [];
    try {
      ctx.out.line(
        `Reenviando o pedido do evento ${seq} (${purpose === "agent" ? "agente" : purpose === "review" ? "revisor" : "compactação"}) da execução ${run.id.slice(0, 8)}: ${times} vez${times === 1 ? "" : "es"} para ${model}${sameModel ? "" : ` (o original usou ${recordedReq.model})`}`,
      );
      for (let i = 1; i <= times && !abort.signal.aborted; i++) {
        const request: GenerateRequest = {
          model,
          system: recordedReq.system,
          messages: recordedReq.messages,
          tools: recordedReq.tools,
          ...(recordedReq.toolChoice === undefined ? {} : { toolChoice: recordedReq.toolChoice }),
          maxOutputTokens,
          ...(recordedReq.temperature === undefined
            ? {}
            : { temperature: recordedReq.temperature }),
          signal: abort.signal,
        };
        const result = await attemptOnce(provider, request, i);
        attempts.push(result);
        if (ctx.json) ctx.out.ndjson({ type: "attempt", ...result });
        else ctx.out.lines(describeAttempt(result, times));
      }
    } finally {
      unsubscribe();
    }

    const summary = summarizeAttempts(attempts, recorded, { sameModel, model });
    const dir = join(ctx.io.cwd, ".suup", "diagnostics");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `resend-${run.id.slice(0, 8)}-seq${seq}-${stamp}.json`);
    const doc = {
      runId: run.id,
      requestSeq: seq,
      purpose,
      recordedModel: recordedReq.model,
      sentTo: { provider: provider.id, model },
      times,
      attempts,
      recorded,
      summary,
      savedAt: new Date().toISOString(),
    };
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
