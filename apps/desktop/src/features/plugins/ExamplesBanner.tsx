import { ArrowRight } from "lucide-react";
import { cx } from "../../lib/cx.js";
import type { Appearance, Banner } from "./appearance.js";

/** The twelve gradients of the banner of a page (the full class names, so Tailwind finds them). */
const BANNER_BG: Record<Banner, string> = {
  ink: "from-banner-ink-from to-banner-ink-to",
  slate: "from-banner-slate-from to-banner-slate-to",
  navy: "from-banner-navy-from to-banner-navy-to",
  plum: "from-banner-plum-from to-banner-plum-to",
  paper: "from-banner-paper-from to-banner-paper-to",
  sky: "from-banner-sky-from to-banner-sky-to",
  mint: "from-banner-mint-from to-banner-mint-to",
  sun: "from-banner-sun-from to-banner-sun-to",
  coral: "from-banner-coral-from to-banner-coral-to",
  amber: "from-banner-amber-from to-banner-amber-to",
  indigo: "from-banner-indigo-from to-banner-indigo-to",
  lilac: "from-banner-lilac-from to-banner-lilac-to",
};

/**
 * The band of a plugin's page: its fixed gradient and three things one could ask a bot once it is
 * connected. The same on every page (a connector of the gallery or an engine of the search queue;
 * owner, 24/11/2026). No examples: no band.
 */
export function ExamplesBanner({
  name,
  look,
}: {
  name: string;
  look: Pick<Appearance, "banner" | "examples">;
}) {
  if (look.examples.length === 0) return null;
  return (
    <section
      className={cx("flex flex-col gap-2 rounded-card bg-linear-to-br p-4", BANNER_BG[look.banner])}
      data-banner={look.banner}
      aria-label="Exemplos do que você poderá pedir"
      data-testid="connector-examples"
    >
      {look.examples.map((text) => (
        <div
          key={text}
          className="flex items-center gap-3 rounded-row bg-surface px-3 py-2.5 text-body"
        >
          <span className="inline-flex flex-none items-center gap-1.5 rounded-chip bg-raised px-2 py-0.5 text-small">
            {name}
          </span>
          <span className="min-w-0 flex-1">{text}</span>
          <ArrowRight size={16} className="flex-none text-text-muted" aria-hidden="true" />
        </div>
      ))}
    </section>
  );
}
