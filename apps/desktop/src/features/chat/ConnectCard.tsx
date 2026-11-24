import type { CatalogItem, Connector } from "@suup/api";
import { BadgeCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import type { ConnectCardItem } from "../../data/connect-cards.js";
import { linkAllowed, linkExpired } from "../../lib/connect-link.js";
import { MutedText, Pill } from "../../ui/primitives.js";
import { appearanceOf } from "../plugins/appearance.js";
import { EntryIcon } from "../plugins/EntryIcon.js";
import { useConnect } from "../plugins/use-connect.js";
import { usePlugins } from "../plugins/use-plugins.js";
import { SecretDialog } from "../settings/VaultSettings.js";

/** The hosts a link on this card may point to: the gallery entry's and the connector's own. */
function hostsOf(item: CatalogItem | undefined, connector: Connector | undefined): string[] {
  const hosts = new Set<string>([
    ...(item?.entry.egressHosts ?? []),
    ...(item?.entry.authHosts ?? []),
  ]);
  if (connector?.transport.kind === "http") {
    try {
      hosts.add(new URL(connector.transport.url).hostname);
    } catch {
      // not an address: no host from it
    }
  } else if (connector?.transport.kind === "stdio") {
    for (const host of connector.transport.egressHosts ?? []) hosts.add(host);
  }
  return [...hosts];
}

/** How often a card with something still missing asks the server again. */
const REFRESH_MS = 3000;

const STATUS_WORDS: Record<CatalogItem["status"], string> = {
  available: "Ainda não instalado",
  unverified: "Em breve",
  needs_login: "Precisa entrar",
  needs_secret: "Falta a chave",
  connected: "Conectado",
  off: "Desligado",
  error: "Não conectou",
};

/** The action buttons of the card that need the gallery item (connect in place, add the key, turn on). */
function useCardAction(item: CatalogItem | undefined, reload: () => Promise<void>) {
  const { api, sync } = useServices();
  const [grantError, setGrantError] = useState<string | undefined>(undefined);
  const [granting, setGranting] = useState(false);
  const connect = useConnect(
    item ??
      ({
        entry: { id: "", auth: { kind: "oauth" } },
        status: "connected",
        connector: null,
      } as never),
    reload,
  );
  const grant = async (connectorName: string, botId: string) => {
    setGranting(true);
    setGrantError(undefined);
    const result = await sync.connectorCall(() =>
      api.connectors.grant(connectorName, botId, { tools: "all" }),
    );
    setGranting(false);
    if (!result.ok) setGrantError(result.message);
    else await reload();
  };
  return { connect, grant, granting, grantError };
}

/**
 * The card a bot hands over when something is missing (owner, 24/11/2026; docs/DESIGN.md, "Cartão
 * do conector no chat"): the brand tile, the name (with the verified mark when it is from our
 * gallery), where it stands in words, ONE button that fits (Conectar, Liberar para o bot, Adicionar
 * chave, Ligar, or the connect link's own button) and "Gerenciar", which opens the plugin page. The
 * link is only a button: its address and query are never on screen.
 */
export function ConnectCard({ card, botName }: { card: ConnectCardItem; botName: string }) {
  const { platform, sync } = useServices();
  const openPlugin = useUi((s) => s.openPlugin);
  const { items, reload } = usePlugins();
  useEffect(() => {
    void sync.loadConnectors();
  }, [sync]);
  const connector = useData((s) => s.connectors[card.connector]);
  const item = items?.find((i) => i.connector === card.connector);
  const name = item?.entry.name ?? card.connector;
  const look = item === undefined ? undefined : appearanceOf(item.entry.id);
  const { connect, grant, granting, grantError } = useCardAction(item, reload);
  const granted =
    connector?.grants.some((g) => g.botId === card.botId && (g.all || g.tools.length > 0)) ?? false;
  const hosts = hostsOf(item, connector);
  const link =
    card.url !== undefined && linkAllowed(card.url, hosts, item?.entry.authLinkSegment)
      ? card.url
      : undefined;
  const expired = link !== undefined && linkExpired(card.expiresAt, Date.now());
  const waiting = connect.flow.kind === "waiting" || connect.flow.kind === "busy";

  // What is missing, in words, and the one button that fixes it.
  let status: string;
  let primary: { label: string; run(): void } | undefined;
  if (link !== undefined) {
    status = expired ? "Expirou: peça outro" : "Falta autorizar";
    if (!expired) {
      primary = {
        label: `Conectar ${card.app ?? name}`,
        run: () => void platform.openUrl(link),
      };
    }
  } else if (item === undefined) {
    status =
      connector === undefined
        ? "Ainda não instalado"
        : connector.enabled
          ? "Conectado"
          : "Desligado";
  } else {
    status = STATUS_WORDS[item.status];
    if (item.status === "needs_login" || item.status === "error") {
      primary = { label: "Conectar", run: () => void connect.connect() };
    } else if (item.status === "needs_secret") {
      primary = { label: "Adicionar chave", run: () => void connect.connect() };
    } else if (item.status === "off") {
      primary = { label: "Ligar", run: () => void connect.turnOn() };
    }
  }
  // The card follows the server while something is still missing (the install of an approved
  // proposal, a login done in the browser, the connector turned on): it asks again now and then.
  const unsettled = primary !== undefined || item === undefined;
  useEffect(() => {
    if (!unsettled) return;
    const timer = setInterval(() => {
      void sync.loadConnectors();
      void reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [unsettled, sync, reload]);
  const missingAccess = connector?.enabled && !granted;
  if (
    primary === undefined &&
    link === undefined &&
    missingAccess &&
    item?.status !== "needs_login"
  ) {
    primary = {
      label: `Liberar para o ${botName}`,
      run: () => void grant(card.connector, card.botId),
    };
  }
  const line =
    link !== undefined
      ? status
      : item?.status === "connected" || (item === undefined && connector?.enabled === true)
        ? `${status} · ${granted ? `${botName} pode usar` : `${botName} ainda sem acesso`}`
        : status;

  return (
    <div className="flex flex-col gap-2" data-testid="connect-card" data-connector={card.connector}>
      <div
        className="flex items-center gap-3 rounded-card border border-border bg-surface p-3"
        data-action={card.action}
      >
        <EntryIcon
          id={item?.entry.id ?? card.connector}
          name={name}
          look={{ tone: look?.tone ?? "neutral", logo: look?.logo, glyph: "plug" }}
          size="lg"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-label font-label">
            <span className="truncate">
              {card.app === undefined ? name : `${name} · ${card.app}`}
            </span>
            {item !== undefined && (
              <BadgeCheck
                size={14}
                className="flex-none text-text-muted"
                aria-label="Da galeria do Suup"
              />
            )}
          </span>
          <span className="truncate text-small text-text-muted" data-testid="connect-card-status">
            {waiting ? "Aguardando login no navegador…" : line}
          </span>
        </div>
        {primary !== undefined && (
          <Pill
            tone="primary"
            size="sm"
            disabled={waiting || granting}
            data-testid="connect-card-primary"
            onClick={primary.run}
          >
            {primary.label}
          </Pill>
        )}
        <Pill
          size="sm"
          data-testid="connect-card-manage"
          onClick={() =>
            openPlugin(
              item === undefined
                ? { kind: "manual", id: card.connector, autoStart: false }
                : { kind: "catalog", id: item.entry.id, autoStart: false },
            )
          }
        >
          Gerenciar
        </Pill>
      </div>
      {(connect.error ?? grantError) !== undefined && (
        <MutedText as="p" role="alert" data-testid="connect-card-error">
          {connect.error ?? grantError}
        </MutedText>
      )}
      {link !== undefined && !expired && (
        <MutedText as="p" data-testid="connect-card-after">
          Depois de autorizar, me avise.
        </MutedText>
      )}
      <MutedText as="p" data-testid="connect-card-note">
        O {botName} sempre pergunta antes de fazer alterações. Desconecte quando quiser.
      </MutedText>
      {connect.flow.kind === "secret" && item?.entry.auth.kind === "token" && (
        <SecretDialog
          existing={undefined}
          preset={{
            name: item.entry.auth.secret,
            title: `Token do ${name}`,
            steps: item.entry.auth.steps,
          }}
          onSaved={() => void connect.secretSaved()}
          onClose={connect.closeSecret}
        />
      )}
    </div>
  );
}
