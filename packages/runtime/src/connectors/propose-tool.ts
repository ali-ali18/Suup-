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
  const server = entry.transport?.kind === "http" ? ` Servidor: ${entry.transport.url}.` : "";
  return `Instalar o conector ${entry.name} da galeria (${entry.source}): ${entry.description}${server} Login: ${AUTH_TEXT[entry.auth.kind]}. Fica desligado até você entrar em Configurações > Conectores.`;
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

export function proposeConnectorTool(gallery: () => ConnectorGallery) {
  return defineTool({
    name: PROPOSE_CONNECTOR_TOOL,
    description:
      "Proposes that the user install ONE connector of the Suup gallery (a vetted list of services), by its exact id. The user sees a card and decides; if approved it is installed OFF: tell the user to finish the login in Settings > Connectors. Nothing outside the gallery can be installed, and you never get the user's tokens.",
    input,
    // Installing a program that talks to an outside service: always a card, unless a rule says so.
    risk: "external_irreversible",
    ownOutput: true,
    describe: ({ connector }) => {
      const entry = catalogEntry(connector);
      return entry === undefined
        ? `Instalar o conector ${connector} (não existe na galeria: será recusado).`
        : proposalCardLine(entry);
    },
    async execute({ connector }) {
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
        const { item } = await gallery().install(entry.id, { origin: "proposal" });
        const already = item.status === "connected" || item.status === "off";
        return {
          content: already
            ? `${entry.name} was already installed (connector "${item.connector}"). Tell the user they can manage it in Settings > Connectors.`
            : `${entry.name} is installed and turned OFF (connector "${item.connector}"). Tell the user to open Settings > Connectors and click Connect on ${entry.name} to ${entry.auth.kind === "oauth" ? "log in in the browser" : "give the token in the secure form"}. Its tools appear only after that, and after the user gives them to a bot.`,
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
