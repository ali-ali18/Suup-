import {
  ApiError,
  type Approval,
  type ApprovalRule,
  type Bot,
  type BotNetwork,
  type Connector,
  type Conversation,
  type DecideApprovalBody,
  type Message,
  type Run,
  type Secret,
  type StreamEvent,
  type Subscription,
  type SuupClient,
  type Task,
  type WrittenRule,
} from "@suup/api";
import { formError, friendlyError } from "../lib/friendly-error.js";
import { expireLive, nextLiveExpiry } from "./live.js";
import {
  addOptimisticMessage,
  applyStreamEvent,
  contiguousSeq,
  isTerminal,
  mergeApproval,
  mergeApprovals,
  mergeBot,
  mergeConnector,
  mergeConversation,
  mergeConversations,
  mergeMemory,
  mergeMessagePage,
  mergeRule,
  mergeRun,
  mergeRunEvents,
  mergeRuns,
  mergeSecret,
  mergeTask,
  mergeTasks,
  mergeWrittenRule,
  removeConnector,
  removeRule,
  removeSecret,
  removeWrittenRule,
  resolveOptimisticMessage,
  rollbackOptimisticMessage,
  setBotNetwork,
  setBots,
  setConnection,
  setConnectors,
  setMemories,
  setPendingMemories,
  setRules,
  setSecrets,
  setVaultStatus,
  setWrittenRules,
  stalePendingIds,
  stalePendingMemoryIds,
  upsertMessage,
} from "./reducers.js";
import { type DataStore, update } from "./store.js";

export interface SyncNotice {
  kind: "question" | "approval" | "done" | "failed";
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

/**
 * What the person reads when a call fails: a friendly sentence by the KIND of the error, never the
 * server's raw text (docs/DESIGN.md, "Amigável"; `lib/friendly-error.ts`).
 */
export const messageOf = friendlyError;

const EVENT_PAGE = 500;

/** What happened to a decision the person made on an approval card. Nothing is shown before it. */
export type DecideOutcome =
  /** The server confirmed (`rule` is the rule an "always allow" created). */
  | { ok: true; approval: Approval; rule: ApprovalRule | null }
  /** The card was already decided (or cancelled, or expired) somewhere else; `approval` is how it is now. */
  | { ok: false; reason: "decided_elsewhere"; approval: Approval | undefined }
  /** A decision on this card is already on its way. */
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "error"; message: string };

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
  /** Cards whose decision is on its way (a card is decided once: no second request meanwhile). */
  private readonly deciding = new Set<string>();

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
    if (this.liveTimer !== undefined) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
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
        void this.shareDeviceTimeZone();
      }
      return;
    }
    if (event.type === "resync") {
      void this.reload();
      return;
    }
    this.notify(event);
    update(this.store, (s) => applyStreamEvent(s, event));
    this.scheduleLiveExpiry();
  }

  private liveTimer: ReturnType<typeof setTimeout> | undefined;

  /** Wakes up when the next typed bubble without a recorded message runs out of time. */
  private scheduleLiveExpiry(): void {
    const at = nextLiveExpiry(this.store.getState());
    if (this.liveTimer !== undefined) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    if (at === undefined) return;
    this.liveTimer = setTimeout(
      () => {
        this.liveTimer = undefined;
        update(this.store, (s) => expireLive(s, Date.now()));
        this.scheduleLiveExpiry();
      },
      Math.max(0, at - Date.now()),
    );
  }

  /** What a bot-side event means for someone who is not looking: only questions and endings. */
  private notify(event: StreamEvent): void {
    const state = this.store.getState();
    if (event.type === "approval.changed") {
      const card = event.data.approval;
      if (card.status === "pending" && state.approvals[card.id] === undefined) {
        this.deps.onNotice?.({ kind: "approval", botId: card.botId, text: card.summary });
      }
    } else if (event.type === "message.created") {
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
      // A task ends in its own view and in the chat's closing turn: that turn is what notifies.
      if (
        run.origin !== "task" &&
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

  /**
   * Tells the server the time zone of THIS computer (docs/ROTINAS.md): the user's routines and "now"
   * are in the user's zone, never the server's, which may run on a VPS in UTC. It only fills the
   * blank (or follows the computer): a zone the user chose in Configurações is never replaced.
   */
  async shareDeviceTimeZone(): Promise<void> {
    try {
      const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof timeZone !== "string" || timeZone === "") return;
      await this.deps.api.userSettings.update({ timeZone, source: "device" });
    } catch {
      // an older server, or a zone it does not know: Configurações > Geral lets the user choose
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
      this.loadPendingMemories(),
      this.loadPendingApprovals(),
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

  /** "Refazer a recepção": the worker starts the welcome again. */
  async resetReception(bot: Bot): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.deps.api.bots.resetReception(bot.id);
      if (bot.conversationId !== null) await this.refreshConversationRow(bot.conversationId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: friendlyError(error),
      };
    }
  }

  /**
   * The user's decision on a team card. Nothing is optimistic: the card changes when the server
   * answers (the bots it created are merged at once; the stream says the same later).
   */
  async decideTeam(
    messageId: string,
    body: Parameters<SuupClient["conversations"]["decideTeam"]>[1],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const result = await this.deps.api.conversations.decideTeam(messageId, body);
      update(this.store, (s) => upsertMessage(s, result.message));
      for (const bot of result.bots) update(this.store, (s) => mergeBot(s, bot));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: friendlyError(error),
      };
    }
  }

  /**
   * The X of a question card: the server locks the card ("Não respondido") and tells the run. The
   * card changes when the server answers (nothing optimistic); a refusal is one friendly sentence.
   */
  async dismissQuestion(messageId: string): Promise<void> {
    try {
      const message = await this.deps.api.conversations.dismissQuestion(messageId);
      update(this.store, (s) => upsertMessage(s, message));
    } catch (error) {
      this.deps.onError?.(friendlyError(error));
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
      this.loadConversationApprovals(conversationId),
      this.loadConversationTasks(conversationId),
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

  /** The tasks asked in a chat (KOD-68): their labels and their state. */
  async loadConversationTasks(conversationId: string): Promise<void> {
    try {
      const items = await this.deps.api.tasks.list({ conversationId });
      update(this.store, (s) => mergeTasks(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * What the person wrote in a task's own view: it goes straight to the task. The message shows at
   * once as sending, and is replaced by the stored one; a refusal brings the text back.
   */
  async replyToTask(task: Task, text: string): Promise<{ ok: true } | { ok: false; text: string }> {
    const tempId = crypto.randomUUID();
    update(this.store, (s) =>
      addOptimisticMessage(s, {
        tempId,
        conversationId: task.taskConversationId,
        text,
        now: new Date().toISOString(),
      }),
    );
    try {
      const result = await this.deps.api.tasks.reply(task.id, text);
      update(this.store, (s) =>
        mergeTask(resolveOptimisticMessage(s, tempId, result.message), result.task),
      );
      return { ok: true };
    } catch (error) {
      update(this.store, (s) => rollbackOptimisticMessage(s, task.taskConversationId, tempId));
      this.fail(error);
      return { ok: false, text };
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
  /**
   * `options.routineRef`: the routine the message is about (the "Editar" of a routine): data, never
   * text. `options.questionRef`: the question card the message answers (an option was clicked): the
   * answer then shows only on that card, from the first moment (the message being sent too).
   */
  async send(
    conversationId: string,
    text: string,
    options: { routineRef?: { id: string }; questionRef?: { id: string } } = {},
  ): Promise<{ ok: true; run: Run; message: Message } | { ok: false; text: string }> {
    const tempId = crypto.randomUUID();
    update(this.store, (s) =>
      addOptimisticMessage(s, {
        tempId,
        conversationId,
        text,
        now: new Date().toISOString(),
        ...(options.questionRef === undefined ? {} : { questionRef: options.questionRef }),
      }),
    );
    try {
      const result = await this.deps.api.conversations.send(conversationId, text, {
        ...(options.routineRef === undefined ? {} : { routineRef: options.routineRef }),
        ...(options.questionRef === undefined ? {} : { questionRef: options.questionRef }),
      });
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

  // -------------------------------------------------------------- approvals

  /**
   * Every card waiting for the person, of every bot. A card the app held as pending that is not in
   * the list was decided somewhere else (the list cannot say how), so each of those is read by id.
   */
  async loadPendingApprovals(): Promise<void> {
    try {
      const items = await this.deps.api.approvals.list({ status: "pending", limit: 200 });
      const stale = stalePendingIds(this.store.getState(), items);
      update(this.store, (s) => mergeApprovals(s, items));
      await Promise.all(stale.map((id) => this.loadApproval(id)));
    } catch (error) {
      this.fail(error);
    }
  }

  /** The cards of a conversation (decided ones too): what the chat draws among its messages. */
  async loadConversationApprovals(conversationId: string): Promise<void> {
    try {
      const items = await this.deps.api.approvals.list({ conversationId, limit: 200 });
      update(this.store, (s) => mergeApprovals(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  async loadApproval(id: string): Promise<Approval | undefined> {
    try {
      const card = await this.deps.api.approvals.get(id);
      update(this.store, (s) => mergeApproval(s, card));
      return this.store.getState().approvals[id];
    } catch {
      return undefined;
    }
  }

  /**
   * Sends the person's decision. Not optimistic: the store changes only with what the server
   * answers (or, when the card turns out to have been decided elsewhere, with how it stands now).
   */
  async decideApproval(id: string, body: DecideApprovalBody): Promise<DecideOutcome> {
    if (this.deciding.has(id)) return { ok: false, reason: "busy" };
    this.deciding.add(id);
    try {
      const result = await this.deps.api.approvals.decide(id, body);
      update(this.store, (s) => {
        const next = mergeApproval(s, result.approval);
        return result.rule === null ? next : mergeRule(next, result.rule);
      });
      return { ok: true, approval: result.approval, rule: result.rule };
    } catch (error) {
      if (error instanceof ApiError && (error.code === "conflict" || error.code === "not_found")) {
        const approval = await this.loadApproval(id);
        return { ok: false, reason: "decided_elsewhere", approval };
      }
      return { ok: false, reason: "error", message: messageOf(error) };
    } finally {
      this.deciding.delete(id);
    }
  }

  // --------------------------------------------- rules, vault and connectors
  // No stream frame for these: the screen reads them when it opens, and the server answers each write
  // with the new row (merged here), so nothing is guessed.

  async loadRules(): Promise<void> {
    try {
      const items = await this.deps.api.rules.list();
      update(this.store, (s) => setRules(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Runs a write that answers with the rule, merges it, and says whether it worked (the error is shown by the caller). */
  async ruleCall(
    call: () => Promise<ApprovalRule>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const rule = await call();
      update(this.store, (s) => mergeRule(s, rule));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: formError(error) };
    }
  }

  async deleteRule(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.deps.api.rules.remove(id);
      update(this.store, (s) => removeRule(s, id));
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        update(this.store, (s) => removeRule(s, id));
        return { ok: true };
      }
      return { ok: false, message: messageOf(error) };
    }
  }

  async loadWrittenRules(): Promise<void> {
    try {
      const items = await this.deps.api.writtenRules.list();
      update(this.store, (s) => setWrittenRules(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Runs a write that answers with the written rule, merges it, and says whether it worked (the server's message is shown by the caller). */
  async writtenRuleCall(
    call: () => Promise<WrittenRule>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const rule = await call();
      update(this.store, (s) => mergeWrittenRule(s, rule));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: formError(error) };
    }
  }

  async deleteWrittenRule(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.deps.api.writtenRules.remove(id);
      update(this.store, (s) => removeWrittenRule(s, id));
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        update(this.store, (s) => removeWrittenRule(s, id));
        return { ok: true };
      }
      return { ok: false, message: messageOf(error) };
    }
  }

  async loadVault(): Promise<void> {
    try {
      const [status, items] = await Promise.all([
        this.deps.api.vault.status(),
        this.deps.api.vault.list(),
      ]);
      update(this.store, (s) => setSecrets(setVaultStatus(s, status), items));
    } catch (error) {
      this.fail(error);
    }
  }

  /** Merges the metadata of a secret the screen just wrote (never a value: the API has none). */
  mergeSecretNow(secret: Secret): void {
    update(this.store, (s) => mergeSecret(s, secret));
  }

  async secretCall(
    call: () => Promise<Secret>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      this.mergeSecretNow(await call());
      return { ok: true };
    } catch (error) {
      return { ok: false, message: formError(error) };
    }
  }

  async deleteSecret(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.deps.api.vault.remove(name);
      update(this.store, (s) => removeSecret(s, name));
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        update(this.store, (s) => removeSecret(s, name));
        return { ok: true };
      }
      return { ok: false, message: messageOf(error) };
    }
  }

  async loadConnectors(): Promise<void> {
    try {
      const items = await this.deps.api.connectors.list();
      update(this.store, (s) => setConnectors(s, items));
    } catch (error) {
      this.fail(error);
    }
  }

  async connectorCall(
    call: () => Promise<Connector>,
  ): Promise<{ ok: true; connector: Connector } | { ok: false; message: string }> {
    try {
      const connector = await call();
      update(this.store, (s) => mergeConnector(s, connector));
      return { ok: true, connector };
    } catch (error) {
      return { ok: false, message: formError(error) };
    }
  }

  async deleteConnector(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.deps.api.connectors.remove(name);
      update(this.store, (s) => removeConnector(s, name));
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        update(this.store, (s) => removeConnector(s, name));
        return { ok: true };
      }
      return { ok: false, message: messageOf(error) };
    }
  }

  // ---------------------------------------------------- network of a bot's machine
  // No stream frame either: the server answers a read and every write with the whole view of the
  // bot, which replaces what the store held. The error of a refused write is the server's message.

  async loadBotNetwork(botId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.networkCall(botId, () => this.deps.api.network.forBot(botId));
  }

  async networkCall(
    botId: string,
    call: () => Promise<BotNetwork>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const network = await call();
      update(this.store, (s) => setBotNetwork(s, botId, network));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: formError(error) };
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

  /**
   * What waits for the user's confirmation, from every bot (the chat and Pendências draw it). A
   * memory held as pending that the list no longer has was decided somewhere else: read again.
   */
  async loadPendingMemories(): Promise<void> {
    try {
      const items = await this.deps.api.memories.pending();
      const stale = stalePendingMemoryIds(this.store.getState(), items);
      update(this.store, (s) => setPendingMemories(s, items));
      if (stale.length === 0) return;
      const [active, rejected] = await Promise.all([
        this.deps.api.memories.list({ includeArchived: true, limit: 1000 }),
        this.deps.api.memories.list({ status: "rejected", limit: 1000 }),
      ]);
      update(this.store, (s) => {
        let next = s;
        for (const memory of [...active, ...rejected])
          if (stale.includes(memory.id)) next = mergeMemory(next, memory);
        return next;
      });
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Confirms or refuses a pending memory. Not optimistic: the store changes with what the server
   * answers. A `409` (already decided elsewhere) reads the lists again and says so.
   */
  async decideMemory(
    id: string,
    decision: "confirm" | "reject",
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const memory =
        decision === "confirm"
          ? await this.deps.api.memories.confirm(id)
          : await this.deps.api.memories.reject(id);
      update(this.store, (s) => mergeMemory(s, memory));
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") {
        await this.loadPendingMemories();
        return { ok: false, message: "Esta memória já tinha sido decidida em outro lugar." };
      }
      return { ok: false, message: messageOf(error) };
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

  /** Merges a memory the screen got from a REST call (an undo): idempotent with the stream. */
  mergeMemoryNow(memory: import("@suup/api").Memory): void {
    update(this.store, (s) => mergeMemory(s, memory));
  }

  /** Merges a message the screen got from a REST call (idempotent with the stream). */
  mergeMessageNow(message: Message): void {
    update(this.store, (s) => upsertMessage(s, message));
  }
}
