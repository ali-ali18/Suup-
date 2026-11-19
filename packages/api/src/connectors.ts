import { z } from "zod";
import { riskLevelSchema } from "./approvals.js";
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
  }),
  z.strictObject({
    kind: z.literal("http"),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string(), valueRefSchema).optional(),
  }),
]);
export type ConnectorTransport = z.infer<typeof connectorTransportSchema>;

export const toolOverridesSchema = z
  .record(z.string().min(1).max(128), z.strictObject({ risk: riskLevelSchema }))
  .refine((o) => Object.keys(o).length <= 200, "overrides demais");

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
  riskBasis: z.enum(["default", "user", "trusted_hint", "tightened_by_hint"]),
  /** Offered to bots. When not, `reason` says why (unsupported schema, read-only scope...). */
  available: z.boolean(),
  reason: z.string().optional(),
  hints: z
    .object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .nullable(),
});
export type ConnectorTool = z.infer<typeof connectorToolSchema>;

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
  grantedBotIds: z.array(uuid),
  /** The vault secrets it refers to (names only). */
  secretNames: z.array(z.string()),
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
  /** Bots to let use it right away. */
  grantBotIds: z.array(uuid).max(50).optional(),
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
