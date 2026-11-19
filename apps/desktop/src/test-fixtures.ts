import type {
  Approval,
  ApprovalRule,
  Bot,
  Connector,
  ConnectorTool,
  Conversation,
  Memory,
  Message,
  Run,
  RunEvent,
  Secret,
} from "@suup/api";

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

export function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: uuid(),
    runId: uuid(),
    botId: uuid(),
    conversationId: null,
    callId: `call-${n}`,
    tool: "shell",
    args: { command: "git push origin main" },
    level: "external_irreversible",
    summary: "Shell em repo: git push origin main",
    secrets: [],
    source: "default",
    outbound: null,
    status: "pending",
    reason: null,
    ruleId: null,
    expiresAt: null,
    decidedAt: null,
    createdAt: iso(),
    ...over,
  };
}

export function makeRule(over: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: uuid(),
    botId: null,
    tool: "shell",
    effect: "allow",
    matchers: [],
    enabled: true,
    disabledReason: null,
    note: null,
    createdBy: "user",
    sourceApprovalId: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}

export function makeSecret(over: Partial<Secret> = {}): Secret {
  return {
    name: "GH_TOKEN",
    description: "",
    keyId: "0123456789abcdef",
    grantedBotIds: [],
    createdAt: iso(),
    updatedAt: iso(),
    lastUsedAt: null,
    ...over,
  };
}

export function makeConnectorTool(over: Partial<ConnectorTool> = {}): ConnectorTool {
  return {
    tool: "echo",
    name: "conn_fake__echo",
    description: "Returns the text it was given.",
    risk: "external_irreversible",
    riskBasis: "default",
    outbound: null,
    available: true,
    hints: null,
    ...over,
  };
}

export function makeConnector(over: Partial<Connector> = {}): Connector {
  return {
    id: uuid(),
    name: "fake",
    description: "",
    transport: { kind: "stdio", command: "node", args: [] },
    scope: "read_write",
    toolOverrides: {},
    trustAnnotations: false,
    timeoutMs: 60_000,
    enabled: true,
    origin: "user",
    grantedBotIds: [],
    secretNames: [],
    connection: { connected: false, failures: 0, lastError: null },
    discovery: { discoveredAt: null, lastError: null, lastErrorAt: null },
    tools: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...over,
  };
}

/** An approval of a message to another person: the tool DECLARED it (`outbound`), as the server sends it. */
export function makeMessageApproval(over: Partial<Approval> = {}): Approval {
  return makeApproval({
    tool: "conn_mail__send_email",
    args: { to: "ana@exemplo.com", subject: "Oi", body: "Tudo bem?" },
    summary: "Conector mail → send_email",
    outbound: {
      kind: "message",
      recipientFields: ["to"],
      recipients: [{ field: "to", value: "ana@exemplo.com" }],
    },
    ...over,
  });
}
