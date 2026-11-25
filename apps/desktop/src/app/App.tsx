import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectorsStep } from "../features/connect/ConnectorsStep.js";
import { ConnectScreen } from "../features/connect/ConnectScreen.js";
import { FirstRunScreen } from "../features/connect/FirstRunScreen.js";
import { LocalScreen } from "../features/connect/LocalScreen.js";
import { CreateBotFlow } from "../features/new-bot/CreateBotFlow.js";
import { Shell } from "../features/shell/Shell.js";
import { Stage } from "../features/welcome/Stage.js";
import { WelcomeScreen } from "../features/welcome/WelcomeScreen.js";
import { type Connection, getPlatform, type Platform, type ServerMode } from "../lib/platform.js";
import { readReducedMotion } from "../lib/reduced-motion.js";
import {
  CONNECT_THINK_MS,
  entryAfterConnect,
  markConnectorsStepDone,
  markWelcomeDone,
  resetWelcome,
  setPendingOwnerName,
  WELCOME_EXIT_MS,
  welcomeDone,
} from "../lib/welcome.js";
import { ToastStack } from "../ui/primitives.js";
import { WindowControls } from "../ui/window-controls.js";
import { checkServer, connect, describeConnectError, normalizeServerUrl } from "./connect.js";
import { type Services, ServicesProvider } from "./context.js";
import { initSettings } from "./settings-store.js";
import { useUi } from "./ui-store.js";

type Phase =
  | { kind: "boot" }
  /** The very first thing a device shows; `next` is the screen it goes on to. */
  | { kind: "welcome"; next: "choose" | "connect" }
  /** The first-run choice: this computer or a VPS. */
  | { kind: "choose" }
  | { kind: "connect" }
  /** The embedded server: `firstRun` asks for the model key before starting. */
  | { kind: "local"; firstRun: boolean }
  /** A new account (no bot yet): the list of connectors, with the same bot of the stage. */
  | { kind: "connectors"; services: Services }
  /** The last screen of the entrance, on an account with no bot: "Crie seu bot", with the same bot. */
  | { kind: "create-bot"; services: Services }
  | { kind: "ready"; services: Services };

/**
 * Where the stage's bot is born: the welcome, the gallery of the connectors or "Crie seu bot" (no
 * connect screen before them), or the corner.
 */
function stageStart(kind: Phase["kind"]): "welcome" | "corner" | "gallery" | "create" {
  if (kind === "welcome") return "welcome";
  if (kind === "connectors") return "gallery";
  return kind === "create-bot" ? "create" : "corner";
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [saved, setSaved] = useState<Connection | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // The connect screen fades out before the connectors (or the app) come.
  const [leavingConnect, setLeavingConnect] = useState(false);
  // A new number is a new bot on the stage (back to the welcome starts the sequence over).
  const [stageRun, setStageRun] = useState(0);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const platformRef = useRef<Platform | null>(null);
  const servicesRef = useRef<Services | null>(null);
  const customFrame = useUi((s) => s.customFrame);
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);
  // The window draws its own buttons: the root says so, and every screen head keeps their corner
  // free (`framed:` in theme.css; docs/DESIGN.md §4c).
  useEffect(() => {
    const root = document.documentElement;
    if (customFrame) root.dataset.frame = "custom";
    else delete root.dataset.frame;
  }, [customFrame]);

  /** Leaves the current server for the first-run choice (the data stays where it is). */
  const switchServer = useCallback(async () => {
    servicesRef.current?.sync.stop();
    servicesRef.current = null;
    useUi.getState().leaveServer();
    const platform = platformRef.current;
    await platform?.local?.stop();
    await platform?.connection.clear();
    await platform?.mode?.clear();
    setSaved(null);
    setError(undefined);
    setPhase({ kind: platform?.local === undefined ? "connect" : "choose" });
  }, []);

  const disconnect = useCallback(async () => {
    if (servicesRef.current?.mode === "local") return switchServer();
    servicesRef.current?.sync.stop();
    servicesRef.current = null;
    useUi.getState().leaveServer();
    await platformRef.current?.connection.clear();
    setSaved(null);
    setPhase({ kind: "connect" });
  }, [switchServer]);

  const open = useCallback(
    async (connection: Connection, platform: Platform, mode: ServerMode) => {
      setBusy(true);
      setError(undefined);
      try {
        // Typed by the person (a VPS): the stage's bot takes a moment to think, as on the address.
        const [services] = await Promise.all([
          connect(connection, platform, { mode, disconnect, switchServer }),
          mode === "vps"
            ? new Promise((done) => setTimeout(done, CONNECT_THINK_MS))
            : Promise.resolve(),
        ]);
        if (mode === "vps") {
          await platform.connection.save(connection);
          await platform.mode?.save("vps");
        }
        servicesRef.current = services;
        setSaved(connection);
        // A server with no bot yet: the connectors come first (once, on this device), then "Crie
        // seu bot", and only then the app. A list that cannot be read is no reason to hold the app back.
        const bots = await services.api.bots.list().catch(() => null);
        const next: Phase = {
          kind: entryAfterConnect(bots === null ? null : bots.length),
          services,
        };
        // From the connect screen to the entrance's last steps: that screen fades out, the bot sets off after.
        if (next.kind !== "ready" && phaseRef.current.kind === "connect") {
          setLeavingConnect(true);
          if (!readReducedMotion()) await new Promise((done) => setTimeout(done, WELCOME_EXIT_MS));
        }
        setPhase(next);
      } catch (e) {
        setSaved(connection);
        setError(describeConnectError(e));
        setPhase(mode === "local" ? { kind: "local", firstRun: false } : { kind: "connect" });
      } finally {
        setLeavingConnect(false);
        setBusy(false);
      }
    },
    [disconnect, switchServer],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const platform = await getPlatform();
      platformRef.current = platform;
      void platform.frame?.custom().then(
        (custom) => useUi.getState().setCustomFrame(custom),
        () => undefined,
      );
      await initSettings(platform);
      const mode = platform.local === undefined ? "vps" : await (platform.mode?.load() ?? null);
      if (cancelled) return;
      // A device that never saw the welcome sees it before choosing or reaching a server.
      const first = (next: "choose" | "connect"): Phase =>
        welcomeDone() ? { kind: next } : { kind: "welcome", next };
      if (mode === null) {
        setPhase(first("choose"));
      } else if (mode === "local") {
        setPhase({ kind: "local", firstRun: false });
      } else {
        const stored = await platform.connection.load();
        if (cancelled) return;
        if (stored === null) setPhase(first("connect"));
        else await open(stored, platform, "vps");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const platform = platformRef.current;
  const openLocal = useCallback(async () => {
    const current = platformRef.current;
    if (current?.local === undefined) return;
    await open(await current.local.connection(), current, "local");
  }, [open]);

  return (
    <>
      {customFrame && platform?.frame !== undefined && (
        <>
          {/* Before the shell there is no header of its own to drag the window by. */}
          {phase.kind !== "ready" && (
            <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-30 h-8" />
          )}
          <WindowControls frame={platform.frame} />
        </>
      )}
      {phase.kind === "boot" && (
        <div className="flex h-full items-center justify-center text-text-muted" role="status">
          Conectando…
        </div>
      )}
      {/* One bot for the welcome and the screen after it: it goes from the middle to the corner. */}
      {(phase.kind === "welcome" ||
        phase.kind === "choose" ||
        phase.kind === "connect" ||
        phase.kind === "connectors" ||
        phase.kind === "create-bot") && (
        <Stage key={stageRun} startsAt={stageStart(phase.kind)}>
          {phase.kind === "welcome" && (
            <WelcomeScreen
              onDone={(name) => {
                markWelcomeDone();
                setPendingOwnerName(name);
                setPhase({ kind: phase.next });
              }}
            />
          )}
          {phase.kind === "choose" && (
            <FirstRunScreen
              onLocal={() => setPhase({ kind: "local", firstRun: true })}
              onVps={() => setPhase({ kind: "connect" })}
            />
          )}
          {phase.kind === "connect" && (
            <ConnectScreen
              initial={saved}
              error={error}
              busy={busy}
              leaving={leavingConnect}
              // Back is the step before: the choice of server in the app; in the browser, the
              // welcome (its name forgotten, so it can be typed again).
              onBack={() => {
                if (platform?.local !== undefined) {
                  setPhase({ kind: "choose" });
                  return;
                }
                resetWelcome();
                setStageRun((n) => n + 1);
                setPhase({ kind: "welcome", next: "connect" });
              }}
              onCheckAddress={async (serverUrl) => {
                if (platform === null) return describeConnectError(undefined);
                try {
                  await checkServer(normalizeServerUrl(serverUrl), platform);
                  return undefined;
                } catch (e) {
                  return describeConnectError(e);
                }
              }}
              onSubmit={(serverUrl, token) => {
                if (platform === null) return;
                void open(
                  { serverUrl: normalizeServerUrl(serverUrl), token: token.trim() },
                  platform,
                  "vps",
                );
              }}
            />
          )}
          {phase.kind === "connectors" && (
            <ServicesProvider services={phase.services}>
              <ConnectorsStep
                onDone={() => {
                  markConnectorsStepDone();
                  setPhase({ kind: "create-bot", services: phase.services });
                }}
              />
            </ServicesProvider>
          )}
          {phase.kind === "create-bot" && (
            <ServicesProvider services={phase.services}>
              <CreateBotFlow
                onCreated={() => setPhase({ kind: "ready", services: phase.services })}
              />
            </ServicesProvider>
          )}
        </Stage>
      )}
      {phase.kind === "local" && platform?.local !== undefined && (
        <LocalScreen
          local={platform.local}
          askKey={phase.firstRun}
          connectError={error}
          onReady={() => void openLocal()}
          onSwitch={() => void switchServer()}
        />
      )}
      {phase.kind === "ready" && (
        <ServicesProvider services={phase.services}>
          <Shell />
        </ServicesProvider>
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
