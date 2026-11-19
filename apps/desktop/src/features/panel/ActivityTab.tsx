import { CalendarClock, MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { MutedText } from "../../ui/primitives.js";

/** A titled box of the panel: a muted title, then its rows in a card. */
function PanelSection({
  title,
  label,
  testId,
  children,
}: {
  title: string;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} data-testid={testId}>
      <h3 className="px-2 pb-2 text-label font-normal text-text-muted">{title}</h3>
      <div className="rounded-card border border-border bg-surface p-1">{children}</div>
    </section>
  );
}

/** One row of a panel box: an optional icon, a title with a line under it, an optional thumbnail. */
function PanelRow({
  icon,
  title,
  text,
  thumb,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  thumb?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 p-3">
      {icon !== undefined && (
        <span className="inline-flex text-text-muted" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label">{title}</span>
        <MutedText>{text}</MutedText>
      </span>
      {thumb !== undefined && (
        <span
          className="inline-flex h-12 w-20 items-center justify-center rounded-inner bg-raised text-text-muted"
          aria-hidden="true"
        >
          {thumb}
        </span>
      )}
    </div>
  );
}

/** The Atividade tab: what the bot has coming (routines) and its computer. Both wait for their phases. */
export function ActivityTab() {
  return (
    <div className="flex flex-col gap-6">
      <PanelSection title="Em breve" label="Em breve" testId="section-soon">
        <PanelRow
          icon={<CalendarClock size={16} />}
          title="Nenhuma rotina"
          text="As rotinas deste bot vão aparecer aqui."
        />
      </PanelSection>
      <PanelSection title="Computador" label="Computador" testId="section-computer">
        <PanelRow
          title="Computador do bot"
          text="Ainda não disponível"
          thumb={<MonitorSmartphone size={22} />}
        />
      </PanelSection>
    </div>
  );
}
