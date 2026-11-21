import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { StdioLauncher } from "@suup/connectors";
import {
  type AutoReviewer,
  allowAllGate,
  type BotConfig,
  CONTROL_TOOL_NAMES,
  controlToolSpecs,
  createMemoryWriteReviewer,
  createModelReviewer,
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
  type RunContextSnapshot,
  type RunEnd,
  type SupervisorRole,
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
  getApprovalMode,
  getBot,
  getDefaultBot,
  getMemorySettings,
  getRun,
  listBots,
  listConnectorsForBot,
  PgRunQueue,
  PgRunStore,
  type Run,
  rulesForBot,
  wakeDueRuns,
  writtenRulesForBot,
} from "@suup/db";
import { createProvider, type ProviderConfig } from "@suup/providers";
import {
  ContainerStdioLauncher,
  DockerExecutor,
  EgressProxy,
  ensureInternalNetwork,
  ensureMachine,
  LocalExecutor,
  type MachineNetwork,
  NetworkedExecutor,
} from "@suup/sandbox";
import { networkTools, registerBuiltinTools, requestNetworkAccessTool } from "@suup/tools";
import {
  DEFAULT_CONNECTOR_IMAGE,
  DEFAULT_MAX_TURNS,
  DEFAULT_NETWORK_NAME,
  DEFAULT_WORKER,
  type ModelEntry,
  type ProviderEntry,
  type RuntimeConfig,
  resolveDatabaseUrl,
  resolveTimeZone,
} from "./config.js";
import {
  type BotConnectorCandidate,
  type ConnectorService,
  createConnectorService,
} from "./connectors/service.js";
import { ConfigError, RuntimeError } from "./errors.js";
import {
  type ConsolidationOutcome,
  requestPreCompactionConsolidation,
  runMemoryExpiry,
  runNextConsolidation,
} from "./memory-consolidation.js";
import { createMemoryService } from "./memory-service.js";
import { createNetworkService, type NetworkService } from "./network/service.js";
import { PROPOSE_TEAM_TOOL, proposeTeamTool } from "./reception.js";
import { DEFAULT_HISTORY_CHARS, loadRunContext } from "./run-context.js";
import { finishRun } from "./run-end.js";
import { createScriptedProvider } from "./scripted-provider.js";
import {
  delegateTool,
  type ReviewOutcome,
  runMorningMessage,
  runNightlyReview,
  SUPERVISOR_TOOL_NAMES,
  teamRecallTool,
} from "./supervisor.js";
import { createVault, DEFAULT_VAULT_KEY_ENV, type Vault } from "./vault/service.js";
import { createWebWiring, type WebWiring } from "./web/wiring.js";

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
  /**
   * How often the worker looks for a conversation to consolidate and for memory to expire
   * (`undefined`: every 30 s and every hour). A worker that follows one run never does either.
   */
  memoryEveryMs?: { consolidation?: number; expiry?: number };
  /** How often the job that wakes the runs parked for a return looks for due ones (ms). Default 5000. */
  wakeEveryMs?: number;
  /** How often the jobs of the supervisor (nightly review, morning message) check the clock (ms). Default 60000. */
  supervisorEveryMs?: number;
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
   * The network allowlist of the bots' machines and connector containers (docker sandbox): the
   * global defaults, each bot's hosts, the grants of a run, and what the proxy refused.
   */
  readonly network: NetworkService;
  /**
   * The egress of the docker sandbox: the internal network and the proxy the machines go out
   * through, started at the first use. `null` for the `local` sandbox (no isolation, no proxy).
   */
  egress(): Promise<EgressRuntime | null>;
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
  /**
   * What "Auto-review" has to work with: the model that reviews calls and whether its provider can
   * be used now. When it cannot, the mode still exists and falls back to the table of risk levels
   * (`reason` says why, in words for the person).
   */
  autoReviewStatus(): AutoReviewStatus;
  /**
   * The cheap model that consolidates the conversations in the background and reviews what the bot
   * writes to memory after reading content from outside (docs/MEMORIA.md): the model of
   * `memory.consolidation`, else the auto-review model. Without one, nothing is consolidated and
   * such writes wait for the user.
   */
  memoryReviewerStatus(): AutoReviewStatus;
  createRun(input: {
    botId: string;
    objective: string;
    acceptanceCriteria?: string[];
    /** An evaluation run: isolated from the user's memory, now and at its end (no journal). */
    isolated?: boolean;
  }): Promise<Run>;
  buildDeps(runId: string, workerId: string, options?: BuildDepsOptions): Promise<LoopDeps>;
  createWorker(options?: CreateWorkerOptions): Worker;
  /**
   * One pass of the background consolidation, as the worker does it (tests and the CLI call it
   * directly): `null` when there is nothing due or it is off.
   */
  consolidateOnce(options?: {
    workerId?: string;
    now?: Date;
    log?: (message: string) => void;
  }): Promise<ConsolidationOutcome | null>;
  /**
   * One pass of the nightly review of the main bot (docs/SUPERVISOR.md), as the worker does it:
   * `null` when it is not due, it is off, or the Principal's model cannot be used now.
   */
  reviewOnce(options?: {
    workerId?: string;
    now?: Date;
    log?: (message: string) => void;
  }): Promise<ReviewOutcome | null>;
  /** One pass of the morning message: whether it posted one. */
  morningOnce(options?: { now?: Date }): Promise<boolean>;
  /** The web (search and reading): starts its services if needed and says what is running. */
  webStatus(): ReturnType<WebWiring["status"]>;
  close(): Promise<void>;
}

export interface AutoReviewStatus {
  available: boolean;
  /** The model's id in the configuration; `null` when none is configured. */
  model: string | null;
  /** Why it is not available (`null` when it is). */
  reason: string | null;
}

export interface EgressRuntime {
  network: MachineNetwork;
  proxy: EgressProxy;
  /** Where the machines reach the proxy (host and port). */
  address: { host: string; port: number };
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
  /** The built-in tools; the isolated machine also has the one that asks for a network host. */
  const newRegistry = (): ToolRegistry => {
    const registry = registerBuiltinTools(new ToolRegistry(registryOptions));
    if (config.sandbox.kind === "docker") for (const tool of networkTools) registry.register(tool);
    return registry;
  };
  const tools = newRegistry();
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
  const sandboxConfig = config.sandbox;
  const networkConfig = sandboxConfig.kind === "docker" ? sandboxConfig.network : undefined;
  const network = createNetworkService({
    db: () => runtime.db,
    defaultHosts: networkConfig?.defaultHosts,
  });
  const networkName = networkConfig?.name ?? DEFAULT_NETWORK_NAME;
  // Web search and page reading (docs/BUSCA.md): nothing starts until a tool asks for it.
  const web = createWebWiring(config.web, {
    ...(dockerPath === undefined ? {} : { dockerPath }),
  });
  let egressStarted: Promise<EgressRuntime> | undefined;
  /** The internal network and the proxy: made once, at the first use of the docker sandbox. */
  const startEgress = (): Promise<EgressRuntime> => {
    egressStarted ??= (async () => {
      const net = await ensureInternalNetwork(networkName, {
        ...(dockerPath === undefined ? {} : { dockerPath }),
      });
      const listenHost = networkConfig?.proxy?.listenHost ?? net.gateway;
      const proxy = new EgressProxy({
        policy: network.policy,
        listenHost,
        listenPort: networkConfig?.proxy?.port ?? 0,
        ...(networkConfig?.proxy?.advertiseHost === undefined
          ? {}
          : { advertiseHost: networkConfig.proxy.advertiseHost }),
        ...(networkConfig?.ports === undefined ? {} : { ports: networkConfig.ports }),
        onEvent: (event) => network.record(event),
      });
      const address = await proxy.start();
      return { network: net, proxy, address };
    })();
    egressStarted.catch(() => {
      egressStarted = undefined; // try again at the next use
    });
    return egressStarted;
  };
  const containerLauncher =
    sandboxConfig.kind === "docker"
      ? new ContainerStdioLauncherLazy(
          {
            image: sandboxConfig.connectors?.image ?? DEFAULT_CONNECTOR_IMAGE,
            ...(sandboxConfig.connectors?.memory === undefined
              ? {}
              : { memory: sandboxConfig.connectors.memory }),
            ...(sandboxConfig.connectors?.cpus === undefined
              ? {}
              : { cpus: sandboxConfig.connectors.cpus }),
            ...(sandboxConfig.extraCaBundle === undefined
              ? {}
              : { extraCaBundle: sandboxConfig.extraCaBundle }),
            ...(dockerPath === undefined ? {} : { dockerPath }),
          },
          startEgress,
        )
      : undefined;
  const connectors = createConnectorService({
    db: () => runtime.db,
    vault,
    launcher: containerLauncher,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // Every tool call goes through the approval policy: the user's rules, the reviewer, then a card.
  // The gate asks the registry of the RUN (built-in tools plus the connector tools of its bot).
  const gateFor = (registry: ToolRegistry) => {
    const autoReviewer = autoReviewerFor();
    return createToolGate({
      tools: registry,
      rules: { rulesFor: (botId) => rulesForBot(runtime.db, botId) },
      written: { writtenRulesFor: (botId) => writtenRulesForBot(runtime.db, botId) },
      mode: { approvalMode: () => getApprovalMode(runtime.db) },
      ...(autoReviewer === undefined ? {} : { modelReviewer: autoReviewer }),
      ...(config.approvals?.levels === undefined
        ? {}
        : { levelOverrides: config.approvals.levels }),
      ...(config.approvals?.expireAfterMinutes === undefined
        ? {}
        : { expireAfterMs: config.approvals.expireAfterMinutes * 60_000 }),
      now: () => new Date(),
    });
  };
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
    const maxReturns =
      typeof limits.maxReturns === "number" ? limits.maxReturns : config.defaults?.maxReturns;
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
        ...(maxReturns === undefined ? {} : { maxReturns }),
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

  /** The model "Auto-review" asks: `approvals.autoReview.model`, else the model of `reviewer`. */
  const autoReviewModelId = config.approvals?.autoReview?.model ?? config.reviewer?.model;
  const autoReviewStatus = (): AutoReviewStatus => {
    if (config.approvals?.autoReview?.enabled === false) {
      return {
        available: false,
        model: null,
        reason: 'Desligado na configuração ("approvals.autoReview.enabled": false).',
      };
    }
    if (autoReviewModelId === undefined) {
      return {
        available: false,
        model: null,
        reason:
          'Nenhum modelo de revisão está configurado ("approvals.autoReview.model" ou "reviewer.model").',
      };
    }
    const { model } = resolveModel(autoReviewModelId);
    const key = keyStatus(model.provider);
    return key.ok
      ? { available: true, model: model.id, reason: null }
      : { available: false, model: model.id, reason: key.reason };
  };
  const autoReviewerFor = (): AutoReviewer | undefined => {
    if (autoReviewModelId === undefined || !autoReviewStatus().available) return undefined;
    const { model } = resolveModel(autoReviewModelId);
    return createModelReviewer({
      provider: getProvider(model.provider),
      model: {
        id: model.id,
        maxOutputTokens: model.maxOutputTokens,
        pricing: model.pricing,
        supportsForcedToolChoice: model.supportsForcedToolChoice,
      },
    });
  };

  /** The cheap model of the memory: `memory.consolidation.model`, else the auto-review one. */
  const memoryModelId = config.memory?.consolidation?.model ?? autoReviewModelId;
  const memoryReviewerStatus = (): AutoReviewStatus => {
    if (config.memory?.consolidation?.enabled === false) {
      return {
        available: false,
        model: null,
        reason: 'Desligado na configuração ("memory.consolidation.enabled": false).',
      };
    }
    if (memoryModelId === undefined) {
      return {
        available: false,
        model: null,
        reason:
          'Nenhum modelo está configurado para a memória ("memory.consolidation.model", "approvals.autoReview.model" ou "reviewer.model").',
      };
    }
    const { model } = resolveModel(memoryModelId);
    const key = keyStatus(model.provider);
    return key.ok
      ? { available: true, model: model.id, reason: null }
      : { available: false, model: model.id, reason: key.reason };
  };
  const memoryModel = () => {
    if (memoryModelId === undefined || !memoryReviewerStatus().available) return undefined;
    const { model } = resolveModel(memoryModelId);
    return {
      provider: getProvider(model.provider),
      model: {
        id: model.id,
        maxOutputTokens: model.maxOutputTokens,
        pricing: model.pricing,
        supportsForcedToolChoice: model.supportsForcedToolChoice,
      },
    };
  };

  const sandbox = config.sandbox;
  const ensureMachineOnce = (): Promise<void> => {
    if (sandbox.kind !== "docker") return Promise.resolve();
    machine ??= startEgress()
      .then(() => undefined)
      .then(() =>
        ensureMachine({
          network: networkName,
          name: sandbox.name,
          image: sandbox.image,
          volume: sandbox.volume,
          ...(sandbox.memory === undefined ? {} : { memory: sandbox.memory }),
          ...(sandbox.cpus === undefined ? {} : { cpus: sandbox.cpus }),
          ...(sandbox.extraCaBundle === undefined ? {} : { extraCaBundle: sandbox.extraCaBundle }),
          ...(dockerPath === undefined ? {} : { dockerPath }),
        }),
      )
      .then(
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
    const { proxy } = await startEgress();
    // The bot's commands go out through the proxy, with the bot's own allowlist.
    return new NetworkedExecutor(dockerExecutor(dockerWorkspace(botId)), proxy, {
      kind: "bot",
      id: botId,
    });
  };

  /**
   * On the isolated machine a bot can always ask for a host (the user decides on a card): the tool
   * is a built-in one, always loaded (never part of the connector catalog, so tool search cannot
   * defer or hide it). One function for the run and for the measurement, so both count it.
   */
  const withNetworkTool = <C extends { allowedTools: string[] }>(botCfg: C): C =>
    sandbox.kind === "docker" && !botCfg.allowedTools.includes(requestNetworkAccessTool.name)
      ? { ...botCfg, allowedTools: [...botCfg.allowedTools, requestNetworkAccessTool.name] }
      : botCfg;

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
    let connectorNames: string[] = [];
    if (guarded) {
      const offered = await connectors.toolsForBot(bot.id);
      if (offered.tools.length > 0) {
        runTools = newRegistry();
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
      botCfg = withNetworkTool(botCfg);
      connectorNames = [
        ...new Set((await listConnectorsForBot(handle, bot.id)).map((c) => c.name)),
      ];
    }
    // The welcome of the main bot may show the user a team to tick: its one extra tool.
    const receptionKind: "general" | "bot" | undefined =
      run.origin !== "reception" ? undefined : bot.isDefault ? "general" : "bot";
    if (guarded && receptionKind === "general") {
      if (runTools === tools) runTools = newRegistry();
      runTools.register(proposeTeamTool(runtime));
      botCfg = { ...botCfg, allowedTools: [...botCfg.allowedTools, PROPOSE_TEAM_TOOL] };
    }
    // The place of the bot in the team (docs/SUPERVISOR.md). The Principal gets the supervisor's
    // two tools in a normal run (not in its welcome, and never in a delegated run: depth 1).
    const supervisor: SupervisorRole | undefined =
      !guarded || receptionKind !== undefined
        ? undefined
        : bot.isDefault !== true
          ? "member"
          : run.origin === "delegation"
            ? undefined
            : "principal";
    if (supervisor === "principal") {
      if (runTools === tools) runTools = newRegistry();
      runTools.register(teamRecallTool(handle));
      runTools.register(delegateTool(handle));
      botCfg = { ...botCfg, allowedTools: [...botCfg.allowedTools, ...SUPERVISOR_TOOL_NAMES] };
    }
    const executor = await runtime.executorFor(bot.id);
    return {
      store: new PgRunStore(handle, { workerId }),
      provider: getProvider(bot.modelProvider),
      tools: runTools,
      executor,
      bot: botCfg,
      ...(reviewer === undefined ? {} : { reviewer }),
      // Uma execução isolada (uma avaliação) roda sem ninguém para responder e numa máquina
      // descartável: nenhum cartão poderia ser respondido, então ela sai da política pelo nome. Toda
      // outra execução passa pelo portão.
      ...(toolSearch === undefined ? {} : { toolSearch }),
      gate: guarded ? gateFor(runTools) : allowAllGate(),
      // The bot may come back by itself (`schedule_return`) in a conversation run; an evaluation
      // runs alone and without a chat, so it has no return.
      ...(guarded ? { allowReturns: true } : {}),
      ...(vaultOn ? { secrets: vault.accessFor(bot.id) } : {}),
      // Uma execução isolada não carrega memória: nada do que o usuário contou chega a ela.
      ...(!guarded
        ? {}
        : {
            loadRunContext: async (id: string) => {
              // What the user chose for the memory is read once, at the start of the run, and
              // recorded in `context_loaded` (a replay uses the recorded values).
              const memorySettings = await getMemorySettings(handle);
              const snapshot = await loadRunContext(
                handle,
                id,
                config.defaults?.historyChars ?? DEFAULT_HISTORY_CHARS,
                {
                  promptLimitItems: memorySettings.promptLimitItems,
                  compactionThreshold: memorySettings.compactionThreshold,
                },
              );
              // What is true of THIS run, read once and recorded with the rest: when it started and
              // the user's time zone, the other bots, what the machine is, the connectors granted.
              const team = (await listBots(handle))
                .filter((other) => other.id !== bot.id)
                .map((other) => ({ name: other.name, description: other.description }));
              const withFacts: RunContextSnapshot = {
                ...snapshot,
                now: { iso: new Date().toISOString(), timeZone: resolveTimeZone(config) },
                team,
                machine: {
                  terminal: botCfg.allowedTools.includes("shell"),
                  files: FILE_TOOL_NAMES.some((name) => botCfg.allowedTools.includes(name)),
                  isolated: executor.isolated === true,
                },
                connectors: connectorNames,
                ...(receptionKind === undefined ? {} : { reception: receptionKind }),
                ...(supervisor === undefined ? {} : { supervisor }),
              };
              // The model is told which secrets exist (names and purpose), never their values.
              return vault.status().ok
                ? { ...withFacts, secrets: await vault.infoFor(bot.id) }
                : withFacts;
            },
            memoryFor: (record: { botId: string; id: string }) => {
              const writer = memoryModel();
              return createMemoryService(
                handle,
                { botId: record.botId, runId: record.id },
                {
                  // Decided by what each tool declares, never by its text: the control tools and
                  // the tools that declare `ownOutput` bring nothing in from outside.
                  isExternalTool: (name) =>
                    !CONTROL_TOOL_NAMES.some((control) => control === name) &&
                    runTools.get(name)?.ownOutput !== true,
                  ...(writer === undefined
                    ? {}
                    : { reviewer: createMemoryWriteReviewer({ ...writer }) }),
                },
              );
            },
            // Before a compaction the conversation is consolidated in the background: the hook
            // only queues, so the run neither waits nor sees any difference.
            beforeCompaction: async (record: { id: string }) => {
              if (!memoryReviewerStatus().available) return;
              if (!(await getMemorySettings(handle)).consolidationEnabled) return;
              const current = await getRun(handle, record.id);
              if (current?.conversationId === null || current?.conversationId === undefined) return;
              await requestPreCompactionConsolidation(handle, {
                conversationId: current.conversationId,
                botId: current.botId,
              });
            },
          }),
      webFor: () => web.access,
      ...(sandbox.kind === "docker" && guarded
        ? {
            networkFor: (record: { botId: string; id: string }) => ({
              allowForRun: (host: string) => network.allowForRun(record.botId, record.id, host),
            }),
          }
        : {}),
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
      const cfg = withNetworkTool(botConfig(bot));
      const offered = await connectors.toolsForBot(bot.id);
      const reg = newRegistry();
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
        ...controlToolSpecs({
          secrets: vault.settings !== undefined,
          scheduleReturn: true,
          toolSearch: catalog.mode,
        }),
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
          builtin.length +
          controlToolSpecs({ secrets: vault.settings !== undefined, scheduleReturn: true }).length,
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
    network,
    async egress() {
      return sandbox.kind === "docker" ? startEgress() : null;
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
      const { proxy } = await startEgress();
      // The harness subject has an EMPTY allowlist: whatever it asks of the network is refused.
      return new NetworkedExecutor(dockerExecutor("/workspace"), proxy, {
        kind: "harness",
        id: "doctor",
      });
    },
    botConfig,
    reviewerConfig,
    autoReviewStatus,
    memoryReviewerStatus,
    async consolidateOnce(opts = {}) {
      const writer = memoryModel();
      if (writer === undefined) return null;
      return runNextConsolidation({
        db: runtime.db,
        workerId: opts.workerId ?? `consolidate-${hostname()}-${process.pid}`,
        provider: writer.provider,
        model: writer.model,
        ...(opts.now === undefined ? {} : { now: () => opts.now as Date }),
        ...(opts.log === undefined ? {} : { log: opts.log }),
      });
    },
    async reviewOnce(opts = {}) {
      const principal = await getDefaultBot(runtime.db);
      if (principal === null) return null;
      // A main bot whose model the configuration lacks (or whose key is missing) cannot review: quiet.
      let resolved: ResolvedModel;
      try {
        resolved = resolveModel(principal.modelId);
      } catch {
        return null;
      }
      const { model, provider: providerEntry } = resolved;
      if (!keyStatus(providerEntry.id).ok) return null;
      return runNightlyReview({
        db: runtime.db,
        workerId: opts.workerId ?? `review-${hostname()}-${process.pid}`,
        provider: getProvider(providerEntry.id),
        model: {
          id: model.id,
          maxOutputTokens: model.maxOutputTokens,
          pricing: model.pricing,
          supportsForcedToolChoice: model.supportsForcedToolChoice,
        },
        timeZone: resolveTimeZone(config),
        ...(opts.now === undefined ? {} : { now: () => opts.now as Date }),
        ...(opts.log === undefined ? {} : { log: opts.log }),
      });
    },
    async morningOnce(opts = {}) {
      return runMorningMessage({
        db: runtime.db,
        timeZone: resolveTimeZone(config),
        ...(opts.now === undefined ? {} : { now: () => opts.now as Date }),
      });
    },
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
        // Beside the runs, never in their way: consolidating what the user said in the
        // conversations and archiving the notes nobody used. The database says who does what, so
        // several workers can run them.
        ...(opts.onlyRunId !== undefined
          ? {}
          : {
              background: [
                {
                  name: "memory-consolidation",
                  everyMs: opts.memoryEveryMs?.consolidation ?? 30_000,
                  run: async (signal: AbortSignal) => {
                    // A few conversations per pass; the next pass takes the rest.
                    for (let n = 0; n < 3 && !signal.aborted; n++) {
                      const done = await runtime.consolidateOnce({
                        workerId,
                        log: (message) =>
                          opts.onError?.(new Error(message), "memory consolidation"),
                      });
                      if (done === null) return;
                    }
                  },
                },
                {
                  // The runs parked for a return that came due are woken here: the event and the
                  // requeue happen in one transaction, so only one worker wakes each (docs/RETORNO.md).
                  name: "wake-returns",
                  everyMs: opts.wakeEveryMs ?? 5_000,
                  run: async () => {
                    await wakeDueRuns(runtime.db);
                  },
                },
                {
                  // The nightly review of the main bot and its morning message: the database
                  // allows one review per night, so any number of workers can run them.
                  name: "team-review",
                  everyMs: opts.supervisorEveryMs ?? 60_000,
                  run: async () => {
                    await runtime.reviewOnce({
                      workerId,
                      log: (message) => opts.onError?.(new Error(message), "team review"),
                    });
                    await runtime.morningOnce();
                  },
                },
                {
                  name: "memory-expiry",
                  everyMs: opts.memoryEveryMs?.expiry ?? 3_600_000,
                  run: async () => {
                    await runMemoryExpiry(runtime.db);
                  },
                },
              ],
            }),
        concurrency: opts.concurrency ?? settings.concurrency,
        leaseRenewMs: settings.leaseRenewMs,
        staleAfterMs: settings.staleAfterMs,
        controlPollMs: settings.controlPollMs,
        ...(opts.idleBackoff === undefined ? {} : { idleBackoff: opts.idleBackoff }),
        ...(opts.onRunEnd === undefined ? {} : { onRunEnd: opts.onRunEnd }),
        ...(opts.onError === undefined ? {} : { onError: opts.onError }),
      });
    },
    webStatus: () => web.status(),
    async close() {
      await web.close();
      await connectors.close();
      await containerLauncher?.closeAll();
      if (egressStarted !== undefined) {
        const started = await egressStarted.catch(() => undefined);
        egressStarted = undefined;
        await started?.proxy.stop();
      }
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
/** The tools that give a bot files on its machine (the names are declared by the tools). */
const FILE_TOOL_NAMES = ["read_file", "write_file", "edit_file", "list_files", "search_files"];

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

/**
 * The container launcher of stdio connectors, which needs the egress proxy to be up before it can
 * say what to run: it starts it (once) at the first connection.
 */
class ContainerStdioLauncherLazy implements StdioLauncher {
  readonly where = "container" as const;
  #inner: ContainerStdioLauncher | undefined;
  constructor(
    private readonly base: Omit<
      ConstructorParameters<typeof ContainerStdioLauncher>[0],
      "network" | "egress"
    >,
    private readonly start: () => Promise<EgressRuntime>,
  ) {}

  async #launcher(): Promise<ContainerStdioLauncher> {
    if (this.#inner === undefined) {
      const { network, proxy } = await this.start();
      this.#inner = new ContainerStdioLauncher({
        ...this.base,
        network: network.name,
        egress: proxy,
      });
    }
    return this.#inner;
  }

  async wrap(input: Parameters<StdioLauncher["wrap"]>[0]) {
    return (await this.#launcher()).wrap(input);
  }

  async closeAll(): Promise<void> {
    await this.#inner?.closeAll();
  }
}
