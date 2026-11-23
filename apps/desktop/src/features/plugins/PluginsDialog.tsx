import { Plug } from "lucide-react";
import { useState } from "react";
import { useUi } from "../../app/ui-store.js";
import { brandGlyphFor } from "../../ui/brand-icons.js";
import { Dialog, MutedText, Pill } from "../../ui/primitives.js";
import { CATALOG, type CatalogEntry } from "./catalog.js";

/** The icon of an entry in its rounded square: the brand mark, or the plug. */
function EntryIcon({ entry, size }: { entry: CatalogEntry; size: number }) {
  const Glyph = (entry.glyph === undefined ? undefined : brandGlyphFor(entry.glyph)) ?? Plug;
  return (
    <span
      className="inline-flex size-avatar-md flex-none items-center justify-center rounded-inner bg-raised text-text"
      aria-hidden="true"
    >
      <Glyph size={size} />
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
      <div className="flex flex-col gap-4" data-testid="plugin-detail" data-plugin={entry.id}>
        <div className="flex items-center gap-3">
          <EntryIcon entry={entry} size={20} />
          <MutedText>{entry.about}</MutedText>
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
 * The plug-ins, in a dialog (docs/DESIGN.md §5d), laid out as the Grok Bot's (read in its code with
 * the REA, 23/11/2026): a grid of two columns, one line per plug-in with its icon at the left and, to
 * its right, the name and ONE faded line under it; one column when the window is narrow. Choosing
 * one opens its own dialog. Nothing here is installed or run: the backend has no plug-ins yet, so
 * one line above the grid says "Em breve" and the detail says so too.
 */
export function PluginsDialog() {
  const close = () => useUi.getState().setPlugins(false);
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  return (
    <>
      <Dialog
        title="Plug-ins"
        wide
        onClose={close}
        footer={
          <Pill tone="primary" onClick={close}>
            Fechar
          </Pill>
        }
      >
        <MutedText as="p" className="mb-3 px-2" data-testid="plugins-soon">
          Em breve: os plug-ins ainda não funcionam. Hoje, um serviço se liga a um bot em
          Configurações &gt; Conectores.
        </MutedText>
        <ul
          className="m-0 grid list-none grid-cols-2 gap-x-2 gap-y-0.5 p-0 narrow:grid-cols-1"
          aria-label="Plug-ins"
          data-testid="plugins-grid"
        >
          {CATALOG.map((entry) => (
            <li key={entry.id} className="min-w-0">
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2.5 rounded-card border-0 bg-transparent p-2 text-left text-text hover:bg-hover"
                data-testid="plugin-item"
                data-plugin={entry.id}
                onClick={() => setChosen(entry)}
              >
                <EntryIcon entry={entry} size={20} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-label font-label">{entry.name}</span>
                  <span className="truncate text-small text-text-muted">{entry.about}</span>
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
