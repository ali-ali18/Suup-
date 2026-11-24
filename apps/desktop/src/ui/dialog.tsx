/*
 * Our copy of the shadcn `dialog` of the base-maia style (shadcn CLI 4.23.0, preset b3XoIU6DI0,
 * 24/11/2026), on Base UI's Dialog. Rewritten to our tokens (docs/DESIGN.md §2a, §3c, §7): the
 * scrim of `--color-scrim` (never the dark fill and the blur of the original), the card radius, the strong 1 px border,
 * `shadow-popover`, the X of the app ("Fechar janela", in pt-BR), and an entrance and an exit that
 * fade and grow a little (docs/DESIGN.md §1 "Nada seco"; reduced motion zeroes them).
 *
 * Base UI gives the modal: `role="dialog"`, the focus taken on opening (the first control) and
 * kept inside (Tab and Shift+Tab loop), Escape and a press outside close the topmost one only, the
 * focus goes back to what had it, the page behind is inert. We add `aria-modal="true"`: the rule of
 * `lib/focus.ts` (nothing in the chat takes the focus while a modal is open) reads it.
 *
 * A dialog is open while it is mounted. A dismissal (Escape, a press on the scrim, the X) plays the
 * exit and THEN calls `onClose`; a screen that unmounts the dialog itself (a "Cancelar" of its own)
 * closes it at once.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import {
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useId,
  useState,
} from "react";
import { cx } from "../lib/cx.js";
import { IconButton } from "./primitives.js";

/** How a dismissal was asked for: the Escape key, a press on the scrim, or the X. */
export type DismissReason = "escape" | "outside" | "close";

const REASON: Record<string, DismissReason> = {
  "escape-key": "escape",
  "outside-press": "outside",
  "close-press": "close",
};

/** Where the surface sits: in the middle of the window, or near the top (the command palette). */
const PLACE = { center: "items-center", top: "items-start pt-[12vh]" } as const;

/** The entrance and the exit of a modal surface: it fades and grows a little from its centre. */
export const MODAL_MOTION =
  "transition-[opacity,scale] duration-(--duration-base) data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0";

/**
 * A modal surface: the scrim, the place, the focus and the dismissals. `className` is the surface
 * itself (its size, background, border and radius: the settings dialog and the palette have their
 * own); `Dialog` below is the plain one. `beforeClose` may keep it open (return `false`), for a
 * dialog where Escape first goes back a step.
 */
export function Modal({
  onClose,
  beforeClose,
  label,
  labelledBy,
  place = "center",
  className,
  testId,
  initialFocus,
  children,
  ...rest
}: {
  onClose(): void;
  beforeClose?(reason: DismissReason): boolean;
  label?: string;
  labelledBy?: string;
  place?: keyof typeof PLACE;
  className: string;
  testId?: string;
  /** What takes the focus on opening (by default the first control inside). */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
} & Pick<HTMLAttributes<HTMLDivElement>, "onKeyDown" | "onBlur">) {
  const [open, setOpen] = useState(true);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        const reason = REASON[details.reason] ?? "close";
        if (beforeClose !== undefined && !beforeClose(reason)) return;
        setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-base) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Viewport
          className={cx("fixed inset-0 z-40 flex justify-center p-5", PLACE[place])}
        >
          <DialogPrimitive.Popup
            aria-modal="true"
            aria-label={label}
            aria-labelledby={labelledBy}
            data-testid={testId}
            {...(initialFocus === undefined ? {} : { initialFocus })}
            className={cx("outline-none", className, MODAL_MOTION)}
            {...rest}
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A control that closes the dialog it is in, with the exit (the X of a dialog's head). `render` is
 * the button, which keeps its own name and look.
 */
export function DialogClose({ render }: { render: ReactElement<Record<string, unknown>> }) {
  return <DialogPrimitive.Close render={render} />;
}

/** The plain dialog: a title, the X, a body that scrolls, and a footer of buttons at the right. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className={cx(
        "flex max-h-[90vh] flex-col gap-4 overflow-hidden rounded-card border border-border-strong bg-surface p-6 shadow-popover",
        wide === true ? "w-dialog-wide" : "w-dialog",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <DialogPrimitive.Title id={titleId} className="text-title font-title">
          {title}
        </DialogPrimitive.Title>
        <DialogClose
          render={
            <IconButton label="Fechar janela">
              <X size={18} aria-hidden="true" />
            </IconButton>
          }
        />
      </div>
      {/* A tall form scrolls inside the dialog; the title and the buttons stay where they are. */}
      <div className="-m-0.5 min-h-0 flex-auto overflow-y-auto p-0.5">{children}</div>
      {footer !== undefined && <div className="flex flex-none justify-end gap-2">{footer}</div>}
    </Modal>
  );
}
