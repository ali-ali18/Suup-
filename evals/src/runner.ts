import { randomBytes } from "node:crypto";
import {
  type InboxItem,
  type InboxItemInput,
  type LoopDeps,
  type PlanStep,
  type RunRecord,
  type RunStore,
  type StatusChange,
  type StoredEvent,
  Worker,
} from "@suup/core";
import {
  archiveBot,
  createBot,
  getRun,
  hasPendingInbox,
  PgRunQueue,
  PgRunStore,
  postInbox,
  setRunStatus,
} from "@suup/db";
import {
  createRuntime,
  DEFAULT_WORKER,
  MEMORY_TOOL_NAMES,
  type Runtime,
  type RuntimeConfig,
  type RuntimeOptions,
} from "@suup/runtime";
import { usd } from "./fmt.js";
import { describeFailures } from "./kit.js";
import { eventMetrics, lastAgentRequestSeq } from "./metrics.js";
import { qualificationTasks } from "./qualify/index.js";
import {
  type CellOrigin,
  type CellResult,
  type EvalReport,
  evalReportSchema,
  summarizeModel,
} from "./report.js";
import type { EvalCheck, EvalTask, VerifyResult } from "./types.js";

/** Something wrong with how the evaluation was asked for, or with the machine it runs on. */
export class EvalSetupError extends Error {
  override readonly name = "EvalSetupError";
  constructor(
    readonly code: "bad_options" | "unpriced" | "no_budget" | "missing_key" | "no_python",
    message: string,
  ) {
    super(message);
  }
}

/** Evaluation-only tools are named with this prefix; the bots of other tasks never see them. */
const EVAL_TOOL_PREFIX = "eval_";
/** Wall-clock margin over a task's `maxDurationMs` before the runner gives up on a run. */
const DEADLINE_GRACE_MS = 60_000;
const POLL_MS = 40;

export interface RunEvalOptions {
  /** A runtime built by the caller (the CLI), or `config` to have one made and closed here. */
  runtime?: Runtime;
  config?: RuntimeConfig;
  runtimeOptions?: RuntimeOptions;
  /** Model ids of the configuration. */
  models: readonly string[];
  tasks: readonly EvalTask[];
  /** Repetitions of every (task, model). Default 1. */
  repeat?: number;
  /**
   * The most the whole evaluation may spend. Required unless every model is the scripted
   * provider, which costs nothing.
   */
  budgetUsd?: number | null;
  /** No single run may be allowed more than this, whatever the task's own limit says. */
  maxCostPerRunUsd?: number;
  /** Runs at the same time. Default 1. */
  concurrency?: number;
  /** Models without pricing in the configuration cannot be budgeted; this lets them run anyway. */
  allowUnpriced?: boolean;
  onProgress?: (event: EvalProgress) => void;
  /**
   * Aborting stops new runs from starting: the ones in flight finish (each is bounded by its
   * limits) and the rest are reported as `skipped_interrupted`.
   */
  signal?: AbortSignal;
  /**
   * How long past a task's `maxDurationMs` the runner waits for a run before giving up on it
   * (a model call stuck in the network, say). Default 60 s.
   */
  deadlineGraceMs?: number;
}

export interface PlannedCell {
  index: number;
  taskId: string;
  model: string;
  repetition: number;
  /** The most this run may cost: the task's limit, capped by `maxCostPerRunUsd`. */
  maxCostUsd: number;
}

export interface EvalPlan {
  models: { id: string; provider: string; scripted: boolean; priced: boolean }[];
  tasks: EvalTask[];
  repeat: number;
  cells: PlannedCell[];
  budgetUsd: number | null;
  maxCostPerRunUsd: number | null;
  /** The sum of every cell's `maxCostUsd`: what the evaluation costs if every run hits its cap. */
  worstCaseUsd: number;
  /** The largest cap of a single run. */
  largestRunCapUsd: number;
  /** Cells that fit in the budget, counting every one at its cap, in run order. */
  cellsThatFit: number;
  /** Some model is a real one: running costs money. */
  costsMoney: boolean;
  unpricedModels: string[];
}

export type EvalProgress =
  | { type: "start"; plan: EvalPlan }
  | { type: "cell_start"; cell: PlannedCell; total: number }
  | { type: "cell_end"; cell: PlannedCell; total: number; result: CellResult; spentUsd: number }
  | { type: "cell_skipped"; cell: PlannedCell; total: number; spentUsd: number }
  | { type: "warning"; message: string };

const isEvalTool = (name: string) => name.startsWith(EVAL_TOOL_PREFIX);
/** Memory tools are not part of what an evaluation measures (see `isolated` in `buildDeps`). */
const isMemoryTool = (name: string) => (MEMORY_TOOL_NAMES as readonly string[]).includes(name);

/** Validates the request and works out what it would cost. Throws `EvalSetupError`. */
export function planEval(options: RunEvalOptions & { runtime: Runtime }): EvalPlan {
  const { runtime } = options;
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new EvalSetupError(
      "bad_options",
      "O número de repetições precisa ser um inteiro positivo.",
    );
  }
  if (options.models.length === 0) {
    throw new EvalSetupError("bad_options", "Nenhum modelo foi indicado para a avaliação.");
  }
  if (options.tasks.length === 0) {
    throw new EvalSetupError("bad_options", "Nenhuma tarefa foi selecionada para a avaliação.");
  }
  const cap = options.maxCostPerRunUsd;
  if (cap !== undefined && !(cap > 0)) {
    throw new EvalSetupError(
      "bad_options",
      "O teto de custo por execução precisa ser maior que zero.",
    );
  }
  const budget = options.budgetUsd ?? null;
  if (budget !== null && !(budget > 0)) {
    throw new EvalSetupError("bad_options", "O orçamento precisa ser maior que zero.");
  }
  if (new Set(options.models).size !== options.models.length) {
    throw new EvalSetupError("bad_options", "Há modelos repetidos na lista.");
  }

  const models = options.models.map((id) => {
    const { model, provider } = runtime.resolveModel(id); // throws RuntimeError for an unknown one
    return {
      id,
      provider: provider.id,
      scripted: provider.kind === "scripted",
      priced: model.pricing !== undefined,
    };
  });

  const missingKeys = models
    .filter((m) => !m.scripted)
    .map((m) => runtime.keyStatus(m.provider))
    .filter((s) => !s.ok);
  if (missingKeys.length > 0) {
    throw new EvalSetupError(
      "missing_key",
      `Falta a chave de API de ${missingKeys.map((s) => `${s.providerId} (${s.reason})`).join("; ")}. Defina a variável antes de rodar; sem ela, todas as execuções falhariam no provedor.`,
    );
  }
  const unpriced = models.filter((m) => !m.scripted && !m.priced).map((m) => m.id);
  if (unpriced.length > 0 && options.allowUnpriced !== true) {
    throw new EvalSetupError(
      "unpriced",
      `${unpriced.length === 1 ? "O modelo" : "Os modelos"} ${unpriced.join(", ")} não ${unpriced.length === 1 ? "tem" : "têm"} "pricing" na configuração: sem preço não há como medir nem limitar o custo. Configure o preço (inputPerMTok e outputPerMTok) ou, por sua conta e risco, passe --allow-unpriced.`,
    );
  }
  const costsMoney = models.some((m) => !m.scripted);
  if (costsMoney && budget === null) {
    throw new EvalSetupError(
      "no_budget",
      "Informe o orçamento máximo da avaliação (--budget-usd): ele é obrigatório quando algum modelo não é o provedor de roteiro.",
    );
  }

  const cells: PlannedCell[] = [];
  for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const task of options.tasks) {
      for (const model of models) {
        cells.push({
          index: cells.length + 1,
          taskId: task.id,
          model: model.id,
          repetition,
          maxCostUsd: Math.min(task.limits.maxCostUsd, cap ?? Number.POSITIVE_INFINITY),
        });
      }
    }
  }
  const worstCaseUsd = cells.reduce((total, c) => total + c.maxCostUsd, 0);
  let fit = 0;
  let running = 0;
  for (const cell of cells) {
    if (budget !== null && running + cell.maxCostUsd > budget) break;
    running += cell.maxCostUsd;
    fit += 1;
  }
  return {
    models,
    tasks: [...options.tasks],
    repeat,
    cells,
    budgetUsd: budget,
    maxCostPerRunUsd: cap ?? null,
    worstCaseUsd,
    largestRunCapUsd: Math.max(...cells.map((c) => c.maxCostUsd)),
    cellsThatFit: fit,
    costsMoney,
    unpricedModels: unpriced,
  };
}

// --- one run, driven by an embedded worker ---------------------------------------------------

/** Delegates to the real store and posts the task's scripted messages as events are recorded. */
class ScriptedInboxStore implements RunStore {
  #log: StoredEvent[] | undefined;
  readonly #fired = new Set<number>();

  constructor(
    private readonly inner: RunStore,
    private readonly task: EvalTask,
    private readonly post: (runId: string, item: InboxItemInput) => Promise<void>,
    private readonly onProblem: (message: string) => void,
  ) {}

  getRun(runId: string): Promise<RunRecord> {
    return this.inner.getRun(runId);
  }

  async appendEvent(runId: string, event: Parameters<RunStore["appendEvent"]>[1]) {
    const script = this.task.inboxScript ?? [];
    if (script.length === 0) return this.inner.appendEvent(runId, event);
    this.#log ??= await this.inner.listEvents(runId);
    const { seq } = await this.inner.appendEvent(runId, event);
    const stored = { ...event, seq, createdAt: new Date() } as StoredEvent;
    this.#log.push(stored);
    for (const [i, entry] of script.entries()) {
      if (this.#fired.has(i)) continue;
      try {
        if (!entry.afterEvent(stored, this.#log)) continue;
        this.#fired.add(i);
        await this.post(runId, entry.item);
      } catch (error) {
        this.#fired.add(i);
        this.onProblem(
          `a mensagem ${i + 1} do roteiro de ${this.task.id} não pôde ser enviada: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { seq };
  }

  listEvents(runId: string) {
    return this.inner.listEvents(runId);
  }
  setStatus(runId: string, change: StatusChange) {
    return this.inner.setStatus(runId, change);
  }
  updatePlan(runId: string, plan: PlanStep[]) {
    return this.inner.updatePlan(runId, plan);
  }
  addUsage(runId: string, usage: Parameters<RunStore["addUsage"]>[1]) {
    return this.inner.addUsage(runId, usage);
  }
  peekInbox(runId: string): Promise<InboxItem[]> {
    return this.inner.peekInbox(runId);
  }
  ackInbox(runId: string, ids: readonly string[]) {
    return this.inner.ackInbox(runId, ids);
  }
  heartbeat(runId: string) {
    return this.inner.heartbeat(runId);
  }
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * Drives one run to the end with an embedded worker that only takes that run: until it is
 * terminal, or the loop ended waiting for the user with nothing left to say (the scripted answers
 * are posted when the event they follow is recorded, so by the time a run waits they have already
 * been posted and the run is back in the queue).
 */
async function driveRun(
  runtime: Runtime,
  runId: string,
  task: EvalTask,
  problems: string[],
  graceMs: number,
): Promise<{ timedOut: boolean }> {
  const db = runtime.db;
  const workerId = `eval-${randomBytes(4).toString("hex")}`;
  const settings = { ...DEFAULT_WORKER, ...runtime.config.worker };
  // The worker claims the run once per loop. A run is only "waiting for the user" when the loop of
  // the latest claim ended that way: resuming a run passes through `waiting_user` for a moment
  // (the loop applies the logged status before it reads the answer), and that is not the end.
  let claims = 0;
  let waitingAfterClaim = 0;
  const worker = new Worker({
    workerId,
    queue: new PgRunQueue(db, { onlyRunId: runId }),
    buildDeps: async (id): Promise<LoopDeps> => {
      claims += 1;
      // Isolated: an evaluation never loads memory (rules, profile, history) from the database.
      const deps = await runtime.buildDeps(id, workerId, { isolated: true });
      return {
        ...deps,
        store: new ScriptedInboxStore(
          deps.store,
          task,
          async (rid, item) => {
            await postInbox(db, rid, item);
          },
          (message) => problems.push(message),
        ),
      };
    },
    concurrency: 1,
    leaseRenewMs: settings.leaseRenewMs,
    staleAfterMs: settings.staleAfterMs,
    idleBackoff: { minMs: 20, maxMs: 200 },
    onRunEnd: (end) => {
      if (end.outcome === "settled" && end.status === "waiting_user") waitingAfterClaim = claims;
    },
    onError: (error, context) =>
      problems.push(
        `worker: ${context}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  worker.start();

  const deadline = Date.now() + task.limits.maxDurationMs + graceMs;
  let timedOut = false;
  try {
    for (;;) {
      const run = await getRun(db, runId);
      if (run === null) throw new Error(`a execução ${runId} desapareceu`);
      if (TERMINAL.has(run.status)) break;
      if (
        run.status === "waiting_user" &&
        waitingAfterClaim === claims &&
        claims > 0 &&
        !(await hasPendingInbox(db, runId))
      ) {
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    if (timedOut) await worker.abortNow();
    else await worker.stop({ graceMs: 5_000 });
  }
  if (timedOut) {
    await setRunStatus(db, runId, {
      from: ["queued", "running", "waiting_user", "waiting_approval"],
      to: "failed",
      failure: {
        origin: "limit",
        detail: `o avaliador desistiu da execução depois de ${Math.round((task.limits.maxDurationMs + graceMs) / 1000)} s`,
      },
    });
  }
  return { timedOut };
}

// --- one cell --------------------------------------------------------------------------------

const emptyMetrics = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  durationMs: 0,
  modelVersions: [] as string[],
  nudges: 0,
  finishRejections: { harness: 0, reviewer: 0 },
  reviews: 0,
  reviewerRejects: 0,
  toolCalls: 0,
  toolErrors: 0,
  invalidArgs: 0,
};

function baseCell(task: EvalTask, cell: PlannedCell): CellResult {
  return {
    taskId: task.id,
    category: task.category,
    model: cell.model,
    repetition: cell.repetition,
    outcome: "fail",
    checks: [],
    expectedStatus: task.expect.status,
    finalStatus: null,
    failureOrigin: null,
    failureDetail: null,
    runId: null,
    botId: null,
    lastRequestSeq: null,
    ...emptyMetrics,
  };
}

export function skippedCell(
  task: EvalTask,
  cell: PlannedCell,
  reason: "skipped_budget" | "skipped_interrupted" = "skipped_budget",
): CellResult {
  return { ...baseCell(task, cell), outcome: reason };
}

async function executeCell(
  runtime: Runtime,
  task: EvalTask,
  cell: PlannedCell,
  builtinTools: string[],
  limits: { maxCostUsd: number },
  graceMs: number,
): Promise<CellResult> {
  const result = baseCell(task, cell);
  const problems: string[] = [];
  const { model, provider } = runtime.resolveModel(cell.model);
  let botId: string | undefined;
  try {
    for (const tool of task.tools ?? []) {
      if (runtime.tools.get(tool.name) === undefined) runtime.tools.register(tool);
    }
    const bot = await createBot(runtime.db, {
      name: `eval ${task.id} ${cell.model} #${cell.repetition} ${randomBytes(3).toString("hex")}`,
      description: "Bot criado pela avaliação do harness (suup eval).",
      modelProvider: provider.id,
      modelId: model.id,
      allowedTools: [...builtinTools, ...(task.tools ?? []).map((t) => t.name)],
      limits: {
        maxTurns: task.limits.maxTurns,
        maxCostUsd: limits.maxCostUsd,
        maxDurationMs: task.limits.maxDurationMs,
      },
    });
    botId = bot.id;
    result.botId = bot.id;
    const ws = await runtime.executorFor(bot.id);
    await task.setup(ws);

    const run = await runtime.createRun({
      botId: bot.id,
      objective: task.objective,
      acceptanceCriteria: task.criteria,
    });
    result.runId = run.id;

    const started = Date.now();
    const { timedOut } = await driveRun(runtime, run.id, task, problems, graceMs);
    result.durationMs = Date.now() - started;

    const store = new PgRunStore(runtime.db, { workerId: "eval-reader" });
    const record = await store.getRun(run.id);
    const events = await store.listEvents(run.id);
    const row = await getRun(runtime.db, run.id);

    const metrics = eventMetrics(events);
    Object.assign(result, {
      finalStatus: record.status,
      turns: record.turns,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costUsd: record.costUsd,
      modelVersions: metrics.modelVersions,
      nudges: metrics.nudges,
      finishRejections: metrics.finishRejections,
      reviews: metrics.reviews,
      reviewerRejects: metrics.reviewerRejects,
      toolCalls: metrics.toolCalls,
      toolErrors: metrics.toolErrors,
      invalidArgs: metrics.invalidArgs,
      lastRequestSeq: lastAgentRequestSeq(events),
    });

    let verdict: VerifyResult;
    try {
      verdict = await task.verify({ ws, run: record, events });
    } catch (error) {
      verdict = {
        pass: false,
        checks: [
          {
            name: "o verificador terminou sem erro",
            pass: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      };
      result.failureOrigin = "eval";
    }
    const checks: EvalCheck[] = [...verdict.checks];
    const statusOk = record.status === task.expect.status;
    if (!statusOk && !checks.some((c) => c.name === "estado final")) {
      checks.unshift({
        name: "estado final",
        pass: false,
        detail: `esperado ${task.expect.status}, obtido ${record.status}`,
      });
    }
    result.checks = checks;
    if (verdict.observations !== undefined) result.observations = verdict.observations;
    const pass = statusOk && verdict.pass;
    result.outcome = pass ? "pass" : "fail";

    if (!pass) {
      if (timedOut) {
        result.failureOrigin = "eval";
        result.failureDetail = `tempo limite do avaliador: a execução não terminou (${row?.failureDetail ?? ""})`;
      } else if (record.status === "failed") {
        result.failureOrigin = (row?.failureOrigin ?? "harness") as CellOrigin;
        result.failureDetail = row?.failureDetail ?? "a execução falhou sem detalhe";
      } else if (result.failureOrigin === "eval") {
        result.failureDetail = describeFailures(checks);
      } else {
        result.failureOrigin = "outcome";
        result.failureDetail = describeFailures(checks);
      }
    }
  } catch (error) {
    result.outcome = "fail";
    result.failureOrigin = "eval";
    result.failureDetail = `erro do avaliador: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (botId !== undefined) await archiveBot(runtime.db, botId).catch(() => undefined);
  }
  if (problems.length > 0) {
    result.observations = { ...result.observations, avisosDoAvaliador: problems.join(" | ") };
  }
  return result;
}

// --- the evaluation --------------------------------------------------------------------------

async function checkPython(runtime: Runtime): Promise<void> {
  const root = await runtime.sandboxRoot();
  const probe = await root.exec("python3 --version", { timeoutMs: 30_000 });
  if (probe.exitCode !== 0) {
    throw new EvalSetupError(
      "no_python",
      `python3 não foi encontrado na máquina dos bots (${(probe.stderr || probe.stdout).trim() || `código ${probe.exitCode ?? "nenhum"}`}). As tarefas de código e de arquivos precisam dele; a imagem do sandbox já o inclui.`,
    );
  }
}

/**
 * Runs every (task, model, repetition) in a fresh workspace with a fresh bot, under a budget.
 * Never throws for a failed cell: a cell that went wrong is a result. Throws `EvalSetupError` for a
 * request that cannot be run at all.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  let own: Runtime | undefined;
  let runtime = options.runtime;
  if (runtime === undefined) {
    if (options.config === undefined) {
      throw new EvalSetupError(
        "bad_options",
        "runEval precisa de um runtime ou de uma configuração.",
      );
    }
    runtime = own = createRuntime(options.config, options.runtimeOptions);
  }
  try {
    return await run(runtime, options);
  } finally {
    await own?.close();
  }
}

async function run(runtime: Runtime, options: RunEvalOptions): Promise<EvalReport> {
  const plan = planEval({ ...options, runtime });
  const progress = (event: EvalProgress) => {
    try {
      options.onProgress?.(event);
    } catch {
      // a broken progress printer must not stop the evaluation
    }
  };
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new EvalSetupError("bad_options", "A concorrência precisa ser um inteiro positivo.");
  }
  await checkPython(runtime);

  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    progress({ type: "warning", message });
  };
  if (plan.unpricedModels.length > 0) {
    warn(
      `Sem preço configurado para ${plan.unpricedModels.join(", ")}: o custo aparece como zero e o orçamento não os protege (--allow-unpriced).`,
    );
  }
  if (plan.budgetUsd !== null && plan.cellsThatFit < plan.cells.length) {
    warn(
      `O orçamento (${usd(plan.budgetUsd)}) cobre só ${plan.cellsThatFit} das ${plan.cells.length} células no pior caso (${usd(plan.worstCaseUsd)}); as que não couberem serão puladas.`,
    );
  }
  progress({ type: "start", plan });

  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));
  const builtinTools = runtime.tools
    .list()
    .map((t) => t.name)
    .filter((name) => !isEvalTool(name) && !isMemoryTool(name));
  const startedAt = new Date();
  const results: CellResult[] = [];
  const inflight = new Map<number, { cost: number; done: Promise<void> }>();
  let spent = 0;
  const queue = [...plan.cells];
  const total = plan.cells.length;

  const reserved = () => [...inflight.values()].reduce((sum, r) => sum + r.cost, 0);
  const waitForOne = async () => {
    await Promise.race([...inflight.values()].map((r) => r.done));
  };

  while (queue.length > 0) {
    if (options.signal?.aborted === true) break;
    if (inflight.size >= concurrency) {
      await waitForOne();
      continue;
    }
    const cell = queue[0] as PlannedCell;
    if (plan.budgetUsd !== null && spent + reserved() + cell.maxCostUsd > plan.budgetUsd) {
      if (inflight.size > 0) {
        // The runs in flight may still end under their caps: wait before deciding.
        await waitForOne();
        continue;
      }
      break; // nothing in flight and still no room: the budget is out
    }
    queue.shift();
    const task = taskById.get(cell.taskId) as EvalTask;
    progress({ type: "cell_start", cell, total });
    const done = executeCell(
      runtime,
      task,
      cell,
      builtinTools,
      { maxCostUsd: cell.maxCostUsd },
      options.deadlineGraceMs ?? DEADLINE_GRACE_MS,
    ).then((result) => {
      spent += result.costUsd;
      results.push(result);
      inflight.delete(cell.index);
      progress({ type: "cell_end", cell, total, result, spentUsd: spent });
    });
    inflight.set(cell.index, { cost: cell.maxCostUsd, done });
  }
  await Promise.all([...inflight.values()].map((r) => r.done));

  const interrupted = options.signal?.aborted === true;
  for (const cell of queue) {
    const task = taskById.get(cell.taskId) as EvalTask;
    results.push(skippedCell(task, cell, interrupted ? "skipped_interrupted" : "skipped_budget"));
    progress({ type: "cell_skipped", cell, total, spentUsd: spent });
  }
  if (queue.length > 0) {
    warn(
      interrupted
        ? `Avaliação interrompida: ${queue.length} célula(s) não chegaram a rodar (skipped_interrupted).`
        : `Orçamento esgotado (gasto ${usd(spent)} de ${usd(plan.budgetUsd ?? 0)}): ${queue.length} célula(s) puladas (skipped_budget).`,
    );
  }

  const order = new Map(plan.cells.map((c) => [`${c.taskId}|${c.model}|${c.repetition}`, c.index]));
  results.sort(
    (a, b) =>
      (order.get(`${a.taskId}|${a.model}|${a.repetition}`) ?? 0) -
      (order.get(`${b.taskId}|${b.model}|${b.repetition}`) ?? 0),
  );
  const qualificationIds = qualificationTasks.map((t) => t.id);
  return evalReportSchema.parse({
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    budgetUsd: plan.budgetUsd,
    spentUsd: spent,
    maxCostPerRunUsd: plan.maxCostPerRunUsd,
    repeat: plan.repeat,
    concurrency,
    models: plan.models,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      limits: t.limits,
    })),
    cells: results,
    summary: plan.models.map((m) => summarizeModel(m.id, results, qualificationIds)),
    warnings,
  });
}
