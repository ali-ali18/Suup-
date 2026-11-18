// Database rows to the wire types of `@suup/api`: ISO dates, no internal columns.
import type { Bot, Conversation, Memory, Message, Run, RunEvent } from "@suup/api";
import {
  type BotSummary,
  type ConversationView,
  type Memory as MemoryRow,
  type Message as MessageRow,
  type RunEvent as RunEventRow,
  type Run as RunRow,
  runResultOrNull,
} from "./db-types.js";

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null | undefined): string | null =>
  date === null || date === undefined ? null : date.toISOString();

export function toRunDto(run: RunRow): Run {
  return {
    id: run.id,
    botId: run.botId,
    parentRunId: run.parentRunId,
    conversationId: run.conversationId ?? null,
    origin: run.origin,
    objective: run.objective,
    acceptanceCriteria: run.acceptanceCriteria,
    plan: run.plan,
    status: run.status,
    paused: run.pausedAt != null,
    failureOrigin: run.failureOrigin,
    failureDetail: run.failureDetail,
    result: runResultOrNull(run.result),
    turns: run.turns,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd: run.costUsd,
    traceId: run.traceId,
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
    startedAt: isoOrNull(run.startedAt),
    finishedAt: isoOrNull(run.finishedAt),
  };
}

export function toBotDto(summary: BotSummary): Bot {
  const { bot, latestRun } = summary;
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    personality: bot.personality,
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    allowedTools: bot.allowedTools,
    limits: bot.limits,
    avatar: bot.avatar ?? null,
    isDefault: bot.isDefault === true,
    createdAt: iso(bot.createdAt),
    updatedAt: iso(bot.updatedAt),
    archivedAt: isoOrNull(bot.archivedAt),
    latestRun:
      latestRun === null
        ? null
        : {
            id: latestRun.id,
            status: latestRun.status,
            paused: latestRun.paused,
            objective: latestRun.objective,
            createdAt: iso(latestRun.createdAt),
          },
    conversationId: summary.conversationId,
    unreadCount: summary.unreadCount,
  };
}

export function toMessageDto(message: MessageRow): Message {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    authorKind: message.authorKind,
    authorBotId: message.authorBotId,
    text: message.text,
    runId: message.runId,
    status: message.status,
    createdAt: iso(message.createdAt),
  };
}

export function toConversationDto(view: ConversationView, activeRun: RunRow | null): Conversation {
  return {
    id: view.id,
    kind: view.kind,
    title: view.title,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
    lastMessageAt: isoOrNull(view.lastMessageAt),
    archivedAt: isoOrNull(view.archivedAt),
    members: view.members.map((m) => ({
      botId: m.botId,
      name: m.name,
      avatar: m.avatar,
      joinedAt: iso(m.joinedAt),
    })),
    lastMessage:
      view.lastMessage === null
        ? null
        : {
            id: view.lastMessage.id,
            seq: view.lastMessage.seq,
            authorKind: view.lastMessage.authorKind,
            authorBotId: view.lastMessage.authorBotId,
            text: view.lastMessage.text,
            createdAt: iso(view.lastMessage.createdAt),
          },
    lastReadSeq: view.lastReadSeq,
    unreadCount: view.unreadCount,
    activeRun: activeRun === null ? null : toRunDto(activeRun),
  };
}

export function toMemoryDto(memory: MemoryRow): Memory {
  return {
    id: memory.id,
    layer: memory.layer,
    scope: memory.scope,
    botId: memory.botId,
    text: memory.text,
    sourceConversationId: memory.sourceConversationId,
    sourceRunId: memory.sourceRunId,
    sourceMessageId: memory.sourceMessageId,
    createdBy: memory.createdBy,
    createdAt: iso(memory.createdAt),
    updatedAt: iso(memory.updatedAt),
    archivedAt: isoOrNull(memory.archivedAt),
  };
}

export function toRunEventDto(event: RunEventRow): RunEvent {
  return {
    seq: event.seq,
    type: event.type,
    createdAt: iso(event.createdAt),
    payload: event.payload,
  };
}

export type { MemoryRow };
