import {
  Check,
  CircleHelp,
  Clock,
  LoaderCircle,
  Pause,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { CHIP_LABEL, type ChipKind } from "../data/derive.js";

const ICON: Record<ChipKind, typeof Check> = {
  working: LoaderCircle,
  thinking: LoaderCircle,
  resuming: RotateCcw,
  queued: Clock,
  doubt: CircleHelp,
  permission: ShieldCheck,
  paused: Pause,
  done: Check,
  failed: TriangleAlert,
  cancelled: X,
};

const SPINS: ReadonlySet<ChipKind> = new Set(["working", "thinking", "resuming"]);

/** The status seal of a bot or a run (Figma v2/Selo de status). */
export function StatusChip({ kind, label }: { kind: ChipKind; label?: string }) {
  const Icon = ICON[kind];
  return (
    <span className={`ui-chip ui-chip--${kind}`} data-chip={kind}>
      <Icon
        size={12}
        strokeWidth={2}
        className={SPINS.has(kind) ? "ui-spin" : undefined}
        aria-hidden="true"
      />
      {label ?? CHIP_LABEL[kind]}
    </span>
  );
}
