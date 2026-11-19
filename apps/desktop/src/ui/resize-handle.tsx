import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef } from "react";
import { cx } from "../lib/cx.js";
import {
  ariaValue,
  type PaneLayout,
  type PaneSpec,
  resizeByKey,
  resolveDrag,
} from "../lib/pane-size.js";

export interface ResizeHandleProps {
  spec: PaneSpec;
  /** Em que borda da coluna a alça fica: a direita (barra lateral) ou a esquerda (painel). */
  edge: "end" | "start";
  /** Estado guardado: a coluna encolhida (trilho/fechada) e a última largura aberta. */
  layout: PaneLayout;
  /** A variável CSS da coluna (o pai da alça) que carrega a largura. */
  cssVar: string;
  label: string;
  /**
   * Se a coluna pode encolher já durante o arrasto (a barra lateral vira o trilho na hora). Sem
   * isso, o arrasto só mostra o estado "vai fechar" (`data-closing`) e decide ao soltar.
   */
  liveCollapse: boolean;
  /** Mudança de encolhida↔aberta no meio do arrasto (só com `liveCollapse`). */
  onCollapsedChange?(collapsed: boolean): void;
  /** O resultado final: ao soltar, ou a cada tecla. */
  onCommit(layout: PaneLayout): void;
}

/**
 * O separador arrastável de uma coluna lateral. Durante o arrasto só a variável CSS da coluna muda
 * (nenhuma renderização do app por pixel); o estado é gravado ao soltar.
 */
export function ResizeHandle({
  spec,
  edge,
  layout,
  cssVar,
  label,
  liveCollapse,
  onCollapsedChange,
  onCommit,
}: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    rect: DOMRect;
    last: PaneLayout;
    collapsed: boolean;
    start: boolean;
  } | null>(null);
  const latest = useRef(layout);
  latest.current = layout;

  const parent = () => ref.current?.parentElement ?? null;
  // A largura que vale no CSS é sempre a guardada (também depois de um arrasto cancelado).
  useLayoutEffect(() => {
    parent()?.style.setProperty(cssVar, `${layout.width}px`);
  }, [cssVar, layout.width]);

  const finish = (e: PointerEvent, commit: boolean) => {
    const d = drag.current;
    const el = ref.current;
    if (d === null || el === null) return;
    drag.current = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    el.removeAttribute("data-dragging");
    document.documentElement.removeAttribute("data-resizing");
    parent()?.removeAttribute("data-closing");
    parent()?.style.setProperty(cssVar, `${latest.current.width}px`);
    if (commit) onCommit(d.last);
    else if (liveCollapse && d.collapsed !== d.start) onCollapsedChange?.(d.start);
  };

  const onPointerDown = (e: PointerEvent) => {
    const target = parent();
    if (e.button !== 0 || target === null) return;
    e.preventDefault();
    ref.current?.setPointerCapture(e.pointerId);
    ref.current?.setAttribute("data-dragging", "true");
    document.documentElement.setAttribute("data-resizing", "");
    drag.current = {
      rect: target.getBoundingClientRect(),
      last: latest.current,
      collapsed: latest.current.collapsed,
      start: latest.current.collapsed,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const target = parent();
    if (d === null || target === null) return;
    const raw = edge === "end" ? e.clientX - d.rect.left : d.rect.right - e.clientX;
    const next = resolveDrag(spec, raw);
    d.last = next;
    if (!next.collapsed || liveCollapse) target.style.setProperty(cssVar, `${next.width}px`);
    if (next.collapsed) target.setAttribute("data-closing", "true");
    else target.removeAttribute("data-closing");
    ref.current?.setAttribute("aria-valuenow", String(ariaValue(spec, next)));
    if (liveCollapse && next.collapsed !== d.collapsed) {
      d.collapsed = next.collapsed;
      onCollapsedChange?.(next.collapsed);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const growKey = edge === "end" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = edge === "end" ? "ArrowLeft" : "ArrowRight";
    const action =
      e.key === growKey
        ? "grow"
        : e.key === shrinkKey
          ? "shrink"
          : e.key === "Home"
            ? "home"
            : e.key === "End"
              ? "end"
              : null;
    if (action === null) return;
    e.preventDefault();
    onCommit(resizeByKey(spec, layout, action, e.shiftKey));
  };

  return (
    <div
      ref={ref}
      className={cx(
        "absolute inset-y-0 z-6 w-2.5 cursor-col-resize touch-none outline-none",
        edge === "end" ? "-right-1.25" : "-left-1.25",
        // The line shows only on hover, on focus and while dragging.
        "after:absolute after:inset-y-0 after:left-1/2 after:-ml-px after:w-0.5 after:rounded-hairline after:bg-focus after:opacity-0 after:transition-opacity after:content-['']",
        "hover:after:opacity-70 focus-visible:after:opacity-70 data-[dragging=true]:after:opacity-70",
      )}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={ariaValue(spec, layout)}
      aria-valuemin={spec.collapsedValue}
      aria-valuemax={spec.max}
      tabIndex={0}
      data-testid="resize-handle"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onLostPointerCapture={(e) => finish(e, false)}
    />
  );
}
