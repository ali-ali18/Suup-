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

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  /** A muted line under the label. */
  description?: string;
}

/** With more options than this the list gets a filter field at the top. */
export const DROPDOWN_FILTER_AFTER = 8;

const OPTION = '[role="option"]';

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

  // Focus: the filter field when there is one, else the chosen option (or the first).
  useEffect(() => {
    if (!open) return;
    if (filtered) filterRef.current?.focus({ preventScroll: true });
    else
      focusOption(
        panelRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
          first(panelRef.current),
      );
  }, [open, filtered]);

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
        className={`ui-dropdown ui-dropdown--${variant}`}
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
        <span className="ui-dropdown__value">{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={14} className="ui-dropdown__chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="ui-menu__list ui-dropdown__panel"
            style={pos ?? { position: "fixed", visibility: "hidden" }}
            onKeyDown={onPanelKey}
          >
            {filtered && (
              <label className="ui-dropdown__filter">
                <Search size={14} aria-hidden="true" />
                <input
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
            <div id={listId} role="listbox" aria-label={label} className="ui-dropdown__list">
              {shown.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  tabIndex={-1}
                  data-value={o.value}
                  className="ui-menu__item"
                  onClick={() => choose(o.value)}
                >
                  <span className="ui-menu__text">
                    <span className="ui-menu__label">{o.label}</span>
                    {o.description !== undefined && (
                      <span className="ui-menu__desc">{o.description}</span>
                    )}
                  </span>
                  {o.value === value && (
                    <Check size={16} className="ui-menu__check" aria-hidden="true" />
                  )}
                </button>
              ))}
              {shown.length === 0 && (
                <p className="ui-dropdown__none">Nada com “{query.trim()}”.</p>
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
