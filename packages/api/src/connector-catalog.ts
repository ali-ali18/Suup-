import { z } from "zod";
import { isoDate, uuid } from "./common.js";
import { connectorSchema, connectorTransportSchema } from "./connectors.js";

/**
 * How a gallery entry logs in: `oauth` (the OAuth of the MCP protocol, in the browser: one click
 * when the server accepts a new client), `token` (a token the person creates on the service and
 * types in the secure form; it goes to the vault under `secret` and is sent in `header`), or
 * `oauth_owner_client` (an OAuth app of the owner's own: `steps` is the guide).
 */
export const catalogAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oauth"), scopes: z.array(z.string()).nullable() }),
  z.object({
    kind: z.literal("token"),
    secret: z.string(),
    header: z.string(),
    prefix: z.string().nullable(),
    steps: z.array(z.string()),
  }),
  z.object({ kind: z.literal("oauth_owner_client"), steps: z.array(z.string()) }),
]);
export type CatalogAuth = z.infer<typeof catalogAuthSchema>;

/** One entry of the gallery, as declared in the server (`packages/connectors/src/catalog.ts`). */
export const catalogEntrySchema = z.object({
  /** Also the name of the connector it creates. */
  id: z.string(),
  name: z.string(),
  /** One line, pt-BR. */
  description: z.string(),
  /** The official page of the server. */
  source: z.string(),
  license: z.string(),
  /** A Simple Icons slug (CC0) to draw as the service's logo; `null`: a generic icon. */
  icon: z.string().nullable(),
  /** `unverified`: shown, not installable (`unverifiedReason` says why). */
  availability: z.enum(["ready", "unverified"]),
  unverifiedReason: z.string().nullable(),
  /** The fixed transport (`null` when that is what is not verified). */
  transport: connectorTransportSchema.nullable(),
  auth: catalogAuthSchema,
  /** The exact hosts it talks to. */
  egressHosts: z.array(z.string()),
  /** Exact hosts of the connect or authorization links this service hands out (the chat card checks them). */
  authHosts: z.array(z.string()),
  /** When set, a connect link must also start with this path segment (`/link/...`). */
  authLinkSegment: z.string().nullable(),
  /** Tools the Suup never offers to a bot (exact names on the server). */
  deniedTools: z.array(z.string()),
  /** Tools that only read, by exact name: they run without a card. */
  readTools: z.array(z.string()),
  /** Tools that change something, by exact name: they always ask. */
  writeTools: z.array(z.string()),
  /** Limits and facts to show (pt-BR). */
  notes: z.array(z.string()),
  /** A third party keeps the logins: show it before connecting (pt-BR). */
  disclosure: z.string().nullable(),
  /** When the entry was last checked (YYYY-MM-DD). */
  checkedAt: z.string(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * Where an entry stands: `available` (Conectar), `unverified` (a confirmar), `needs_login`
 * (Precisa de login: OAuth), `needs_secret` (Precisa do token), `connected` (Conectado), `off`
 * (installed with credentials, turned off), `error` (`detail` says why).
 */
export const catalogStatusSchema = z.enum([
  "available",
  "unverified",
  "needs_login",
  "needs_secret",
  "connected",
  "off",
  "error",
]);
export type CatalogStatus = z.infer<typeof catalogStatusSchema>;

export const catalogItemSchema = z.object({
  entry: catalogEntrySchema,
  status: catalogStatusSchema,
  /** The installed connector's name (`/v1/connectors/{name}`), or `null`. */
  connector: z.string().nullable(),
  detail: z.string().nullable(),
  /** A browser login waiting for its callback. */
  login: z.object({ flowId: uuid, expiresAt: isoDate }).nullable(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const catalogListSchema = z.object({ items: z.array(catalogItemSchema) });

/** `next`: what the person still does: `login` (OAuth), `secret` (the secure form), `none`. */
export const installResultSchema = z.object({
  item: catalogItemSchema,
  next: z.enum(["login", "secret", "none"]),
  connector: connectorSchema,
});
export type InstallResult = z.infer<typeof installResultSchema>;

/** `POST /v1/connectors/{name}/oauth/start`: open `authorizationUrl` in the system browser. */
export const oauthStartSchema = z.object({
  authorizationUrl: z.string(),
  flowId: uuid,
  /** Where the browser comes back: the server's loopback listener. */
  redirectUri: z.string(),
  expiresAt: isoDate,
});
export type OAuthStart = z.infer<typeof oauthStartSchema>;

export const oauthStatusSchema = z.object({
  status: z.enum(["none", "pending", "connected", "needs_login", "error"]),
  flowId: uuid.nullable(),
  expiresAt: isoDate.nullable(),
  error: z.string().nullable(),
});
export type OAuthStatus = z.infer<typeof oauthStatusSchema>;
