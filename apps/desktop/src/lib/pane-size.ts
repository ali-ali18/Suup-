// A lógica pura de redimensionar uma coluna lateral (a barra lateral e o painel do bot): limites,
// o ponto em que ela "encolhe de vez" (vira o trilho, ou fecha), o teclado e a leitura do que foi
// guardado. Nada aqui toca o DOM: o arrasto e o componente ficam em `ui/resize-handle.tsx`.

export interface PaneSpec {
  /** Chave no armazenamento local (por instalação). */
  key: string;
  /** Largura padrão, a de antes de existir o arrasto. */
  def: number;
  /** Menor e maior largura aberta (contínua entre as duas). */
  min: number;
  max: number;
  /** Abaixo disto a coluna encolhe de vez (trilho ou fechada). */
  snap: number;
  /** Passo das setas; com Shift, quatro vezes isto. */
  step: number;
  /** O valor que o separador anuncia quando a coluna está encolhida (a largura do trilho, ou 0). */
  collapsedValue: number;
}

/** A barra lateral: arrastar abaixo de 200 px vira o trilho (110 px, `--width-rail`). */
export const SIDEBAR_SPEC: PaneSpec = {
  key: "suup.sidebarWidth",
  def: 316,
  min: 240,
  max: 420,
  snap: 200,
  step: 16,
  collapsedValue: 110,
};

/** O painel do bot: arrastar abaixo de 280 px fecha o painel. */
export const PANEL_SPEC: PaneSpec = {
  key: "suup.panelWidth",
  def: 450,
  min: 340,
  max: 640,
  snap: 280,
  step: 16,
  collapsedValue: 0,
};

export interface PaneLayout {
  collapsed: boolean;
  /** A última largura aberta (continua valendo enquanto a coluna está encolhida). */
  width: number;
}

/** Largura inteira dentro de [min, max]; qualquer coisa que não seja número vira o padrão. */
export function clampWidth(spec: PaneSpec, width: number): number {
  if (!Number.isFinite(width)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, Math.round(width)));
}

/** O que um arrasto até `raw` px (distância da borda fixa da coluna ao ponteiro) significa. */
export function resolveDrag(spec: PaneSpec, raw: number): PaneLayout {
  if (!Number.isFinite(raw) || raw < spec.snap) return { collapsed: true, width: spec.min };
  return { collapsed: false, width: clampWidth(spec, raw) };
}

/**
 * O teclado no separador. `grow` é +1 para a seta que alarga a coluna e -1 para a que estreita.
 * Devolve `null` se a tecla não é do separador. Estreitar além do mínimo encolhe de vez; alargar a
 * partir do encolhido volta ao mínimo.
 */
export function resizeByKey(
  spec: PaneSpec,
  layout: PaneLayout,
  action: "grow" | "shrink" | "home" | "end",
  big = false,
): PaneLayout {
  const step = spec.step * (big ? 4 : 1);
  if (action === "home") return { collapsed: true, width: layout.width };
  if (action === "end") return { collapsed: false, width: spec.max };
  if (action === "grow") {
    if (layout.collapsed) return { collapsed: false, width: clampWidth(spec, layout.width) };
    return { collapsed: false, width: clampWidth(spec, layout.width + step) };
  }
  if (layout.collapsed) return layout;
  const next = layout.width - step;
  if (next < spec.min) return { collapsed: true, width: layout.width };
  return { collapsed: false, width: next };
}

/** A largura guardada (texto): inválida, fora dos limites ou ausente vira o padrão ou é aparada. */
export function parseStoredWidth(spec: PaneSpec, raw: string | null): number {
  if (raw === null || !/^\d{1,5}$/.test(raw.trim())) return spec.def;
  return clampWidth(spec, Number(raw));
}

/** O estado guardado "1"/"0" (aberto/fechado); qualquer outra coisa é `fallback`. */
export function parseStoredFlag(raw: string | null, fallback: boolean): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return fallback;
}

/** O valor de `aria-valuenow` do separador. */
export function ariaValue(spec: PaneSpec, layout: PaneLayout): number {
  return layout.collapsed ? spec.collapsedValue : layout.width;
}
