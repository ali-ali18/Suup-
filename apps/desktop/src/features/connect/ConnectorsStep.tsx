import type { SearchProvider } from "@suup/api";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import { writeConnectorToken, writeSearchKey } from "../../lib/secret-form.js";
import { galleryStart, STAGE_SURPRISED_MS, WELCOME_EXIT_MS } from "../../lib/welcome.js";
import { Dialog, MutedText, Notice, Pill } from "../../ui/primitives.js";
import { GalleryFrame } from "../../ui/welcome.js";
import { appearanceOf, CATEGORIES } from "../plugins/appearance.js";
import {
  actionOf,
  type Entry,
  GalleryIcon,
  loginBlocked,
  NEEDS_PUBLIC_ADDRESS,
  StateTag,
} from "../plugins/ConnectorsScreen.js";
import { EntryIcon } from "../plugins/EntryIcon.js";
import { PROVIDER_STATE_WORDS, searchLook, searchPlugins } from "../plugins/installed.js";
import type { SearchEntry } from "../plugins/SearchPlugin.js";
import { POLL_MS, useConnect } from "../plugins/use-connect.js";
import { useCanLogIn, usePlugins } from "../plugins/use-plugins.js";
import { SecretDialog } from "../settings/VaultSettings.js";
import { type StageCue, useStage, useStageStatus } from "../welcome/Stage.js";

/** What a row tells the bot about itself. `done`: it was just connected. */
type RowState = "idle" | "busy" | "failed" | "done";

/** What the row of the list needs from the list: to say how it is, and to be looked at. */
interface RowHooks {
  report(id: string, state: RowState): void;
  /** The pointer (or the keyboard) is on this row: the bot looks at it. */
  look(element: HTMLElement | null): void;
}

/**
 * The words of the action pill, in plain words: the entry's own action, but a login or a token are
 * both just "Conectar" here (docs/DESIGN.md §1, "Amigável").
 */
function pillWords(action: string): string {
  return action === "Fazer login" || action === "Informar token" ? "Conectar" : action;
}

/** The frame of one row: the bot looks at it while the pointer or the focus is on it. */
function RowFrame({
  id,
  status,
  kind,
  look,
  children,
}: {
  id: string;
  status: string;
  kind: "catalog" | "search";
  look: RowHooks["look"];
  children: ReactNode;
}) {
  const frame = useRef<HTMLLIElement>(null);
  return (
    <li
      ref={frame}
      className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-3 hover:bg-hover"
      data-testid="connector-item"
      data-plugin={id}
      data-kind={kind}
      data-status={status}
      onPointerEnter={() => look(frame.current)}
      onPointerLeave={() => look(null)}
      onFocus={() => look(frame.current)}
      onBlur={() => look(null)}
    >
      {children}
    </li>
  );
}

/** The icon, the name and the one faded line of a row. */
function RowText({ icon, name, line }: { icon: ReactNode; name: string; line: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label font-label">{name}</span>
        <span className="truncate text-small text-text-muted">{line}</span>
      </span>
    </div>
  );
}

/**
 * One service of the server's gallery, connected the same way as on the Conectores screen
 * (`useConnect`): the login in the browser for the ones that use it, the secure form for the ones
 * that need a token. An entry with a notice about a third party asks first, in a window over the
 * stage (the screen of Conectores opens the page for that; here nothing leaves the entrance).
 */
function EntryRow({
  entry,
  canLogIn,
  reload,
  pollMs,
  hooks,
}: {
  entry: Entry;
  canLogIn: boolean;
  reload(): Promise<void>;
  pollMs: number;
  hooks: RowHooks;
}) {
  const { api } = useServices();
  const { item } = entry;
  const id = item.entry.id;
  const name = item.entry.name;
  const connect = useConnect(item, reload, pollMs);
  const { flow } = connect;
  const [confirming, setConfirming] = useState(false);

  // Tells the bot how this row is: working, failed, or just connected.
  const working = flow.kind === "busy" || flow.kind === "waiting";
  const failed = connect.error !== undefined;
  const connected = item.status === "connected";
  const was = useRef(false);
  const { report } = hooks;
  useEffect(() => {
    if (working) {
      was.current = true;
      report(id, "busy");
    } else if (failed) {
      was.current = false;
      report(id, "failed");
    } else if (connected && was.current) {
      was.current = false;
      report(id, "done");
    } else report(id, "idle");
  }, [working, failed, connected, id, report]);

  const blocked = loginBlocked(item, canLogIn);
  const action = actionOf(item, canLogIn);
  // A service that needs an app of the person's own cannot be connected from here.
  const ownApp = item.entry.auth.kind === "oauth_owner_client";
  const start = () => {
    if (item.status === "off") void connect.turnOn();
    else if (item.entry.disclosure !== null && !connected) setConfirming(true);
    else void connect.connect();
  };

  let side: ReactNode = null;
  if (flow.kind === "busy") {
    side = (
      <Pill size="sm" tone="quiet" disabled aria-busy="true" data-testid="connector-connect">
        {flow.label}
      </Pill>
    );
  } else if (flow.kind === "waiting") {
    side = <StateTag state="waiting" />;
  } else if (item.status === "connected") {
    side = <StateTag state="connected" />;
  } else if (item.status === "unverified") {
    side = <StateTag state="unverified" title={item.entry.unverifiedReason ?? undefined} />;
  } else if (action !== undefined && !ownApp) {
    const words = pillWords(action);
    side = (
      <>
        {(item.status === "error" || item.status === "off") && <StateTag state={item.status} />}
        <Pill
          tone="quiet"
          size="sm"
          icon={item.status === "available" ? <Plus size={14} aria-hidden="true" /> : undefined}
          aria-label={`${words} ${name}`}
          data-testid="connector-connect"
          data-plugin={id}
          onClick={start}
        >
          {words}
        </Pill>
      </>
    );
  }

  return (
    <RowFrame id={id} status={item.status} kind="catalog" look={hooks.look}>
      <div className="flex min-w-0 items-center gap-2">
        <RowText
          icon={<GalleryIcon entry={entry} size="lg" />}
          name={name}
          line={item.entry.description}
        />
        {side}
      </div>
      {flow.kind === "waiting" && (
        <div
          className="flex flex-col gap-2 pl-14"
          data-testid="connector-waiting"
          aria-live="polite"
        >
          <MutedText as="p">Entre na página que abriu no navegador; aqui muda sozinho.</MutedText>
          <div className="flex flex-wrap items-center gap-2">
            <Pill size="sm" onClick={connect.reopen} data-testid="connector-reopen">
              Abrir a página de novo
            </Pill>
            <Pill size="sm" tone="quiet" onClick={connect.cancel} data-testid="connector-cancel">
              Cancelar
            </Pill>
          </div>
        </div>
      )}
      {blocked && item.status !== "unverified" && (
        <MutedText as="p" className="pl-14">
          {NEEDS_PUBLIC_ADDRESS}
        </MutedText>
      )}
      {connect.error !== undefined && (
        <Notice role="alert" data-testid="connector-error">
          {connect.error}
        </Notice>
      )}
      {flow.kind === "secret" && item.entry.auth.kind === "token" && (
        <SecretDialog
          existing={undefined}
          preset={{
            name: item.entry.auth.secret,
            title: `Token do ${name}`,
            steps: item.entry.auth.steps,
          }}
          save={(value) => writeConnectorToken(api.connectorCatalog, item.entry.id, value)}
          onSaved={() => void connect.secretSaved()}
          onClose={connect.closeSecret}
        />
      )}
      {confirming && (
        <Dialog
          title={`Antes de conectar o ${name}`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setConfirming(false)}>
                Agora não
              </Pill>
              <Pill
                tone="primary"
                data-testid="connector-confirm"
                onClick={() => {
                  setConfirming(false);
                  void connect.connect();
                }}
              >
                Conectar
              </Pill>
            </>
          }
        >
          <Notice role="note" data-testid="connector-disclosure">
            {item.entry.disclosure}
          </Notice>
        </Dialog>
      )}
    </RowFrame>
  );
}

/** What a web search engine says on its right: its state in words, or the pill to add its key. */
function engineWords(provider: SearchProvider): string {
  return provider.state === "ready" ? "Conectado" : PROVIDER_STATE_WORDS[provider.state];
}

/** A web search engine of the gallery: its key goes through the same secure form as the screen's. */
function EngineRow({
  entry,
  reload,
  hooks,
}: {
  entry: SearchEntry;
  reload(): Promise<void>;
  hooks: RowHooks;
}) {
  const { api } = useServices();
  const { provider, plugin } = entry;
  const [adding, setAdding] = useState(false);
  const canAdd = provider.state === "no_key" && provider.keyNames !== undefined;
  return (
    <RowFrame id={plugin.id} status={provider.state} kind="search" look={hooks.look}>
      <div className="flex min-w-0 items-center gap-2">
        <RowText
          icon={
            <EntryIcon id={plugin.id} name={provider.label} look={searchLook(provider)} size="lg" />
          }
          name={provider.label}
          line={plugin.description}
        />
        {provider.state === "no_key" ? (
          canAdd && (
            <Pill
              tone="quiet"
              size="sm"
              icon={<Plus size={14} aria-hidden="true" />}
              aria-label={`Conectar ${provider.label}`}
              data-testid="connector-connect"
              data-plugin={plugin.id}
              onClick={() => setAdding(true)}
            >
              Conectar
            </Pill>
          )
        ) : (
          <span
            className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-raised px-2.5 py-0.5 text-small whitespace-nowrap"
            data-testid="connector-state"
            data-state={provider.state}
          >
            {engineWords(provider)}
          </span>
        )}
      </div>
      {adding && provider.keyNames !== undefined && (
        <SecretDialog
          existing={undefined}
          preset={{
            name: provider.keyNames.secret,
            title: `Chave do ${provider.label}`,
            steps: plugin.keySteps,
          }}
          save={(value) => writeSearchKey(api.webSearch, provider.id, value)}
          onSaved={() => {
            hooks.report(plugin.id, "done");
            void reload();
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </RowFrame>
  );
}

/**
 * The step after the token on a new account (docs/DESIGN.md §3d; owner, 24/11/2026): "Conecte o
 * que você usa", a gallery. The SAME bot of the stage goes from the corner to the top, in the
 * middle, and a crew of other bots comes out beside it (the stage draws them: `StageCrew`); under
 * them the title and a faded line, then the cards of what the server's gallery offers (the data of
 * the Conectores screen: `usePlugins`), by the sections the app gives each entry, in a grid of 3, 2
 * or 1 columns inside a box of limited height that scrolls with the fade on its edges; and, under
 * the box, "Continuar". Nothing in it is written by hand: a new service of the gallery shows up here
 * without anyone touching this screen. It is optional: "Continuar" is always on, fades the step out
 * and goes on to "Crie seu bot".
 *
 * The bot reacts through the stage: curious about the card under the pointer (the crew looks too),
 * thinking while a service connects, wide-eyed when it did (the crew smiles), sorry when it did
 * not. Connecting a service here does not give it to any bot (there is none yet).
 */
export function ConnectorsStep({ onDone, pollMs = POLL_MS }: { onDone(): void; pollMs?: number }) {
  const stage = useStage();
  const reduced = useReducedMotion();
  const { items, search, loadError, reload } = usePlugins();
  const canLogIn = useCanLogIn();

  // The bot (and the crew) go to the top of the screen while this step is here.
  useEffect(() => {
    stage.gallery(true);
    return () => stage.gallery(false);
  }, [stage]);
  // When each part rises: after the bot's trip, or right away for a bot born there.
  const [start] = useState(() => galleryStart(stage.bornAt !== "gallery"));

  // What the rows tell the bot, put together: working > just connected > failed > calm.
  const [states, setStates] = useState<Record<string, RowState>>({});
  const [confirmed, setConfirmed] = useState(false);
  const report = useCallback((id: string, state: RowState) => {
    setStates((now) => (now[id] === state ? now : { ...now, [id]: state }));
    if (state === "done") setConfirmed(true);
  }, []);
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => setConfirmed(false), STAGE_SURPRISED_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);
  const all = Object.values(states);
  const status: StageCue["status"] = all.includes("busy")
    ? "busy"
    : confirmed
      ? "confirmed"
      : all.includes("failed")
        ? "error"
        : "idle";
  useStageStatus(status);

  const look = useCallback(
    (element: HTMLElement | null) => stage.cue({ curiousAt: element }),
    [stage],
  );
  useEffect(() => () => stage.cue({ curiousAt: null }), [stage]);
  const hooks = useMemo<RowHooks>(() => ({ report, look }), [report, look]);

  // "Continuar": the step fades out (the bots with it) and then the next screen comes.
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!leaving) return;
    stage.cue({ leaving: true, curiousAt: null });
    if (reduced) {
      done.current();
      return;
    }
    const timer = setTimeout(() => done.current(), WELCOME_EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, reduced, stage]);

  const entries = useMemo<Entry[]>(
    () => (items ?? []).map((item) => ({ item, look: appearanceOf(item.entry.id) })),
    [items],
  );
  const engines = useMemo<SearchEntry[]>(() => searchPlugins(search), [search]);
  const sections = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        entries: entries.filter((e) => e.look.category === category),
        engines: engines.filter((e) => e.plugin.category === category),
      })).filter((s) => s.entries.length + s.engines.length > 0),
    [entries, engines],
  );

  return (
    <GalleryFrame
      title="Conecte o que você usa"
      subtitle="É opcional: dá para conectar depois, quando quiser."
      start={start}
      leaving={leaving}
      testId="connectors-step"
      footer={
        <Pill
          tone="primary"
          size="lg"
          className="min-w-72"
          onClick={() => setLeaving(true)}
          data-testid="connectors-continue"
        >
          Continuar
        </Pill>
      }
    >
      <div className="flex flex-col gap-5" data-testid="connectors-step-list">
        {items === null && loadError === undefined && (
          <MutedText as="p" className="text-center" aria-busy="true">
            Carregando…
          </MutedText>
        )}
        {loadError !== undefined && (
          <Notice role="alert" data-testid="connectors-load-error">
            Não consegui carregar a lista agora.
            <div>
              <Pill size="sm" onClick={() => void reload()}>
                Tentar de novo
              </Pill>
            </div>
          </Notice>
        )}
        {items !== null && sections.length === 0 && (
          <MutedText as="p" className="text-center">
            Ainda não há nada para conectar por aqui.
          </MutedText>
        )}
        {sections.map(({ category, entries: list, engines: found }) => (
          <section
            key={category}
            className="flex flex-col gap-2"
            aria-label={category}
            data-testid="connectors-section"
            data-category={category}
          >
            <h2 className="px-1 text-small font-normal text-text-muted">{category}</h2>
            <ul className="m-0 grid list-none grid-cols-3 gap-3 p-0 compact:grid-cols-2 narrow:grid-cols-1">
              {list.map((entry) => (
                <EntryRow
                  key={entry.item.entry.id}
                  entry={entry}
                  canLogIn={canLogIn}
                  reload={reload}
                  pollMs={pollMs}
                  hooks={hooks}
                />
              ))}
              {found.map((engine) => (
                <EngineRow key={engine.plugin.id} entry={engine} reload={reload} hooks={hooks} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </GalleryFrame>
  );
}
