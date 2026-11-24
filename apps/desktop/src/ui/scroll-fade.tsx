import { cx } from "../lib/cx.js";

/** The colour the fade melts into: the page, or the darker sidebar. */
const FADE_FROM = {
  bg: "from-bg",
  sidebar: "from-sidebar",
} as const;

const FADE_EDGE = {
  top: "top-0 bg-linear-to-b",
  bottom: "bottom-0 bg-linear-to-t",
} as const;

/**
 * "Nada seco" (owner, 23/11/2026; docs/DESIGN.md §1): a scrolling area never cuts its content with
 * a hard line. Put this inside the `relative` box that holds the scroller: a soft fade over its top
 * and bottom edge, in the colour behind it, that lets nothing be clicked through it by mistake
 * (it takes no pointer events).
 */
export function ScrollFade({
  tone = "bg",
  edges = ["top", "bottom"],
}: {
  tone?: keyof typeof FADE_FROM;
  edges?: readonly (keyof typeof FADE_EDGE)[];
}) {
  return (
    <>
      {edges.map((edge) => (
        <div
          key={edge}
          aria-hidden="true"
          data-testid="scroll-fade"
          data-edge={edge}
          className={cx(
            "pointer-events-none absolute inset-x-0 z-10 h-fade to-transparent",
            FADE_EDGE[edge],
            FADE_FROM[tone],
          )}
        />
      ))}
    </>
  );
}
