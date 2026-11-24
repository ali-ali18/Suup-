import type { SearchProvider, WebSearchSettings } from "@suup/api";
import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { friendlyError } from "../../lib/friendly-error.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  type SectionProps,
  SettingsGroup,
  SettingsHint,
  SettingsRow,
} from "./parts.js";
import { SecretDialog } from "./VaultSettings.js";

/** How each state is said (docs/DESIGN.md, "Amigável": plain words, never a code). */
export const PROVIDER_STATE_WORDS: Readonly<Record<SearchProvider["state"], string>> = {
  ready: "Pronto",
  no_key: "Sem chave",
  quota: "Cota do mês usada",
  key_rejected: "Chave não aceita",
  unavailable: "Não respondeu agora",
  off: "Desligado",
};

/** "1 busca este mês", "12 buscas este mês". */
export function usageWords(count: number): string {
  return count === 1 ? "1 busca este mês" : `${count} buscas este mês`;
}

/**
 * What the person does to get a key, per engine: the steps shown above the field. The name the key
 * is kept under is the server's (`keyNames.secret`) and is never shown.
 */
const KEY_STEPS: Readonly<Record<string, readonly string[]>> = {
  tavily: [
    "Crie uma conta grátis no site do Tavily (mil buscas por mês, sem cartão).",
    "Copie a chave de API que ele mostra e cole aqui.",
  ],
  brave: [
    "Crie uma conta no painel da Brave Search API e ative o plano de busca.",
    "O plano traz US$ 5 de crédito por mês, cerca de mil buscas.",
    "Copie a chave de API e cole aqui.",
  ],
};

/**
 * Configurações > Busca (docs/DESIGN.md §3c): the general web search engines in the order they are
 * tried, each with where it stands (ready, no key, month's quota used) and a way to add its key,
 * which goes straight to the vault. Only what the server offers (`GET /v1/web-search`): the order
 * is the server configuration's, so there is no control for it here.
 */
export function SearchSettings({ title, titleId, onClose }: SectionProps) {
  const { api } = useServices();
  const [settings, setSettings] = useState<WebSearchSettings | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<SearchProvider | null>(null);

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
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
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
            label="Busca geral"
            testId="search-providers"
            hint="A busca usa o primeiro que estiver pronto; se a cota acabar, passa para o próximo."
          >
            {providers.map((p) => (
              <SettingsRow
                key={p.id}
                icon={Search}
                title={p.label}
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
                  p.keyNames === undefined || p.state === "off" ? undefined : (
                    <RowAction
                      data-testid={`search-key-${p.id}`}
                      aria-label={`${p.state === "no_key" ? "Adicionar a chave" : "Trocar a chave"} do ${p.label}`}
                      onClick={() => setAdding(p)}
                    >
                      {p.state === "no_key" ? "Adicionar chave" : "Trocar a chave"}
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
      {adding?.keyNames !== undefined && (
        <SecretDialog
          existing={undefined}
          preset={{
            name: adding.keyNames.secret,
            title: `Chave do ${adding.label}`,
            steps: KEY_STEPS[adding.id] ?? ["Cole a chave de API do serviço."],
          }}
          onSaved={load}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}
