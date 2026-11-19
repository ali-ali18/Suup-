import {
  askForcedTool,
  buildConsolidationMessage,
  CONSOLIDATION_MAX_OUTPUT_TOKENS,
  CONSOLIDATION_PROMPT_VERSION,
  CONSOLIDATION_SYSTEM_PROMPT,
  CONSOLIDATION_TIMEOUT_MS,
  CONSOLIDATION_TOOL_SPEC,
  type DroppedProposal,
  type ForcedCallModel,
  type KnownMemory,
  type Provider,
  readProposalItems,
  type VerifiedProposal,
  verifyProposals,
} from "@suup/core";
import {
  addMemory,
  type Consolidation,
  claimConsolidation,
  consolidationWindow,
  type Db,
  expireUnusedMemories,
  findMemoriesWithText,
  finishConsolidation,
  getMemory,
  getMemorySettings,
  lockOwnConsolidation,
  type Memory,
  type MemoryOrigin,
  memoriesVisibleTo,
  promoteToProfile,
  requestConsolidation,
  updateMemory,
  type VisibleMemory,
  withTransaction,
} from "@suup/db";

/** How long a worker owns a consolidation without finishing it (the model call is capped at 60 s). */
export const CONSOLIDATION_LEASE_MS = 5 * 60_000;

export interface ConsolidationDeps {
  db: Db;
  workerId: string;
  provider: Provider;
  model: ForcedCallModel;
  now?: () => Date;
  /** Told about every outcome, including failures (nothing is written on a failure). */
  log?: (message: string) => void;
}

/** What one consolidation did, as it is recorded in `memory_consolidations.kept`. */
export interface KeptItem {
  action: "added" | "updated" | "proposed" | "promoted";
  layer: "rule" | "profile" | "note";
  memoryId: string;
  status: "active" | "pending";
  text: string;
  quote: string;
  messageId: string;
}

export interface ConsolidationOutcome {
  consolidation: Consolidation;
  status: "done" | "skipped" | "failed" | "lost";
  kept: KeptItem[];
  dropped: DroppedProposal[];
}

const toKnown = (m: VisibleMemory): KnownMemory => ({
  id: m.id,
  layer: m.layer as KnownMemory["layer"],
  status: m.status as KnownMemory["status"],
  text: m.text,
});

/**
 * Takes one consolidation that is due (or was queued before a compaction) and does it. Returns
 * `null` when there is nothing to do. It never throws for a model failure: a failure is recorded in
 * the row, nothing is written to the memory, and the window is tried again later (the cursor only
 * moves when a consolidation ends `done`).
 *
 * What the model reads is ONLY the user's messages and the bot's chat answers of the window and the
 * bot's current memories (`consolidationWindow`, `memoriesVisibleTo`): no tool call, tool result,
 * fetched page, e-mail, reasoning or journal ever reaches it.
 */
export async function runNextConsolidation(
  deps: ConsolidationDeps,
): Promise<ConsolidationOutcome | null> {
  const { db } = deps;
  const settings = await getMemorySettings(db);
  if (!settings.consolidationEnabled) return null;
  const now = deps.now ?? (() => new Date());
  const claimed = await claimConsolidation(db, {
    workerId: deps.workerId,
    leaseMs: CONSOLIDATION_LEASE_MS,
    idleMinutes: settings.idleMinutes,
    maxTurns: settings.maxTurns,
    now: now(),
  });
  if (claimed === null) return null;
  const fromSeq = claimed.fromSeq ?? 0;
  const toSeq = claimed.toSeq ?? 0;

  const finish = async (
    status: "done" | "skipped" | "failed",
    extra: Partial<Parameters<typeof finishConsolidation>[1]> = {},
    tx: Db = db,
  ) => finishConsolidation(tx, { id: claimed.id, workerId: deps.workerId, status, ...extra });
  const result = (
    status: ConsolidationOutcome["status"],
    kept: KeptItem[] = [],
    dropped: DroppedProposal[] = [],
  ): ConsolidationOutcome => ({ consolidation: claimed, status, kept, dropped });

  const window = await consolidationWindow(db, {
    conversationId: claimed.conversationId,
    fromSeq,
    toSeq,
  });
  const userTurns = window.filter((m) => m.author === "user").length;
  if (userTurns === 0) {
    await finish("skipped", { userTurns: 0 });
    return result("skipped");
  }

  const visible = await memoriesVisibleTo(db, claimed.botId);
  const call = await askForcedTool({
    provider: deps.provider,
    model: deps.model,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    user: buildConsolidationMessage(
      window.map((m) => ({ id: m.id, author: m.author, text: m.text })),
      visible.map(toKnown),
    ),
    tool: CONSOLIDATION_TOOL_SPEC,
    maxOutputTokens: CONSOLIDATION_MAX_OUTPUT_TOKENS,
    timeoutMs: CONSOLIDATION_TIMEOUT_MS,
    now,
  });
  const metrics = {
    userTurns,
    model: deps.model.id,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    costUsd: call.costUsd,
    latencyMs: call.latencyMs,
  };
  if (!call.ok) {
    deps.log?.(`consolidação ${claimed.id}: falhou (${call.failure}): ${call.detail}`);
    await finish("failed", { ...metrics, error: `${call.failure}: ${call.detail}` });
    return result("failed");
  }
  const items = readProposalItems(call.args);
  if (items === undefined) {
    deps.log?.(`consolidação ${claimed.id}: resposta fora do formato`);
    await finish("failed", { ...metrics, error: "invalid_output: items não é uma lista" });
    return result("failed");
  }

  const verification = verifyProposals(items, {
    window: window.map((m) => ({ id: m.id, author: m.author, text: m.text })),
    visible: new Map(visible.map((m) => [m.id, { layer: m.layer as KnownMemory["layer"] }])),
  });

  const applied = await withTransaction(db, async (tx) => {
    // A worker that lost its lease (another one took the row over) writes nothing.
    if (!(await lockOwnConsolidation(tx, claimed.id, deps.workerId))) return null;
    const kept: KeptItem[] = [];
    const dropped: DroppedProposal[] = [...verification.dropped];
    for (const proposal of verification.kept) {
      const outcome = await applyProposal(tx, proposal, claimed);
      if (outcome.kept !== undefined) kept.push(outcome.kept);
      else if (outcome.dropped !== undefined) dropped.push({ item: proposal, ...outcome.dropped });
    }
    await finish("done", { ...metrics, record: { proposed: items, kept, dropped } }, tx);
    return { kept, dropped };
  });
  if (applied === null) {
    deps.log?.(`consolidação ${claimed.id}: a posse foi perdida; nada foi gravado`);
    return result("lost");
  }
  return result("done", applied.kept, applied.dropped);
}

type Applied =
  | { kept: KeptItem; dropped?: undefined }
  | {
      kept?: undefined;
      dropped: { reason: "duplicate" | "rejected_before" | "unchanged"; detail: string };
    };

/**
 * The policy of what a verified proposal becomes (docs/MEMORIA.md):
 * - a note is written at once (author `bot`, origin: this consolidation and the message of the quote);
 * - a rule or a profile fact becomes PENDING (the user confirms; it never enters a prompt before);
 * - an update of a note edits it; an update of a rule or profile fact becomes a pending proposal that
 *   replaces the old one when confirmed;
 * - the same text (ignoring only case and white space) already there: dropped as a duplicate, unless
 *   it is a note, or a pending profile fact, from ANOTHER conversation: then the fact was seen in two
 *   conversations and it is promoted to an active profile fact; a text the user refused is never
 *   proposed again.
 */
async function applyProposal(
  tx: Db,
  proposal: VerifiedProposal,
  claimed: Consolidation,
): Promise<Applied> {
  const origin: MemoryOrigin = {
    conversationId: claimed.conversationId,
    messageId: proposal.messageId,
    consolidationId: claimed.id,
  };
  const keptOf = (action: KeptItem["action"], memory: Memory): { kept: KeptItem } => ({
    kept: {
      action,
      layer: proposal.layer,
      memoryId: memory.id,
      status: memory.status === "pending" ? "pending" : "active",
      text: proposal.text,
      quote: proposal.quote,
      messageId: proposal.messageId,
    },
  });
  const source = {
    sourceConversationId: claimed.conversationId,
    sourceMessageId: proposal.messageId,
    consolidationId: claimed.id,
    createdBy: "bot" as const,
    actor: "consolidation" as const,
  };

  const same = await findMemoriesWithText(tx, proposal.text);
  if (same.some((m) => m.status === "rejected")) {
    return { dropped: { reason: "rejected_before", detail: "Você já recusou esta memória." } };
  }
  if (proposal.action === "add" && proposal.layer !== "rule") {
    const sameFact = same.find(
      (m) =>
        (m.layer === "note" || m.layer === "profile") &&
        m.status !== "rejected" &&
        m.sourceConversationId !== null &&
        m.sourceConversationId !== claimed.conversationId &&
        ((m.layer === "note" && m.status === "active") ||
          (m.layer === "profile" && m.status === "pending")),
    );
    if (sameFact !== undefined) {
      // Same fact, seen in two different conversations: it becomes an active profile fact.
      const promoted = await promoteToProfile(tx, sameFact.id, { actor: "consolidation", origin });
      if (promoted !== null && promoted.layer === "profile" && promoted.status === "active") {
        return keptOf("promoted", promoted);
      }
    }
  }
  if (same.length > 0 && proposal.action === "add") {
    return {
      dropped: { reason: "duplicate", detail: "Esta memória, com o mesmo texto, já existe." },
    };
  }

  if (proposal.action === "update" && proposal.targetId !== null) {
    const target = await getMemory(tx, proposal.targetId);
    if (target === null || target.archivedAt !== null) {
      return { dropped: { reason: "unchanged", detail: "A memória a atualizar já não existe." } };
    }
    const editInPlace = target.layer === "note" || target.status === "pending";
    if (editInPlace) {
      const edited = await updateMemory(tx, target.id, proposal.text, {
        actor: "consolidation",
        origin,
        ...(proposal.summary === null ? {} : { summary: proposal.summary }),
      });
      if (edited === null || edited.text === target.text) {
        return { dropped: { reason: "unchanged", detail: "O texto já era este." } };
      }
      return keptOf("updated", edited);
    }
    const proposed = await addMemory(tx, {
      layer: target.layer,
      scope: target.scope,
      ...(target.botId === null ? {} : { botId: target.botId }),
      text: proposal.text,
      ...source,
      status: "pending",
      supersedesId: target.id,
    });
    return keptOf("proposed", proposed);
  }

  if (proposal.layer === "note") {
    const note = await addMemory(tx, {
      layer: "note",
      botId: claimed.botId,
      text: proposal.text,
      ...(proposal.summary === null ? {} : { summary: proposal.summary }),
      ...source,
    });
    return keptOf("added", note);
  }
  const pending = await addMemory(tx, {
    layer: proposal.layer,
    // A profile fact is the user's, for every bot; a rule said to one bot stays with that bot.
    ...(proposal.layer === "rule" ? { scope: "bot" as const, botId: claimed.botId } : {}),
    text: proposal.text,
    ...source,
    status: "pending",
  });
  return keptOf("proposed", pending);
}

/** Asks for a consolidation of the conversation before its run compacts (it only queues). */
export async function requestPreCompactionConsolidation(
  db: Db,
  input: { conversationId: string; botId: string },
): Promise<void> {
  await requestConsolidation(db, { ...input, reason: "pre_compaction" });
}

/** Archives the notes and journal entries nobody used for `expiryDays`. Returns how many. */
export async function runMemoryExpiry(db: Db, now: Date = new Date()): Promise<number> {
  const settings = await getMemorySettings(db);
  if (settings.expiryDays === null) return 0;
  return (await expireUnusedMemories(db, { days: settings.expiryDays, now })).length;
}
