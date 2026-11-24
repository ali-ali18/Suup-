// Database rows to the wire types of `@suup/api`: ISO dates, no internal columns.
import type {
  Approval,
  ApprovalRule,
  Bot,
  CatalogItem,
  Connector,
  ConnectorTest,
  ConnectorToolEvent,
  ConnectorToolReview,
  Conversation,
  Memory,
  Message,
  OAuthStatus,
  Run,
  RunEvent,
  Secret,
  WrittenRule,
} from "@suup/api";
import { recipientMatchers } from "@suup/core";
import type {
  CatalogItem as CatalogItemView,
  ConnectorTestResult,
  ConnectorView,
  OAuthStatusView,
  ConnectorToolReview as ReviewView,
} from "@suup/runtime";
import {
  type Approval as ApprovalRow,
  type BotSummary,
  type ConversationView,
  type Memory as MemoryRow,
  type Message as MessageRow,
  type RunEvent as RunEventRow,
  type Run as RunRow,
  runResultOrNull,
  type SecretMeta,
  type StoredRule,
  type StoredWrittenRule,
} from "./db-types.js";

export const iso = (date: Date): string => date.toISOString();
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
    wakeAt: isoOrNull(run.wakeAt),
    wakeNote: run.wakeNote ?? null,
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
    pinned: bot.pinned === true,
    groupName: bot.groupName ?? null,
    sortOrder: bot.sortOrder ?? null,
    color: bot.color === undefined ? null : (bot.color as Bot["color"]),
    avatarStyle: bot.avatarStyle ?? "shapes",
    avatarPixel3d: bot.avatarPixel3d === true,
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
    ...(message.question === undefined ? {} : { question: message.question }),
    ...(message.team === undefined ? {} : { team: message.team }),
    ...(message.routineId === null ? {} : { routineId: message.routineId }),
    ...(message.routineRef === null ? {} : { routineRef: { id: message.routineRef } }),
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
    reception: view.reception,
    activeRun: activeRun === null ? null : toRunDto(activeRun),
  };
}

export function toMemoryDto(
  memory: MemoryRow,
  review?: { decision: string; reason: string } | null,
): Memory {
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
    status: memory.status,
    summary: memory.summary,
    lastUsedAt: isoOrNull(memory.lastUsedAt),
    supersedesId: memory.supersedesId,
    ...(review === undefined ? {} : { review }),
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

/** What "Permitir destinatário" would pin for this call, or `null` when it cannot be said exactly. */
function recipientsOf(
  args: ApprovalRow["args"],
  outbound: NonNullable<ApprovalRow["outbound"]>,
): { field: string; value: string }[] | null {
  return recipientMatchers(args, outbound);
}

export function toApprovalDto(approval: ApprovalRow): Approval {
  return {
    id: approval.id,
    runId: approval.runId,
    botId: approval.botId,
    conversationId: approval.conversationId,
    callId: approval.callId,
    tool: approval.tool,
    args: approval.args,
    level: approval.level,
    summary: approval.summary,
    secrets: approval.secrets,
    source: approval.source,
    outbound:
      approval.outbound === null
        ? null
        : {
            ...approval.outbound,
            recipients: recipientsOf(approval.args, approval.outbound),
          },
    status: approval.status,
    reason: approval.reason,
    ruleId: approval.ruleId,
    reviewReason: approval.reviewReason,
    writtenRuleId: approval.writtenRuleId,
    expiresAt: isoOrNull(approval.expiresAt),
    decidedAt: isoOrNull(approval.decidedAt),
    createdAt: iso(approval.createdAt),
    waitedMs: approval.waitedMs,
    stale: approval.stale,
  };
}

export function toRuleDto(rule: StoredRule): ApprovalRule {
  return {
    id: rule.id,
    botId: rule.botId,
    tool: rule.tool,
    effect: rule.effect,
    matchers: rule.matchers,
    enabled: rule.enabled,
    disabledReason: rule.disabledReason,
    note: rule.note,
    createdBy: rule.createdBy,
    sourceApprovalId: rule.sourceApprovalId,
    createdAt: iso(rule.createdAt),
    updatedAt: iso(rule.updatedAt),
  };
}

export function toWrittenRuleDto(rule: StoredWrittenRule): WrittenRule {
  return {
    id: rule.id,
    kind: rule.kind,
    text: rule.text,
    botId: rule.botId,
    enabled: rule.enabled,
    createdAt: iso(rule.createdAt),
    updatedAt: iso(rule.updatedAt),
  };
}

/** A secret's metadata. There is no value to map: the database never has one in the clear. */
export function toSecretDto(secret: SecretMeta): Secret {
  return {
    name: secret.name,
    description: secret.description,
    keyId: secret.keyId,
    grantedBotIds: secret.grantedBotIds,
    createdAt: iso(secret.createdAt),
    updatedAt: iso(secret.updatedAt),
    lastUsedAt: isoOrNull(secret.lastUsedAt),
  };
}

export function toConnectorDto(view: ConnectorView): Connector {
  return {
    id: view.id,
    name: view.name,
    description: view.description,
    transport: view.transport,
    scope: view.scope,
    toolOverrides: view.toolOverrides,
    trustAnnotations: view.trustAnnotations,
    timeoutMs: view.timeoutMs,
    enabled: view.enabled,
    origin: view.origin,
    catalogId: view.catalogId,
    oauth:
      view.oauth === null
        ? null
        : {
            status: view.oauth.status,
            lastError: view.oauth.lastError,
            expiresAt: isoOrNull(view.oauth.expiresAt),
          },
    grantedBotIds: view.grantedBotIds,
    grants: view.grants,
    pendingReviews: view.pendingReviews,
    secretNames: view.secretNames,
    runsIn: view.runsIn,
    connection: view.connection,
    discovery: {
      discoveredAt: isoOrNull(view.discovery.discoveredAt),
      lastError: view.discovery.lastError,
      lastErrorAt: isoOrNull(view.discovery.lastErrorAt),
    },
    tools: view.tools === null ? null : view.tools.map(toConnectorToolDto),
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

function toConnectorToolDto(
  tool: NonNullable<ConnectorView["tools"]>[number],
): Connector["tools"] extends (infer T)[] | null ? T : never {
  return {
    tool: tool.tool,
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    riskBasis: tool.riskBasis,
    outbound: tool.outbound === undefined ? null : tool.outbound,
    available: tool.available,
    ...(tool.reason === undefined ? {} : { reason: tool.reason }),
    hints: tool.hints === undefined ? null : tool.hints,
    pin: tool.pin,
    fingerprint: tool.fingerprint,
  };
}

export function toConnectorTestDto(result: ConnectorTestResult): ConnectorTest {
  return {
    ok: result.ok,
    serverName: result.serverName,
    serverVersion: result.serverVersion,
    durationMs: result.durationMs,
    error: result.error,
    tools: result.tools.map(toConnectorToolDto),
  };
}

export function toConnectorReviewDto(review: ReviewView): ConnectorToolReview {
  return {
    tool: review.tool,
    status: review.status,
    approvedFingerprint: review.approvedFingerprint,
    approved: review.approved,
    currentFingerprint: review.currentFingerprint,
    current: review.current,
    seenAt: iso(review.seenAt),
  };
}

export function toConnectorEventDto(event: {
  id: string;
  tool: string | null;
  kind: ConnectorToolEvent["kind"];
  fromFingerprint: string | null;
  toFingerprint: string | null;
  detail: string | null;
  createdAt: Date;
}): ConnectorToolEvent {
  return {
    id: event.id,
    tool: event.tool,
    kind: event.kind,
    fromFingerprint: event.fromFingerprint,
    toFingerprint: event.toFingerprint,
    detail: event.detail,
    createdAt: iso(event.createdAt),
  };
}

export function toCatalogItemDto(item: CatalogItemView): CatalogItem {
  const e = item.entry;
  const auth: CatalogItem["entry"]["auth"] =
    e.auth.kind === "oauth"
      ? { kind: "oauth", scopes: e.auth.scopes === undefined ? null : [...e.auth.scopes] }
      : e.auth.kind === "token"
        ? {
            kind: "token",
            secret: e.auth.secret,
            header: e.auth.header,
            prefix: e.auth.prefix ?? null,
            steps: [...e.auth.steps],
          }
        : { kind: "oauth_owner_client", steps: [...e.auth.steps] };
  return {
    entry: {
      id: e.id,
      name: e.name,
      description: e.description,
      source: e.source,
      license: e.license,
      icon: e.icon,
      availability: e.availability,
      unverifiedReason: e.unverifiedReason ?? null,
      transport: e.transport as CatalogItem["entry"]["transport"],
      auth,
      egressHosts: [...e.egressHosts],
      readTools: [...e.readTools],
      writeTools: [...e.writeTools],
      notes: [...e.notes],
      disclosure: e.disclosure ?? null,
      checkedAt: e.checkedAt,
    },
    status: item.status,
    connector: item.connector,
    detail: item.detail,
    login:
      item.login === null
        ? null
        : { flowId: item.login.flowId, expiresAt: iso(item.login.expiresAt) },
  };
}

export function toOAuthStatusDto(view: OAuthStatusView): OAuthStatus {
  return {
    status: view.status,
    flowId: view.flowId,
    expiresAt: isoOrNull(view.expiresAt),
    error: view.error,
  };
}
