// `propose_connector`: the bot proposes ONE entry of the gallery, by its exact id, and the person
// decides on a card. It can never install anything else: no command, no URL, no arguments of the
// bot reach a connector; the transport is the entry's. Approved, the connector is installed OFF
// (origin `proposal`) and stays off until the person logs in or gives the token in the gallery
// (Configurações > Conectores). See docs/CONECTORES.md and docs/APROVACOES.md.
import { type CatalogEntry, CONNECTOR_CATALOG, catalogEntry } from "@suup/connectors";
import { defineTool } from "@suup/core";
import { z } from "zod";
import { RuntimeError } from "../errors.js";
import type { ConnectorGallery } from "./gallery.js";

export const PROPOSE_CONNECTOR_TOOL = "propose_connector";

const READY = CONNECTOR_CATALOG.filter((e) => e.availability === "ready").map((e) => e.id);

const AUTH_TEXT: Record<CatalogEntry["auth"]["kind"], string> = {
  oauth: "login no navegador (OAuth)",
  token: "um token do serviço, no formulário seguro",
  oauth_owner_client: "um app OAuth do dono",
};

/** The one line of the approval card (pt-BR), from the entry only, never from the bot's text. */
export function proposalCardLine(entry: CatalogEntry): string {
  // No address and no link: the owner reads a sentence, not a log (docs/DESIGN.md, "Amigável").
  return `Instalar o conector ${entry.name} da galeria: ${entry.description} Entrada: ${AUTH_TEXT[entry.auth.kind]}. Este bot já pode usar as ferramentas dele; fica desligado até você entrar, na página do plugin.`;
}

/**
 * The ids of the gallery entries already installed (any state but `available` and `unverified`).
 * A conversation run reads this when it is set up: `propose_connector` does not ask about these.
 */
export async function installedCatalogIds(gallery: ConnectorGallery): Promise<Set<string>> {
  try {
    return new Set(
      (await gallery.list()).filter((i) => i.connector !== null).map((i) => i.entry.id),
    );
  } catch {
    return new Set();
  }
}

const input = z.object({
  connector: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(`The exact id of a gallery entry. One of: ${READY.join(", ")}.`),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe("One sentence for the user: what you would do with it."),
});

export function proposeConnectorTool(
  gallery: () => ConnectorGallery,
  /** The entries installed when the run was set up (`installedCatalogIds`): no card for these. */
  installed: ReadonlySet<string> = new Set(),
) {
  return defineTool({
    name: PROPOSE_CONNECTOR_TOOL,
    description:
      "Proposes that the user install ONE connector of the Suup gallery (a vetted list of services), by its exact id. The user sees a card and decides; if approved it is installed OFF and given to you, and the card has the button to connect it. If the entry is already installed, the card shows where it stands (connect, give access, manage) with the one button that fits. Never send the user to Settings. Nothing outside the gallery can be installed, and you never get the user's tokens.",
    input,
    // Installing a program that talks to an outside service: always a card, unless a rule says so.
    risk: "external_irreversible",
    // An entry already installed changes nothing here: the call only reports where it stands.
    classify: ({ connector }) => (installed.has(connector) ? "read" : "external_irreversible"),
    ownOutput: true,
    describe: ({ connector }) => {
      const entry = catalogEntry(connector);
      return entry === undefined
        ? `Instalar o conector ${connector} (não existe na galeria: será recusado).`
        : proposalCardLine(entry);
    },
    async execute({ connector }, ctx) {
      const entry = catalogEntry(connector);
      if (entry === undefined) {
        return {
          isError: true,
          content: `There is no "${connector}" in the gallery. The ids are: ${CONNECTOR_CATALOG.map((e) => e.id).join(", ")}.`,
        };
      }
      if (entry.availability !== "ready") {
        return {
          isError: true,
          content: `${entry.name} is not available yet: ${entry.unverifiedReason ?? "not verified"}. Tell the user.`,
        };
      }
      try {
        const gal = gallery();
        const current = (await gal.list()).find((i) => i.entry.id === entry.id);
        if (current !== undefined && current.connector !== null) {
          // Already installed: nothing is installed or granted here; say where it stands.
          const mine = await gal.hasAccess(current.connector, ctx.botId);
          const where =
            current.status === "connected"
              ? mine
                ? `${entry.name} is already installed, connected and available to you: use its tools.`
                : `${entry.name} is already installed and connected, but you have no access to it yet. Do not propose it again: tell the user to click "Gerenciar" on the card (the plugin page) and choose the bots that may use it.`
              : `${entry.name} is already installed but not connected yet (${current.status}). Do not propose it again: tell the user to click "Gerenciar" on the card (the plugin page) and ${entry.auth.kind === "oauth" ? "log in in the browser" : "give the token in the secure form"}.`;
          return { content: `Já instalado. ${where}` };
        }
        if (installed.has(entry.id)) {
          return {
            isError: true,
            content: `${entry.name} was installed when this run began but is not any more. Nothing was done: propose it again.`,
          };
        }
        const { item } = await gal.install(entry.id, { origin: "proposal" });
        // The user approved the card: this bot gets the connector (its tools still ask, by risk).
        let granted = true;
        try {
          if (item.connector !== null) await gal.grantAll(item.connector, ctx.botId);
        } catch {
          granted = false;
        }
        return {
          content: `${entry.name} is installed and turned OFF (connector "${item.connector}")${granted ? ", and you were given access to it" : ", but giving you access failed (the user can choose the bots on the plugin page)"}. Tell the user to click "Gerenciar" on the card (the plugin page) and ${entry.auth.kind === "oauth" ? "log in in the browser" : "give the token in the secure form"}. Its tools appear only after that.`,
        };
      } catch (error) {
        return {
          isError: true,
          content: `Not installed: ${error instanceof RuntimeError || error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}

// ------------------------------------------------------------------ the connect card

export const SHOW_CONNECT_CARD_TOOL = "show_connect_card";

/** What the card offers: one button that fits where the connector stands. */
export const CONNECT_CARD_ACTIONS = [
  "connect",
  "authorize_app",
  "grant",
  "add_key",
  "manage",
] as const;
export type ConnectCardAction = (typeof CONNECT_CARD_ACTIONS)[number];

/**
 * Why a link may NOT be drawn on a connect card, or `undefined` when it may (owner, 24/11/2026:
 * "ele deveria ter usado um card"). The URL must be https, with no user name or password, and its host
 * must be EXACTLY one of `allowed` (the connector's declared hosts): never a pattern, never a part
 * of the text. Parsed with the URL class; nothing is read from the text around it.
 */
export function connectLinkProblem(
  url: string,
  allowed: readonly string[],
  /** The first path segment every link of the service starts with (`link` for Composio), if any. */
  firstSegment?: string | undefined,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The url is not a valid address.";
  }
  if (parsed.protocol !== "https:") return "The url must be https.";
  if (parsed.username !== "" || parsed.password !== "") return "The url must not carry a login.";
  if (parsed.port !== "") return "The url must use the default https port.";
  if (!allowed.includes(parsed.hostname)) {
    return `The host ${parsed.hostname} is not one this connector declares (${allowed.join(", ") || "none"}). Do not put it on a card.`;
  }
  if (firstSegment !== undefined && parsed.pathname.split("/")[1] !== firstSegment) {
    return `The link must start with /${firstSegment}/ on ${parsed.hostname}. Do not put it on a card.`;
  }
  return undefined;
}

const cardInput = z.object({
  connector: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe("The exact name of an INSTALLED connector (for a gallery entry, its id)."),
  app: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe('The app inside the connector, as the user knows it, e.g. "Google Agenda".'),
  url: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("The connect or authorization link the connector returned, exactly as it came."),
  expiresAt: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("When the link stops working (ISO 8601), if the service said."),
  action: z
    .enum(CONNECT_CARD_ACTIONS)
    .describe(
      "What is missing: connect (log in to the connector), authorize_app (an app inside it needs the user's authorization: give url), grant (give a bot access), add_key (its key), manage (just show it).",
    ),
});

/**
 * `show_connect_card`: the way to hand the user a link or a button to connect, authorize, give access
 * or add a key. The user sees a CARD with one button; the link is never written in a message. The
 * link is checked here (https, a host the connector declares) and again by the app.
 */
export function showConnectCardTool(gallery: () => ConnectorGallery) {
  return defineTool({
    name: SHOW_CONNECT_CARD_TOOL,
    description:
      "Shows the user a card with ONE button to connect, authorize an app, give a bot access, add a key or manage an installed connector. ALWAYS use it whenever you give the user a link or an action to connect, authorize or log in: never write such a link in a message. Pass the connect link the connector returned in `url` (it must belong to the connector's own service). The card is the whole message: do not repeat the link. Opening a link does not finish the connection: after it, check again with the connector's own tool (for Composio, COMPOSIO_MANAGE_CONNECTIONS).",
    input: cardInput,
    risk: "read",
    ownOutput: true,
    describe: ({ connector, app }) => `Mostrar o cartão de ${app ?? connector}`,
    async execute({ connector, url, action, expiresAt }) {
      try {
        const info = await gallery().connectCardInfo(connector);
        if (info === undefined) {
          return {
            isError: true,
            content: `There is no installed connector named "${connector}". If it is in the gallery, call propose_connector first.`,
          };
        }
        if (action === "authorize_app" && url === undefined) {
          return { isError: true, content: "authorize_app needs the link in `url`." };
        }
        if (url !== undefined) {
          const problem = connectLinkProblem(url, info.hosts, info.firstSegment);
          if (problem !== undefined) return { isError: true, content: problem };
        }
        if (expiresAt !== undefined && Number.isNaN(Date.parse(expiresAt))) {
          return { isError: true, content: "expiresAt must be a date (ISO 8601)." };
        }
        return {
          content: `The card is shown to the user (${action}). Do not write the link or repeat the card: wait for the user to act on it.`,
        };
      } catch (error) {
        return {
          isError: true,
          content: `The card was not shown: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
