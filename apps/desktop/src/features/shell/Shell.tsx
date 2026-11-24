import { useEffect, useMemo } from "react";
import { useData } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { ChatScreen } from "../chat/ChatScreen.js";
import { InspectorScreen } from "../inspector/InspectorScreen.js";
import { MemoryScreen } from "../memory/MemoryScreen.js";
import { NewBotDialog } from "../new-bot/NewBotDialog.js";
import { CommandPalette, ShortcutsDialog } from "../palette/CommandPalette.js";
import { PendingScreen } from "../pending/PendingScreen.js";
import { ConnectorsScreen } from "../plugins/ConnectorsScreen.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import { ApprovalAnnouncer } from "./ApprovalAnnouncer.js";
import { GroupDialog } from "./GroupDialog.js";
import { IsolationNotice } from "./IsolationNotice.js";
import { Sidebar } from "./Sidebar.js";

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

  // Nothing selected yet (or the selected bot vanished): the main bot, else the first.
  useEffect(() => {
    if (!loaded) return;
    const current = selected === null ? undefined : bots[selected];
    if (current === undefined || current.archivedAt !== null) {
      const main = list.find((b) => b.isDefault) ?? list[0];
      if (main !== undefined) useUi.setState({ selectedBotId: main.id, botPicked: false });
    }
  }, [loaded, selected, bots, list]);

  // Ctrl/Cmd+K opens the command palette from anywhere.
  useEffect(() => {
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
        {view === "chat" && <ChatScreen />}
        {view === "pending" && <PendingScreen />}
        {view === "memory" && <MemoryScreen />}
        {view === "inspector" && <InspectorScreen />}
        {view === "connectors" && <ConnectorsScreen />}
      </div>
      <ApprovalAnnouncer />
      <IsolationNotice />
      {settingsOpen && <SettingsDialog />}
      {newBotOpen && <NewBotDialog />}
      {groupBotId !== null && <GroupDialog />}
      {paletteOpen && <CommandPalette />}
      {shortcutsOpen && <ShortcutsDialog />}
    </div>
  );
}
