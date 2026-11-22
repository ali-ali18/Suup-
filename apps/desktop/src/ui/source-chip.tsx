import type { RoutineSource } from "@suup/api";
import { useState } from "react";
import { cx } from "../lib/cx.js";
import { faviconUrl, parseLink } from "../lib/links.js";
import { categoryGlyph } from "./category-icon.js";

/**
 * The icon of a site, or the generic one. `src` is `null` when the person has not turned the icons
 * of sites on (Configurações > Geral > Aparência; they come from the site itself) or the site gets none: then
 * it is the glyph of the category, the same one an action row shows.
 */
function SiteIcon({ src, fallback }: { src: string | null; fallback: "web" | "connector" }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="inline-flex size-4 flex-none items-center justify-center text-text-muted [&_img]:rounded-xs"
      aria-hidden="true"
      data-testid="source-icon"
      data-favicon={src !== null && !failed}
    >
      {src === null || failed ? (
        categoryGlyph(fallback, 14)
      ) : (
        <img
          src={src}
          alt=""
          width={14}
          height={14}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

const CHIP =
  "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-chip px-1.5 py-0.5 text-small text-text-muted";

/**
 * One source of a routine's run (docs/ROTINAS.md): a page a tool declared it read (the site's icon
 * and host, a link that opens outside the app) or a connector (its icon and name). From the
 * backend's `sources`, never from the text of the result.
 */
export function SourceChip({
  source,
  favicons,
  openUrl,
}: {
  source: RoutineSource;
  favicons: boolean;
  openUrl?: (url: string) => void;
}) {
  if (source.kind === "connector") {
    return (
      <span className={CHIP} data-testid="routine-source" data-kind="connector">
        <SiteIcon src={null} fallback="connector" />
        <span className="truncate">{source.connector}</span>
      </span>
    );
  }
  const safe = parseLink(source.url);
  if (safe === null || safe.scheme === "mailto") {
    return (
      <span className={CHIP} data-testid="routine-source" data-kind="web">
        <SiteIcon src={null} fallback="web" />
        <span className="truncate">{source.title ?? source.url}</span>
      </span>
    );
  }
  return (
    <a
      className={cx(CHIP, "no-underline hover:bg-hover hover:text-text")}
      href={safe.href}
      // The real destination, as the browser sees it, and the page's title when it has one.
      title={source.title === null ? safe.href : `${source.title}\n${safe.href}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="routine-source"
      data-kind="web"
      onClick={(e) => {
        if (openUrl !== undefined) {
          e.preventDefault();
          openUrl(safe.href);
        }
      }}
    >
      <SiteIcon src={favicons ? faviconUrl(safe) : null} fallback="web" />
      <span className="truncate">{safe.host}</span>
    </a>
  );
}
