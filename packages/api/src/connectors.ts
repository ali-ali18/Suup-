import { z } from "zod";
import { outboundMessageSchema, riskLevelSchema } from "./approvals.js";
import { isoDate, uuid } from "./common.js";

export const CONNECTOR_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const connectorNameSchema = z
  .string()
  .max(24)
  .regex(CONNECTOR_NAME, "use letras minúsculas e números, separados por hífen (ex.: github)");

/**
 * A value that is plain text or a reference to a vault secret by NAME. A credential is always a
 * reference: the API has no field that holds one, and none that returns one.
 */
export const valueRefSchema = z.union([
  z.string().max(4096),
  z.strictObject({ secret: z.string(), prefix: z.string().max(32).optional() }),
]);
export type ValueRef = z.infer<typeof valueRefSchema>;

export const connectorTransportSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stdio"),
    /** The executable only (no shell string); arguments go in `args`. It runs on the server host. */
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(64).optional(),
    /** Only these variables reach the program (besides HOME, PATH and a few safe ones). */
    env: z.record(z.string(), valueRefSchema).optional(),
    cwd: z.string().min(1).max(1024).optional(),
    /**
     * Exact host names the server may reach when it runs isolated (docker sandbox), through the
     * egress proxy, besides the default package registries. Empty or absent: only those.
     */
    egressHosts: z.array(z.string().max(300)).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal("http"),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string(), valueRefSchema).optional(),
  }),
]);
export type ConnectorTransport = z.infer<typeof connectorTransportSchema>;

/**
 * What the USER says about one tool of a connector (a server can never set either): its risk, and
 * whether a call is a message to another person (`outbound`, with the argument fields that hold
 * the recipient). Only the user's mark makes the approval card the message card.
 */
export const toolOverrideSchema = z
  .strictObject({
    risk: riskLevelSchema.optional(),
    outbound: outboundMessageSchema.optional(),
  })
  .refine((o) => o.risk !== undefined || o.outbound !== undefined, "override vazio");
export const toolOverridesSchema = z
  .record(z.string().min(1).max(128), toolOverrideSchema)
  .refine((o) => Object.keys(o).length <= 200, "overrides demais");

/**
 * What a bot may use of a connector: `"all"` (every tool the connector offers and that is
 * approved) or exactly the listed tools, by the name on the server. An empty list grants nothing.
 */
export const toolSelectionSchema = z.union([
  z.literal("all"),
  z.array(z.string().min(1).max(128)).max(200),
]);
export type ToolSelection = z.infer<typeof toolSelectionSchema>;

/** Body of `PUT /v1/connectors/{name}/grants/{botId}`: replaces what the bot may use. */
export const grantConnectorBodySchema = z.strictObject({ tools: toolSelectionSchema });
export type GrantConnectorBody = z.input<typeof grantConnectorBodySchema>;

/** One tool of a connector, as the model would get it now. */
export const connectorToolSchema = z.object({
  /** The name on the server. */
  tool: z.string(),
  /** The name the model calls and the rules match: `conn_<connector>__<tool>`. */
  name: z.string(),
  /** Cleaned and bounded text from the server (untrusted). */
  description: z.string(),
  risk: riskLevelSchema,
  /** Where the level came from: the default, the user, a hint the user trusts, or a hint that tightened it. */
  riskBasis: z.enum(["default", "user", "trusted_hint", "tightened_by_hint", "outbound"]),
  /** Set when the user marked the tool as sending a message to another person. */
  outbound: outboundMessageSchema.nullable(),
  /** Offered to bots. When not, `reason` says why (unsupported schema, read-only scope...). */
  available: z.boolean(),
  reason: z.string().optional(),
  hints: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .nullable(),
  /**
   * The pinning of the definition: `approved` (the server shows what the user approved), `changed`
   * (it shows something else: the tool is off for every bot until reviewed), `new` (appeared after
   * the first listing, not approved yet), `unseen` (never listed).
   */
  pin: z.enum(["approved", "changed", "new", "unseen"]),
  /** SHA-256 of the definition the server shows now; `null` when unseen. */
  fingerprint: z.string().nullable(),
});
export type ConnectorTool = z.infer<typeof connectorToolSchema>;

/** What one bot may use of a connector: every tool, or exactly `tools` (names on the server). */
export const connectorGrantSchema = z.object({
  botId: uuid,
  all: z.boolean(),
  /** Empty when `all`. */
  tools: z.array(z.string()),
});
export type ConnectorGrant = z.infer<typeof connectorGrantSchema>;

export const connectorSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string(),
  transport: connectorTransportSchema,
  scope: z.enum(["read_only", "read_write"]),
  /** What the user said about each tool (by the name on the server). */
  toolOverrides: toolOverridesSchema,
  trustAnnotations: z.boolean(),
  timeoutMs: z.number().int(),
  enabled: z.boolean(),
  /** `proposal`: a bot proposed it (not built yet; such a connector is created off). */
  origin: z.enum(["user", "proposal"]),
  /** The bots that have a grant (see `grants` for what each may use). */
  grantedBotIds: z.array(uuid),
  grants: z.array(connectorGrantSchema),
  /** Tools off for every bot until a person reviews their definition (changed or new). */
  pendingReviews: z.number().int(),
  /** The vault secrets it refers to (names only). */
  secretNames: z.array(z.string()),
  /**
   * Where a stdio server runs: `container` (isolated: no host files, no server environment, network
   * only through the allowlist proxy) or `host` (a program of the machine that runs the worker,
   * WITHOUT isolation). `null` for an HTTP connector.
   */
  runsIn: z.enum(["container", "host"]).nullable(),
  /** The state of the connection in the instance that answered. */
  connection: z.object({
    connected: z.boolean(),
    failures: z.number().int(),
    lastError: z.string().nullable(),
  }),
  /** What was last seen of the server by any worker or server (not only the one that answered). */
  discovery: z.object({
    discoveredAt: isoDate.nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: isoDate.nullable(),
  }),
  /** `null` until the server was listed once. */
  tools: z.array(connectorToolSchema).nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Connector = z.infer<typeof connectorSchema>;
export const connectorListSchema = z.object({ items: z.array(connectorSchema) });

export const createConnectorBodySchema = z.strictObject({
  name: connectorNameSchema,
  description: z.string().max(500).optional(),
  transport: connectorTransportSchema,
  scope: z.enum(["read_only", "read_write"]).optional(),
  tools: toolOverridesSchema.optional(),
  trustAnnotations: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** Default `true`: the user is adding it. */
  enabled: z.boolean().optional(),
  /** Bots to let use it right away, each with the tools it may use. */
  grants: z
    .array(z.strictObject({ botId: uuid, tools: toolSelectionSchema }))
    .max(50)
    .optional(),
});
export type CreateConnectorBody = z.input<typeof createConnectorBodySchema>;

export const updateConnectorBodySchema = z.strictObject({
  description: z.string().max(500).optional(),
  transport: connectorTransportSchema.optional(),
  scope: z.enum(["read_only", "read_write"]).optional(),
  tools: toolOverridesSchema.optional(),
  trustAnnotations: z.boolean().optional(),
  /** `null`: back to the default. */
  timeoutMs: z.number().int().min(1000).max(600_000).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateConnectorBody = z.input<typeof updateConnectorBodySchema>;

/** Sets what the user says one tool's risk is; `risk: null` clears it (back to the default). */
export const setToolRiskBodySchema = z.strictObject({ risk: riskLevelSchema.nullable() });
export type SetToolRiskBody = z.input<typeof setToolRiskBodySchema>;

/**
 * Marks (or, with `outbound: null`, unmarks) a tool as sending a message to another person, naming
 * the argument fields that hold the recipient. The server's hints can never do this.
 */
export const setToolOutboundBodySchema = z.strictObject({
  outbound: outboundMessageSchema.nullable(),
});
export type SetToolOutboundBody = z.input<typeof setToolOutboundBodySchema>;

export const connectorTestSchema = z.object({
  ok: z.boolean(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  durationMs: z.number().int(),
  /** Names the connector; never holds a credential. */
  error: z.string().nullable(),
  tools: z.array(connectorToolSchema),
});
export type ConnectorTest = z.infer<typeof connectorTestSchema>;

/** The definition of a tool as the server gave it (bounded, cleaned; untrusted text). */
export const pinnedDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  annotations: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .nullable(),
});
export type PinnedDefinition = z.infer<typeof pinnedDefinitionSchema>;

/** A tool waiting for a person: the definition they approved (if any) and the one shown now. */
export const connectorToolReviewSchema = z.object({
  tool: z.string(),
  /** `changed`: approved before, the server now shows something else. `new`: never approved. */
  status: z.enum(["changed", "new"]),
  approvedFingerprint: z.string().nullable(),
  approved: pinnedDefinitionSchema.nullable(),
  currentFingerprint: z.string(),
  current: pinnedDefinitionSchema,
  seenAt: isoDate,
});
export type ConnectorToolReview = z.infer<typeof connectorToolReviewSchema>;
export const connectorReviewListSchema = z.object({ items: z.array(connectorToolReviewSchema) });

/** Approves the definition the person looked at; refused when the tool changed again meanwhile. */
export const approveToolBodySchema = z.strictObject({ fingerprint: z.string().min(1).max(128) });
export type ApproveToolBody = z.input<typeof approveToolBodySchema>;

export const connectorToolEventSchema = z.object({
  id: z.string(),
  tool: z.string().nullable(),
  kind: z.enum(["baseline", "pinned_on_grant", "changed", "new", "restored", "approved"]),
  fromFingerprint: z.string().nullable(),
  toFingerprint: z.string().nullable(),
  detail: z.string().nullable(),
  createdAt: isoDate,
});
export type ConnectorToolEvent = z.infer<typeof connectorToolEventSchema>;
export const connectorToolEventListSchema = z.object({ items: z.array(connectorToolEventSchema) });
