/*
 * Our copy of the shadcn `dropdown-menu` of the base-maia style (shadcn CLI 4.23.0, preset
 * b3XoIU6DI0, 24/11/2026), on Base UI's Menu. Rewritten to our tokens (docs/DESIGN.md §2a): the
 * shared popup surface of `ui/popover.tsx`, items of the row radius highlighted with `bg-hover`,
 * a muted icon, a muted line under the label, the danger tone. The public API of the app's menus
 * did not change: `MenuButton` (a button that opens a menu) and `PopupMenu` (a menu at a point of
 * the screen, the context menu) take the same `MenuItem` list as before.
 *
 * Base UI gives the ARIA menu button: `role="menu"`/`menuitem`/`menuitemcheckbox`, arrows, Home and
 * End, typeahead, Escape and the focus back to the trigger, a press outside. The menus are not modal
 * (a press outside closes the menu and still reaches what was pressed), and the popup follows its
 * trigger when the page behind scrolls.
 */
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  useMemo,
  useState,
} from "react";
import { cx } from "../lib/cx.js";
import { POPUP_LAYER, POPUP_MOTION, POPUP_SURFACE } from "./popover.js";
import { RoundButton } from "./primitives.js";

export interface MenuItem {
  id: string;
  label: string;
  /** A muted line under the label. */
  description?: string;
  /** A lucide icon before the label (data only: the item draws it, muted, at the icon size). */
  icon?: LucideIcon;
  /** A short muted text at the right end of the row ("3" pending, a value): never a sentence. */
  hint?: string;
  /** The items of a submenu: the row opens it (a chevron at its right end) instead of acting. */
  submenu?: readonly MenuItem[];
  /** A menu item that is on or off (drawn with a check): `role="menuitemcheckbox"`. */
  checked?: boolean;
  testId?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}

/**
 * A group of items. Groups are split by a separator (Base UI's `Menu.Separator`), and a group that
 * needs a title has a `label` (Base UI's `Menu.GroupLabel`, the shadcn `DropdownMenuLabel`).
 */
export interface MenuSection {
  id: string;
  label?: string;
  items: readonly MenuItem[];
}

/** What a menu shows: plain items, or sections of them. */
export type MenuEntries = readonly MenuItem[] | readonly MenuSection[];

const isSections = (entries: MenuEntries): entries is readonly MenuSection[] =>
  entries.length > 0 && "items" in (entries[0] as MenuItem | MenuSection);

/** What a custom trigger receives and spreads on its button (Base UI's props: ref, ARIA, handlers). */
export type MenuTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
};

/** The panel of a menu: the shared popup surface, a scroll of its own when the window is short. */
const MENU_PANEL = cx(
  "flex max-h-(--available-height) flex-col overflow-y-auto p-1.5",
  POPUP_SURFACE,
  POPUP_MOTION,
);

/** The width of a menu: `wide` for a menu of a button (items with a line under them), `normal` at a point. */
const MENU_WIDTH = { normal: "min-w-menu", wide: "min-w-menu-wide" } as const;

/**
 * One row of a menu or a list (owner, 24/11/2026): the icon, the label in the normal weight, a
 * comfortable height, the highlight inset in the panel with the row radius (Base UI marks the row
 * under the pointer or the keys `data-highlighted`).
 */
export const MENU_ITEM =
  "flex w-full cursor-default items-center justify-between gap-2.5 rounded-row border-0 bg-transparent px-2.5 py-2 text-left text-label leading-inherit font-normal outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover data-popup-open:bg-hover";

/** The title of a group of a menu: small and muted, aligned with the labels of the rows. */
const MENU_LABEL = "px-2.5 pt-1.5 pb-1 text-small text-text-muted select-none";

/** The line between two groups, with room above and below. */
const MENU_SEPARATOR = "-mx-1.5 my-1.5 h-px flex-none bg-border";

const ITEM_TONE = { normal: "text-text", danger: "text-danger-text" } as const;

/** The content of a menu item: its icon, its label, the muted line and the check when it has them. */
export function MenuItemBody({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  return (
    <>
      {Icon !== undefined && (
        <Icon
          size={16}
          className={cx("flex-none", item.danger === true ? "" : "text-text-muted")}
          aria-hidden="true"
          data-testid="menu-icon"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-testid="menu-label">{item.label}</span>
        {item.description !== undefined && (
          <span className="text-small text-text-muted">{item.description}</span>
        )}
      </span>
      {item.hint !== undefined && (
        <span className="flex-none text-small text-text-muted" data-testid="menu-hint">
          {item.hint}
        </span>
      )}
      {item.checked === true && (
        <Check size={16} className="flex-none text-text-muted" aria-hidden="true" />
      )}
      {item.submenu !== undefined && (
        <ChevronRight size={16} className="flex-none text-text-muted" aria-hidden="true" />
      )}
    </>
  );
}

/**
 * The items of a menu: a plain item, a checkbox item when it is on or off, or the row of a
 * submenu. Each is a native button.
 */
function MenuItems({ items }: { items: readonly MenuItem[] }) {
  return items.map((item) => {
    if (item.submenu !== undefined)
      return (
        <Menu.SubmenuRoot key={item.id}>
          <Menu.SubmenuTrigger
            nativeButton
            render={<button type="button" />}
            disabled={item.disabled === true}
            data-testid={item.testId}
            label={item.label}
            className={cx(MENU_ITEM, ITEM_TONE.normal)}
          >
            <MenuItemBody item={item} />
          </Menu.SubmenuTrigger>
          <Menu.Portal>
            <Menu.Positioner
              side="right"
              align="start"
              alignOffset={-6}
              sideOffset={4}
              collisionPadding={8}
              className={cx(POPUP_LAYER, "outline-none")}
            >
              <Menu.Popup aria-label={item.label} className={cx(MENU_PANEL, MENU_WIDTH.normal)}>
                <MenuItems items={item.submenu} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.SubmenuRoot>
      );
    const shared = {
      nativeButton: true,
      render: <button type="button" />,
      disabled: item.disabled === true,
      "data-testid": item.testId,
      label: item.label,
      className: cx(MENU_ITEM, ITEM_TONE[item.danger === true ? "danger" : "normal"]),
      onClick: () => item.onSelect(),
    };
    return item.checked === undefined ? (
      <Menu.Item key={item.id} {...shared}>
        <MenuItemBody item={item} />
      </Menu.Item>
    ) : (
      // The state is the screen's: a click tells it (onSelect), and the item shows what it says.
      <Menu.CheckboxItem key={item.id} {...shared} checked={item.checked} closeOnClick>
        <MenuItemBody item={item} />
      </Menu.CheckboxItem>
    );
  });
}

/** The entries of a menu: the items, or the groups with their titles and the lines between them. */
function MenuContent({ entries }: { entries: MenuEntries }) {
  if (!isSections(entries)) return <MenuItems items={entries} />;
  return entries.map((section, index) => (
    <Menu.Group key={section.id} className="flex flex-col">
      {index > 0 && <Menu.Separator className={MENU_SEPARATOR} />}
      {section.label !== undefined && (
        <Menu.GroupLabel className={MENU_LABEL}>{section.label}</Menu.GroupLabel>
      )}
      <MenuItems items={section.items} />
    </Menu.Group>
  ));
}

/** The popup of a menu, in a portal on the body, above the dialogs. */
function MenuPopup({
  label,
  items,
  side,
  align,
  width,
  anchor,
}: {
  label: string;
  items: MenuEntries;
  side: "top" | "bottom";
  align: "start" | "end";
  width: keyof typeof MENU_WIDTH;
  anchor?: { getBoundingClientRect(): DOMRect };
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cx(POPUP_LAYER, "outline-none")}
        {...(anchor === undefined ? {} : { anchor })}
      >
        <Menu.Popup aria-label={label} className={cx(MENU_PANEL, MENU_WIDTH[width])}>
          <MenuContent entries={items} />
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

/**
 * A button that opens a small menu (ARIA menu button). `trigger` draws the button itself (the
 * chevron of a split button, the account button of the sidebar) from the props it is given;
 * `placement` opens it above or below; `align` lines it up with the start or the end of the button.
 */
export function MenuButton({
  label,
  icon,
  items,
  trigger,
  placement = "below",
  align = "end",
  disabled,
  width = "wide",
}: {
  label: string;
  icon?: ReactNode;
  items: MenuEntries;
  trigger?(props: MenuTriggerProps): ReactElement;
  placement?: "below" | "above";
  align?: "start" | "end";
  disabled?: boolean;
  width?: keyof typeof MENU_WIDTH;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        disabled={disabled === true}
        render={(props) => {
          // Base UI's props are those of a button here (ref, ARIA, handlers): typed as such.
          const own = props as MenuTriggerProps;
          return trigger !== undefined ? (
            trigger(own)
          ) : (
            <RoundButton label={label} tone="ghost" disabled={disabled === true} {...own}>
              {icon}
            </RoundButton>
          );
        }}
      />
      <MenuPopup
        label={label}
        items={items}
        side={placement === "above" ? "top" : "bottom"}
        align={align}
        width={width}
      />
    </Menu.Root>
  );
}

let popupCount = 0;
/**
 * A new key for each opening of a `PopupMenu`: the screen keys the menu by it, so an opening while
 * the last one is still fading out is a new menu, and the old one's `onClose` cannot close it.
 */
export function popupKey(): number {
  popupCount += 1;
  return popupCount;
}

/**
 * A menu at a point of the screen (a context menu, or a menu opened from a key), with the same
 * keyboard as `MenuButton`. It is open while it is mounted; `onClose` is called once it has gone
 * (after its exit), and the focus goes back to what had it before.
 */
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
  items: MenuEntries;
  onClose(): void;
}) {
  const [open, setOpen] = useState(true);
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }),
    [x, y],
  );
  return (
    <Menu.Root
      open={open}
      modal={false}
      onOpenChange={(next) => setOpen(next)}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <MenuPopup
        label={label}
        items={items}
        side="bottom"
        align="start"
        width="normal"
        anchor={anchor}
      />
    </Menu.Root>
  );
}
