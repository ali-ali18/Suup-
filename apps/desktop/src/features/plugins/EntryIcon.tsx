import { Plug, Search } from "lucide-react";
import { cx } from "../../lib/cx.js";
import { solidMarkFor } from "../../ui/brand-icons.js";
import type { Tone } from "./appearance.js";
import type { PluginLook } from "./installed.js";

/** The three backgrounds of a logo (the full class names, so Tailwind finds them). */
const TILE_BG: Record<Tone, string> = {
  neutral: "bg-raised",
  black: "bg-tile-black",
  white: "bg-tile-white",
  solid: "bg-raised",
};

/** What is drawn without a logo (the plug): the faded text on the grey, white on black, black on white. */
const PLUG_FG: Record<Tone, string> = {
  neutral: "text-text-muted",
  black: "text-tile-white",
  white: "text-tile-black",
  solid: "text-text-muted",
};

/** The rounded square and the logo inside it, per size. */
export const TILE = {
  /* Round inside the "Meus conectores" pill: a square tile's corners poked out of the pill's round
     end (owner, 24/11/2026). */
  sm: { box: "size-avatar-sm rounded-pill ring-2 ring-bg", logo: "size-4" },
  lg: { box: "size-avatar-lg rounded-row", logo: "size-7" },
} as const;

/**
 * The service's tile, as in the reference the owner gave (23/11/2026). A `solid` brand (its logo is
 * one colour: Linear, Stack Overflow, Brave): the brand's OWN primary colour as the background (the
 * `hex` of the package) and its mark in white over it. Any other: the logo in its own colours (an
 * `<img>` of an SVG copied from thesvg, `assets/brand/`) on a neutral background (the project's grey,
 * or the black or white the brand's own icon has). No logo of its own: the plug (a magnifier for a
 * search engine). Used by the gallery, the plugin's page and the "Instalado" list.
 */
export function EntryIcon({
  id,
  name,
  look,
  size,
}: {
  id: string;
  name: string;
  look: PluginLook;
  size: keyof typeof TILE;
}) {
  const tile = TILE[size];
  const solid = look.tone === "solid" ? solidMarkFor(id) : undefined;
  const box = cx(
    "inline-flex flex-none items-center justify-center border border-border",
    tile.box,
  );
  if (solid !== undefined) {
    return (
      <span className={box} style={{ backgroundColor: `#${solid.hex}` }} aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cx("text-tile-white", tile.logo)}
          data-brand={id}
        >
          <title>{name}</title>
          <path d={solid.path} />
        </svg>
      </span>
    );
  }
  const Glyph = look.glyph === "search" ? Search : Plug;
  return (
    <span className={cx(box, TILE_BG[look.tone])} aria-hidden="true">
      {look.logo === undefined ? (
        <Glyph className={cx(PLUG_FG[look.tone], tile.logo)} strokeWidth={1.5} />
      ) : (
        <img
          src={look.logo}
          alt=""
          draggable={false}
          data-logo={id}
          className={cx("flex-none object-contain", tile.logo)}
        />
      )}
    </span>
  );
}
