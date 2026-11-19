import type { AvatarStateId } from "@suup/avatar";
import type { ChipKind } from "../data/derive.js";
import { cx } from "../lib/cx.js";
import { Avatar } from "./avatar.js";
import { Counter } from "./primitives.js";
import { StatusChip } from "./status-chip.js";

export interface BotItemProps {
  name: string;
  subtitle: string;
  avatar: string | null;
  seed: string;
  active: boolean;
  chip: ChipKind | null;
  state: AvatarStateId;
  unread: number;
  onSelect(): void;
}

/** A row of the bots list (Figma v2/Item de bot). */
export function BotItem(p: BotItemProps) {
  return (
    <button
      type="button"
      className={cx(
        "flex w-full min-w-0 items-center gap-3 rounded-row border py-2.5 pr-3.5 pl-2.5 text-left hover:bg-hover",
        p.active ? "border-border bg-raised" : "border-transparent bg-transparent",
      )}
      aria-current={p.active ? "page" : undefined}
      onClick={p.onSelect}
      data-testid="bot-item"
    >
      <Avatar avatar={p.avatar} seed={p.seed} size="md" state={p.state} />
      <span className="flex min-w-0 flex-1 flex-col leading-label">
        <span className="truncate text-label font-label">{p.name}</span>
        <span className="truncate text-small text-text-muted">{p.subtitle}</span>
      </span>
      <span className="flex flex-none flex-col items-end gap-1">
        {p.chip !== null && <StatusChip kind={p.chip} />}
        <Counter
          value={p.unread}
          label={`${p.unread} ${p.unread === 1 ? "mensagem não lida" : "mensagens não lidas"}`}
        />
      </span>
    </button>
  );
}
