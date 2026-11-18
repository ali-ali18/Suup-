import type { AvatarStateId } from "@suup/avatar";
import type { ChipKind } from "../data/derive.js";
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
      className={`ui-bot${p.active ? " ui-bot--active" : ""}`}
      aria-current={p.active ? "page" : undefined}
      onClick={p.onSelect}
      data-testid="bot-item"
    >
      <Avatar avatar={p.avatar} seed={p.seed} size="md" state={p.state} />
      <span className="ui-bot__text">
        <span className="ui-bot__name">{p.name}</span>
        <span className="ui-bot__sub">{p.subtitle}</span>
      </span>
      <span className="ui-bot__meta">
        {p.chip !== null && <StatusChip kind={p.chip} />}
        <Counter
          value={p.unread}
          label={`${p.unread} ${p.unread === 1 ? "mensagem não lida" : "mensagens não lidas"}`}
        />
      </span>
    </button>
  );
}
