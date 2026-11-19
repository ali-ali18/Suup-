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
import { cx } from "../lib/cx.js";

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

/** The one colour of a seal: done and failed use the semantic colours, the quiet ones are muted. */
const CHIP_TONE: Partial<Record<ChipKind, string>> = {
  done: "text-success-text",
  failed: "text-danger-text",
  cancelled: "text-text-muted",
  queued: "text-text-muted",
  paused: "text-text-muted",
};

/** The status seal of a bot or a run (Figma v2/Selo de status). */
export function StatusChip({ kind, label }: { kind: ChipKind; label?: string }) {
  const Icon = ICON[kind];
  return (
    <span
      className={cx(
        "inline-flex h-5.5 items-center gap-1.5 rounded-pill border border-border bg-raised pr-2.5 pl-2 text-section font-label whitespace-nowrap",
        CHIP_TONE[kind] ?? "text-text",
      )}
      data-chip={kind}
    >
      <Icon
        size={12}
        strokeWidth={2}
        className={SPINS.has(kind) ? "animate-spin" : undefined}
        aria-hidden="true"
      />
      {label ?? CHIP_LABEL[kind]}
    </span>
  );
}
