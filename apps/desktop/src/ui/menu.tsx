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

const ENTRY = '[role^="menuitem"]:not([disabled])';

/** The content of a menu item: its label, and the muted line and the check when it has them. */
export function MenuItemBody({ item }: { item: MenuItem }) {
  return (
    <>
      <span className="ui-menu__text">
        <span className="ui-menu__label">{item.label}</span>
        {item.description !== undefined && (
          <span className="ui-menu__desc">{item.description}</span>
        )}
      </span>
      {item.checked === true && <Check size={16} className="ui-menu__check" aria-hidden="true" />}
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
    first?.focus();
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
      entries[(next + entries.length) % entries.length]?.focus();
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
    <div className="ui-menu" ref={rootRef} onKeyDown={onKeyDown}>
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
          className="ui-menu__list ui-menu__list--wide"
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
              className={`ui-menu__item${item.danger ? " ui-menu__item--danger" : ""}`}
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
