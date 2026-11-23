import { Plug } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useUi } from "../../app/ui-store.js";
import { cx } from "../../lib/cx.js";
import { Dialog, MutedText, Pill } from "../../ui/primitives.js";
import { CATALOG, type CatalogEntry } from "./catalog.js";

/** The square (the project's dark grey, `bg-raised`, the same in both themes) and the logo inside it. */
const TILE = {
  sm: { box: "size-avatar-sm rounded-chip ring-2 ring-surface", logo: "size-4" },
  md: { box: "size-avatar-md rounded-inner", logo: "size-5" },
  lg: { box: "size-avatar-lg rounded-row", logo: "size-7" },
} as const;

/**
 * The service's logo in its own colours (an `<img>` of an SVG copied from thesvg, `assets/brand/`)
 * on a rounded square in the project's dark grey (owner, 23/11/2026: "um fundo no tom de cinza do
 * nosso projeto"; "no tema branco ele é o oposto do cinza": so the square does NOT change with the
 * theme, and the white logos (GitHub, Composio) need no inversion). Higgsfield has none: the plug.
 */
function EntryIcon({ entry, size }: { entry: CatalogEntry; size: "sm" | "md" | "lg" }) {
  const tile = TILE[size];
  return (
    <span
      className={cx("inline-flex flex-none items-center justify-center bg-raised", tile.box)}
      aria-hidden="true"
    >
      {entry.logo === undefined ? (
        <Plug className={cx("text-text-muted", tile.logo)} strokeWidth={1.5} />
      ) : (
        <img
          src={entry.logo}
          alt=""
          draggable={false}
          data-logo={entry.id}
          className={cx(
            "flex-none object-contain",
            tile.logo,
            entry.whiteOnDark === true && "light:invert",
          )}
        />
      )}
    </span>
  );
}

/**
 * The logos "Meus plug-ins" stacks, in the order they stack (the first at the right).
 */
const MINE_STACK = ["github", "figma", "gmail", "google-drive"];

/**
 * "Meus plug-ins", beside the close button: a label and the logos of the user's plug-ins side by side
 * and stacked, the first at the right and each next one a little to its left, over it, only the
 * logos in their colours with no square behind them (owner, 23/11/2026). The backend has no
 * plug-ins, so it is an ornament (docs/DESIGN.md, Princípios, "Enfeite"): dimmed, out of the reading
 * order and of the Tab order, and it opens nothing.
 */
function MyPlugins() {
  return (
    <span
      className="inline-flex items-center gap-3 rounded-pill border border-border py-1.5 pr-3 pl-3 text-label opacity-60"
      aria-hidden="true"
      data-testid="plugins-mine"
    >
      Meus conectores
      <span className="flex flex-row-reverse items-center">
        {MINE_STACK.flatMap((id) => CATALOG.filter((e) => e.id === id)).map((entry, i) => (
          <span
            key={entry.id}
            className={i === 0 ? "inline-flex" : "-mr-1.5 inline-flex"}
            data-testid="plugins-mine-icon"
            data-plugin={entry.id}
          >
            <EntryIcon entry={entry} size="sm" />
          </span>
        ))}
      </span>
    </span>
  );
}

/** A titled block of the detail: a faded label of 30 px and what it holds (as the routine's). */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col" aria-label={title}>
      <h3 className="flex h-7.5 items-center text-label font-normal text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What opens when a service of the gallery is chosen (docs/DESIGN.md §5d), laid out as the Grok Bot's
 * (read in its code with the REA, 23/11/2026): the logo with the name's line and the state, the
 * button to connect, then "Informações" and "Ferramentas". Nothing is connected: the backend does not
 * connect an account of a service, so the state says "Não conectado", the button is off (the
 * ornament: "Em breve"), the information is what the gallery declares and the tools appear only
 * after a connection. What works today is in Configurações > Conectores, and the text says so.
 */
function PluginDetail({ entry, onClose }: { entry: CatalogEntry; onClose(): void }) {
  return (
    <Dialog
      title={entry.name}
      onClose={onClose}
      footer={
        <Pill tone="primary" onClick={onClose}>
          Fechar
        </Pill>
      }
    >
      <div className="flex flex-col gap-5" data-testid="plugin-detail" data-plugin={entry.id}>
        <div className="flex items-center gap-4">
          <EntryIcon entry={entry} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-body">{entry.about}</p>
            <MutedText data-testid="plugin-state">Não conectado</MutedText>
          </div>
        </div>
        <Pill tone="primary" disabled title="Em breve" data-testid="plugin-connect">
          Conectar {entry.name}
        </Pill>
        <Block title="Informações">
          <dl className="m-0 flex flex-col" data-testid="plugin-info">
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-text-muted">Categoria</dt>
              <dd className="m-0">{entry.category}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-text-muted">Disponibilidade</dt>
              <dd className="m-0">Em breve</dd>
            </div>
          </dl>
        </Block>
        <Block title="Ferramentas">
          <MutedText as="p" data-testid="plugin-tools">
            Aparecem aqui depois de conectar.
          </MutedText>
        </Block>
        <MutedText as="p">
          Este conector ainda não funciona aqui. Para ligar um serviço a um bot hoje, use
          Configurações &gt; Conectores.
        </MutedText>
      </div>
    </Dialog>
  );
}

/**
 * The plug-ins, in a dialog (docs/DESIGN.md §5d): a wide grid, two columns (one when the window is
 * narrow), each item a row: the service's logo in its colours at the left and, side by side with it,
 * the name with a faded line of at most two lines UNDER it (owner, 23/11/2026). No box around an item (owner, 23/11/2026: a card each
 * weighs too much): only the hover. All of them show with no scrolling. Choosing one opens its own dialog. Nothing here is installed or run: the backend has no
 * plug-ins yet, so one line above the grid says "Em breve" and the detail says so too.
 */
export function PluginsDialog() {
  const close = () => useUi.getState().setPlugins(false);
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  return (
    <>
      <Dialog
        title="Conectores"
        gallery
        headerExtra={<MyPlugins />}
        onClose={close}
        footer={
          <Pill tone="primary" onClick={close}>
            Fechar
          </Pill>
        }
      >
        <MutedText as="p" className="mb-4" data-testid="plugins-soon">
          Em breve: esta vitrine ainda não liga nada. Hoje, um serviço se liga a um bot em
          Configurações &gt; Conectores.
        </MutedText>
        <ul
          className="m-0 grid list-none grid-cols-2 gap-x-2 gap-y-1 p-0 narrow:grid-cols-1"
          aria-label="Conectores"
          data-testid="plugins-grid"
        >
          {CATALOG.map((entry) => (
            <li key={entry.id} className="min-w-0">
              <button
                type="button"
                className="flex h-full w-full min-w-0 items-center gap-4 rounded-card border-0 bg-transparent p-3 text-left text-text hover:bg-hover"
                data-testid="plugin-item"
                data-plugin={entry.id}
                onClick={() => setChosen(entry)}
              >
                <EntryIcon entry={entry} size="lg" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-label font-label">{entry.name}</span>
                  <span className="line-clamp-2 text-small text-text-muted">{entry.about}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
      {chosen !== null && <PluginDetail entry={chosen} onClose={() => setChosen(null)} />}
    </>
  );
}
