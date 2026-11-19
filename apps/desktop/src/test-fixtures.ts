import type { Bot, Conversation, Memory, Message, Run, RunEvent } from "@suup/api";

let n = 0;
const uuid = (): string => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
};
const iso = (offsetMs = 0): string =>
  new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + offsetMs).toISOString();
export const at = iso;

export function makeBot(over: Partial<Bot> = {}): Bot {
  return {
    id: uuid(),
    name: "Principal",
    description: "O bot principal.",
    personality: "",
    modelProvider: "roteiro",
    modelId: "model-x",
    allowedTools: ["shell"],
    limits: {},
    avatar: null,
    isDefault: true,
    pinned: false,
    groupName: null,
    sortOrder: null,
    color: null,
    createdAt: iso(),
    updatedAt: iso(),
    archivedAt: null,
    latestRun: null,
    conversationId: null,
    unreadCount: 0,
    ...over,
  };
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: uuid(),
    botId: uuid(),
    parentRunId: null,
    conversationId: null,
    origin: "user",
    objective: "Faça algo",
    acceptanceCriteria: [],
    plan: [],
    status: "running",
    paused: false,
    failureOrigin: null,
    failureDetail: null,
    result: null,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: "0.000000",
    traceId: null,
    createdAt: iso(),
    updatedAt: iso(),
    startedAt: iso(),
    finishedAt: null,
    ...over,
  };
}

export function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: uuid(),
    conversationId: uuid(),
    seq: 1,
    authorKind: "user",
    authorBotId: null,
    text: "Olá",
    runId: null,
    status: null,
    createdAt: iso(),
    ...over,
  };
}

export function makeConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: uuid(),
    kind: "direct",
    title: null,
    createdAt: iso(),
    updatedAt: iso(),
    lastMessageAt: null,
    archivedAt: null,
    members: [],
    lastMessage: null,
    lastReadSeq: 0,
    unreadCount: 0,
    activeRun: null,
    ...over,
  };
}

export function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: uuid(),
    layer: "rule",
    scope: "shared",
    botId: null,
    text: "Responda em português.",
    sourceConversationId: null,
    sourceRunId: null,
    sourceMessageId: null,
    createdBy: "user",
    createdAt: iso(),
    updatedAt: iso(),
    archivedAt: null,
    ...over,
  };
}

export function makeEvent(
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): RunEvent {
  return { seq, type, createdAt: iso(seq * 1000), payload };
}
