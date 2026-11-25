import { useEffect, useLayoutEffect, useMemo } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { syncOwnerName } from "../../lib/owner-name.js";
import { ChatScreen } from "../chat/ChatScreen.js";
import { InspectorScreen } from "../inspector/InspectorScreen.js";
import { MemoryScreen } from "../memory/MemoryScreen.js";
import { NewBotDialog } from "../new-bot/NewBotDialog.js";
import { NoBots } from "../new-bot/NoBots.js";
import { SupervisorOffer } from "../new-bot/SupervisorOffer.js";
import { CommandPalette, ShortcutsDialog } from "../palette/CommandPalette.js";
import { PendingScreen } from "../pending/PendingScreen.js";
import { ConnectorsScreen } from "../plugins/ConnectorsScreen.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import { ApprovalAnnouncer } from "./ApprovalAnnouncer.js";
import { GroupDialog } from "./GroupDialog.js";
import { IsolationNotice } from "./IsolationNotice.js";
import { Sidebar } from "./Sidebar.js";
import { UpdateNotice, useUpdateChecks } from "./UpdateNotice.js";

/** The frame of the app: the sidebar (or the rail) on the left and one content area. */
export function Shell() {
  const bots = useData((s) => s.bots);
  const loaded = useData((s) => s.botsLoaded);
  const phase = useData((s) => s.connection.phase);
  const view = useUi((s) => s.view);
  const selected = useUi((s) => s.selectedBotId);
  const newBotOpen = useUi((s) => s.newBotOpen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const groupBotId = useUi((s) => s.groupBotId);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const list = useMemo(() => sortedBots(bots), [bots]);
  const { api, platform } = useServices();
  useUpdateChecks(platform.updater);

  // Connected: the name typed in the welcome goes to the server (only if it has none), and the
  // account of the sidebar says the name the server has.
  useEffect(() => {
    let current = true;
    void syncOwnerName(api).then((name) => {
      if (current) useUi.getState().setOwnerName(name);
    });
    return () => {
      current = false;
    };
  }, [api]);

  // Nothing selected yet (or the selected bot vanished): the main bot, else the first.
  useEffect(() => {
    if (!loaded) return;
    const current = selected === null ? undefined : bots[selected];
    if (current === undefined || current.archivedAt !== null) {
      const main = list.find((b) => b.isDefault) ?? list[0];
      if (main !== undefined) useUi.setState({ selectedBotId: main.id, botPicked: false });
    }
  }, [loaded, selected, bots, list]);

  // Ctrl/Cmd+K opens the command palette from anywhere. Registered before the first paint
  // (`useLayoutEffect`): the sidebar is on screen as soon as it paints, so a shortcut pressed right
  // after a reload must already work (it was lost to the gap between paint and a plain effect).
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUi.getState().setPalette(!useUi.getState().paletteOpen);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useUi.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const banner =
    phase === "reconnecting"
      ? "Reconectando ao servidor…"
      : phase === "connecting"
        ? "Conectando ao servidor…"
        : undefined;

  return (
    <div className="flex h-full min-w-0">
      <Sidebar />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {banner !== undefined && (
          <div
            className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-pill border border-border-strong bg-raised px-4 py-1.5 text-small"
            role="status"
            data-testid="connection-banner"
          >
            {banner}
          </div>
        )}
        {/* A team with no bot (all archived): a friendly line and the way to make one. A new
            account makes its first bot in the entrance, before the app. */}
        {view === "chat" && (loaded && list.length === 0 ? <NoBots /> : <ChatScreen />)}
        {view === "pending" && <PendingScreen />}
        {view === "memory" && <MemoryScreen />}
        {view === "inspector" && <InspectorScreen />}
        {view === "connectors" && <ConnectorsScreen />}
      </div>
      <ApprovalAnnouncer />
      <IsolationNotice />
      <UpdateNotice />
      {settingsOpen && <SettingsDialog />}
      {newBotOpen && <NewBotDialog />}
      <SupervisorOffer />
      {groupBotId !== null && <GroupDialog />}
      {paletteOpen && <CommandPalette />}
      {shortcutsOpen && <ShortcutsDialog />}
    </div>
  );
}
