// Owns the network allowlist as people and the loop use it: the global defaults (configuration),
// each bot's own hosts (database), the grants of one run (what an approved card creates), and what
// the proxy refused. It is the policy the egress proxy asks, and the service behind `suup network`
// and the API. Names are validated by the same function the proxy decides with (`core/network`).
import { parseAllowlistHost } from "@suup/core";
import {
  activeHostsForBot,
  addBotHost,
  type Db,
  getBot,
  getConnector,
  grantRunHost,
  listBotHosts,
  listNetworkEvents,
  type NetworkEventRow,
  type NetworkHostRow,
  recordNetworkEvent,
  removeBotHost,
} from "@suup/db";
import type { EgressEvent, EgressPolicy } from "@suup/sandbox";
import { DEFAULT_ALLOWED_HOSTS } from "../config.js";
import { RuntimeError } from "../errors.js";

export interface BotNetworkView {
  /** The hosts every bot may reach (configuration). */
  defaults: string[];
  /** The hosts added for this bot, until removed. */
  hosts: NetworkHostRow[];
  /** What the proxy refused for this bot, newest first. */
  refusals: NetworkEventRow[];
}

export interface NetworkService {
  readonly policy: EgressPolicy;
  defaults(): string[];
  forBot(botId: string, options?: { refusals?: number }): Promise<BotNetworkView>;
  /** Adds an exact host for the bot (an act of the user). `added: false`: it was already there. */
  allow(botId: string, host: string): Promise<{ host: string; added: boolean }>;
  /** Removes the host the bot had of its own. */
  remove(botId: string, host: string): Promise<boolean>;
  /** Allows a host for one run (an approved card). */
  allowForRun(
    botId: string,
    runId: string,
    host: string,
  ): Promise<{ host: string; added: boolean }>;
  /** Records a decision of the proxy (refusals only are stored). */
  record(event: EgressEvent): void;
}

function checked(raw: string): string {
  const parsed = parseAllowlistHost(raw);
  if (!parsed.ok) throw new RuntimeError("invalid_input", `Host inválido: ${parsed.message}.`);
  return parsed.host;
}

export function createNetworkService(options: {
  db: () => Db;
  defaultHosts?: readonly string[] | undefined;
}): NetworkService {
  const defaults = [...new Set(options.defaultHosts ?? DEFAULT_ALLOWED_HOSTS)];
  const mustBot = async (botId: string): Promise<void> => {
    if ((await getBot(options.db(), botId)) === null) {
      throw new RuntimeError("bot_not_found", `Bot ${botId} não encontrado.`);
    }
  };
  return {
    defaults: () => [...defaults],
    policy: {
      async allowedHosts(subject) {
        const hosts = new Set(defaults);
        if (subject.kind === "bot") {
          for (const host of await activeHostsForBot(options.db(), subject.id)) hosts.add(host);
        } else if (subject.kind === "connector") {
          // The defaults (the package registries: `npx` and `uvx` fetch the server itself) plus
          // the hosts this connector was given.
          for (const host of (await getConnector(options.db(), subject.id))?.egressHosts ?? []) {
            hosts.add(host);
          }
        } else {
          hosts.clear(); // the harness (doctor) is allowed nothing: it only probes refusals
        }
        return hosts;
      },
    },
    async forBot(botId, opts = {}) {
      await mustBot(botId);
      const db = options.db();
      return {
        defaults: [...defaults],
        hosts: await listBotHosts(db, botId),
        refusals: await listNetworkEvents(db, { kind: "bot", id: botId }, opts.refusals ?? 20),
      };
    },
    async allow(botId, raw) {
      const host = checked(raw);
      await mustBot(botId);
      return { host, added: await addBotHost(options.db(), botId, host) };
    },
    async remove(botId, raw) {
      return removeBotHost(options.db(), botId, checked(raw));
    },
    async allowForRun(botId, runId, raw) {
      const host = checked(raw);
      return { host, added: await grantRunHost(options.db(), botId, runId, host) };
    },
    record(event) {
      if (event.decision !== "refused") return;
      void recordNetworkEvent(options.db(), {
        subjectKind: event.subject.kind,
        subjectId: event.subject.id,
        host: event.host,
        port: event.port,
        reason: event.reason ?? "refused",
        message: event.message ?? "",
      }).catch(() => {
        // the audit row is best effort: a refusal is already enforced and shown in the tool result
      });
    },
  };
}
