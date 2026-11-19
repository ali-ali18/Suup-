import { Check, ChevronDown, Search } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx.js";
import { MENU_PANEL, menuItemClass } from "./menu.js";

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  /** A muted line under the label. */
  description?: string;
}

/** With more options than this the list gets a filter field at the top. */
export const DROPDOWN_FILTER_AFTER = 8;

const OPTION = '[role="option"]';

/** `quiet`: text and chevron, no box until hover; `field`: the bordered control of a form. */
const TRIGGER = {
  quiet:
    "h-8 rounded-pill border-transparent bg-transparent px-3 text-small aria-expanded:bg-raised enabled:hover:bg-raised",
  field: "h-control w-full rounded-pill border-border bg-bg px-4 text-body",
} as const;

/**
 * The app's one dropdown (docs/DESIGN.md §3c): never a native select element. A button with the current
 * value and a chevron (`aria-haspopup="listbox"`) opens our menu surface, a listbox in a portal on
 * the body (so a dialog never cuts it). Keyboard: Enter, Space and ArrowDown/ArrowUp open it;
 * arrows, Home and End move; Enter chooses; Escape closes and gives the focus back to the button.
 * A long list has a filter field: a case-insensitive substring of the labels already loaded.
 * `quiet` is the text-and-chevron of a settings row; `field` is the bordered control of a form.
 */
export function Dropdown<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  variant = "quiet",
  placeholder,
  disabled,
  id,
  filterAfter = DROPDOWN_FILTER_AFTER,
}: {
  /** The accessible name (also names the list). */
  label: string;
  value: V;
  options: readonly DropdownOption<V>[];
  onChange(value: V): void;
  testId?: string;
  variant?: "quiet" | "field";
  /** Shown when `value` is none of the options (for example the empty choice). */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  filterAfter?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<CSSProperties | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const filtered = options.length > filterAfter;
  const needle = query.trim().toLowerCase();
  const shown =
    filtered && needle !== ""
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;
  const current = options.find((o) => o.value === value);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (next: V) => {
    close(true);
    if (next !== value) onChange(next);
  };

  // Placed by the screen (fixed): below the button when it fits, else above, with a scroll of its own.
  useLayoutEffect(() => {
    if (!open) {
      setPos(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const edge = 8;
    const wanted = Math.min(320, (panelRef.current?.scrollHeight ?? 320) + 2);
    const below = window.innerHeight - rect.bottom - edge - 6;
    const above = rect.top - edge - 6;
    const up = below < wanted && above > below;
    const room = Math.max(120, up ? above : below);
    const width = Math.max(rect.width, 200);
    const left =
      variant === "quiet"
        ? Math.min(Math.max(edge, rect.right - width), window.innerWidth - width - edge)
        : Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
    setPos({
      position: "fixed",
      left,
      minWidth: width,
      maxHeight: Math.min(320, room),
      ...(up
        ? { top: "auto", bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
    });
  }, [open, variant, shown.length]);

  // Focus: the filter field when there is one, else the chosen option (or the first). Only once the
  // panel has its place: until then it is hidden, and a hidden element cannot take the focus (Esc
  // would then reach the dialog around instead of closing just this menu).
  const placed = pos !== undefined;
  useEffect(() => {
    if (!open || !placed) return;
    if (filtered) filterRef.current?.focus({ preventScroll: true });
    else
      focusOption(
        panelRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
          first(panelRef.current),
      );
  }, [open, filtered, placed]);

  // Outside click, a resize or a scroll of the page behind (the trigger moved) close it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    // The page behind scrolled: close only when the button really moved from where it opened (a
    // scroll that was already under way when it opened does not move it).
    const at = buttonRef.current?.getBoundingClientRect();
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      const now = buttonRef.current?.getBoundingClientRect();
      if (at !== undefined && now !== undefined && at.top === now.top && at.left === now.left)
        return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPanelKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // the dialog around must not read these keys
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const entries = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(OPTION) ?? []);
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      e.preventDefault();
      focusOption(entries[Math.max(0, Math.min(entries.length - 1, next))]);
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") {
      if (index <= 0 && filtered) {
        e.preventDefault();
        filterRef.current?.focus({ preventScroll: true });
      } else move(index - 1);
    } else if (e.key === "Home" && index >= 0) move(0);
    else if (e.key === "End" && index >= 0) move(entries.length - 1);
    else if (e.key === "Enter" && document.activeElement === filterRef.current) {
      e.preventDefault();
      const top = shown[0];
      if (top !== undefined) choose(top.value);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={cx(
          "inline-flex max-w-full items-center justify-between gap-2 border text-left text-text focus-visible:border-border-strong focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40",
          TRIGGER[variant],
        )}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        data-testid={testId}
        data-value={value}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onButtonKey}
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={14} className="flex-none text-text-muted" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={cx(MENU_PANEL, "fixed z-60 max-w-dropdown overflow-hidden")}
            style={pos ?? { position: "fixed", visibility: "hidden" }}
            onKeyDown={onPanelKey}
          >
            {filtered && (
              <label className="mb-1 flex h-9 flex-none items-center gap-2 border-b border-border px-3 text-text-muted">
                <Search size={14} aria-hidden="true" />
                <input
                  className="min-w-0 flex-1 border-0 bg-transparent text-small text-text focus-visible:outline-none"
                  ref={filterRef}
                  type="text"
                  aria-label={`Filtrar: ${label}`}
                  placeholder="Filtrar"
                  autoComplete="off"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
            <div
              id={listId}
              role="listbox"
              aria-label={label}
              className="relative flex min-h-0 flex-col overflow-y-auto"
            >
              {shown.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  tabIndex={-1}
                  data-value={o.value}
                  className={menuItemClass()}
                  onClick={() => choose(o.value)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span data-testid="menu-label">{o.label}</span>
                    {o.description !== undefined && (
                      <span className="text-small text-text-muted">{o.description}</span>
                    )}
                  </span>
                  {o.value === value && (
                    <Check size={16} className="flex-none text-text-muted" aria-hidden="true" />
                  )}
                </button>
              ))}
              {shown.length === 0 && (
                <p className="p-3 text-small text-text-muted">Nada com “{query.trim()}”.</p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const first = (panel: HTMLElement | null): HTMLElement | null | undefined =>
  panel?.querySelector<HTMLElement>(OPTION);

/** Focus an option without letting the browser scroll the page; the list is scrolled by hand. */
function focusOption(el: HTMLElement | null | undefined): void {
  if (el === null || el === undefined) return;
  el.focus({ preventScroll: true });
  const list = el.closest<HTMLElement>('[role="listbox"]');
  if (list === null) return;
  const top = el.offsetTop; // the list is positioned: it is the offset parent
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + el.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = top + el.offsetHeight - list.clientHeight;
}
