import { Check } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "../lib/cx.js";
import { RoundButton } from "./primitives.js";

export interface MenuItem {
  id: string;
  label: string;
  /** A muted line under the label. */
  description?: string;
  /** A menu item that is on or off (drawn with a check): `role="menuitemcheckbox"`. */
  checked?: boolean;
  testId?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick(): void;
}

/** The panel of every menu (a menu button, a context menu, the list of a dropdown). */
export const MENU_PANEL =
  "flex min-w-menu flex-col rounded-row border border-border-strong bg-raised p-1 shadow-popover";

/** One entry of a menu or one option of a dropdown (`aria-selected` marks the chosen one). */
export function menuItemClass(danger?: boolean): string {
  return cx(
    "flex items-center justify-between gap-3 rounded-inner border-0 bg-transparent px-3 py-2.5 text-left text-label leading-inherit focus-visible:bg-hover enabled:hover:bg-hover disabled:opacity-40 aria-selected:bg-hover",
    danger === true && "text-danger-text",
  );
}

const ENTRY = '[role^="menuitem"]:not([disabled])';

/**
 * Focus a menu item without letting the browser scroll the page to reveal it: the menu is `fixed`,
 * and a plain `focus()` of an item that is cut by the list's own scroll also scrolls the chat
 * behind it, which the menu takes for "the screen moved" and closes. The list is scrolled by hand.
 */
export function focusEntry(el: HTMLElement | null | undefined): void {
  if (el === undefined || el === null) return;
  el.focus({ preventScroll: true });
  const list = el.closest<HTMLElement>('[role="menu"]');
  if (list === null) return;
  const top = el.offsetTop; // the list is positioned: it is the item's offset parent
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + el.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = top + el.offsetHeight - list.clientHeight;
}

/** The content of a menu item: its label, and the muted line and the check when it has them. */
export function MenuItemBody({ item }: { item: MenuItem }) {
  return (
    <>
      <span className="flex min-w-0 flex-col">
        <span data-testid="menu-label">{item.label}</span>
        {item.description !== undefined && (
          <span className="text-small text-text-muted">{item.description}</span>
        )}
      </span>
      {item.checked === true && (
        <Check size={16} className="flex-none text-text-muted" aria-hidden="true" />
      )}
    </>
  );
}

/**
 * A button that opens a small menu (ARIA menu button: arrows, Home/End, Escape and focus back to the
 * button, click outside). `trigger` draws the button itself (the chevron of a split button);
 * `placement` opens it above or below, aligned to the end of the button.
 */
export function MenuButton({
  label,
  icon,
  items,
  trigger,
  placement = "below",
  disabled,
}: {
  label: string;
  icon?: ReactNode;
  items: readonly MenuItem[];
  trigger?(props: MenuTriggerProps): ReactNode;
  placement?: "below" | "above";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  // Placed by the screen (fixed): above the button when it fits, else below, else on the side
  // with more room, with a scroll of its own: a tall menu is never cut by the chat or its header.
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open || placement !== "above") {
      setPos(undefined);
      return;
    }
    const list = rootRef.current?.querySelector<HTMLElement>('[role="menu"]');
    const rect = rootRef.current?.getBoundingClientRect();
    if (list === null || list === undefined || rect === undefined) return;
    const edge = 8;
    const top = 72; // under the chat's header
    const above = rect.top - top;
    const below = window.innerHeight - rect.bottom - edge;
    const wanted = list.scrollHeight + 6;
    const up = above >= wanted || above >= below;
    const side = up ? above : below;
    setPos({
      position: "fixed",
      right: Math.max(edge, window.innerWidth - rect.right),
      ...(up
        ? { top: "auto", bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
      left: "auto",
      maxHeight: Math.max(160, side - 6),
      overflowY: "auto",
    });
  }, [open, placement]);
  useEffect(() => {
    if (!open || placement !== "above") return;
    const close = (e?: Event) => {
      if (e?.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open, placement]);
  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLElement>(ENTRY);
    focusEntry(first);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    const entries = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(ENTRY) ?? []);
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      e.preventDefault();
      focusEntry(entries[(next + entries.length) % entries.length]);
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(entries.length - 1);
    else if (e.key === "Tab") setOpen(false);
  };

  const triggerProps: MenuTriggerProps = {
    ref: buttonRef,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => setOpen((v) => !v),
  };
  return (
    <div className="relative" ref={rootRef} onKeyDown={onKeyDown}>
      {trigger !== undefined ? (
        trigger(triggerProps)
      ) : (
        <RoundButton label={label} tone="ghost" disabled={disabled} {...triggerProps}>
          {icon}
        </RoundButton>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cx(
            MENU_PANEL,
            "absolute top-[calc(100%+var(--menu-gap))] right-0 z-30 min-w-menu-wide",
          )}
          {...(pos === undefined ? {} : { style: pos })}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              {...(item.checked === undefined
                ? { role: "menuitem" }
                : { role: "menuitemcheckbox", "aria-checked": item.checked })}
              disabled={item.disabled}
              data-testid={item.testId}
              className={menuItemClass(item.danger)}
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
                item.onSelect();
              }}
            >
              <MenuItemBody item={item} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
