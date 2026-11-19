import type { ReactNode } from "react";

/** The small rounded square that holds a card's icon: in the collapsed row and in a card's header. */
export function IconBox({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex size-icon-box flex-none items-center justify-center rounded-chip bg-raised text-text-muted"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
