import {
  ApiError,
  type Bot,
  type Conversation,
  type Message,
  type Run,
  type StreamEvent,
  type Subscription,
  type SuupClient,
} from "@suup/api";
import {
  addOptimisticMessage,
  applyStreamEvent,
  contiguousSeq,
  isTerminal,
  mergeBot,
  mergeConversation,
  mergeConversations,
  mergeMemory,
  mergeMessagePage,
  mergeRun,
  mergeRunEvents,
  mergeRuns,
  resolveOptimisticMessage,
  rollbackOptimisticMessage,
  setBots,
  setConnection,
  setMemories,
  upsertMessage,
} from "./reducers.js";
import { type DataStore, update } from "./store.js";

export interface SyncNotice {
  kind: "question" | "done" | "failed";
  botId: string | null;
  text: string;
}

export interface SyncDeps {
  api: SuupClient;
  store: DataStore;
  /** An error the person should see (a failed action). */
  onError?(message: string): void;
  /** Something the person may want to know while away (the caller decides whether to show it). */
  onNotice?(notice: SyncNotice): void;
  /** The server refused the stream for good: the saved connection is no good. */
  onRefused?(error: ApiError | undefined): void;
  backoff?: { minMs?: number; maxMs?: number };
  pageSize?: number;
}

export const messageOf = (error: unknown): string =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "Algo deu errado.";

const EVENT_PAGE = 500;

/**
 * Keeps the store equal to the server: stream first, REST after, reconnects, resync. The screen
 * tells it what it is looking at (`watchConversation`, `follow`) and reads the store; it never
 * touches the network itself.
 */
export class Sync {
  private sub: Subscription | undefined;
  private readonly watched = new Set<string>();
  private followed: string[] = [];
  private memoryWatched = false;
  private opened = false;
  private stopped = false;
  private readonly pageSize: number;
  /** Event loads in flight, so two callers do not fetch the same run at once. */
  private readonly loading = new Map<string, Promise<void>>();
  private readyWaiters: ((ok: boolean) => void)[] = [];

  constructor(private readonly deps: SyncDeps) {
    this.pageSize = deps.pageSize ?? 50;
  }

  private get store(): DataStore {
    return this.deps.store;
  }

  private fail(error: unknown): void {
    this.deps.onError?.(messageOf(error));
  }

  // ----------------------------------------------------------------- stream

  /** Opens the stream; resolves true on the first `ready`, false if the server refuses. */
  start(): Promise<boolean> {
    this.stopped = false;
    update(this.store, (s) => setConnection(s, { phase: "connecting" }));
    const first = new Promise<boolean>((resolve) => this.readyWaiters.push(resolve));
    this.sub = this.deps.api.subscribe({
      runs: this.followed,
      ...(this.deps.backoff === undefined ? {} : { backoff: this.deps.backoff }),
      onEvent: (event) => this.onStreamEvent(event),
      onStatus: (status, detail) => {
        if (this.stopped) return;
        if (status === "reconnecting" || status === "connecting") {
          update(this.store, (s) =>
            s.connection.phase === "online" || s.connection.phase === "reconnecting"
              ? setConnection(s, { phase: "reconnecting" })
              : setConnection(s, { phase: "connecting" }),
          );
        } else if (status === "closed") {
          update(this.store, (s) =>
            setConnection(s, {
              phase: "refused",
              ...(detail === undefined ? {} : { detail }),
            }),
          );
        }
      },
      onClose: (error) => {
        this.settleReady(false);
        if (!this.stopped) this.deps.onRefused?.(error);
      },
    });
    return first;
  }

  stop(): void {
    this.stopped = true;
    this.sub?.close();
    this.sub = undefined;
    this.settleReady(false);
    update(this.store, (s) => setConnection(s, { phase: "offline" }));
  }

  private settleReady(ok: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const resolve of waiters) resolve(ok);
  }

  private onStreamEvent(event: StreamEvent): void {
    if (event.type === "ready") {
      update(this.store, (s) => setConnection(s, { phase: "online" }));
      this.settleReady(true);
      // The first connection: load what is on screen. A reconnection that resumed loses nothing;
      // one that could not is followed by a `resync` frame.
      if (!this.opened) {
        this.opened = true;
        void this.reload();
      }
      return;
    }
    if (event.type === "resync") {
      void this.reload();
      return;
    }
    this.notify(event);
    update(this.store, (s) => applyStreamEvent(s, event));
  }

  /** What a bot-side event means for someone who is not looking: only questions and endings. */
  private notify(event: StreamEvent): void {
    const state = this.store.getState();
    if (event.type === "message.created") {
      const m = event.data.message;
      if (m.authorKind === "bot" && m.question !== undefined) {
        this.deps.onNotice?.({
          kind: "question",
          botId: m.authorBotId,
          text: m.text,
        });
      }
    } else if (event.type === "run.updated") {
      const run = event.data.run;
      const before = state.runs[run.id];
      if (
        before !== undefined &&
        !isTerminal(before.status) &&
        (run.status === "done" || run.status === "failed")
      ) {
        this.deps.onNotice?.({
          kind: run.status === "done" ? "done" : "failed",
          botId: run.botId,
          text: run.status === "done" ? (run.result?.summary ?? run.objective) : run.objective,
        });
      }
    }
  }

  /** Reloads what is on screen: after the first connection and after a `resync`. */
  async reload(): Promise<void> {
    await Promise.all([
      this.loadBots(),
      this.loadConversations(),
      this.loadRecentRuns(),
      ...[...this.watched].map((id) => this.refreshConversation(id)),
      ...this.followed.map((id) => this.loadRunEvents(id)),
      this.memoryWatched ? this.loadMemories() : Promise.resolve(),
    ]);
  }

  // ------------------------------------------------------------------- reads

  async loadBots(): Promise<void> {
    try {
      const bots = await this.deps.api.bots.list();
      update(this.store, (s) => setBots(s, bots));
      // The bot's latest run is part of the list: keep the run table in step.
    } catch (error) {
      this.fail(error);
    }
  }

  async loadConversations(): Promise<void> {
    try {
      const items = await this.deps.api.conversations.list();
      update(this.store, (s) => mergeConversations(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  async loadRecentRuns(): Promise<void> {
    try {
      const page = await this.deps.api.runs.list({ limit: 100 });
      update(this.store, (s) => mergeRuns(s, page.items));
    } catch (error) {
      this.fail(error);
    }
  }

  /** The bot's direct conversation, created at the first call. */
  async openBotConversation(bot: Bot): Promise<Conversation | undefined> {
    const known =
      bot.conversationId === null
        ? undefined
        : this.store.getState().conversations[bot.conversationId];
    if (known !== undefined) return known;
    try {
      const conversation = await this.deps.api.bots.openConversation(bot.id);
      update(this.store, (s) => mergeConversation(s, conversation));
      return conversation;
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  /** From now on the conversation is on screen: fetch it and keep it fresh on `resync`. */
  async watchConversation(conversationId: string): Promise<void> {
    this.watched.add(conversationId);
    await this.refreshConversation(conversationId);
  }

  unwatchConversation(conversationId: string): void {
    this.watched.delete(conversationId);
  }

  private async refreshConversation(conversationId: string): Promise<void> {
    await Promise.all([
      this.loadNewestMessages(conversationId),
      this.loadConversationRuns(conversationId),
      this.refreshConversationRow(conversationId),
    ]);
  }

  private async refreshConversationRow(conversationId: string): Promise<void> {
    try {
      const conversation = await this.deps.api.conversations.get(conversationId);
      update(this.store, (s) => mergeConversation(s, conversation));
    } catch (error) {
      this.fail(error);
    }
  }

  async loadNewestMessages(conversationId: string): Promise<void> {
    try {
      const page = await this.deps.api.conversations.messages(conversationId, {
        limit: this.pageSize,
      });
      update(this.store, (s) =>
        mergeMessagePage(s, conversationId, page.items, page.hasMore, "newest"),
      );
    } catch (error) {
      this.fail(error);
    }
  }

  /** Scrolling up: the page before the oldest message held. Returns whether there was more. */
  async loadOlderMessages(conversationId: string): Promise<boolean> {
    const slice = this.store.getState().messages[conversationId];
    if (slice === undefined || !slice.hasOlder) return false;
    const oldest = Object.values(slice.byId)
      .filter((m) => m.local === undefined)
      .reduce<number | undefined>(
        (min, m) => (min === undefined || m.seq < min ? m.seq : min),
        undefined,
      );
    if (oldest === undefined) return false;
    try {
      const page = await this.deps.api.conversations.messages(conversationId, {
        before: oldest,
        limit: this.pageSize,
      });
      update(this.store, (s) =>
        mergeMessagePage(s, conversationId, page.items, page.hasMore, "older"),
      );
      return page.items.length > 0;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async loadConversationRuns(conversationId: string): Promise<void> {
    try {
      const page = await this.deps.api.runs.list({ conversationId, limit: 50 });
      update(this.store, (s) => mergeRuns(s, page.items));
    } catch (error) {
      this.fail(error);
    }
  }

  async loadRun(runId: string): Promise<Run | undefined> {
    try {
      const run = await this.deps.api.runs.get(runId);
      update(this.store, (s) => mergeRun(s, run));
      return this.store.getState().runs[runId];
    } catch (error) {
      this.fail(error);
      return undefined;
    }
  }

  /**
   * The runs whose events the screen draws. The stream is told first, then what is missing is read
   * by REST; an event that arrives by both ways is one event (they are keyed by `seq`).
   */
  follow(runIds: readonly string[]): void {
    const next = [...new Set(runIds)];
    const same =
      next.length === this.followed.length && next.every((id) => this.followed.includes(id));
    this.followed = next;
    if (!same) this.sub?.setRuns(next);
    for (const id of next) void this.loadRunEvents(id);
  }

  /** Reads the events from the first one not held, page by page, until the end. */
  loadRunEvents(runId: string, view: "chat" | "full" = "chat"): Promise<void> {
    const key = `${runId}:${view}`;
    const running = this.loading.get(key);
    if (running !== undefined) return running;
    const job = (async () => {
      try {
        for (;;) {
          const slice = this.store.getState().events[runId];
          const page = await this.deps.api.runs.events(runId, {
            afterSeq: contiguousSeq(slice),
            limit: EVENT_PAGE,
            view,
          });
          update(this.store, (s) =>
            mergeRunEvents(s, runId, page.items, { loaded: !page.hasMore }),
          );
          if (!page.hasMore || page.items.length === 0) break;
        }
        update(this.store, (s) => mergeRunEvents(s, runId, [], { loaded: true }));
      } catch (error) {
        this.fail(error);
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, job);
    return job;
  }

  // --------------------------------------------------------------- actions

  /**
   * Sends a message: it appears at once and is confirmed (or taken back) when the server answers.
   * Returns the text to give back to the composer when the server refused.
   */
  async send(
    conversationId: string,
    text: string,
  ): Promise<{ ok: true; run: Run; message: Message } | { ok: false; text: string }> {
    const tempId = crypto.randomUUID();
    update(this.store, (s) =>
      addOptimisticMessage(s, { tempId, conversationId, text, now: new Date().toISOString() }),
    );
    try {
      const result = await this.deps.api.conversations.send(conversationId, text);
      update(this.store, (s) =>
        mergeRun(resolveOptimisticMessage(s, tempId, result.message), result.run),
      );
      return { ok: true, run: result.run, message: result.message };
    } catch (error) {
      update(this.store, (s) => rollbackOptimisticMessage(s, conversationId, tempId));
      this.fail(error);
      return { ok: false, text };
    }
  }

  async runAction(
    runId: string,
    action: "pause" | "interrupt" | "cancel" | "resume",
  ): Promise<boolean> {
    try {
      const run = await this.deps.api.runs[action](runId);
      update(this.store, (s) => mergeRun(s, run));
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async markRead(conversationId: string, upToSeq?: number): Promise<void> {
    try {
      const conversation = await this.deps.api.conversations.markRead(
        conversationId,
        upToSeq === undefined ? {} : { upToSeq },
      );
      update(this.store, (s) => mergeConversation(s, conversation));
    } catch (error) {
      this.fail(error);
    }
  }

  // ----------------------------------------------------------------- memory

  async loadMemories(): Promise<void> {
    this.memoryWatched = true;
    try {
      const items = await this.deps.api.memories.list({ includeArchived: true, limit: 1000 });
      update(this.store, (s) => setMemories(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  unwatchMemories(): void {
    this.memoryWatched = false;
  }

  async memoryCall(call: () => Promise<import("@suup/api").Memory>): Promise<boolean> {
    try {
      const memory = await call();
      update(this.store, (s) => mergeMemory(s, memory));
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  // ------------------------------------------------------------------- bots

  /** Merges a bot the screen just created or edited (the stream says it too; same data). */
  mergeBotNow(bot: Bot): void {
    update(this.store, (s) => mergeBot(s, bot));
  }

  /** Merges a message the screen got from a REST call (idempotent with the stream). */
  mergeMessageNow(message: Message): void {
    update(this.store, (s) => upsertMessage(s, message));
  }
}
