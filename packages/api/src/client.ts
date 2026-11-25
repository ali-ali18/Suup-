import { z } from "zod";
import {
  type Approval,
  type ApprovalRule,
  type ApprovalSettings,
  approvalListSchema,
  approvalSchema,
  approvalSettingsSchema,
  type CreateRuleBody,
  type CreateWrittenRuleBody,
  type DecideApprovalBody,
  type DecideApprovalResult,
  decideApprovalResultSchema,
  type ListApprovalsQuery,
  type ListRulesQuery,
  type ListWrittenRulesQuery,
  ruleListSchema,
  ruleSchema,
  type UpdateApprovalSettingsBody,
  type UpdateRuleBody,
  type UpdateWrittenRuleBody,
  type WrittenRule,
  writtenRuleListSchema,
  writtenRuleSchema,
} from "./approvals.js";
import {
  type Bot,
  type BotDraft,
  botDraftSchema,
  botListSchema,
  botSchema,
  type CreateBotBody,
  type DraftBotBody,
  type ListBotsQuery,
  type ModelInfo,
  modelListSchema,
  type ServerInfo,
  serverInfoSchema,
  type ToolInfo,
  toolListSchema,
  type UpdateBotBody,
} from "./bots.js";
import {
  type CatalogItem,
  catalogListSchema,
  type InstallResult,
  installResultSchema,
  type OAuthStart,
  type OAuthStatus,
  oauthStartSchema,
  oauthStatusSchema,
} from "./connector-catalog.js";
import {
  type ApproveToolBody,
  type Connector,
  type ConnectorTest,
  type ConnectorToolEvent,
  type ConnectorToolReview,
  type CreateConnectorBody,
  connectorListSchema,
  connectorReviewListSchema,
  connectorSchema,
  connectorTestSchema,
  connectorToolEventListSchema,
  type GrantConnectorBody,
  type SetToolOutboundBody,
  type SetToolRiskBody,
  type UpdateConnectorBody,
} from "./connectors.js";
import {
  type Conversation,
  conversationListSchema,
  conversationSchema,
  type DecideTeamBody,
  type DecideTeamResult,
  decideTeamResultSchema,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MarkReadBody,
  type Message,
  messagePageSchema,
  messageSchema,
  type ReceptionResult,
  receptionResultSchema,
  type SendMessageResult,
  sendMessageResultSchema,
} from "./conversations.js";
import {
  type Doctor,
  doctorSchema,
  type ModelRequest,
  modelRequestSchema,
  type Replay,
  type Resend,
  type ResendBody,
  replaySchema,
  resendSchema,
} from "./diagnostics.js";
import { ApiError, type ErrorCode } from "./errors.js";
import {
  type AddMemoryBody,
  type ListMemoriesQuery,
  type ListMemoryConsolidationsQuery,
  type Memory,
  type MemoryConsolidation,
  type MemoryRevision,
  type MemorySettings,
  memoryConsolidationListSchema,
  memoryListSchema,
  memoryRevisionListSchema,
  memorySchema,
  memorySearchSchema,
  memorySettingsSchema,
  messageSearchSchema,
  type SearchMemoriesQuery,
  type SearchMessagesQuery,
  type UpdateMemorySettingsBody,
} from "./memory.js";
import { type BotNetwork, botNetworkSchema } from "./network.js";
import {
  type CreateRoutineBody,
  type ListRoutineFiresQuery,
  type ListRoutinesQuery,
  type Routine,
  type RoutineFire,
  routineFireListSchema,
  routineListSchema,
  routineSchema,
  runRoutineResultSchema,
  type UpdateRoutineBody,
  type UpdateUserSettingsBody,
  type UserSettings,
  userSettingsSchema,
} from "./routines.js";
import {
  type ListRunsQuery,
  type Run,
  type RunEvents,
  type RunEventsQuery,
  runEventsSchema,
  runListSchema,
  runSchema,
} from "./runs.js";
import { errorOf, type SubscribeOptions, type Subscription, subscribe } from "./subscribe.js";
import {
  type ListTeamReviewsQuery,
  type SupervisorSettings,
  supervisorSettingsSchema,
  type TeamReview,
  teamReviewListSchema,
  type UpdateSupervisorSettingsBody,
} from "./supervisor.js";
import {
  type AnswerSecretRequestBody,
  type AnswerSecretRequestResult,
  answerSecretRequestResultSchema,
  pluginCredentialStoredSchema,
  type Secret,
  type SecretRequest,
  type SetSecretBody,
  secretListSchema,
  secretRequestSchema,
  secretSchema,
  type VaultStatus,
  vaultStatusSchema,
} from "./vault.js";
import { type WebSearchSettings, webSearchSchema } from "./web-search.js";

export interface ClientOptions {
  /** Where the server is, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** The server's bearer token. */
  token: string;
  /** For tests, or a platform whose `fetch` is not the global one. */
  fetch?: typeof fetch;
  /** Gives up on a request that has not been answered in this time (not the stream). Default 60 s. */
  timeoutMs?: number;
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

function queryString(query: Query | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

const healthSchema = z.object({ status: z.literal("ok") });
const resetReceptionSchema = z.object({ reset: z.literal(true) });
const deletedSchema = z.object({ deleted: z.literal(true) });
const secretRequestAnswerSchema = z.object({ request: secretRequestSchema.nullable() });

export interface SuupClient {
  /** `GET /health`: no token needed. */
  health(): Promise<{ status: "ok" }>;
  models: { list(): Promise<ModelInfo[]> };
  /** `GET /v1/info`: the user's time zone the bots use (`null` while unknown) and where it came from. */
  info(): Promise<ServerInfo>;
  /** The user's own settings: today the time zone (docs/ROTINAS.md). */
  userSettings: {
    get(): Promise<UserSettings>;
    /** `source: "device"` fills the blank only; `source: "user"` is the user's choice and wins. */
    update(body: UpdateUserSettingsBody): Promise<UserSettings>;
  };
  /** The bots' routines (docs/ROTINAS.md). */
  routines: {
    list(query?: ListRoutinesQuery): Promise<Routine[]>;
    get(id: string): Promise<Routine>;
    create(body: CreateRoutineBody): Promise<Routine>;
    update(id: string, body: UpdateRoutineBody): Promise<Routine>;
    delete(id: string): Promise<void>;
    /** "Rodar agora": a fire outside the schedule; `409` while the previous run still goes. */
    run(id: string): Promise<RoutineFire>;
    /** The history of fires, newest first. */
    fires(id: string, query?: ListRoutineFiresQuery): Promise<RoutineFire[]>;
  };
  tools: { list(): Promise<{ items: ToolInfo[]; control: string[] }> };
  bots: {
    list(query?: ListBotsQuery): Promise<Bot[]>;
    get(id: string): Promise<Bot>;
    create(body: CreateBotBody): Promise<Bot>;
    update(id: string, body: UpdateBotBody): Promise<Bot>;
    archive(id: string): Promise<Bot>;
    setDefault(id: string): Promise<Bot>;
    /** The bot's direct conversation (created at the first call). */
    openConversation(id: string): Promise<Conversation>;
    /** A proposal (name, description, personality) from a free-text description. Creates nothing. */
    draft(body: DraftBotBody): Promise<BotDraft>;
    /**
     * The open of the bot's chat asks for its welcome (docs/RECEPCAO.md). Idempotent: it starts at
     * most once, however many times, and from however many windows, it is called.
     */
    startReception(id: string): Promise<ReceptionResult>;
    /** "Refazer a recepção": the next open of the chat starts the welcome again. */
    resetReception(id: string): Promise<void>;
  };
  conversations: {
    list(query?: ListConversationsQuery): Promise<Conversation[]>;
    get(id: string): Promise<Conversation>;
    messages(
      id: string,
      query?: ListMessagesQuery,
    ): Promise<{ items: Message[]; hasMore: boolean }>;
    /** `options.routineRef`: the routine the message is about (never part of the text). */
    send(
      id: string,
      text: string,
      options?: { routineRef?: { id: string } },
    ): Promise<SendMessageResult>;
    markRead(id: string, body?: MarkReadBody): Promise<Conversation>;
    /** The user's decision on a team card (the message that carries it): create the ticked ones, or "Agora não". */
    decideTeam(messageId: string, body: DecideTeamBody): Promise<DecideTeamResult>;
    /** The X of a question card: no option will be chosen; the run is told and goes on. */
    dismissQuestion(messageId: string): Promise<Message>;
  };
  runs: {
    list(query?: ListRunsQuery): Promise<{ items: Run[]; hasMore: boolean }>;
    get(id: string): Promise<Run>;
    events(id: string, query?: RunEventsQuery): Promise<RunEvents>;
    /** Stops at the next safe point; resumable. */
    pause(id: string): Promise<Run>;
    /** Stops now (cuts the model call and the tool in flight); resumable. */
    interrupt(id: string): Promise<Run>;
    /** Ends the run as `cancelled`. Needs a worker alive to be applied. */
    cancel(id: string): Promise<Run>;
    resume(id: string): Promise<Run>;
  };
  memories: {
    list(query?: ListMemoriesQuery): Promise<Memory[]>;
    add(body: AddMemoryBody): Promise<Memory>;
    edit(id: string, text: string): Promise<Memory>;
    /** Forgets (archives): it can be restored. */
    archive(id: string): Promise<Memory>;
    restore(id: string): Promise<Memory>;
    search(query: SearchMemoriesQuery): Promise<z.infer<typeof memorySearchSchema>["items"]>;
    /** What waits for your confirmation: `list({ status: "pending" })`. */
    pending(): Promise<Memory[]>;
    /** Confirms a pending memory: from the next run it counts (a rule or fact enters the prompts). */
    confirm(id: string): Promise<Memory>;
    /** Refuses a pending memory (kept as `rejected`, not proposed again). */
    reject(id: string): Promise<Memory>;
    /** The history of changes of one memory, newest first. */
    history(id: string): Promise<MemoryRevision[]>;
    /** Undoes one change (only the latest of a memory); the memory comes back as it was before. */
    undo(id: string, revisionId: string): Promise<Memory>;
    /** The attempts of the background consolidation, newest first. */
    consolidations(query?: ListMemoryConsolidationsQuery): Promise<MemoryConsolidation[]>;
  };
  /** The Principal as the supervisor of the team (docs/SUPERVISOR.md). */
  supervisor: {
    settings: {
      get(): Promise<SupervisorSettings>;
      update(body: UpdateSupervisorSettingsBody): Promise<SupervisorSettings>;
    };
    /** The history of the nightly reviews, newest first. */
    reviews(query?: ListTeamReviewsQuery): Promise<TeamReview[]>;
  };
  memorySettings: {
    get(): Promise<MemorySettings>;
    /** Changes only the keys sent. `expiryDays: null` means never. */
    update(body: UpdateMemorySettingsBody): Promise<MemorySettings>;
  };
  search: {
    messages(query: SearchMessagesQuery): Promise<z.infer<typeof messageSearchSchema>["items"]>;
  };
  diagnostics: {
    /** What the model saw in the call recorded at event `seq`, and what it answered. */
    request(runId: string, seq: number): Promise<ModelRequest>;
    replay(runId: string): Promise<Replay>;
    resend(runId: string, body: ResendBody, signal?: AbortSignal): Promise<Resend>;
    doctor(options?: { live?: boolean }): Promise<Doctor>;
  };
  /** Follows the realtime stream, reconnecting and resuming by itself. */
  subscribe(options: SubscribeOptions): Subscription;
  approvals: {
    /** Newest first. `status: "pending"` is the list of cards waiting for you. */
    list(query?: ListApprovalsQuery): Promise<Approval[]>;
    get(id: string): Promise<Approval>;
    /** Approves (optionally "and always allow") or denies (with a reason). A card is decided once. */
    decide(id: string, body: DecideApprovalBody): Promise<DecideApprovalResult>;
  };
  rules: {
    list(query?: ListRulesQuery): Promise<ApprovalRule[]>;
    create(body: CreateRuleBody): Promise<ApprovalRule>;
    update(id: string, body: UpdateRuleBody): Promise<ApprovalRule>;
    remove(id: string): Promise<void>;
  };
  /** The approval mode ("Auto-review" or "Perguntar tudo") and whether the reviewer is available. */
  approvalSettings: {
    get(): Promise<ApprovalSettings>;
    update(body: UpdateApprovalSettingsBody): Promise<ApprovalSettings>;
  };
  /** The rules the user writes in plain language; a model reads them when it reviews a call. */
  writtenRules: {
    list(query?: ListWrittenRulesQuery): Promise<WrittenRule[]>;
    create(body: CreateWrittenRuleBody): Promise<WrittenRule>;
    update(id: string, body: UpdateWrittenRuleBody): Promise<WrittenRule>;
    remove(id: string): Promise<void>;
  };
  connectors: {
    list(): Promise<Connector[]>;
    get(name: string): Promise<Connector>;
    create(body: CreateConnectorBody): Promise<Connector>;
    update(name: string, body: UpdateConnectorBody): Promise<Connector>;
    remove(name: string): Promise<void>;
    /** Replaces what the bot may use: `{ tools: "all" }` or `{ tools: ["a", "b"] }` (names on the server). */
    grant(name: string, botId: string, body: GrantConnectorBody): Promise<Connector>;
    /** The tools whose definition changed (or that are new): off for every bot until approved. */
    review(name: string): Promise<ConnectorToolReview[]>;
    /** Approves the definition the person looked at (`fingerprint` from `review`). */
    approveTool(name: string, tool: string, body: ApproveToolBody): Promise<Connector>;
    events(name: string): Promise<ConnectorToolEvent[]>;
    revoke(name: string, botId: string): Promise<Connector>;
    /** What the user says a tool's risk is (`null` clears it). */
    setToolRisk(name: string, tool: string, body: SetToolRiskBody): Promise<Connector>;
    /** Marks a tool as sending a message to another person, naming the recipient fields (`null` clears it). */
    setToolOutbound(name: string, tool: string, body: SetToolOutboundBody): Promise<Connector>;
    /** Starts the server from scratch where THIS server runs, lists its tools and closes. */
    test(name: string): Promise<ConnectorTest>;
    /** Starts a browser login (OAuth of the MCP): open `authorizationUrl` in the system browser. */
    oauthStart(name: string): Promise<OAuthStart>;
    /** Where the login stands: poll it while `pending`. */
    oauthStatus(name: string): Promise<OAuthStatus>;
    /** Revokes (when the server can), forgets the tokens and turns the connector off. */
    oauthDisconnect(name: string): Promise<Connector>;
  };
  /** The gallery of connectors (docs/CONECTORES.md, "Galeria"). */
  connectorCatalog: {
    list(): Promise<CatalogItem[]>;
    /** Installs the entry (off until the login or the token), or turns it on once its token is in the vault. */
    install(id: string): Promise<InstallResult>;
    /**
     * Keeps the token of a `token` entry with the connector (never in the owner's vault, never
     * granted to a bot). Write-only.
     */
    setToken(id: string, value: string): Promise<void>;
    /** Forgets the token the connector keeps. */
    removeToken(id: string): Promise<void>;
  };
  network: {
    /** The hosts a bot's machine may reach (defaults, its own) and what the proxy refused lately. */
    forBot(botId: string): Promise<BotNetwork>;
    /** Allows one exact host for the bot (an act of the user). */
    allow(botId: string, host: string): Promise<BotNetwork>;
    /** Takes the host away from the bot's own list. */
    remove(botId: string, host: string): Promise<BotNetwork>;
  };
  files: {
    /** The address of a file the bot sent (behind the token: `Authorization: Bearer`). */
    url(fileId: string): string;
    /** Downloads a file the bot sent (`GET /v1/files/:id`): its exact bytes. */
    download(fileId: string, signal?: AbortSignal): Promise<Uint8Array>;
  };
  webSearch: {
    /** The general search engines in the order they are tried, with where each stands this month. */
    get(): Promise<WebSearchSettings>;
    /** Keeps the key of a general engine with the engine (never in the owner's vault). Write-only. */
    setKey(id: string, value: string): Promise<void>;
    /** Forgets the key the engine keeps. */
    removeKey(id: string): Promise<void>;
  };
  vault: {
    /** Whether the server has a vault it can write to (the section and the key), and why not. */
    status(): Promise<VaultStatus>;
    /** Names and metadata. There is no way to read a value back. */
    list(): Promise<Secret[]>;
    /** Creates or replaces a secret (write-only). */
    set(name: string, body: SetSecretBody): Promise<Secret>;
    remove(name: string): Promise<void>;
    grant(name: string, botId: string): Promise<Secret>;
    revoke(name: string, botId: string): Promise<Secret>;
    /** The credential a run is waiting for, or `null`. */
    request(runId: string): Promise<SecretRequest | null>;
    /** Answers it: the value goes straight to the vault; the bot is told only that it is available. */
    answerRequest(runId: string, body: AnswerSecretRequestBody): Promise<AnswerSecretRequestResult>;
  };
}

/** A typed client for every endpoint of the server and its realtime stream. */
export function createClient(options: ClientOptions): SuupClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function call<T extends z.ZodType>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: T,
    config: {
      query?: Query | undefined;
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal | undefined;
      timeoutMs?: number;
    } = {},
  ): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      config.timeoutMs ?? timeoutMs,
    );
    const onAbort = () => controller.abort(config.signal?.reason);
    config.signal?.addEventListener("abort", onAbort, { once: true });
    if (config.signal?.aborted) controller.abort(config.signal.reason);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}${queryString(config.query)}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(config.auth === false ? {} : { Authorization: `Bearer ${options.token}` }),
          ...(config.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(config.body === undefined ? {} : { body: JSON.stringify(config.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (config.signal?.aborted)
        throw new ApiError("aborted", "A requisição foi cancelada.", undefined, { cause: error });
      throw new ApiError(
        "network",
        controller.signal.aborted
          ? "O servidor demorou demais para responder."
          : `Não foi possível falar com o servidor: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) throw await errorOf(response);
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new ApiError(
        "invalid_response",
        "O servidor respondeu algo que não é JSON.",
        response.status,
        { cause: error },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        "invalid_response",
        `A resposta de ${method} ${path} não segue o contrato: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        response.status,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  const id = (value: string) => encodeURIComponent(value);
  const noBody = { body: undefined } as const;

  /** A file is bytes, not JSON: the same token and errors as `call`, a longer wait (25 MB). */
  async function download(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.token}` },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted)
        throw new ApiError("aborted", "A requisição foi cancelada.", undefined, { cause: error });
      throw new ApiError("network", "Não foi possível falar com o servidor.", undefined, {
        cause: error,
      });
    }
    if (!response.ok) throw await errorOf(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    health: () => call("GET", "/health", healthSchema, { auth: false }),
    models: { list: async () => (await call("GET", "/v1/models", modelListSchema)).items },
    info: () => call("GET", "/v1/info", serverInfoSchema),
    userSettings: {
      get: () => call("GET", "/v1/user-settings", userSettingsSchema),
      update: (body) => call("PATCH", "/v1/user-settings", userSettingsSchema, { body }),
    },
    routines: {
      list: async (query) =>
        (
          await call("GET", "/v1/routines", routineListSchema, {
            query: query as Query | undefined,
          })
        ).items,
      get: (routineId) => call("GET", `/v1/routines/${id(routineId)}`, routineSchema),
      create: (body) => call("POST", "/v1/routines", routineSchema, { body }),
      update: (routineId, body) =>
        call("PATCH", `/v1/routines/${id(routineId)}`, routineSchema, { body }),
      delete: async (routineId) => {
        await call("DELETE", `/v1/routines/${id(routineId)}`, deletedSchema, noBody);
      },
      run: async (routineId) =>
        (await call("POST", `/v1/routines/${id(routineId)}/run`, runRoutineResultSchema, noBody))
          .fire,
      fires: async (routineId, query) =>
        (
          await call("GET", `/v1/routines/${id(routineId)}/fires`, routineFireListSchema, {
            query: query as Query | undefined,
          })
        ).items,
    },
    tools: { list: () => call("GET", "/v1/tools", toolListSchema) },
    bots: {
      list: async (query) =>
        (await call("GET", "/v1/bots", botListSchema, { query: query as Query | undefined })).items,
      get: (botId) => call("GET", `/v1/bots/${id(botId)}`, botSchema),
      create: (body) => call("POST", "/v1/bots", botSchema, { body }),
      update: (botId, body) => call("PATCH", `/v1/bots/${id(botId)}`, botSchema, { body }),
      archive: (botId) => call("POST", `/v1/bots/${id(botId)}/archive`, botSchema, noBody),
      setDefault: (botId) => call("POST", `/v1/bots/${id(botId)}/default`, botSchema, noBody),
      openConversation: (botId) =>
        call("POST", `/v1/bots/${id(botId)}/conversation`, conversationSchema, noBody),
      draft: (body) => call("POST", "/v1/bots/draft", botDraftSchema, { body, timeoutMs: 180_000 }),
      startReception: (botId) =>
        call("POST", `/v1/bots/${id(botId)}/reception`, receptionResultSchema, noBody),
      resetReception: async (botId) => {
        await call("POST", `/v1/bots/${id(botId)}/reception/reset`, resetReceptionSchema, noBody);
      },
    },
    conversations: {
      list: async (query) =>
        (
          await call("GET", "/v1/conversations", conversationListSchema, {
            query: query as Query | undefined,
          })
        ).items,
      get: (conversationId) =>
        call("GET", `/v1/conversations/${id(conversationId)}`, conversationSchema),
      messages: (conversationId, query) =>
        call("GET", `/v1/conversations/${id(conversationId)}/messages`, messagePageSchema, {
          query: query as Query | undefined,
        }),
      send: (conversationId, text, options = {}) =>
        call("POST", `/v1/conversations/${id(conversationId)}/messages`, sendMessageResultSchema, {
          body:
            options.routineRef === undefined
              ? { text }
              : { text, routineRef: { id: options.routineRef.id } },
        }),
      dismissQuestion: async (messageId) =>
        (
          await call(
            "POST",
            `/v1/messages/${id(messageId)}/dismiss`,
            z.object({ message: messageSchema }),
            noBody,
          )
        ).message,
      decideTeam: (messageId, body) =>
        call("POST", `/v1/messages/${id(messageId)}/team`, decideTeamResultSchema, {
          body,
          timeoutMs: 60_000,
        }),
      markRead: (conversationId, body = {}) =>
        call("POST", `/v1/conversations/${id(conversationId)}/read`, conversationSchema, { body }),
    },
    runs: {
      list: (query) =>
        call("GET", "/v1/runs", runListSchema, { query: query as Query | undefined }),
      get: (runId) => call("GET", `/v1/runs/${id(runId)}`, runSchema),
      events: (runId, query) =>
        call("GET", `/v1/runs/${id(runId)}/events`, runEventsSchema, {
          query: query === undefined ? undefined : (query as Query),
        }),
      pause: (runId) => call("POST", `/v1/runs/${id(runId)}/pause`, runSchema, noBody),
      interrupt: (runId) => call("POST", `/v1/runs/${id(runId)}/interrupt`, runSchema, noBody),
      cancel: (runId) => call("POST", `/v1/runs/${id(runId)}/cancel`, runSchema, noBody),
      resume: (runId) => call("POST", `/v1/runs/${id(runId)}/resume`, runSchema, noBody),
    },
    memories: {
      list: async (query) =>
        (await call("GET", "/v1/memories", memoryListSchema, { query: query as Query | undefined }))
          .items,
      add: (body) => call("POST", "/v1/memories", memorySchema, { body }),
      edit: (memoryId, text) =>
        call("PATCH", `/v1/memories/${id(memoryId)}`, memorySchema, { body: { text } }),
      archive: (memoryId) =>
        call("POST", `/v1/memories/${id(memoryId)}/archive`, memorySchema, noBody),
      restore: (memoryId) =>
        call("POST", `/v1/memories/${id(memoryId)}/restore`, memorySchema, noBody),
      search: async (query) =>
        (
          await call("GET", "/v1/memories/search", memorySearchSchema, {
            query: query as unknown as Query,
          })
        ).items,
      pending: async () =>
        (
          await call("GET", "/v1/memories", memoryListSchema, {
            query: { status: "pending" } as Query,
          })
        ).items,
      confirm: (memoryId) =>
        call("POST", `/v1/memories/${id(memoryId)}/confirm`, memorySchema, noBody),
      reject: (memoryId) =>
        call("POST", `/v1/memories/${id(memoryId)}/reject`, memorySchema, noBody),
      history: async (memoryId) =>
        (await call("GET", `/v1/memories/${id(memoryId)}/revisions`, memoryRevisionListSchema))
          .items,
      undo: (memoryId, revisionId) =>
        call(
          "POST",
          `/v1/memories/${id(memoryId)}/revisions/${id(revisionId)}/undo`,
          memorySchema,
          noBody,
        ),
      consolidations: async (query) =>
        (
          await call("GET", "/v1/memory-consolidations", memoryConsolidationListSchema, {
            query: query as Query | undefined,
          })
        ).items,
    },
    supervisor: {
      settings: {
        get: () => call("GET", "/v1/supervisor/settings", supervisorSettingsSchema),
        update: (body) =>
          call("PATCH", "/v1/supervisor/settings", supervisorSettingsSchema, { body }),
      },
      reviews: async (query) =>
        (
          await call("GET", "/v1/supervisor/reviews", teamReviewListSchema, {
            query: query as Query | undefined,
          })
        ).items,
    },
    memorySettings: {
      get: () => call("GET", "/v1/memory-settings", memorySettingsSchema),
      update: (body) => call("PATCH", "/v1/memory-settings", memorySettingsSchema, { body }),
    },
    search: {
      messages: async (query) =>
        (
          await call("GET", "/v1/messages/search", messageSearchSchema, {
            query: query as unknown as Query,
          })
        ).items,
    },
    diagnostics: {
      request: (runId, seq) =>
        call("GET", `/v1/runs/${id(runId)}/requests/${seq}`, modelRequestSchema),
      replay: (runId) =>
        call("POST", `/v1/runs/${id(runId)}/replay`, replaySchema, {
          ...noBody,
          timeoutMs: 180_000,
        }),
      resend: (runId, body, signal) =>
        call("POST", `/v1/runs/${id(runId)}/resend`, resendSchema, {
          body,
          timeoutMs: 600_000,
          ...(signal === undefined ? {} : { signal }),
        }),
      doctor: (opts = {}) =>
        call("GET", "/v1/doctor", doctorSchema, {
          query: opts.live === undefined ? undefined : { live: opts.live },
          timeoutMs: 180_000,
        }),
    },
    subscribe: (subscribeOptions) =>
      subscribe({ baseUrl, token: options.token, fetch: doFetch }, subscribeOptions),
    approvals: {
      list: async (query) =>
        (
          await call("GET", "/v1/approvals", approvalListSchema, {
            query: query as Query | undefined,
          })
        ).items,
      get: (approvalId) => call("GET", `/v1/approvals/${id(approvalId)}`, approvalSchema),
      decide: (approvalId, body) =>
        call("POST", `/v1/approvals/${id(approvalId)}/decision`, decideApprovalResultSchema, {
          body,
        }),
    },
    rules: {
      list: async (query) =>
        (
          await call("GET", "/v1/approval-rules", ruleListSchema, {
            query: query as Query | undefined,
          })
        ).items,
      create: (body) => call("POST", "/v1/approval-rules", ruleSchema, { body }),
      update: (ruleId, body) =>
        call("PATCH", `/v1/approval-rules/${id(ruleId)}`, ruleSchema, { body }),
      remove: async (ruleId) => {
        await call("DELETE", `/v1/approval-rules/${id(ruleId)}`, deletedSchema);
      },
    },
    approvalSettings: {
      get: () => call("GET", "/v1/approval-settings", approvalSettingsSchema),
      update: (body) => call("PATCH", "/v1/approval-settings", approvalSettingsSchema, { body }),
    },
    writtenRules: {
      list: async (query) =>
        (
          await call("GET", "/v1/written-rules", writtenRuleListSchema, {
            query: query as Query | undefined,
          })
        ).items,
      create: (body) => call("POST", "/v1/written-rules", writtenRuleSchema, { body }),
      update: (ruleId, body) =>
        call("PATCH", `/v1/written-rules/${id(ruleId)}`, writtenRuleSchema, { body }),
      remove: async (ruleId) => {
        await call("DELETE", `/v1/written-rules/${id(ruleId)}`, deletedSchema);
      },
    },
    connectors: {
      list: async () => (await call("GET", "/v1/connectors", connectorListSchema)).items,
      get: (name) => call("GET", `/v1/connectors/${id(name)}`, connectorSchema),
      create: (body) => call("POST", "/v1/connectors", connectorSchema, { body }),
      update: (name, body) =>
        call("PATCH", `/v1/connectors/${id(name)}`, connectorSchema, { body }),
      remove: async (name) => {
        await call("DELETE", `/v1/connectors/${id(name)}`, deletedSchema);
      },
      grant: (name, botId, body) =>
        call("PUT", `/v1/connectors/${id(name)}/grants/${id(botId)}`, connectorSchema, { body }),
      review: async (name) =>
        (await call("GET", `/v1/connectors/${id(name)}/review`, connectorReviewListSchema)).items,
      approveTool: (name, tool, body) =>
        call("POST", `/v1/connectors/${id(name)}/tools/${id(tool)}/review`, connectorSchema, {
          body,
        }),
      events: async (name) =>
        (await call("GET", `/v1/connectors/${id(name)}/events`, connectorToolEventListSchema))
          .items,
      revoke: (name, botId) =>
        call("DELETE", `/v1/connectors/${id(name)}/grants/${id(botId)}`, connectorSchema),
      setToolRisk: (name, tool, body) =>
        call("PUT", `/v1/connectors/${id(name)}/tools/${id(tool)}/risk`, connectorSchema, {
          body,
        }),
      setToolOutbound: (name, tool, body) =>
        call("PUT", `/v1/connectors/${id(name)}/tools/${id(tool)}/outbound`, connectorSchema, {
          body,
        }),
      test: (name) => call("POST", `/v1/connectors/${id(name)}/test`, connectorTestSchema, noBody),
      oauthStart: (name) =>
        call("POST", `/v1/connectors/${id(name)}/oauth/start`, oauthStartSchema, noBody),
      oauthStatus: (name) =>
        call("GET", `/v1/connectors/${id(name)}/oauth/status`, oauthStatusSchema),
      oauthDisconnect: (name) =>
        call("DELETE", `/v1/connectors/${id(name)}/oauth`, connectorSchema),
    },
    connectorCatalog: {
      list: async () => (await call("GET", "/v1/connector-catalog", catalogListSchema)).items,
      install: (catalogId) =>
        call("POST", `/v1/connector-catalog/${id(catalogId)}/install`, installResultSchema, noBody),
      setToken: async (catalogId, value) => {
        await call(
          "PUT",
          `/v1/connector-catalog/${id(catalogId)}/token`,
          pluginCredentialStoredSchema,
          { body: { value } },
        );
      },
      removeToken: async (catalogId) => {
        await call("DELETE", `/v1/connector-catalog/${id(catalogId)}/token`, deletedSchema);
      },
    },
    network: {
      forBot: (botId) => call("GET", `/v1/bots/${id(botId)}/network`, botNetworkSchema),
      allow: (botId, host) =>
        call("PUT", `/v1/bots/${id(botId)}/network/hosts/${id(host)}`, botNetworkSchema, noBody),
      remove: (botId, host) =>
        call("DELETE", `/v1/bots/${id(botId)}/network/hosts/${id(host)}`, botNetworkSchema),
    },
    files: {
      url: (fileId) => `${baseUrl}/v1/files/${id(fileId)}`,
      download: (fileId, signal) => download(`/v1/files/${id(fileId)}`, signal),
    },
    webSearch: {
      get: () => call("GET", "/v1/web-search", webSearchSchema),
      setKey: async (engineId, value) => {
        await call(
          "PUT",
          `/v1/web-search/providers/${id(engineId)}/key`,
          pluginCredentialStoredSchema,
          { body: { value } },
        );
      },
      removeKey: async (engineId) => {
        await call("DELETE", `/v1/web-search/providers/${id(engineId)}/key`, deletedSchema);
      },
    },
    vault: {
      status: () => call("GET", "/v1/vault", vaultStatusSchema),
      list: async () => (await call("GET", "/v1/secrets", secretListSchema)).items,
      set: (name, body) => call("PUT", `/v1/secrets/${id(name)}`, secretSchema, { body }),
      remove: async (name) => {
        await call("DELETE", `/v1/secrets/${id(name)}`, deletedSchema);
      },
      grant: (name, botId) =>
        call("PUT", `/v1/secrets/${id(name)}/grants/${id(botId)}`, secretSchema, noBody),
      revoke: (name, botId) =>
        call("DELETE", `/v1/secrets/${id(name)}/grants/${id(botId)}`, secretSchema),
      request: async (runId) =>
        (await call("GET", `/v1/runs/${id(runId)}/secret-request`, secretRequestAnswerSchema))
          .request,
      answerRequest: (runId, body) =>
        call(
          "POST",
          `/v1/runs/${id(runId)}/secret-request/answer`,
          answerSecretRequestResultSchema,
          { body },
        ),
    },
  };
}

export type { ErrorCode };
