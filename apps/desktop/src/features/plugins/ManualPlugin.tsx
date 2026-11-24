import type { Connector } from "@suup/api";
import { ChevronRight } from "lucide-react";
import { cx } from "../../lib/cx.js";
import { MutedText } from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHeader } from "../../ui/screen.js";
import { ConnectorManage } from "./ConnectorManage.js";
import { EntryIcon } from "./EntryIcon.js";
import { manualStatus } from "./installed.js";

/**
 * The page of a connector the person added by hand (not from the gallery): the generic icon and its
 * own name, with everything the other pages manage (on or off, bots, tools, risks, removing).
 */
export function ManualPluginPage({ connector, onBack }: { connector: Connector; onBack(): void }) {
  const status = manualStatus(connector);
  return (
    <Screen data-testid="connector-page" data-plugin={connector.name} data-kind="manual">
      <ScreenHeader>
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
            {connector.name}
          </span>
        </nav>
        <div className="flex items-center gap-4">
          <EntryIcon
            id={connector.name}
            name={connector.name}
            look={{ tone: "neutral", glyph: "plug" }}
            size="lg"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-3">
              <h1 className="text-heading font-title">{connector.name}</h1>
              <span
                className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small whitespace-nowrap"
                data-testid="connector-state"
              >
                <span
                  className={cx(
                    "size-1.5 rounded-full",
                    status.tone === "ok" ? "bg-success-text" : "bg-text-muted",
                  )}
                  aria-hidden="true"
                />
                {status.label}
              </span>
            </div>
            <MutedText>
              {connector.description === "" ? "Conector seu" : connector.description}
            </MutedText>
          </div>
        </div>
      </ScreenHeader>
      <ScreenBody>
        <ConnectorManage connector={connector} onRemoved={onBack} />
      </ScreenBody>
    </Screen>
  );
}
