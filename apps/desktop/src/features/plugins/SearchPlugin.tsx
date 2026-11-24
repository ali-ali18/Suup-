import type { SearchPlugin, SearchProvider } from "@suup/api";
import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx.js";
import { BulletList, MutedText, Pill } from "../../ui/primitives.js";
import { Screen, ScreenBody, ScreenHeader } from "../../ui/screen.js";
import { SecretDialog } from "../settings/VaultSettings.js";
import { appearanceOf } from "./appearance.js";
import { EntryIcon } from "./EntryIcon.js";
import { ExamplesBanner } from "./ExamplesBanner.js";
import {
  PROVIDER_STATE_WORDS,
  queueWords,
  searchLook,
  searchStatus,
  usageWords,
} from "./installed.js";

/** One web search engine of the queue and how the gallery shows it (`GET /v1/web-search`). */
export interface SearchEntry {
  provider: SearchProvider;
  plugin: SearchPlugin;
}

/** "Adicionar chave" or "Trocar a chave": what the person does to the key of an engine, if anything. */
function keyAction(provider: SearchProvider): string | undefined {
  if (provider.keyNames === undefined || provider.state === "off") return undefined;
  return provider.state === "no_key" ? "Adicionar chave" : "Trocar a chave";
}

/** One line of the gallery for a search engine: the same row as a connector, with its words. */
export function SearchRow({
  entry,
  onOpen,
}: {
  entry: SearchEntry;
  /** `autoStart`: the button of the row was clicked, so the form of the key opens with the page. */
  onOpen(autoStart: boolean): void;
}) {
  const { provider, plugin } = entry;
  const action = provider.state === "no_key" ? keyAction(provider) : undefined;
  return (
    <li
      className="flex min-w-0 items-center gap-2 rounded-card pr-2 hover:bg-hover"
      data-testid="connector-item"
      data-plugin={plugin.id}
      data-kind="search"
      data-status={provider.state}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-4 rounded-card border-0 bg-transparent p-3 text-left text-text"
        onClick={() => onOpen(false)}
      >
        <EntryIcon id={plugin.id} name={provider.label} look={searchLook(provider)} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-label font-label">{provider.label}</span>
          <span className="truncate text-small text-text-muted">{plugin.description}</span>
        </span>
      </button>
      {provider.state !== "no_key" && (
        <span
          className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small whitespace-nowrap"
          data-testid="connector-state"
          data-state={provider.state}
        >
          <span
            className={cx(
              "size-1.5 rounded-full",
              provider.state === "ready" ? "bg-success-text" : "bg-text-muted",
            )}
            aria-hidden="true"
          />
          {PROVIDER_STATE_WORDS[provider.state]}
        </span>
      )}
      {action !== undefined && (
        <Pill
          tone="quiet"
          size="sm"
          icon={<Plus size={14} aria-hidden="true" />}
          aria-label={`${action} ${provider.label}`}
          data-testid="connector-connect"
          data-plugin={plugin.id}
          onClick={() => onOpen(true)}
        >
          {action}
        </Pill>
      )}
    </li>
  );
}

/**
 * The page of a search engine (owner, 24/11/2026): where it stands in plain words, this month's
 * searches, its place in the queue, and "Adicionar chave", which opens the secure form of the vault
 * (the key never shows). It stays a built-in engine: nothing here makes an MCP connector.
 */
export function SearchPluginPage({
  entry,
  all,
  onBack,
  reload,
  autoStart,
}: {
  entry: SearchEntry;
  /** The whole queue, to say who comes before. */
  all: readonly SearchProvider[];
  onBack(): void;
  reload(): Promise<void>;
  autoStart: boolean;
}) {
  const { provider, plugin } = entry;
  const [adding, setAdding] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    if (provider.state === "no_key") setAdding(true);
  }, [autoStart, provider.state]);
  const status = searchStatus(provider);
  const action = keyAction(provider);
  const before = all.filter((p) => p.position < provider.position).map((p) => p.label);
  return (
    <Screen data-testid="connector-page" data-plugin={plugin.id} data-kind="search">
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
            {provider.label}
          </span>
        </nav>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <EntryIcon id={plugin.id} name={provider.label} look={searchLook(provider)} size="lg" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-3">
                <h1 className="text-heading font-title">{provider.label}</h1>
                <span
                  className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small whitespace-nowrap"
                  data-testid="connector-state"
                  data-state={provider.state}
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
              <MutedText>{plugin.description}</MutedText>
            </div>
          </div>
          {action !== undefined && (
            <Pill
              tone={provider.state === "no_key" ? "primary" : "secondary"}
              onClick={() => setAdding(true)}
              data-testid="search-key"
            >
              {action}
            </Pill>
          )}
        </div>
      </ScreenHeader>
      <ScreenBody>
        <ExamplesBanner name={provider.label} look={appearanceOf(plugin.id)} />
        <section className="flex flex-col gap-1" aria-label="Situação">
          <h2 className="flex h-7.5 items-center text-label font-normal text-text-muted">
            Situação
          </h2>
          <div className="flex flex-col gap-2 rounded-card bg-raised p-4 text-body">
            <p className="m-0" data-testid="search-plugin-state">
              {status.label}
            </p>
            <MutedText as="p" data-testid="search-plugin-usage">
              {usageWords(provider.searchesThisMonth)}
            </MutedText>
            <MutedText as="p" data-testid="search-plugin-queue">
              {queueWords(provider)}
              {before.length > 0 && ` (depois do ${before.join(" e do ")})`}.
            </MutedText>
            <MutedText as="p">
              A busca usa o primeiro que estiver pronto; se a cota acabar, passa para o próximo.
            </MutedText>
          </div>
        </section>
        {plugin.notes.length > 0 && (
          <section className="flex flex-col gap-1" aria-label="Bom saber">
            <h2 className="flex h-7.5 items-center text-label font-normal text-text-muted">
              Bom saber
            </h2>
            <div className="rounded-card bg-raised p-4 text-body">
              <BulletList data-testid="connector-notes">
                {plugin.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </BulletList>
            </div>
          </section>
        )}
      </ScreenBody>
      {adding && provider.keyNames !== undefined && (
        <SecretDialog
          existing={undefined}
          preset={{
            name: provider.keyNames.secret,
            title: `Chave do ${provider.label}`,
            steps: plugin.keySteps,
          }}
          onSaved={() => void reload()}
          onClose={() => setAdding(false)}
        />
      )}
    </Screen>
  );
}
