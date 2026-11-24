import type {
  Approval,
  ApprovalRule,
  Bot,
  Connector,
  ConnectorTool,
  Conversation,
  Memory,
  Message,
  Routine,
  Run,
  RunEvent,
  Secret,
  WrittenRule,
} from "@suup/api";
import { fireEvent } from "@testing-library/react";

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
    avatarStyle: "shapes",
    avatarPixel3d: false,
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
    reception: "done",
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
    reviewReason: null,
    writtenRuleId: null,
    expiresAt: null,
    decidedAt: null,
    createdAt: iso(),
    waitedMs: null,
    stale: false,
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

export function makeWrittenRule(over: Partial<WrittenRule> = {}): WrittenRule {
  return {
    id: uuid(),
    kind: "never",
    text: "Apagar a pasta notas",
    botId: null,
    enabled: true,
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
    pin: "approved",
    fingerprint: null,
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
    grants: [],
    pendingReviews: 0,
    secretNames: [],
    runsIn: "container",
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

/** A routine of the Rotinas panel (docs/ROTINAS.md): daily at 08:00 in Sao Paulo. */
export const routineOf = (over: Partial<Routine> = {}): Routine => ({
  id: "00000000-0000-4000-8000-000000000002",
  botId: "00000000-0000-4000-8000-0000000000b1",
  name: "Calendário da manhã",
  instruction: "Veja meu calendário de hoje.",
  triggerKind: "schedule",
  schedule: { kind: "daily", time: "08:00" },
  problem: null,
  timeZone: "America/Sao_Paulo",
  status: "active",
  nextRunAt: "2026-11-23T11:00:00.000Z",
  state: "",
  costCapUsd: null,
  createdBy: "bot",
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
  endedAt: null,
  lastFire: null,
  ...over,
});

/**
 * Choose an option of a dropdown as a person does: the pointer goes down on it, then the click.
 * Base UI's Select ignores a click that did not start on the option (a press that opened the list
 * and was released over it), so a bare synthetic click is not a choice.
 */
export function pressOption(el: Element): void {
  fireEvent.pointerDown(el, { pointerType: "mouse" });
  fireEvent.click(el);
}
