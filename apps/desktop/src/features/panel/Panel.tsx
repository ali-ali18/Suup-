import { X } from "lucide-react";
import { useState } from "react";
import { useData } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { Avatar } from "../../ui/avatar.js";
import { LibraryList } from "../../ui/library-list.js";
import { RoundButton, Tabs } from "../../ui/primitives.js";
import { ActivityTab } from "./ActivityTab.js";

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
  const [now] = useState(() => new Date());
  if (bot === undefined) return null;
  return (
    <aside className="panel" aria-label={`Painel de ${bot.name}`} data-testid="panel">
      <div className="panel__head">
        <RoundButton label="Fechar o painel" tone="ghost" onClick={togglePanel}>
          <X size={18} aria-hidden="true" />
        </RoundButton>
        <Avatar avatar={bot.avatar} color={bot.color} seed={bot.id} size="xl" />
        <h2 className="panel__name">{bot.name}</h2>
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={(id) => setTab(id as "activity" | "library")}
          label="Seções do painel"
          idPrefix="panel"
        />
      </div>
      <div
        className="panel__body"
        role="tabpanel"
        id={`panel-panel-${tab}`}
        aria-labelledby={`panel-${tab}`}
      >
        {tab === "activity" ? <ActivityTab /> : <LibraryList items={[]} now={now} />}
      </div>
    </aside>
  );
}
