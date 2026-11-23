import type { CatalogItem, CatalogStatus } from "@suup/api";
import { ArrowRight, ChevronRight, LoaderCircle, Plug, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { fold } from "../../data/botlist.js";
import { messageOf } from "../../data/sync.js";
import { cx } from "../../lib/cx.js";
import { solidMarkFor } from "../../ui/brand-icons.js";
import {
  BulletList,
  Dialog,
  EmptyState,
  MutedText,
  Notice,
  Pill,
  SearchField,
} from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHead } from "../../ui/screen.js";
import { SecretDialog } from "../settings/VaultSettings.js";
import { type Appearance, appearanceOf, type Banner, CATEGORIES, type Tone } from "./appearance.js";
import { type Connect, POLL_MS, useConnect } from "./use-connect.js";

/** The twelve gradients of the banner of a page (the full class names, so Tailwind finds them). */
const BANNER_BG: Record<Banner, string> = {
  ink: "from-banner-ink-from to-banner-ink-to",
  slate: "from-banner-slate-from to-banner-slate-to",
  navy: "from-banner-navy-from to-banner-navy-to",
  plum: "from-banner-plum-from to-banner-plum-to",
  paper: "from-banner-paper-from to-banner-paper-to",
  sky: "from-banner-sky-from to-banner-sky-to",
  mint: "from-banner-mint-from to-banner-mint-to",
  sun: "from-banner-sun-from to-banner-sun-to",
  coral: "from-banner-coral-from to-banner-coral-to",
  amber: "from-banner-amber-from to-banner-amber-to",
  indigo: "from-banner-indigo-from to-banner-indigo-to",
  lilac: "from-banner-lilac-from to-banner-lilac-to",
};

/** The three backgrounds of a logo (the full class names, so Tailwind finds them). */
const TILE_BG: Record<Tone, string> = {
  neutral: "bg-raised",
  black: "bg-tile-black",
  white: "bg-tile-white",
  solid: "bg-raised",
};

/** What is drawn without a logo (the plug): the faded text on the grey, white on black, black on white. */
const PLUG_FG: Record<Tone, string> = {
  neutral: "text-text-muted",
  black: "text-tile-white",
  white: "text-tile-black",
  solid: "text-text-muted",
};

/** The rounded square and the logo inside it, per size. */
const TILE = {
  sm: { box: "size-avatar-sm rounded-chip ring-2 ring-bg", logo: "size-4" },
  lg: { box: "size-avatar-lg rounded-row", logo: "size-7" },
} as const;

/**
 * Where an entry stands, in words (docs/FRONTEND.md, "Galeria de conectores"); the status itself is
 * the server's. `waiting`: the browser login this screen opened.
 */
const STATE_TEXT: Record<CatalogStatus | "waiting", string> = {
  available: "Não conectado",
  unverified: "Em breve",
  needs_login: "Precisa entrar",
  needs_secret: "Falta o token",
  connected: "Conectado",
  off: "Desligado",
  error: "Não conectou",
  waiting: "Aguardando login…",
};

/**
 * Whether the browser login of this entry can come back to the server: always with the server on
 * this computer; on a VPS only when it has its public address (`GET /v1/info`, `oauthCallback`).
 * An entry already logged in (connected, or off with its login) needs no new login.
 */
function loginBlocked(item: CatalogItem, canLogIn: boolean): boolean {
  return (
    !canLogIn &&
    item.entry.auth.kind === "oauth" &&
    item.status !== "connected" &&
    item.status !== "off"
  );
}

/** Why a login cannot be offered: one friendly sentence (docs/DESIGN.md §5d). */
const NEEDS_PUBLIC_ADDRESS =
  "Para conectar pelo login, a sua VPS precisa ter o endereço público configurado.";

/** The main action of an entry as it stands; none: nothing to do from here. */
function actionOf(item: CatalogItem, canLogIn: boolean): string | undefined {
  if (loginBlocked(item, canLogIn)) return undefined;
  switch (item.status) {
    case "available":
      return "Conectar";
    case "needs_login":
      return "Fazer login";
    case "needs_secret":
      return "Informar token";
    case "error":
      return "Tentar de novo";
    case "off":
      return "Ligar";
    default:
      return undefined;
  }
}

/** One entry of the server, with the look the app gives its id. */
interface Entry {
  item: CatalogItem;
  look: Appearance;
}

/**
 * The service's tile, as in the reference the owner gave (23/11/2026). A `solid` brand (its logo is
 * one colour: Linear, Stack Overflow): the brand's OWN primary colour as the background (the `hex`
 * of the package) and its mark in white over it. Any other: the logo in its own colours (an `<img>`
 * of an SVG copied from thesvg, `assets/brand/`) on a neutral background (the project's grey, or the
 * black or white the brand's own icon has). An entry with no look of its own gets the plug.
 */
function EntryIcon({ entry, size }: { entry: Entry; size: keyof typeof TILE }) {
  const tile = TILE[size];
  const id = entry.item.entry.id;
  const tone = entry.look.tone;
  const solid = tone === "solid" ? solidMarkFor(id) : undefined;
  const box = cx(
    "inline-flex flex-none items-center justify-center border border-border",
    tile.box,
  );
  if (solid !== undefined) {
    return (
      <span className={box} style={{ backgroundColor: `#${solid.hex}` }} aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cx("text-tile-white", tile.logo)}
          data-brand={id}
        >
          <title>{entry.item.entry.name}</title>
          <path d={solid.path} />
        </svg>
      </span>
    );
  }
  return (
    <span className={cx(box, TILE_BG[tone])} aria-hidden="true">
      {entry.look.logo === undefined ? (
        <Plug className={cx(PLUG_FG[tone], tile.logo)} strokeWidth={1.5} />
      ) : (
        <img
          src={entry.look.logo}
          alt=""
          draggable={false}
          data-logo={id}
          className={cx("flex-none object-contain", tile.logo)}
        />
      )}
    </span>
  );
}

/** The small tag of where an entry stands: a dot and the words (the dot is the text's own grey). */
function StateTag({
  state,
  title,
}: {
  state: CatalogStatus | "waiting";
  title?: string | undefined;
}) {
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small whitespace-nowrap"
      data-testid="connector-state"
      data-state={state}
      title={title}
    >
      <span
        className={cx(
          "size-1.5 rounded-full",
          state === "connected" ? "bg-success-text" : "bg-text-muted",
        )}
        aria-hidden="true"
      />
      {STATE_TEXT[state]}
    </span>
  );
}

/**
 * "Meus conectores", at the head of the screen: a label and the logos of the entries the server says
 * are connected, side by side and stacked, the first at the right and each next one a little to its
 * left, over it. It opens the user's connectors (Configurações > Conectores).
 */
function MyConnectors({ entries, onOpen }: { entries: Entry[]; onOpen(): void }) {
  const mine = entries.filter((e) => e.item.status === "connected").slice(0, 4);
  return (
    <button
      type="button"
      className="inline-flex h-control items-center gap-3 rounded-pill border border-border bg-transparent py-1 pr-1.5 pl-3 text-label text-text hover:bg-hover"
      data-testid="connectors-mine"
      onClick={onOpen}
    >
      Meus conectores
      {mine.length > 0 && (
        <span className="flex flex-row-reverse items-center">
          {mine.map((entry, i) => (
            <span
              key={entry.item.entry.id}
              className={i === 0 ? "inline-flex" : "-mr-1.5 inline-flex"}
              data-testid="connectors-mine-icon"
              data-plugin={entry.item.entry.id}
            >
              <EntryIcon entry={entry} size="sm" />
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** One line of the list: the logo, the name with one faded line under it, and its action or state. */
function Row({
  entry,
  canLogIn,
  onOpen,
  onAction,
}: {
  entry: Entry;
  canLogIn: boolean;
  onOpen(): void;
  onAction(): void;
}) {
  const { item } = entry;
  const action = actionOf(item, canLogIn);
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-card pr-2 hover:bg-hover"
      data-testid="connector-item"
      data-plugin={item.entry.id}
      data-status={item.status}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-4 rounded-card border-0 bg-transparent p-3 text-left text-text"
        onClick={onOpen}
      >
        <EntryIcon entry={entry} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label font-label">{item.entry.name}</span>
          <span className="truncate text-small text-text-muted">{item.entry.description}</span>
        </span>
      </button>
      {item.status !== "available" && <StateTag state={item.status} />}
      {action !== undefined && (
        <Pill
          tone="quiet"
          size="sm"
          icon={item.status === "available" ? <Plus size={14} aria-hidden="true" /> : undefined}
          aria-label={`${action} ${item.entry.name}`}
          data-testid="connector-connect"
          data-plugin={item.entry.id}
          onClick={onAction}
        >
          {action}
        </Pill>
      )}
    </li>
  );
}

/** A titled block of the page: a faded label of 30 px and what it holds. */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1" aria-label={title}>
      <h2 className="flex h-7.5 items-center text-label font-normal text-text-muted">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The browser login is open: the app waits for the server, says so, and lets the person cancel or
 * open the page again. The browser comes back to the server by itself: nothing to paste.
 */
function Waiting({ connect }: { connect: Connect }) {
  return (
    <div className="flex flex-col gap-3" data-testid="connector-waiting" aria-live="polite">
      <div className="flex items-center gap-2 text-body">
        <LoaderCircle size={16} className="animate-spin text-text-muted" aria-hidden="true" />
        Aguardando login no navegador…
      </div>
      <MutedText as="p">
        Entre com a sua conta na página que abriu; esta tela muda sozinha.
      </MutedText>
      <div className="flex flex-wrap items-center gap-2">
        <Pill size="sm" onClick={connect.reopen} data-testid="connector-reopen">
          Abrir a página de login de novo
        </Pill>
        <Pill size="sm" tone="quiet" onClick={connect.cancel} data-testid="connector-cancel">
          Cancelar
        </Pill>
      </div>
    </div>
  );
}

/**
 * What the "Conexão" block says about the entry as it stands: one plain sentence, from the status
 * the server declares (never its raw `detail`, which is a log: docs/DESIGN.md, "Amigável").
 */
function ConnectionText({ item, canLogIn }: { item: CatalogItem; canLogIn: boolean }) {
  const { entry } = item;
  const text = (() => {
    if (item.status === "unverified")
      return entry.unverifiedReason ?? "Ainda não dá para conectar.";
    if (item.status === "connected") {
      return entry.auth.kind === "token"
        ? "Conectado com o seu token, guardado com segurança."
        : `Conectado com a sua conta do ${entry.name}.`;
    }
    if (item.status === "off") return "Conectado, mas desligado.";
    if (loginBlocked(item, canLogIn)) return NEEDS_PUBLIC_ADDRESS;
    if (item.status === "error")
      return `Não deu para falar com o ${entry.name} agora. Tenta de novo?`;
    if (item.status === "needs_secret") return `Falta guardar o seu token do ${entry.name}.`;
    if (item.status === "needs_login") return `Entre de novo com a sua conta do ${entry.name}.`;
    return entry.auth.kind === "oauth"
      ? `Entre com a sua conta do ${entry.name} no navegador.`
      : entry.auth.kind === "token"
        ? `Crie um token no ${entry.name} e guarde aqui; o bot nunca vê o valor.`
        : `Precisa de um app seu no ${entry.name}.`;
  })();
  return (
    <MutedText as="p" data-testid="connector-connection-text">
      {text}
    </MutedText>
  );
}

/** The main button of the page as the entry stands (or the flow this page is running). */
function MainAction({
  entry,
  connect,
  canLogIn,
}: {
  entry: Entry;
  connect: Connect;
  canLogIn: boolean;
}) {
  const { item } = entry;
  const { flow } = connect;
  const name = item.entry.name;
  if (flow.kind === "busy" || flow.kind === "waiting") {
    return (
      <Pill tone="primary" disabled aria-busy="true" data-testid="connector-main">
        {flow.kind === "busy" ? flow.label : "Aguardando…"}
      </Pill>
    );
  }
  if (item.status === "connected") {
    if (item.entry.auth.kind === "oauth") {
      return (
        <Pill tone="danger" onClick={connect.askDisconnect} data-testid="connector-main">
          Desconectar
        </Pill>
      );
    }
    if (item.entry.auth.kind === "token") {
      return (
        <Pill onClick={connect.changeToken} data-testid="connector-main">
          Trocar o token
        </Pill>
      );
    }
    return null;
  }
  if (item.status === "unverified" || loginBlocked(item, canLogIn)) {
    return (
      <Pill
        tone="primary"
        disabled
        title={
          item.status === "unverified"
            ? (item.entry.unverifiedReason ?? "Em breve")
            : NEEDS_PUBLIC_ADDRESS
        }
        aria-label={`Conectar ${name}`}
        data-testid="connector-main"
      >
        Conectar
      </Pill>
    );
  }
  const action = actionOf(item, canLogIn);
  if (action === undefined) return null;
  return (
    <Pill
      tone="primary"
      onClick={() => void (item.status === "off" ? connect.turnOn() : connect.connect())}
      aria-label={`${action} ${name}`}
      data-testid="connector-main"
    >
      {action}
    </Pill>
  );
}

/**
 * The page of one service, in the same screen in place of the list (owner, 23/11/2026), laid out as
 * the reference he gave: the way back ("Conectores > name"), the head (logo, name, where it stands,
 * the line and the main action), a band, with the gradient FIXED for this connector, with examples of
 * what to ask, then "Conexão" (how to connect, the login in progress, the third-party notice) and
 * "Bom saber" (the server's notes, in plain words). Nothing technical: no address, licence, hosts or
 * dates (the owner, 23/11/2026: "a ideia é ser friendly").
 */
function ConnectorPage({
  entry,
  onBack,
  reload,
  autoStart,
  pollMs,
  canLogIn,
}: {
  entry: Entry;
  onBack(): void;
  reload(): Promise<void>;
  /** The line's button was clicked: start its action as the page opens. */
  autoStart: boolean;
  pollMs: number;
  /** Whether the browser login can come back to the server (see `loginBlocked`). */
  canLogIn: boolean;
}) {
  const openSettings = useUi((s) => s.openSettings);
  const setSettingsConnector = useUi((s) => s.setSettingsConnector);
  const { item, look } = entry;
  const connect = useConnect(item, reload, pollMs);
  const { flow } = connect;
  const name = item.entry.name;
  const state: CatalogStatus | "waiting" = flow.kind === "waiting" ? "waiting" : item.status;

  // The action of the line that opened this page runs once, as the page opens (the ref keeps a
  // second run of the effect, as React's strict mode does, from starting it twice).
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    if (loginBlocked(item, canLogIn)) return;
    if (item.status === "off") void connect.turnOn();
    else void connect.connect();
  }, [autoStart, item, canLogIn, connect]);

  return (
    <Screen data-testid="connector-page" data-plugin={item.entry.id}>
      <header className="flex flex-none flex-col gap-4 px-6 pt-5 pb-3" data-tauri-drag-region>
        <nav aria-label="Caminho" className="flex items-center gap-1 text-small">
          <button
            type="button"
            className="rounded-pill border-0 bg-transparent px-2 py-1 text-text-muted hover:bg-hover hover:text-text"
            onClick={onBack}
            data-testid="connector-back"
          >
            Conectores
          </button>
          <ChevronRight size={14} className="text-text-muted" aria-hidden="true" />
          <span aria-current="page" className="px-2 py-1">
            {name}
          </span>
        </nav>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <EntryIcon entry={entry} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-3">
                <h1 className="text-heading font-title">{name}</h1>
                <StateTag state={state} />
              </div>
              <MutedText>{item.entry.description}</MutedText>
            </div>
          </div>
          <MainAction entry={entry} connect={connect} canLogIn={canLogIn} />
        </div>
      </header>
      <ScreenBody>
        {look.examples.length > 0 && (
          <section
            className={cx(
              "flex flex-col gap-2 rounded-card bg-linear-to-br p-4",
              BANNER_BG[look.banner],
            )}
            data-banner={look.banner}
            aria-label="Exemplos do que você poderá pedir"
            data-testid="connector-examples"
          >
            {look.examples.map((text) => (
              <div
                key={text}
                className="flex items-center gap-3 rounded-row bg-surface px-3 py-2.5 text-body"
              >
                <span className="inline-flex flex-none items-center gap-1.5 rounded-chip bg-raised px-2 py-0.5 text-small">
                  {name}
                </span>
                <span className="min-w-0 flex-1">{text}</span>
                <ArrowRight size={16} className="flex-none text-text-muted" aria-hidden="true" />
              </div>
            ))}
          </section>
        )}
        <Block title="Conexão">
          <div
            className="flex flex-col gap-3 rounded-card bg-raised p-3"
            data-testid="connector-connection"
          >
            <div className="flex items-center gap-3">
              <EntryIcon entry={entry} size="lg" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label font-label">{name}</span>
                <ConnectionText item={item} canLogIn={canLogIn} />
              </div>
            </div>
            {item.entry.auth.kind === "oauth_owner_client" &&
              item.status !== "unverified" &&
              item.entry.auth.steps.length > 0 && (
                <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-small">
                  {item.entry.auth.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
            {item.entry.disclosure !== null && item.status !== "connected" && (
              <Notice role="note" data-testid="connector-disclosure">
                {item.entry.disclosure}
              </Notice>
            )}
            {flow.kind === "waiting" && <Waiting connect={connect} />}
            {connect.error !== undefined && (
              <Notice role="alert" data-testid="connector-error">
                {connect.error}
              </Notice>
            )}
            {item.connector !== null && (
              <div className="flex flex-wrap items-center gap-3">
                <MutedText>
                  Cada bot só usa o conector com a sua permissão, por ferramenta.
                </MutedText>
                <Pill
                  size="sm"
                  onClick={() => {
                    openSettings("connectors");
                    setSettingsConnector(item.connector);
                  }}
                  data-testid="connector-open-settings"
                >
                  Escolher os bots que podem usar
                </Pill>
              </div>
            )}
          </div>
        </Block>
        {item.entry.notes.length > 0 && (
          <Block title="Bom saber">
            <div className="rounded-card bg-raised p-4 text-body">
              <BulletList data-testid="connector-notes">
                {item.entry.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </BulletList>
            </div>
          </Block>
        )}
      </ScreenBody>
      {flow.kind === "secret" && item.entry.auth.kind === "token" && (
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
      {flow.kind === "confirm-disconnect" && (
        <Dialog
          title={`Desconectar o ${name}?`}
          onClose={connect.closeDisconnect}
          footer={
            <>
              <Pill tone="secondary" onClick={connect.closeDisconnect}>
                Cancelar
              </Pill>
              <Pill
                tone="danger"
                onClick={() => void connect.disconnect()}
                data-testid="connector-disconnect"
              >
                Desconectar
              </Pill>
            </>
          }
        >
          <MutedText as="p">Seus bots deixam de usar o {name} até você entrar de novo.</MutedText>
        </Dialog>
      )}
    </Screen>
  );
}

/**
 * The connectors, in a screen of its own in place of the chat and the bot's panel (docs/DESIGN.md
 * §5d; owner, 23/11/2026, with the reference he gave): the title and its line, "Meus conectores" and
 * "Conector personalizado" (both open Configurações > Conectores, where a connector is made and
 * granted), a search field, and the entries of the server's gallery (`GET /v1/connector-catalog`,
 * in its order) by section, two columns, each line with its action or where it stands. Choosing one
 * shows its page in this same screen. The look of each entry comes from `appearance.ts`, by its id.
 */
export function ConnectorsScreen({ pollMs = POLL_MS }: { pollMs?: number } = {}) {
  const { api, mode } = useServices();
  const openSettings = useUi((s) => s.openSettings);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [callback, setCallback] = useState<"loopback" | "public" | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<{ id: string; autoStart: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await api.connectorCatalog.list());
      setLoadError(undefined);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Where the browser comes back from a login: the server on this computer always takes it; a VPS
  // only with its public address (docs/CONECTORES.md, "OAuth do MCP").
  useEffect(() => {
    if (mode === "local") return;
    api.info().then(
      (info) => setCallback(info.oauthCallback),
      () => setCallback(undefined),
    );
  }, [api, mode]);
  const canLogIn = mode === "local" || callback === "public";

  // Esc goes back from a page to the list (unless a dialog is open on top).
  useEffect(() => {
    if (chosen === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.querySelector('[aria-modal="true"]') === null) {
        setChosen(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chosen]);

  const entries = useMemo<Entry[]>(
    () => (items ?? []).map((item) => ({ item, look: appearanceOf(item.entry.id) })),
    [items],
  );
  const q = fold(query.trim());
  const sections = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        entries: entries.filter(
          (e) =>
            e.look.category === category &&
            (q === "" ||
              fold(`${e.item.entry.name} ${e.item.entry.description} ${category}`).includes(q)),
        ),
      })).filter((s) => s.entries.length > 0),
    [entries, q],
  );

  const page = chosen === null ? undefined : entries.find((e) => e.item.entry.id === chosen.id);
  if (chosen !== null && page !== undefined) {
    return (
      <ConnectorPage
        key={page.item.entry.id}
        entry={page}
        onBack={() => setChosen(null)}
        reload={reload}
        autoStart={chosen.autoStart}
        pollMs={pollMs}
        canLogIn={canLogIn}
      />
    );
  }
  return (
    <Screen data-testid="connectors-screen">
      <ScreenHead
        title="Conectores"
        subtitle="Conecte as ferramentas e os serviços com que seus bots trabalham."
        action={
          <div className="flex items-center gap-3">
            <MyConnectors entries={entries} onOpen={() => openSettings("connectors")} />
            <Pill
              tone="primary"
              icon={<Plus size={16} aria-hidden="true" />}
              onClick={() => openSettings("connectors")}
              data-testid="connectors-add-custom"
            >
              Conector personalizado
            </Pill>
          </div>
        }
      />
      <ScreenBody>
        <SearchField
          label="Buscar conectores"
          value={query}
          onChange={setQuery}
          placeholder="Buscar"
          className="max-w-search"
          testId="connectors-search"
        />
        {loadError !== undefined && (
          <Notice role="alert" data-testid="connectors-load-error">
            {loadError}
            <div>
              <Pill size="sm" onClick={() => void reload()}>
                Tentar de novo
              </Pill>
            </div>
          </Notice>
        )}
        {items === null && loadError === undefined && (
          <MutedText as="p" aria-busy="true">
            Carregando a galeria…
          </MutedText>
        )}
        {items !== null && sections.length === 0 && (
          <EmptyState
            title="Nenhum conector encontrado"
            text={
              items.length === 0
                ? "Ainda não há conectores por aqui."
                : "Tente outro nome ou limpe a busca."
            }
          />
        )}
        {sections.map(({ category, entries: list }) => (
          <section
            key={category}
            className="flex flex-col gap-2"
            aria-label={category}
            data-testid="connectors-section"
            data-category={category}
          >
            <h2 className="flex items-baseline gap-2 px-1 text-label font-title">
              {category}
              <span className="text-small font-normal text-text-muted">{list.length}</span>
            </h2>
            <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 narrow:grid-cols-1">
              {list.map((entry) => (
                <Row
                  key={entry.item.entry.id}
                  entry={entry}
                  canLogIn={canLogIn}
                  onOpen={() => setChosen({ id: entry.item.entry.id, autoStart: false })}
                  // An entry with a third-party notice opens its page first: the notice is read
                  // before connecting (docs/FRONTEND.md).
                  onAction={() =>
                    setChosen({
                      id: entry.item.entry.id,
                      autoStart: entry.item.entry.disclosure === null,
                    })
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </ScreenBody>
    </Screen>
  );
}
