import { X } from "lucide-react";
import { useState } from "react";
import { useData } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { cx } from "../../lib/cx.js";
import { PANEL_SPEC } from "../../lib/pane-size.js";
import { Avatar } from "../../ui/avatar.js";
import { LibraryList } from "../../ui/library-list.js";
import { RoundButton, Tabs } from "../../ui/primitives.js";
import { ResizeHandle } from "../../ui/resize-handle.js";
import { ActivityTab } from "./ActivityTab.js";
import { RoutineDetail } from "./RoutineDetail.js";

const TABS = [
  { id: "activity", label: "Atividade" },
  { id: "library", label: "Biblioteca" },
] as const;

/** The bot's panel on the right: who it is, and two tabs, Atividade and Biblioteca. */
export function Panel({ botId }: { botId: string }) {
  const bot = useData((s) => s.bots[botId]);
  const tab = useUi((s) => s.panelTab);
  const setTab = useUi((s) => s.setPanelTab);
  const togglePanel = useUi((s) => s.togglePanel);
  const panelWidth = useUi((s) => s.panelWidth);
  const setPanelLayout = useUi((s) => s.setPanelLayout);
  const routineId = useUi((s) => s.panelRoutineId);
  const customFrame = useUi((s) => s.customFrame);
  const [now] = useState(() => new Date());
  if (bot === undefined) return null;
  const resize = (
    <ResizeHandle
      spec={PANEL_SPEC}
      edge="start"
      layout={{ collapsed: false, width: panelWidth }}
      cssVar="--panel-w"
      label="Redimensionar o painel"
      liveCollapse={false}
      onCommit={setPanelLayout}
    />
  );
  const frame =
    "relative flex min-h-0 min-w-0 flex-[0_1_var(--panel-w,var(--width-panel))] flex-col border-l border-border data-[closing=true]:opacity-50";
  // A routine opened from the list: its detail takes the whole panel (docs/DESIGN.md §5b).
  if (routineId !== null) {
    return (
      <aside className={frame} aria-label={`Painel de ${bot.name}`} data-testid="panel">
        <RoutineDetail key={routineId} botId={bot.id} routineId={routineId} />
        {resize}
      </aside>
    );
  }
  return (
    <aside className={frame} aria-label={`Painel de ${bot.name}`} data-testid="panel">
      <div
        className="relative flex flex-none flex-col items-center gap-4 px-5 pt-14 pb-5"
        data-tauri-drag-region
      >
        <RoundButton
          label="Fechar o painel"
          tone="ghost"
          className={cx("absolute top-3", customFrame ? "right-37.5" : "right-3")}
          onClick={togglePanel}
        >
          <X size={18} aria-hidden="true" />
        </RoundButton>
        <Avatar
          avatar={bot.avatar}
          avatarStyle={bot.avatarStyle}
          pixel3d={bot.avatarPixel3d}
          color={bot.color}
          seed={bot.id}
          size="xl"
          supervisor={bot.isDefault}
        />
        <h2 className="text-title font-label">{bot.name}</h2>
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={(id) => setTab(id as "activity" | "library")}
          label="Seções do painel"
          idPrefix="panel"
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-5"
        role="tabpanel"
        id={`panel-panel-${tab}`}
        aria-labelledby={`panel-${tab}`}
      >
        {tab === "activity" ? <ActivityTab botId={botId} /> : <LibraryList items={[]} now={now} />}
      </div>
      {resize}
    </aside>
  );
}
