/*
 * Our copies of the shadcn `select` and `combobox` of the base-maia style (shadcn CLI 4.23.0, preset
 * b3XoIU6DI0, 24/11/2026), on Base UI's Select and Combobox. Rewritten to our tokens (docs/DESIGN.md
 * §2a, §3c): the quiet text-and-chevron of a settings row or the bordered control of a form, the
 * shared popup surface of `ui/popover.tsx`, options drawn as the items of our menus. The public API
 * did not change (`Dropdown`, `DropdownOption`, `DROPDOWN_FILTER_AFTER`).
 *
 * A short list is a Select (`role="combobox"` on the button, a `listbox` of `option`s). A long one
 * (more than `filterAfter` options) is a Combobox with its field INSIDE the popup ("Filtrar"): Base
 * UI's Select does not filter, and its docs say to use the Combobox when a list is long enough. The
 * filter is a case-insensitive substring of the labels already loaded, never a pattern.
 */
import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../lib/cx.js";
import { MENU_ITEM } from "./menu.js";
import { POPUP_LAYER, POPUP_MOTION, POPUP_SURFACE } from "./popover.js";

export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  /** A muted line under the label. */
  description?: string;
}

/** With more options than this the list gets a filter field at the top. */
export const DROPDOWN_FILTER_AFTER = 8;

/** `quiet`: text and chevron, no box until hover; `field`: the bordered control of a form. */
const TRIGGER = {
  quiet:
    "h-8 rounded-pill border-transparent bg-transparent px-3 text-small aria-expanded:bg-raised enabled:hover:bg-raised",
  field: "h-control w-full rounded-pill border-border bg-bg px-4 text-body",
} as const;

const TRIGGER_BASE =
  "inline-flex max-w-full items-center justify-between gap-2 border text-left text-text focus-visible:border-border-strong focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";

/**
 * The list's panel: at least as wide as its button and as a menu, at most the dropdown's width,
 * never taller than the room on its side (it scrolls inside).
 */
const PANEL = cx(
  "flex max-h-[min(var(--available-height),var(--height-dropdown))] w-max max-w-dropdown min-w-[max(var(--anchor-width),var(--width-menu))] flex-col overflow-hidden p-1.5",
  POPUP_SURFACE,
  POPUP_MOTION,
);

/** Where the list opens: under the button, lined up with its end (a quiet row) or its start (a form). */
const ALIGN = { quiet: "end", field: "start" } as const;

/** The content of an option: its label and, when it has one, the muted line under it. */
function OptionBody({ option }: { option: DropdownOption }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span data-testid="menu-label">{option.label}</span>
      {option.description !== undefined && (
        <span className="text-small text-text-muted">{option.description}</span>
      )}
    </span>
  );
}

const CHECK = <Check size={16} className="flex-none text-text-muted" aria-hidden="true" />;
const CHEVRON = <ChevronDown size={14} className="flex-none text-text-muted" aria-hidden="true" />;

interface DropdownProps<V extends string> {
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
}

/**
 * The app's one dropdown (docs/DESIGN.md §3c): never a native select element. A button with the
 * current value and a chevron opens our menu surface, in a portal on the body (so a dialog never cuts
 * it). Keyboard (Base UI): Enter, Space and the arrows open it; arrows, Home and End move; typing
 * jumps to a label; Enter chooses; Escape closes it and gives the focus back to the button, without
 * closing the dialog around.
 */
export function Dropdown<V extends string>(props: DropdownProps<V>) {
  const filterAfter = props.filterAfter ?? DROPDOWN_FILTER_AFTER;
  return props.options.length > filterAfter ? (
    <FilteredDropdown {...props} />
  ) : (
    <ShortDropdown {...props} />
  );
}

function ShortDropdown<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  variant = "quiet",
  placeholder,
  disabled,
  id,
}: DropdownProps<V>) {
  const current = options.find((o) => o.value === value);
  return (
    <Select.Root
      value={value}
      modal={false}
      disabled={disabled === true}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as V);
      }}
    >
      <Select.Trigger
        id={id}
        aria-label={label}
        data-testid={testId}
        data-value={value}
        className={cx(TRIGGER_BASE, TRIGGER[variant])}
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder ?? ""}</span>
        {CHEVRON}
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align={ALIGN[variant]}
          sideOffset={6}
          collisionPadding={8}
          className={cx(POPUP_LAYER, "outline-none")}
        >
          <Select.Popup className={PANEL}>
            <Select.List aria-label={label} className="flex min-h-0 flex-col overflow-y-auto">
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  label={o.label}
                  data-value={o.value}
                  className={MENU_ITEM}
                >
                  <OptionBody option={o} />
                  <Select.ItemIndicator render={<span className="flex flex-none" />}>
                    {CHECK}
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function FilteredDropdown<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  variant = "quiet",
  placeholder,
  disabled,
  id,
}: DropdownProps<V>) {
  const current = options.find((o) => o.value === value) ?? null;
  // The values the Combobox works with are the options themselves (it shows their labels).
  const items = useMemo(() => [...options], [options]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<DropdownOption<V> | undefined>(undefined);
  const matches = (o: DropdownOption<V>, text: string): boolean =>
    o.label.toLowerCase().includes(text.trim().toLowerCase());
  return (
    <Combobox.Root
      items={items}
      value={current}
      open={open}
      inputValue={query}
      onInputValueChange={(next) => setQuery(next)}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onItemHighlighted={(next: DropdownOption<V> | undefined) => setHighlighted(next)}
      modal={false}
      autoHighlight
      disabled={disabled === true}
      itemToStringLabel={(o: DropdownOption<V>) => o.label}
      isItemEqualToValue={(a: DropdownOption<V>, b: DropdownOption<V>) => a.value === b.value}
      // A case-insensitive substring of the label (docs/REGRAS.md §1: never a pattern).
      filter={matches}
      onValueChange={(next: DropdownOption<V> | null) => {
        if (next !== null && next.value !== value) onChange(next.value);
      }}
    >
      <Combobox.Trigger
        id={id}
        aria-label={label}
        data-testid={testId}
        data-value={value}
        className={cx(TRIGGER_BASE, TRIGGER[variant])}
      >
        <span className="min-w-0 truncate">{current?.label ?? placeholder ?? ""}</span>
        {CHEVRON}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align={ALIGN[variant]}
          sideOffset={6}
          collisionPadding={8}
          className={cx(POPUP_LAYER, "outline-none")}
        >
          <Combobox.Popup aria-label={label} className={PANEL}>
            <div className="mb-1 flex h-9 flex-none items-center gap-2 border-b border-border px-3 text-text-muted">
              <Search size={14} aria-hidden="true" />
              <Combobox.Input
                aria-label={`Filtrar: ${label}`}
                placeholder="Filtrar"
                autoComplete="off"
                onKeyDown={(e) => {
                  // Enter with nothing highlighted takes the first match, as the filter shows it.
                  if (e.key !== "Enter" || highlighted !== undefined) return;
                  const first = options.find((o) => matches(o, query));
                  if (first === undefined) return;
                  e.preventDefault();
                  setOpen(false);
                  setQuery("");
                  if (first.value !== value) onChange(first.value);
                }}
                className="min-w-0 flex-1 border-0 bg-transparent text-small text-text focus-visible:outline-none"
              />
            </div>
            <Combobox.Empty className="text-small text-text-muted">
              <p className="p-3">Nada com “{query.trim()}”.</p>
            </Combobox.Empty>
            <Combobox.List aria-label={label} className="flex min-h-0 flex-col overflow-y-auto">
              {(o: DropdownOption<V>) => (
                <Combobox.Item key={o.value} value={o} data-value={o.value} className={MENU_ITEM}>
                  <OptionBody option={o} />
                  <Combobox.ItemIndicator render={<span className="flex flex-none" />}>
                    {CHECK}
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
