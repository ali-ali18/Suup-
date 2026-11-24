import type { WebSearchSettings } from "@suup/api";
import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { friendlyError } from "../../lib/friendly-error.js";
import { PROVIDER_STATE_WORDS, usageWords } from "../plugins/installed.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  type SectionProps,
  SettingsGroup,
  SettingsHint,
  SettingsRow,
} from "./parts.js";

/**
 * Configurações > Busca (docs/DESIGN.md §3c; owner, 24/11/2026): a short pointer. Tavily and Brave
 * are plugins now, and each one's page has its key, its state and this month's searches, so this
 * section keeps only what is not there: the ORDER of the queue, read-only, with where each engine
 * stands in words and one "Abrir" that goes to its plugin page. No control is repeated here (the key
 * is added on the plugin's page). The order is the server configuration's (`GET /v1/web-search`).
 */
export function SearchSettings({ title, titleId }: SectionProps) {
  const { api } = useServices();
  const openPlugin = useUi((s) => s.openPlugin);
  const [settings, setSettings] = useState<WebSearchSettings | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    api.webSearch.get().then(
      (next) => {
        setFailed(undefined);
        setSettings(next);
      },
      (error: unknown) => setFailed(friendlyError(error)),
    );
  }, [api]);
  useEffect(load, [load]);

  const providers = settings?.providers ?? [];
  return (
    <>
      <PaneHead title={title} titleId={titleId} />
      <PaneBody>
        {settings === undefined ? (
          <SettingsGroup>
            <SettingsRow
              title={failed === undefined ? "Carregando…" : "Não foi possível ler a busca"}
              {...(failed === undefined ? {} : { description: failed, role: "note" as const })}
            />
          </SettingsGroup>
        ) : !settings.enabled ? (
          <SettingsGroup>
            <SettingsRow
              icon={Search}
              title="Busca na web desligada"
              description="Quem cuida deste computador desligou a busca na web."
              testId="search-off"
            />
          </SettingsGroup>
        ) : (
          <SettingsGroup
            label="Fila da busca geral"
            testId="search-providers"
            hint="A busca usa o primeiro que estiver pronto; se a cota acabar, passa para o próximo. A chave de cada um se adiciona na página do plugin."
          >
            {providers.map((p) => (
              <SettingsRow
                key={p.id}
                icon={Search}
                title={`${p.position}. ${p.label}`}
                testId={`search-provider-${p.id}`}
                description={
                  <>
                    <span data-testid={`search-state-${p.id}`}>
                      {PROVIDER_STATE_WORDS[p.state]}
                    </span>
                    {p.state !== "off" && (
                      <span data-testid={`search-usage-${p.id}`}>
                        {" · "}
                        {usageWords(p.searchesThisMonth)}
                      </span>
                    )}
                  </>
                }
                control={
                  p.plugin === null ? undefined : (
                    <RowAction
                      data-testid={`search-open-${p.id}`}
                      aria-label={`Abrir a página do ${p.label}`}
                      onClick={() =>
                        p.plugin === null
                          ? undefined
                          : openPlugin({ kind: "search", id: p.plugin.id, autoStart: false })
                      }
                    >
                      Abrir
                    </RowAction>
                  )
                }
              />
            ))}
          </SettingsGroup>
        )}
        {settings?.enabled === true && providers.every((p) => p.state !== "ready") && (
          <SettingsHint data-testid="search-none-ready">
            Sem nenhum pronto, os bots buscam só na Wikipédia, no arXiv e no Stack Overflow.
          </SettingsHint>
        )}
      </PaneBody>
    </>
  );
}
