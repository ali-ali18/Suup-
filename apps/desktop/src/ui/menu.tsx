import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { RoundButton } from "./primitives.js";

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}

/** A button that opens a small menu (ARIA menu button: arrows, Home/End, Escape, click outside). */
export function MenuButton({
  label,
  icon,
  items,
}: {
  label: string;
  icon: ReactNode;
  items: readonly MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
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
    const entries = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
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

  return (
    <div className="ui-menu" ref={rootRef} onKeyDown={onKeyDown}>
      <RoundButton
        ref={buttonRef}
        label={label}
        tone="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </RoundButton>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className="ui-menu__list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`ui-menu__item${item.danger ? " ui-menu__item--danger" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
