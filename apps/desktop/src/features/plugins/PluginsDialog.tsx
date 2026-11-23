import { Plug } from "lucide-react";
import { useState } from "react";
import { useUi } from "../../app/ui-store.js";
import { brandGlyphFor } from "../../ui/brand-icons.js";
import { Dialog, MutedText, Pill } from "../../ui/primitives.js";
import { CATALOG, type CatalogEntry } from "./catalog.js";

/**
 * The service's logo in ITS colours on a light rounded square (docs/DESIGN.md §5d), the same in both
 * themes so a black logo (GitHub, Notion) shows on the dark one. Composio and Higgsfield are not in
 * Simple Icons: the generic plug, in the text colour on the same square.
 */
function EntryIcon({ entry, size }: { entry: CatalogEntry; size: "md" | "lg" }) {
  const Brand = entry.glyph === undefined ? undefined : brandGlyphFor(entry.glyph);
  return (
    <span
      className={
        size === "lg"
          ? "inline-flex size-avatar-lg flex-none items-center justify-center rounded-row border border-border bg-brand-tile"
          : "inline-flex size-avatar-md flex-none items-center justify-center rounded-inner border border-border bg-brand-tile"
      }
      aria-hidden="true"
    >
      {Brand === undefined ? (
        <Plug size={size === "lg" ? 26 : 20} className="text-on-brand-tile" />
      ) : (
        <Brand size={size === "lg" ? 26 : 20} colored />
      )}
    </span>
  );
}

/** What opens when a plug-in is chosen: who it is and, honestly, that it does not work yet. */
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
          <p className="m-0 text-body">{entry.about}</p>
        </div>
        <MutedText as="p">
          Os plug-ins ainda não funcionam no Suup. Para ligar um serviço a um bot hoje, use
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
        title="Plug-ins"
        gallery
        onClose={close}
        footer={
          <Pill tone="primary" onClick={close}>
            Fechar
          </Pill>
        }
      >
        <MutedText as="p" className="mb-4" data-testid="plugins-soon">
          Em breve: os plug-ins ainda não funcionam. Hoje, um serviço se liga a um bot em
          Configurações &gt; Conectores.
        </MutedText>
        <ul
          className="m-0 grid list-none grid-cols-2 gap-x-2 gap-y-1 p-0 narrow:grid-cols-1"
          aria-label="Plug-ins"
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
