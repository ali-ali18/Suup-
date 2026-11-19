import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  allowAllGate,
  type BotConfig,
  CONTROL_TOOL_NAMES,
  controlToolSpecs,
  createToolGate,
  DEFAULT_TOOL_SEARCH,
  type Executor,
  type LoopDeps,
  type NativeToolSearch,
  type Provider,
  ProviderError,
  planToolSearch,
  type Redactor,
  type ReviewerConfig,
  type RunEnd,
  ToolRegistry,
  type ToolSearchMode,
  type ToolSearchSetup,
  toolDefinitionStats,
  Worker,
} from "@suup/core";
import {
  type Bot,
  createDb,
  createRun as createRunRow,
  type Db,
  getBot,
  getRun,
  PgRunQueue,
  PgRunStore,
  type Run,
  rulesForBot,
} from "@suup/db";
import { createProvider, type ProviderConfig } from "@suup/providers";
import { DockerExecutor, ensureMachine, LocalExecutor } from "@suup/sandbox";
import { registerBuiltinTools } from "@suup/tools";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_WORKER,
  type ModelEntry,
  type ProviderEntry,
  type RuntimeConfig,
  resolveDatabaseUrl,
} from "./config.js";
import {
  type BotConnectorCandidate,
  type ConnectorService,
  createConnectorService,
} from "./connectors/service.js";
import { ConfigError, RuntimeError } from "./errors.js";
import { createMemoryService } from "./memory-service.js";
import { DEFAULT_HISTORY_CHARS, loadRunContext } from "./run-context.js";
import { finishRun } from "./run-end.js";
import { createScriptedProvider } from "./scripted-provider.js";
import { createVault, DEFAULT_VAULT_KEY_ENV, type Vault } from "./vault/service.js";

type Env = Record<string, string | undefined>;

export interface RuntimeOptions {
  /** Environment variables (API keys, `DATABASE_URL`). Default `process.env`. */
  env?: Env;
  /** Relative paths of the configuration (sandbox root, scripts) start here. Default: cwd. */
  baseDir?: string;
  /** Passed to the network providers (tests). */
  fetch?: typeof fetch;
  /** Path of the docker CLI. Default: `SUUP_DOCKER_PATH` from the environment, else `docker`. */
  dockerPath?: string;
}

export interface ResolvedModel {
  model: ModelEntry;
  /** The provider entry the model is configured on. */
  provider: ProviderEntry;
}

/** Whether the API key of a provider is available (without building the provider). */
export interface ProviderKeyStatus {
  providerId: string;
  /** `null` for providers that need no key (scripted, a local compatible server). */
  envName: string | null;
  ok: boolean;
  reason: string;
}

export interface CreateWorkerOptions {
  workerId?: string;
  /** The worker only ever takes this run (used by the CLI to follow one run). */
  onlyRunId?: string;
  concurrency?: number;
  idleBackoff?: { minMs?: number; maxMs?: number; factor?: number };
  onRunEnd?(end: RunEnd): void;
  onError?(error: unknown, context: string): void;
}

export interface BuildDepsOptions {
  /**
   * Runs the loop with no memory at all: no rules, profile or conversation history are loaded
   * (so no `context_loaded` carries anything from the database) and the memory tools have no
   * `MemoryService` behind them. For evaluations, which must measure the harness and the model,
   * never what a real user once told the system. Default: what the run says (`runs.isolated`).
   */
  isolated?: boolean;
}

export interface Runtime {
  readonly config: RuntimeConfig;
  /** Directory relative paths of the configuration start from (sandbox root, scripts). */
  readonly baseDir: string;
  /** The database handle. Created at the first use; throws `ConfigError` without a URL. */
  readonly db: Db;
  readonly tools: ToolRegistry;
  /** The vault: secrets encrypted in the database, with the master key from the environment. */
  readonly vault: Vault;
  /**
   * MCP connectors (plan 4.11): configuration in the database, connections opened lazily by this
   * process and closed by `close()`. Their tools join a run's registry only for the bots granted.
   */
  readonly connectors: ConnectorService;
  /**
   * What one bot's requests carry as tool definitions: its built-in and control tools, its
   * connector tools (granted and approved), how they are offered (loaded, or searched) and the
   * estimated tokens of the definitions per request. Connects to the connectors, like a run does.
   */
  toolReport(botId: string): Promise<BotToolReport>;
  /**
   * `value` with every known secret value scrubbed out (a copy). It reloads the vault's values
   * when they are older than a few seconds, so a secret saved by another process is covered too.
   * A system without a usable vault returns `value` as it is.
   */
  redactJson<T>(value: T): Promise<T>;
  /** The redactor itself (values as of the last reload), for code that cannot wait. */
  readonly redactor: Redactor;
  /** Provider by id. Never throws for a missing API key: see `getProvider`. */
  getProvider(id: string): Provider;
  keyStatus(providerId: string): ProviderKeyStatus;
  resolveModel(modelId: string): ResolvedModel;
  /** The bot's machine: its own subdirectory `bots/<botId>` of the shared machine. */
  executorFor(botId: string): Promise<Executor>;
  /** The shared machine's root, for health checks (docker: the machine is started if needed). */
  sandboxRoot(): Promise<Executor>;
  botConfig(bot: Bot): BotConfig;
  reviewerConfig(): ReviewerConfig | undefined;
  createRun(input: {
    botId: string;
    objective: string;
    acceptanceCriteria?: string[];
    /** An evaluation run: isolated from the user's memory, now and at its end (no journal). */
    isolated?: boolean;
  }): Promise<Run>;
  buildDeps(runId: string, workerId: string, options?: BuildDepsOptions): Promise<LoopDeps>;
  createWorker(options?: CreateWorkerOptions): Worker;
  close(): Promise<void>;
}

/** What `DockerExecutor` needs from a machine, built from the `docker` sandbox settings. */
export function dockerWorkspace(botId: string): string {
  return `/workspace/bots/${botId}`;
}

const SAFE_BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Turns the configuration into a working system: the database, the providers, the tools, the
 * machine of each bot and the pieces the loop and the worker need. The CLI sits on top of it now;
 * the server and the evaluation runner will later.
 *
 * Nothing here reaches the network or Docker at creation: providers, the machine and the
 * database connection are made at the first use.
 */
/** See `Runtime.toolReport`. */
export interface BotToolReport {
  botId: string;
  /** Built-in tools the bot may use, plus the control tools (plan, finish, escalate...). */
  builtinTools: number;
  /** Connector tools granted to the bot and approved (the ones it can use). */
  connectorTools: number;
  /** Granted tools that are off until a person reviews their definition. */
  withheld: number;
  mode: ToolSearchMode;
  /** Connector tools whose definitions are in every request. */
  loadedDirectly: number;
  /** Connector tools kept out of the context and found by search. */
  deferred: number;
  /** Definitions in each request (all the tools sent). */
  definitionsPerRequest: number;
  /** Estimated tokens of all the definitions sent, and of the ones that enter the context. */
  estimatedTokens: number;
  loadedTokens: number;
}

export function createRuntime(config: RuntimeConfig, options: RuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const path = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));

  const dockerPath = options.dockerPath ?? env.SUUP_DOCKER_PATH;
  const providerEntries = new Map(config.providers.map((p) => [p.id, p]));
  const modelEntries = new Map(config.models.map((m) => [m.id, m]));

  const registryOptions =
    config.untrustedOutputTools === undefined
      ? {}
      : { externalOutputTools: config.untrustedOutputTools };
  const tools = registerBuiltinTools(new ToolRegistry(registryOptions));
  const vaultSettings =
    config.vault === undefined
      ? undefined
      : {
          keyEnv: config.vault.keyEnv ?? DEFAULT_VAULT_KEY_ENV,
          ...(config.vault.previousKeyEnvs === undefined
            ? {}
            : { previousKeyEnvs: config.vault.previousKeyEnvs }),
        };
  const vault = createVault(() => runtime.db, env, vaultSettings);
  const connectors = createConnectorService({
    db: () => runtime.db,
    vault,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // Every tool call goes through the approval policy: the user's rules, the reviewer, then a card.
  // The gate asks the registry of the RUN (built-in tools plus the connector tools of its bot).
  const gateFor = (registry: ToolRegistry) =>
    createToolGate({
      tools: registry,
      rules: { rulesFor: (botId) => rulesForBot(runtime.db, botId) },
      ...(config.approvals?.levels === undefined
        ? {}
        : { levelOverrides: config.approvals.levels }),
      ...(config.approvals?.expireAfterMinutes === undefined
        ? {}
        : { expireAfterMs: config.approvals.expireAfterMinutes * 60_000 }),
      now: () => new Date(),
    });
  const REDACTION_MAX_AGE_MS = 5_000;

  let db: Db | undefined;
  const providers = new Map<string, Provider>();
  const executors = new Map<string, Promise<Executor>>();
  let machine: Promise<void> | undefined;

  const entryOf = (id: string): ProviderEntry => {
    const entry = providerEntries.get(id);
    if (entry === undefined) {
      throw new RuntimeError(
        "unknown_provider",
        `O provedor "${id}" não está em "providers" na configuração (configurados: ${[...providerEntries.keys()].join(", ")}).`,
      );
    }
    return entry;
  };

  const keyStatus = (providerId: string): ProviderKeyStatus => {
    const entry = entryOf(providerId);
    if (entry.kind === "scripted") {
      return { providerId, envName: null, ok: true, reason: "provedor de roteiro: não usa chave" };
    }
    const name = entry.apiKeyEnv;
    if (name === undefined) {
      return {
        providerId,
        envName: null,
        ok: true,
        reason: "sem apiKeyEnv: nenhuma chave será enviada (servidor local)",
      };
    }
    const value = env[name];
    if (value === undefined || value === "") {
      return {
        providerId,
        envName: name,
        ok: false,
        reason: `a variável de ambiente ${name} não está definida`,
      };
    }
    return { providerId, envName: name, ok: true, reason: `variável ${name} presente` };
  };

  const getProvider = (id: string): Provider => {
    const cached = providers.get(id);
    if (cached !== undefined) return cached;
    const entry = entryOf(id);
    let provider: Provider;
    if (entry.kind === "scripted") {
      provider = createScriptedProvider({
        id: entry.id,
        scriptPath: path(entry.scriptPath),
        ...(entry.textChunkSize === undefined ? {} : { textChunkSize: entry.textChunkSize }),
      });
    } else {
      const status = keyStatus(id);
      if (!status.ok) {
        // Not an error now: the run that first uses this provider fails with this message, as a
        // provider failure, and the other providers keep working. Not cached, so a fixed
        // environment is picked up.
        return unavailableProvider(
          id,
          `${status.reason} (apiKeyEnv do provedor "${id}"). Defina a variável antes de usar este provedor.`,
        );
      }
      const { kind, apiKeyEnv, ...rest } = entry;
      const apiKey = apiKeyEnv === undefined ? "" : (env[apiKeyEnv] ?? "");
      provider = createProvider({
        kind,
        ...rest,
        apiKey,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      } as ProviderConfig);
    }
    providers.set(id, provider);
    return provider;
  };

  const resolveModel = (modelId: string): ResolvedModel => {
    const model = modelEntries.get(modelId);
    if (model === undefined) {
      throw new RuntimeError(
        "unknown_model",
        `O modelo "${modelId}" não está em "models" na configuração (configurados: ${[...modelEntries.keys()].join(", ")}).`,
      );
    }
    return { model, provider: entryOf(model.provider) };
  };

  const botConfig = (bot: Bot): BotConfig => {
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(bot.modelId);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "unknown_model") {
        throw new RuntimeError(
          "unknown_model",
          `O bot "${bot.name}" (${bot.id}) usa o modelo "${bot.modelId}", que não está em "models" na configuração (configurados: ${[...modelEntries.keys()].join(", ")}). Adicione-o à configuração ou crie outro bot.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (resolved.model.provider !== bot.modelProvider) {
      throw new RuntimeError(
        "model_provider_mismatch",
        `O bot "${bot.name}" (${bot.id}) foi criado com o modelo "${bot.modelId}" no provedor "${bot.modelProvider}", mas a configuração agora o coloca no provedor "${resolved.model.provider}". Ajuste a configuração ou crie outro bot.`,
      );
    }
    const { model } = resolved;
    const limits = bot.limits;
    const maxCostUsd = limits.maxCostUsd ?? config.defaults?.maxCostUsd;
    const maxDurationMs = limits.maxDurationMs ?? config.defaults?.maxDurationMs;
    return {
      id: bot.id,
      name: bot.name,
      personality: bot.personality,
      model: {
        id: model.id,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      },
      allowedTools: bot.allowedTools,
      limits: {
        maxTurns: limits.maxTurns ?? config.defaults?.maxTurns ?? DEFAULT_MAX_TURNS,
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
        ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      },
    };
  };

  const reviewerConfig = (): ReviewerConfig | undefined => {
    if (config.reviewer === undefined) return undefined;
    const { model } = resolveModel(config.reviewer.model);
    return {
      provider: getProvider(model.provider),
      model: {
        id: model.id,
        maxOutputTokens: model.maxOutputTokens,
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
        ...(model.supportsForcedToolChoice === undefined
          ? {}
          : { supportsForcedToolChoice: model.supportsForcedToolChoice }),
      },
    };
  };

  const sandbox = config.sandbox;
  const ensureMachineOnce = (): Promise<void> => {
    if (sandbox.kind !== "docker") return Promise.resolve();
    machine ??= ensureMachine({
      name: sandbox.name,
      image: sandbox.image,
      volume: sandbox.volume,
      ...(sandbox.memory === undefined ? {} : { memory: sandbox.memory }),
      ...(sandbox.cpus === undefined ? {} : { cpus: sandbox.cpus }),
      ...(dockerPath === undefined ? {} : { dockerPath }),
    }).then(
      () => undefined,
      (error: unknown) => {
        machine = undefined; // try again at the next use
        throw new RuntimeError(
          "sandbox_failed",
          `Não foi possível preparar a máquina dos bots (contêiner "${sandbox.name}"): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      },
    );
    return machine;
  };

  const dockerExecutor = (workspace: string): DockerExecutor => {
    if (sandbox.kind !== "docker") throw new Error("not a docker sandbox");
    return new DockerExecutor({
      container: sandbox.name,
      workspace,
      ...(dockerPath === undefined ? {} : { dockerPath }),
    });
  };

  const makeExecutor = async (botId: string): Promise<Executor> => {
    if (!SAFE_BOT_ID.test(botId)) {
      throw new RuntimeError(
        "invalid_bot_id",
        `Identificador de bot inválido: ${JSON.stringify(botId)}.`,
      );
    }
    if (sandbox.kind === "local") {
      return new LocalExecutor({
        root: join(path(sandbox.root), "bots", botId),
        iUnderstandThisIsNotIsolated: true,
      });
    }
    await ensureMachineOnce();
    const made = await dockerExecutor("/workspace").exec(`mkdir -p bots/${botId}`);
    if (made.exitCode !== 0) {
      throw new RuntimeError(
        "sandbox_failed",
        `Não foi possível criar a pasta do bot ${botId} na máquina: ${made.stderr.trim() || `código de saída ${made.exitCode}`}`,
      );
    }
    return dockerExecutor(dockerWorkspace(botId));
  };

  /** How the connector tools of a bot reach its model (see `docs/CONFIGURACAO.md`, `toolSearch`). */
  const toolSearchSetup = (
    candidates: BotConnectorCandidate[],
    modelId: string,
  ): ToolSearchSetup => {
    const declared = modelEntries.get(modelId)?.nativeToolSearch;
    const native: NativeToolSearch | undefined =
      declared === undefined || declared === false
        ? undefined
        : declared === true
          ? "bm25"
          : declared;
    return {
      settings: { ...DEFAULT_TOOL_SEARCH, ...(config.toolSearch ?? {}) },
      candidates,
      native,
    };
  };

  const buildDeps = async (
    runId: string,
    workerId: string,
    buildOptions: BuildDepsOptions = {},
  ): Promise<LoopDeps> => {
    const handle = runtime.db;
    const run = await getRun(handle, runId);
    if (run === null) throw new RuntimeError("bot_not_found", `Execução ${runId} não encontrada.`);
    const bot = await getBot(handle, run.botId);
    if (bot === null) {
      throw new RuntimeError(
        "bot_not_found",
        `O bot ${run.botId} da execução ${runId} não existe.`,
      );
    }
    const cfg = botConfig(bot);
    const reviewer = reviewerConfig();
    // Uma única fonte da verdade: a opção explícita, ou então a marca `isolated` da própria
    // execução. Uma avaliação roda sem ninguém por perto numa máquina descartável: sem diário,
    // sem memória, sem conectores, portão que permite tudo e sem cofre (não depende do que o
    // usuário guarda nele).
    const isolated = (buildOptions.isolated ?? run.isolated) === true;
    const guarded = !isolated;
    const vaultOn = guarded && vault.settings !== undefined;
    if (vaultOn) await vault.refresh(REDACTION_MAX_AGE_MS);

    // The registry of this run: the built-in tools, plus the tools of the connectors this bot was
    // granted (connected now, lazily). An evaluation (isolated) has no connectors.
    let runTools = tools;
    let botCfg = cfg;
    let toolSearch: ToolSearchSetup | undefined;
    if (guarded) {
      const offered = await connectors.toolsForBot(bot.id);
      if (offered.tools.length > 0) {
        runTools = registerBuiltinTools(new ToolRegistry(registryOptions));
        const names: string[] = [];
        for (const tool of offered.tools) {
          try {
            runTools.register(tool);
            names.push(tool.name);
          } catch {
            // a name the registry refuses (it cannot happen with the names this package makes)
          }
        }
        botCfg = { ...cfg, allowedTools: [...cfg.allowedTools, ...names] };
        toolSearch = toolSearchSetup(offered.candidates, bot.modelId);
      }
    }
    return {
      store: new PgRunStore(handle, { workerId }),
      provider: getProvider(bot.modelProvider),
      tools: runTools,
      executor: await runtime.executorFor(bot.id),
      bot: botCfg,
      ...(reviewer === undefined ? {} : { reviewer }),
      // Uma execução isolada (uma avaliação) roda sem ninguém para responder e numa máquina
      // descartável: nenhum cartão poderia ser respondido, então ela sai da política pelo nome. Toda
      // outra execução passa pelo portão.
      ...(toolSearch === undefined ? {} : { toolSearch }),
      gate: guarded ? gateFor(runTools) : allowAllGate(),
      ...(vaultOn ? { secrets: vault.accessFor(bot.id) } : {}),
      // Uma execução isolada não carrega memória: nada do que o usuário contou chega a ela.
      ...(!guarded
        ? {}
        : {
            loadRunContext: async (id: string) => {
              const snapshot = await loadRunContext(
                handle,
                id,
                config.defaults?.historyChars ?? DEFAULT_HISTORY_CHARS,
              );
              // The model is told which secrets exist (names and purpose), never their values.
              return vault.status().ok
                ? { ...snapshot, secrets: await vault.infoFor(bot.id) }
                : snapshot;
            },
            memoryFor: (record: { botId: string; id: string }) =>
              createMemoryService(handle, { botId: record.botId, runId: record.id }),
          }),
      now: () => new Date(),
      sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
    };
  };

  let workerCount = 0;
  const runtime: Runtime = {
    config,
    baseDir,
    get db(): Db {
      if (db === undefined) {
        const url = resolveDatabaseUrl(config, env);
        if (url === undefined) {
          throw new ConfigError(
            'Nenhum banco de dados configurado: defina DATABASE_URL no ambiente ou "databaseUrl" no arquivo de configuração.',
          );
        }
        db = createDb(url);
      }
      return db;
    },
    tools,
    vault,
    connectors,
    async toolReport(botId) {
      const bot = await getBot(runtime.db, botId);
      if (bot === null) throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
      const cfg = botConfig(bot);
      const offered = await connectors.toolsForBot(bot.id);
      const reg = registerBuiltinTools(new ToolRegistry(registryOptions));
      const connectorNames = new Set<string>();
      for (const tool of offered.tools) {
        try {
          reg.register(tool);
          connectorNames.add(tool.name);
        } catch {
          // a name the registry refuses
        }
      }
      const control = new Set<string>(CONTROL_TOOL_NAMES);
      const specs = reg.specs([...cfg.allowedTools, ...connectorNames]);
      const builtin = specs.filter((s) => !connectorNames.has(s.name) && !control.has(s.name));
      const connectorSpecs = new Map(
        specs.filter((s) => connectorNames.has(s.name)).map((s) => [s.name, s]),
      );
      const catalog = planToolSearch(
        toolSearchSetup(offered.candidates, bot.modelId),
        connectorSpecs,
        getProvider(bot.modelProvider).capabilities,
      );
      const sent = [
        ...controlToolSpecs({ secrets: vault.settings !== undefined, toolSearch: catalog.mode }),
        ...builtin,
        ...(catalog.mode === "direct"
          ? [...connectorSpecs.values()]
          : catalog.mode === "meta"
            ? []
            : catalog.deferred.map((d) => d.spec)),
      ];
      const stats = toolDefinitionStats(sent);
      return {
        botId,
        builtinTools:
          builtin.length + controlToolSpecs({ secrets: vault.settings !== undefined }).length,
        connectorTools: connectorSpecs.size,
        withheld: offered.withheld.length,
        mode: catalog.mode,
        loadedDirectly: catalog.mode === "direct" ? connectorSpecs.size : 0,
        deferred: catalog.deferred.length,
        definitionsPerRequest: stats.definitions,
        estimatedTokens: stats.estimatedTokens,
        loadedTokens: stats.loadedTokens,
      };
    },
    redactor: vault.redactor,
    async redactJson(value) {
      await vault.refresh(REDACTION_MAX_AGE_MS);
      return vault.redactor.redactJson(value);
    },
    getProvider,
    keyStatus,
    resolveModel,
    executorFor(botId) {
      let made = executors.get(botId);
      if (made === undefined) {
        made = makeExecutor(botId);
        executors.set(botId, made);
        made.catch(() => executors.delete(botId));
      }
      return made;
    },
    async sandboxRoot() {
      if (sandbox.kind === "local") {
        return new LocalExecutor({ root: path(sandbox.root), iUnderstandThisIsNotIsolated: true });
      }
      await ensureMachineOnce();
      return dockerExecutor("/workspace");
    },
    botConfig,
    reviewerConfig,
    async createRun(input) {
      const bot = await getBot(runtime.db, input.botId);
      if (bot === null) {
        throw new RuntimeError("bot_not_found", `Bot ${input.botId} não encontrado.`);
      }
      if (bot.archivedAt !== null) {
        throw new RuntimeError(
          "bot_archived",
          `O bot "${bot.name}" (${bot.id}) está arquivado: não é possível criar execuções para ele.`,
        );
      }
      botConfig(bot); // refuses a bot whose model or provider the configuration lacks
      return createRunRow(runtime.db, {
        botId: bot.id,
        origin: "user",
        objective: input.objective,
        ...(input.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: input.acceptanceCriteria }),
        ...(input.isolated === true ? { isolated: true } : {}),
      });
    },
    buildDeps,
    createWorker(opts = {}) {
      // Unique across machines and containers: in two containers the pid can be the same (1, 7...),
      // and a lease held by "the same worker" would be taken for one's own.
      const workerId =
        opts.workerId ??
        `worker-${hostname()}-${process.pid}-${++workerCount}-${randomBytes(3).toString("hex")}`;
      const settings = { ...DEFAULT_WORKER, ...config.worker };
      return new Worker({
        workerId,
        queue: new PgRunQueue(runtime.db, {
          ...(opts.onlyRunId === undefined ? {} : { onlyRunId: opts.onlyRunId }),
          // What crashed the harness may have had a secret in its message: scrub it first.
          redact: (text) => runtime.redactJson(text),
        }),
        buildDeps: (runId) => buildDeps(runId, workerId),
        // What must follow a run (the bot's message in the conversation, the journal) is derived
        // from the stored run, so it also happens for a run another worker finished after a crash.
        afterRun: async (end) => {
          if (end.outcome === "settled" || end.outcome === "failed") {
            await finishRun(runtime.db, end.runId, {
              redact: (value) => runtime.redactJson(value),
            });
          }
        },
        concurrency: opts.concurrency ?? settings.concurrency,
        leaseRenewMs: settings.leaseRenewMs,
        staleAfterMs: settings.staleAfterMs,
        controlPollMs: settings.controlPollMs,
        ...(opts.idleBackoff === undefined ? {} : { idleBackoff: opts.idleBackoff }),
        ...(opts.onRunEnd === undefined ? {} : { onRunEnd: opts.onRunEnd }),
        ...(opts.onError === undefined ? {} : { onError: opts.onError }),
      });
    },
    async close() {
      await connectors.close();
      const open = db;
      db = undefined;
      if (open !== undefined) await open.close();
    },
  };
  return runtime;
}

/**
 * A provider that fails every call with `auth` and a message saying what is missing. Used when the
 * API key's environment variable is not set: the run that uses it records the failure (origin
 * `provider`) instead of the whole program refusing to start.
 */
function unavailableProvider(id: string, message: string): Provider {
  return {
    id,
    capabilities: { promptCache: false, parallelTools: true, vision: false },
    // biome-ignore lint/correctness/useYield: it only ever fails
    async *generate() {
      throw new ProviderError("auth", message, { retryable: false });
    },
  };
}
