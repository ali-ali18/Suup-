import { useEffect, useRef } from "react";
import { type MenuItem, MenuItemBody } from "./menu.js";

/** A menu at a point of the screen (a context menu), with the same keyboard behaviour as `MenuButton`. */
export function PopupMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: readonly MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      previous?.focus?.();
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(x, window.innerWidth - 256));
  const top = Math.max(8, Math.min(y, window.innerHeight - 8 - items.length * 40));
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="ui-menu__list ui-menu__list--popup"
      style={{ left, top }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        const entries = Array.from(
          ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [],
        );
        const index = entries.indexOf(document.activeElement as HTMLElement);
        const go = (n: number) => {
          e.preventDefault();
          entries[(n + entries.length) % entries.length]?.focus();
        };
        if (e.key === "ArrowDown") go(index + 1);
        else if (e.key === "ArrowUp") go(index - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(entries.length - 1);
        else if (e.key === "Tab") onClose();
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={`ui-menu__item${item.danger ? " ui-menu__item--danger" : ""}`}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <MenuItemBody item={item} />
        </button>
      ))}
    </div>
  );
}
