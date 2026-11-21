// The diagnostics of section 4.13 of the plan, shared by the CLI (`suup inspect`, `replay`,
// `resend`, `doctor`) and the server (the "Inspetor" screen): one implementation, two front ends.
// Everything here reads the database and the configuration; nothing runs a loop or a tool.

import { resolve } from "node:path";
import {
  type GenerateRequest,
  type GenerateResult,
  generateAndCollect,
  type ModelCallPurpose,
  type Provider,
  ProviderError,
  type ProviderErrorKind,
  parseRunEvent,
  type ReplayReport,
  type RunEventData,
  type RunEventPayload,
  replayRun,
  runEventSchema,
  type StopReason,
} from "@suup/core";
import { type Db, getBot, getRun, listRunEvents, migrationStatus } from "@suup/db";
import { checkConnectors } from "./connectors/doctor.js";
import { RuntimeError } from "./errors.js";
import { checkMemory } from "./memory-doctor.js";
import { checkNetwork } from "./network/doctor.js";
import type { Runtime } from "./runtime.js";
import { loadScript } from "./scripted-provider.js";
import { checkVaultAndApprovals } from "./vault/doctor.js";
import { checkWeb } from "./web/doctor.js";

// ---------------------------------------------------------------------------------------------
// Reading a run's events

/** An event as it comes out of the database, before any interpretation. */
export interface RawRunEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Every event of a run after `afterSeq`, raw (not validated against the schema). */
export async function readRunEvents(db: Db, runId: string, afterSeq = 0): Promise<RawRunEvent[]> {
  const out: RawRunEvent[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await listRunEvents(db, runId, { afterSeq: cursor, limit: 500 });
    for (const row of page) {
      out.push({ seq: row.seq, type: row.type, payload: row.payload, createdAt: row.createdAt });
    }
    const last = page[page.length - 1];
    if (page.length < 500 || last === undefined) return out;
    cursor = last.seq;
  }
}

/** The typed form of an event, or `undefined` when it does not match the current schema. */
export function typedRunEvent(event: RawRunEvent): RunEventData | undefined {
  const parsed = runEventSchema.safeParse({ type: event.type, payload: event.payload });
  return parsed.success ? parsed.data : undefined;
}

async function requireRun(db: Db, runId: string): Promise<void> {
  if ((await getRun(db, runId)) === null) {
    throw new RuntimeError("run_not_found", `Execução não encontrada: ${runId}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Inspect: what the model saw

export type ModelRequestPayload = RunEventPayload<"model_request">;
export type ModelResponsePayload = RunEventPayload<"model_response">;

/** `suup inspect --request <seq>`: the exact request of one model call and what came back. */
export interface ModelRequestView {
  runId: string;
  /** The `seq` of the `model_request` event. */
  seq: number;
  purpose: ModelCallPurpose;
  /** For the agent's own calls: which turn this is (1, 2, ...). `null` for review and compaction. */
  turn: number | null;
  request: ModelRequestPayload;
  /** The recorded answer (the next `model_response` of the same purpose), or `null` when there is none. */
  response: ({ seq: number } & ModelResponsePayload) | null;
}

/** Why the event the caller named is not a model request: says which ones the run has. */
export function describeNotARequest(
  events: readonly RawRunEvent[],
  seq: number,
  type: string,
): RuntimeError {
  const near = events
    .filter((e) => e.type === "model_request")
    .map((e) => e.seq)
    .join(", ");
  return new RuntimeError(
    "not_a_model_request",
    `O evento ${seq} é "${type}", não um model_request. Pedidos ao modelo desta execução: seq ${near === "" ? "(nenhum)" : near}.`,
  );
}

/**
 * The model request recorded at `seq`, whole. Throws `RuntimeError` (`run_not_found`,
 * `event_not_found`, `not_a_model_request`).
 */
export async function inspectModelRequest(
  db: Db,
  runId: string,
  seq: number,
): Promise<ModelRequestView> {
  await requireRun(db, runId);
  const events = await readRunEvents(db, runId);
  const event = events.find((e) => e.seq === seq);
  if (event === undefined) {
    throw new RuntimeError("event_not_found", `A execução não tem o evento seq ${seq}.`);
  }
  const typed = typedRunEvent(event);
  if (event.type !== "model_request" || typed?.type !== "model_request") {
    throw describeNotARequest(events, seq, event.type);
  }
  const request = typed.payload;
  const purpose = request.purpose ?? "agent";
  const turn =
    purpose === "agent"
      ? events.filter((e) => {
          if (e.seq > seq || e.type !== "model_request") return false;
          const t = typedRunEvent(e);
          return t?.type === "model_request" && (t.payload.purpose ?? "agent") === "agent";
        }).length
      : null;
  const responseEvent = events.find((e) => {
    if (e.seq <= seq || e.type !== "model_response") return false;
    const t = typedRunEvent(e);
    return t?.type === "model_response" && (t.payload.purpose ?? "agent") === purpose;
  });
  const answer = responseEvent === undefined ? undefined : typedRunEvent(responseEvent);
  return {
    runId,
    seq,
    purpose,
    turn,
    request,
    response:
      responseEvent !== undefined && answer?.type === "model_response"
        ? { seq: responseEvent.seq, ...answer.payload }
        : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Replay

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

/** The replay report in the shape both the CLI (`--json`) and the API print. */
export interface ReplayView {
  runId: string;
  /** The current loop reproduced the recorded decisions. */
  identical: boolean;
  finalStatus: ReplayReport["finalStatus"];
  firstDivergence: (NonNullable<ReplayReport["firstDivergence"]> & { seq: number | null }) | null;
  requestDiffs: (ReplayReport["requestDiffs"][number] & { seq: number | null })[];
  stoppedBecause: string | null;
  /** The reading of the report, in plain Portuguese. */
  reading: string;
}

export interface ReplayOutcome {
  view: ReplayView;
  report: ReplayReport;
  eventCount: number;
  /** The `seq` of the event at a position of the replay. */
  seqOf(index: number): number | undefined;
}

/**
 * Replays the run with the current loop and the recorded answers (nothing is called for real).
 * Throws `RuntimeError`: `run_not_found`, `bot_not_found`, `no_events`, `replay_failed`.
 */
export async function replayRecordedRun(runtime: Runtime, runId: string): Promise<ReplayOutcome> {
  const db = runtime.db;
  const run = await getRun(db, runId);
  if (run === null) throw new RuntimeError("run_not_found", `Execução não encontrada: ${runId}.`);
  const bot = await getBot(db, run.botId);
  if (bot === null) {
    throw new RuntimeError("bot_not_found", `O bot ${run.botId} desta execução não existe mais.`);
  }
  const raw = await readRunEvents(db, run.id);
  const events = raw.map((e) => ({
    ...parseRunEvent(e.type, e.payload),
    seq: e.seq,
    createdAt: e.createdAt,
  }));
  if (events.length === 0) {
    throw new RuntimeError("no_events", "Esta execução não tem eventos gravados.");
  }
  let report: ReplayReport;
  try {
    report = await replayRun(events, { bot: runtime.botConfig(bot), tools: runtime.tools });
  } catch (error) {
    throw new RuntimeError(
      "replay_failed",
      `Não foi possível reexecutar: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const seqOf = (index: number) => events[index]?.seq;
  const divergence = report.firstDivergence;
  return {
    report,
    eventCount: events.length,
    seqOf,
    view: {
      runId: run.id,
      identical: report.identical,
      finalStatus: report.finalStatus,
      firstDivergence:
        divergence === undefined ? null : { ...divergence, seq: seqOf(divergence.index) ?? null },
      requestDiffs: report.requestDiffs.map((d) => ({ ...d, seq: seqOf(d.index) ?? null })),
      stoppedBecause: report.stoppedBecause ?? null,
      reading: explainReplay(report, seqOf),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Resend

export const MAX_RESEND_TIMES = 100;

export type ResendAttempt =
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
export function outcomeKey(a: ResendAttempt): string {
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
  attempts: readonly ResendAttempt[],
  recorded: ResendAttempt | null,
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
): Promise<ResendAttempt> {
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

export interface ResendOptions {
  runId: string;
  /** The `seq` of the `model_request` event to send again. */
  seq: number;
  /** How many times (1 to `MAX_RESEND_TIMES`). Default 1. */
  times?: number;
  /** Another model of the configuration, instead of the recorded one. */
  model?: string;
  /** Stops the attempts not made yet. */
  signal?: AbortSignal;
  /** Called after every attempt (the CLI prints it as it goes). */
  onAttempt?(attempt: ResendAttempt, total: number): void;
}

export interface ResendResult {
  runId: string;
  requestSeq: number;
  purpose: ModelCallPurpose;
  recordedModel: string;
  sentTo: { provider: string; model: string };
  times: number;
  attempts: ResendAttempt[];
  /** What the recorded request got back the first time, to compare with. */
  recorded: ResendAttempt | null;
  summary: ResendSummary;
  savedAt: string;
}

/**
 * Sends a recorded model request again, exactly as recorded, N times or to another model, and says
 * whether the model varies, errs always, or only the original model errs. The run is not touched
 * and the cost is not added to it. Throws `RuntimeError`: `run_not_found`, `event_not_found`,
 * `not_a_model_request`, `invalid_input`, `unknown_model`.
 */
export async function resendRecordedRequest(
  runtime: Runtime,
  options: ResendOptions,
): Promise<ResendResult> {
  const times = options.times ?? 1;
  if (!Number.isInteger(times) || times < 1 || times > MAX_RESEND_TIMES) {
    throw new RuntimeError(
      "invalid_input",
      `O número de tentativas precisa ser um inteiro de 1 a ${MAX_RESEND_TIMES}.`,
    );
  }
  const view = await inspectModelRequest(runtime.db, options.runId, options.seq);
  const recordedReq = view.request;
  const purpose = view.purpose;

  let provider: Provider;
  let model: string;
  let maxOutputTokens = recordedReq.maxOutputTokens;
  if (options.model !== undefined) {
    const resolved = runtime.resolveModel(options.model);
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

  const answer = view.response;
  const recorded: ResendAttempt | null =
    answer === null
      ? null
      : {
          attempt: 0,
          ok: true,
          latencyMs: answer.durationMs,
          stopReason: answer.stopReason,
          toolCalls: answer.blocks.flatMap((b) =>
            b.type === "tool_call" ? [{ name: b.name, args: b.args }] : [],
          ),
          text: answer.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
          usage: answer.usage,
          modelVersion: answer.modelVersion,
        };

  const attempts: ResendAttempt[] = [];
  for (let i = 1; i <= times && options.signal?.aborted !== true; i++) {
    const request: GenerateRequest = {
      model,
      system: recordedReq.system,
      messages: recordedReq.messages,
      tools: recordedReq.tools,
      ...(recordedReq.toolChoice === undefined ? {} : { toolChoice: recordedReq.toolChoice }),
      maxOutputTokens,
      ...(recordedReq.temperature === undefined ? {} : { temperature: recordedReq.temperature }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const result = await attemptOnce(provider, request, i);
    attempts.push(result);
    options.onAttempt?.(result, times);
  }
  return {
    runId: options.runId,
    requestSeq: options.seq,
    purpose,
    recordedModel: recordedReq.model,
    sentTo: { provider: provider.id, model },
    times,
    attempts,
    recorded,
    summary: summarizeAttempts(attempts, recorded, { sameModel, model }),
    savedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Doctor

/** One line of `suup doctor`: a component, whether it is fine, and why. */
export interface DoctorCheck {
  component: string;
  ok: boolean;
  detail: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function guarded(
  component: string,
  fn: () => Promise<DoctorCheck[] | DoctorCheck>,
): Promise<DoctorCheck[]> {
  try {
    const result = await fn();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [{ component, ok: false, detail: message(error).split("\n")[0] ?? "erro" }];
  }
}

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

async function checkDatabase(runtime: Runtime): Promise<DoctorCheck> {
  const db = runtime.db;
  await db.sql`select 1`;
  const status = await migrationStatus(db);
  if (status.pending.length > 0) {
    return {
      component: "Banco de dados",
      ok: false,
      detail: `acessível, mas com ${status.pending.length} migraç${status.pending.length === 1 ? "ão pendente" : "ões pendentes"} (${status.pending.join(", ")}); rode: suup db migrate`,
    };
  }
  return {
    component: "Banco de dados",
    ok: true,
    detail: `acessível, ${status.applied.length} migraç${status.applied.length === 1 ? "ão aplicada" : "ões aplicadas"}${status.unknown.length > 0 ? ` (atenção: o banco tem migrações que este código não conhece: ${status.unknown.join(", ")})` : ""}`,
  };
}

/** Whether the search folds accents (migration 0007) and how long the queue has been waiting. */
async function checkSearchAndQueue(runtime: Runtime): Promise<DoctorCheck[]> {
  const db = runtime.db;
  const [folded] = await db.sql<{ folds: boolean }[]>`
    select suup_unaccent('avaliação') = 'avaliacao' as folds`;
  const [queue] = await db.sql<{ n: string; oldest: number | null }[]>`
    select count(*) as n, extract(epoch from now() - min(created_at)) as oldest
    from runs where status = 'queued' and paused_at is null`;
  const waiting = Number(queue?.n ?? 0);
  const oldest = queue?.oldest === null || queue?.oldest === undefined ? 0 : Number(queue.oldest);
  const stuck = waiting > 0 && oldest > 120;
  return [
    {
      component: "Busca",
      ok: true,
      detail:
        folded?.folds === true
          ? "ignora acentos (extensão unaccent do PostgreSQL ativa)"
          : 'NÃO ignora acentos: o PostgreSQL deste banco não tem a extensão unaccent (pacote contrib); a busca por palavras funciona, mas "avaliacao" não acha "avaliação". Veja docs/IMPLANTACAO.md',
    },
    {
      component: "Fila de execuções",
      ok: !stuck,
      detail:
        waiting === 0
          ? "vazia"
          : stuck
            ? `${waiting} na fila, a mais antiga há ${Math.round(oldest)} s: parece que nenhum worker está pegando execuções (suba um: suup worker)`
            : `${waiting} na fila, a mais antiga há ${Math.round(oldest)} s`,
    },
  ];
}

async function checkSandbox(runtime: Runtime): Promise<DoctorCheck> {
  const { config, baseDir } = runtime;
  const root = await runtime.sandboxRoot();
  const result = await root.exec("true", { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    return {
      component: "Sandbox",
      ok: false,
      detail: `o comando \`true\` terminou com código ${result.exitCode ?? "nenhum"}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}`,
    };
  }
  const sb = config.sandbox;
  return {
    component: "Sandbox",
    ok: true,
    detail:
      sb.kind === "local"
        ? `LOCAL em ${resolve(baseDir, sb.root)} — SEM isolamento (só para desenvolvimento e testes); \`true\` rodou`
        : `docker, contêiner "${sb.name}" respondeu (\`true\` rodou)`,
  };
}

async function checkProviders(runtime: Runtime, live: boolean): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const entry of runtime.config.providers) {
    const status = runtime.keyStatus(entry.id);
    checks.push({
      component: `Provedor ${entry.id}`,
      ok: status.ok,
      detail: `${entry.kind}: ${status.reason}`,
    });
    if (entry.kind === "scripted" && status.ok) {
      try {
        const script = loadScript(resolve(runtime.baseDir, entry.scriptPath));
        checks[checks.length - 1] = {
          component: `Provedor ${entry.id}`,
          ok: true,
          detail: `scripted (NÃO é um modelo de verdade): roteiro ${entry.scriptPath} lido, ${script.cases === undefined ? `${script.agent.length} passos do agente` : `${script.cases.length} casos (um roteiro por tarefa)`}`,
        };
      } catch (error) {
        checks[checks.length - 1] = {
          component: `Provedor ${entry.id}`,
          ok: false,
          detail: message(error),
        };
      }
    }
  }
  if (!live) return checks;
  for (const model of runtime.config.models) {
    const component = `Modelo ${model.id}`;
    const entry = runtime.config.providers.find((p) => p.id === model.provider);
    if (entry?.kind === "scripted") {
      checks.push({ component, ok: true, detail: "provedor scripted: sem chamada real" });
      continue;
    }
    if (!runtime.keyStatus(model.provider).ok) {
      checks.push({
        component,
        ok: false,
        detail: `sem chamada real: ${runtime.keyStatus(model.provider).reason}`,
      });
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await generateAndCollect(runtime.getProvider(model.provider), {
        model: model.id,
        system: "Responda com uma única palavra.",
        messages: [{ role: "user", blocks: [{ type: "text", text: "Diga: ok" }] }],
        tools: [],
        maxOutputTokens: Math.min(32, model.maxOutputTokens),
      });
      checks.push({
        component,
        ok: true,
        detail: `respondeu em ${formatDuration(Date.now() - startedAt)}; versão devolvida pelo provedor: ${result.modelVersion}`,
      });
    } catch (error) {
      checks.push({ component, ok: false, detail: `a chamada real falhou: ${message(error)}` });
    }
  }
  return checks;
}

/**
 * The health of each component the runtime sits on: database (and its migrations), search, queue,
 * sandbox, providers (and, with `live`, a tiny real call to each model) and tools. Never throws:
 * a component that cannot even be checked is a failed line. The configuration itself is checked by
 * whoever loaded it.
 */
export async function runDoctorChecks(
  runtime: Runtime,
  options: {
    live?: boolean;
    /**
     * Whether to check the bot machine (default `true`). A process that never runs the bots (an
     * API-only server, which must not hold the Docker socket) says so instead of failing.
     */
    sandbox?: boolean;
    /**
     * Whether to start the connectors (default `true`). A stdio connector is a program on the host
     * that runs the bots (the worker), not necessarily on an API-only server, so that process says
     * so instead of reporting a failure that is not real.
     */
    connectors?: boolean;
  } = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(...(await guarded("Banco de dados", () => checkDatabase(runtime))));
  checks.push(...(await guarded("Busca", () => checkSearchAndQueue(runtime))));
  checks.push(
    ...(options.sandbox === false
      ? [
          {
            component: "Sandbox",
            ok: true,
            detail:
              "não verificado neste processo: ele não roda os bots, só o worker usa a máquina deles (veja o log do worker, ou rode `suup doctor` onde o worker roda)",
          },
        ]
      : await guarded("Sandbox", () => checkSandbox(runtime))),
  );
  if (options.sandbox !== false) {
    checks.push(...(await guarded("Rede dos bots", () => checkNetwork(runtime))));
  }
  checks.push(
    ...(await guarded("Provedores", () => checkProviders(runtime, options.live === true))),
  );
  checks.push(...(await guarded("Cofre", () => checkVaultAndApprovals(runtime))));
  checks.push(...(await guarded("Memória", () => checkMemory(runtime))));
  if (options.sandbox !== false) {
    checks.push(...(await guarded("Web", () => checkWeb(runtime))));
  }
  checks.push(
    ...(options.connectors === false
      ? [
          {
            component: "Conectores",
            ok: true,
            detail:
              "não verificados neste processo: um conector de processo local roda onde o worker roda; rode `suup doctor` (ou `suup connectors test`) lá",
          },
        ]
      : await guarded("Conectores", () => checkConnectors(runtime))),
  );
  checks.push(
    ...(await guarded("Ferramentas", async () => {
      const names = runtime.tools.list().map((t) => t.name);
      return {
        component: "Ferramentas",
        ok: names.length > 0,
        detail: `${names.length} registradas: ${names.join(", ")}`,
      };
    })),
  );
  return checks;
}
