import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectScreen } from "../features/connect/ConnectScreen.js";
import { FirstRunScreen } from "../features/connect/FirstRunScreen.js";
import { LocalScreen } from "../features/connect/LocalScreen.js";
import { Shell } from "../features/shell/Shell.js";
import { type Connection, getPlatform, type Platform, type ServerMode } from "../lib/platform.js";
import { ToastStack } from "../ui/primitives.js";
import { WindowControls } from "../ui/window-controls.js";
import { connect, describeConnectError, normalizeServerUrl } from "./connect.js";
import { type Services, ServicesProvider } from "./context.js";
import { initSettings } from "./settings-store.js";
import { useUi } from "./ui-store.js";

type Phase =
  | { kind: "boot" }
  /** The first-run choice: this computer or a VPS. */
  | { kind: "choose" }
  | { kind: "connect" }
  /** The embedded server: `firstRun` asks for the model key before starting. */
  | { kind: "local"; firstRun: boolean }
  | { kind: "ready"; services: Services };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [saved, setSaved] = useState<Connection | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
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
        const services = await connect(connection, platform, { mode, disconnect, switchServer });
        if (mode === "vps") {
          await platform.connection.save(connection);
          await platform.mode?.save("vps");
        }
        servicesRef.current = services;
        setSaved(connection);
        setPhase({ kind: "ready", services });
      } catch (e) {
        setSaved(connection);
        setError(describeConnectError(e));
        setPhase(mode === "local" ? { kind: "local", firstRun: false } : { kind: "connect" });
      } finally {
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
      if (mode === null) {
        setPhase({ kind: "choose" });
      } else if (mode === "local") {
        setPhase({ kind: "local", firstRun: false });
      } else {
        const stored = await platform.connection.load();
        if (cancelled) return;
        if (stored === null) setPhase({ kind: "connect" });
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
          {...(platform?.local === undefined ? {} : { onBack: () => setPhase({ kind: "choose" }) })}
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
