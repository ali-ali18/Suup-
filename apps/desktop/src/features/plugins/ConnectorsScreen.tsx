import { ArrowRight, ChevronRight, ExternalLink, Plug, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { fold } from "../../data/botlist.js";
import { cx } from "../../lib/cx.js";
import { solidMarkFor } from "../../ui/brand-icons.js";
import { EmptyState, MutedText, Pill, TextField } from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHead } from "../../ui/screen.js";
import { CATALOG, CATEGORIES, type CatalogEntry, type Tone, toneOf } from "./catalog.js";

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
 * The service's tile, as in the reference the owner gave (23/11/2026). A `solid` brand (its logo is
 * one colour: Trello, Todoist, Discord): the brand's OWN primary colour as the background (the `hex`
 * of the package) and its mark in white over it. Any other: the logo in its own colours (an `<img>`
 * of an SVG copied from thesvg, `assets/brand/`) on a neutral background (the project's grey, or the
 * black or white the brand's own icon has). The one without a logo yet (Higgsfield) gets the plug.
 */
function EntryIcon({ entry, size }: { entry: CatalogEntry; size: keyof typeof TILE }) {
  const tile = TILE[size];
  const tone = toneOf(entry);
  const solid = tone === "solid" ? solidMarkFor(entry.id) : undefined;
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
          data-brand={entry.id}
        >
          <path d={solid.path} />
        </svg>
      </span>
    );
  }
  return (
    <span className={cx(box, TILE_BG[tone])} aria-hidden="true">
      {entry.logo === undefined ? (
        <Plug className={cx(PLUG_FG[tone], tile.logo)} strokeWidth={1.5} />
      ) : (
        <img
          src={entry.logo}
          alt=""
          draggable={false}
          data-logo={entry.id}
          className={cx("flex-none object-contain", tile.logo)}
        />
      )}
    </span>
  );
}

/** The logos "Meus conectores" stacks, in the order they stack (the first at the right). */
const MINE_STACK = ["github", "figma", "gmail", "google-drive"];

/**
 * "Meus conectores", at the head of the screen: a label and the logos of the user's connectors side
 * by side and stacked, the first at the right and each next one a little to its left, over it. The
 * backend cannot connect a service yet, so it is an ornament (docs/DESIGN.md, Princípios, "Enfeite"):
 * dimmed, out of the reading order and of the Tab order, and it opens nothing.
 */
function MyConnectors() {
  return (
    <span
      className="inline-flex items-center gap-3 rounded-pill border border-border py-1 pr-1.5 pl-3 text-label opacity-60"
      aria-hidden="true"
      data-testid="connectors-mine"
    >
      Meus conectores
      <span className="flex flex-row-reverse items-center">
        {MINE_STACK.flatMap((id) => CATALOG.filter((e) => e.id === id)).map((entry, i) => (
          <span
            key={entry.id}
            className={i === 0 ? "inline-flex" : "-mr-1.5 inline-flex"}
            data-testid="connectors-mine-icon"
            data-plugin={entry.id}
          >
            <EntryIcon entry={entry} size="sm" />
          </span>
        ))}
      </span>
    </span>
  );
}

/** The button that connects: off (the ornament, "Em breve"), as the backend cannot connect yet. */
function ConnectButton({ entry, primary }: { entry: CatalogEntry; primary?: boolean }) {
  return (
    <Pill
      tone={primary === true ? "primary" : "quiet"}
      size={primary === true ? "md" : "sm"}
      disabled
      title="Em breve"
      icon={primary === true ? undefined : <Plus size={14} aria-hidden="true" />}
      aria-label={`Conectar ${entry.name}`}
      data-testid="connector-connect"
      data-plugin={entry.id}
    >
      Conectar
    </Pill>
  );
}

/** One line of the list: the logo, the name with one faded line under it, and "+ Conectar". */
function Row({ entry, onOpen }: { entry: CatalogEntry; onOpen(): void }) {
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-card pr-2 hover:bg-hover"
      data-testid="connector-item"
      data-plugin={entry.id}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-4 rounded-card border-0 bg-transparent p-3 text-left text-text"
        onClick={onOpen}
      >
        <EntryIcon entry={entry} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label font-label">{entry.name}</span>
          <span className="truncate text-small text-text-muted">{entry.about}</span>
        </span>
      </button>
      <ConnectButton entry={entry} />
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
 * The page of one service, in the same screen in place of the list (owner, 23/11/2026), laid out as
 * the reference he gave: the way back ("Conectores > name"), the head (logo, name, state "Não
 * conectado", the line and "Conectar"), a band with examples of what to ask, then "Conexão" and
 * "Informações". Nothing is connected: the button is off (ornament) and the examples are
 * illustrations. What works today is in Configurações > Conectores, and the page says so.
 */
function ConnectorPage({ entry, onBack }: { entry: CatalogEntry; onBack(): void }) {
  const { platform } = useServices();
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Screen data-testid="connector-page" data-plugin={entry.id}>
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
            {entry.name}
          </span>
        </nav>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <EntryIcon entry={entry} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-3">
                <h1 className="text-heading font-title">{entry.name}</h1>
                <span
                  className="inline-flex items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small"
                  data-testid="connector-state"
                >
                  <span className="size-1.5 rounded-full bg-text-muted" aria-hidden="true" />
                  Não conectado
                </span>
              </div>
              <MutedText>{entry.about}</MutedText>
            </div>
          </div>
          <ConnectButton entry={entry} primary />
        </div>
      </header>
      <ScreenBody limit="wide">
        <section
          className="flex flex-col gap-2 rounded-card bg-raised p-4"
          aria-label="Exemplos do que você poderá pedir"
          data-testid="connector-examples"
        >
          {entry.examples.map((text) => (
            <div
              key={text}
              className="flex items-center gap-3 rounded-row bg-surface px-3 py-2.5 text-body"
            >
              <span className="inline-flex flex-none items-center gap-1.5 rounded-chip bg-raised px-2 py-0.5 text-small">
                {entry.name}
              </span>
              <span className="min-w-0 flex-1">{text}</span>
              <ArrowRight size={16} className="flex-none text-text-muted" aria-hidden="true" />
            </div>
          ))}
        </section>
        <Block title="Conexão">
          <div className="flex items-center gap-3 rounded-card border border-border bg-surface p-3">
            <EntryIcon entry={entry} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-label font-label">{entry.name}</span>
              <MutedText>Entre com a sua conta do {entry.name}. Em breve.</MutedText>
            </div>
          </div>
        </Block>
        <Block title="Informações">
          <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
            <p className="m-0 text-body">{entry.about}.</p>
            <dl className="m-0 flex flex-col" data-testid="connector-info">
              <div className="flex items-center gap-4 py-1.5">
                <dt className="w-32 flex-none text-text-muted">Desenvolvedor</dt>
                <dd className="m-0">{entry.developer}</dd>
              </div>
              <div className="flex items-center gap-4 py-1.5">
                <dt className="w-32 flex-none text-text-muted">Categoria</dt>
                <dd className="m-0">{entry.category}</dd>
              </div>
              <div className="flex items-center gap-4 py-1.5">
                <dt className="w-32 flex-none text-text-muted">Disponibilidade</dt>
                <dd className="m-0">Em breve</dd>
              </div>
              <div className="flex items-center gap-4 py-1.5">
                <dt className="w-32 flex-none text-text-muted">Site</dt>
                <dd className="m-0">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-text hover:underline"
                    onClick={() => platform.openUrl(entry.site.url)}
                    data-testid="connector-site"
                  >
                    {entry.site.host}
                    <ExternalLink size={14} aria-hidden="true" />
                  </button>
                </dd>
              </div>
            </dl>
          </div>
        </Block>
        <MutedText as="p">
          Este conector ainda não funciona aqui. Para ligar um serviço a um bot hoje, use
          Configurações &gt; Conectores.
        </MutedText>
        <div>
          <Pill
            size="sm"
            onClick={() => openSettings("connectors")}
            data-testid="connector-open-settings"
          >
            Abrir Configurações &gt; Conectores
          </Pill>
        </div>
      </ScreenBody>
    </Screen>
  );
}

/**
 * The connectors, in a screen of its own in place of the chat and the bot's panel (docs/DESIGN.md
 * §5d; owner, 23/11/2026, with the reference he gave): the title and its line, "Meus conectores" and
 * "Adicionar personalizado" (which is real: it opens Configurações > Conectores, where a connector
 * is made), a search field, and the services by section, two columns, each line with "+ Conectar".
 * Choosing one shows its page in this same screen. The gallery is a shop window: the backend cannot
 * connect the account of a service yet, so "Conectar" is off ("Em breve").
 */
export function ConnectorsScreen() {
  const openSettings = useUi((s) => s.openSettings);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);

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

  const q = fold(query.trim());
  const sections = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        entries: CATALOG.filter(
          (e) =>
            e.category === category &&
            (q === "" || fold(`${e.name} ${e.about} ${e.category}`).includes(q)),
        ),
      })).filter((s) => s.entries.length > 0),
    [q],
  );

  if (chosen !== null) return <ConnectorPage entry={chosen} onBack={() => setChosen(null)} />;
  return (
    <Screen data-testid="connectors-screen">
      <ScreenHead
        title="Conectores"
        subtitle="Conecte as ferramentas e os serviços com que seus bots trabalham."
        action={
          <div className="flex items-center gap-3">
            <MyConnectors />
            <Pill
              tone="primary"
              icon={<Plus size={16} aria-hidden="true" />}
              onClick={() => openSettings("connectors")}
              data-testid="connectors-add-custom"
            >
              Adicionar personalizado
            </Pill>
          </div>
        }
      />
      <ScreenBody limit="wide">
        <TextField
          label="Buscar conectores"
          hideLabel
          type="search"
          value={query}
          onChange={setQuery}
          placeholder="Buscar"
        />
        {sections.length === 0 && (
          <EmptyState
            title="Nenhum conector encontrado"
            text="Tente outro nome ou limpe a busca."
          />
        )}
        {sections.map(({ category, entries }) => (
          <section
            key={category}
            className="flex flex-col gap-2"
            aria-label={category}
            data-testid="connectors-section"
            data-category={category}
          >
            <h2 className="flex items-baseline gap-2 px-1 text-label font-title">
              {category}
              <span className="text-small font-normal text-text-muted">{entries.length}</span>
            </h2>
            <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0 narrow:grid-cols-1">
              {entries.map((entry) => (
                <Row key={entry.id} entry={entry} onOpen={() => setChosen(entry)} />
              ))}
            </ul>
          </section>
        ))}
      </ScreenBody>
    </Screen>
  );
}
