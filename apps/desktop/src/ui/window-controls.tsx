import { Copy, Minus, Square, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cx } from "../lib/cx.js";
import type { WindowFrame } from "../lib/platform.js";

const BUTTON =
  "inline-flex h-8 w-11.5 flex-none items-center justify-center border-0 bg-transparent p-0 text-text";

/**
 * The window's minimize, maximize and close, drawn by the app in the top right corner, over the
 * panel (owner's decision, 22/11/2026, as in the Grok Bot): the window has no system title bar. They
 * exist only when the shell says so (`WindowFrame.custom`); in a browser or on macOS there are none.
 * Three flat buttons of 46 x 32 px, the width of the caption buttons the system draws, so the whole
 * strip is 138 px wide (what `right-37.5` of the panel's close button leaves free).
 */
export function WindowControls({ frame }: { frame: WindowFrame }) {
  const [maximized, setMaximized] = useState(false);
  const refresh = useCallback(() => {
    frame.isMaximized().then(setMaximized, () => undefined);
  }, [frame]);
  // The window can also be maximized by the keyboard or by a double click on its top: ask again
  // whenever it is resized.
  useEffect(() => {
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [refresh]);
  return (
    <div
      className="fixed top-0 right-0 z-50 flex"
      role="group"
      aria-label="Controles da janela"
      data-testid="window-controls"
    >
      <button
        type="button"
        className={cx(BUTTON, "hover:bg-hover")}
        aria-label="Minimizar"
        data-testid="window-minimize"
        onClick={() => void frame.minimize()}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={cx(BUTTON, "hover:bg-hover")}
        aria-label={maximized ? "Restaurar" : "Maximizar"}
        data-testid="window-maximize"
        data-maximized={maximized}
        onClick={() => void frame.toggleMaximize().then(refresh, () => undefined)}
      >
        {maximized ? (
          <Copy size={13} aria-hidden="true" />
        ) : (
          <Square size={12} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={cx(BUTTON, "hover:bg-danger-subtle hover:text-danger-text")}
        aria-label="Fechar a janela"
        data-testid="window-close"
        onClick={() => void frame.close()}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
