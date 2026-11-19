import { describe, expect, it } from "vitest";
import {
  ariaValue,
  clampWidth,
  PANEL_SPEC,
  parseStoredFlag,
  parseStoredWidth,
  resizeByKey,
  resolveDrag,
  SIDEBAR_SPEC as S,
} from "./pane-size.js";

describe("pane-size: limites", () => {
  it("o padrão da barra lateral continua 316 e o do painel 450, ambos dentro dos limites", () => {
    expect(S.def).toBe(316);
    expect(PANEL_SPEC.def).toBe(450);
    for (const spec of [S, PANEL_SPEC]) {
      expect(spec.def).toBeGreaterThanOrEqual(spec.min);
      expect(spec.def).toBeLessThanOrEqual(spec.max);
      expect(spec.snap).toBeLessThan(spec.min);
    }
  });

  it("clampWidth apara, arredonda e troca o que não é número pelo padrão", () => {
    expect(clampWidth(S, 100)).toBe(S.min);
    expect(clampWidth(S, 9999)).toBe(S.max);
    expect(clampWidth(S, 300.6)).toBe(301);
    expect(clampWidth(S, Number.NaN)).toBe(S.def);
    expect(clampWidth(S, Number.POSITIVE_INFINITY)).toBe(S.def);
  });
});

describe("pane-size: arrasto", () => {
  it("abaixo do limiar encolhe de vez (trilho/fechado); no limiar e acima é contínuo", () => {
    expect(resolveDrag(S, S.snap - 1).collapsed).toBe(true);
    expect(resolveDrag(S, 0).collapsed).toBe(true);
    expect(resolveDrag(S, Number.NaN).collapsed).toBe(true);
    expect(resolveDrag(S, S.snap)).toEqual({ collapsed: false, width: S.min });
    expect(resolveDrag(S, 300)).toEqual({ collapsed: false, width: 300 });
    expect(resolveDrag(S, 5000)).toEqual({ collapsed: false, width: S.max });
  });

  it("o painel fecha abaixo do seu limiar e respeita o máximo", () => {
    expect(resolveDrag(PANEL_SPEC, 270).collapsed).toBe(true);
    expect(resolveDrag(PANEL_SPEC, 500)).toEqual({ collapsed: false, width: 500 });
    expect(resolveDrag(PANEL_SPEC, 900).width).toBe(PANEL_SPEC.max);
  });
});

describe("pane-size: teclado", () => {
  const open = { collapsed: false, width: 316 };
  it("setas mudam em passos, com Shift em passos maiores, sempre dentro dos limites", () => {
    expect(resizeByKey(S, open, "grow")).toEqual({ collapsed: false, width: 332 });
    expect(resizeByKey(S, open, "grow", true).width).toBe(380);
    expect(resizeByKey(S, { collapsed: false, width: 410 }, "grow", true).width).toBe(S.max);
    expect(resizeByKey(S, open, "shrink")).toEqual({ collapsed: false, width: 300 });
  });
  it("estreitar além do mínimo encolhe e guarda a última largura; alargar volta", () => {
    const min = { collapsed: false, width: S.min };
    const rail = resizeByKey(S, min, "shrink");
    expect(rail).toEqual({ collapsed: true, width: S.min });
    expect(resizeByKey(S, rail, "shrink")).toEqual(rail);
    expect(resizeByKey(S, { collapsed: true, width: 350 }, "grow")).toEqual({
      collapsed: false,
      width: 350,
    });
  });
  it("Home encolhe, End vai ao máximo", () => {
    expect(resizeByKey(S, open, "home")).toEqual({ collapsed: true, width: 316 });
    expect(resizeByKey(S, { collapsed: true, width: 316 }, "end")).toEqual({
      collapsed: false,
      width: S.max,
    });
  });
  it("aria-valuenow: a largura, ou o valor do encolhido", () => {
    expect(ariaValue(S, open)).toBe(316);
    expect(ariaValue(S, { collapsed: true, width: 316 })).toBe(110);
    expect(ariaValue(PANEL_SPEC, { collapsed: true, width: 450 })).toBe(0);
  });
});

describe("pane-size: o que foi guardado", () => {
  it("ausente, lixo ou sinal vira o padrão; fora dos limites é aparado", () => {
    expect(parseStoredWidth(S, null)).toBe(S.def);
    expect(parseStoredWidth(S, "abc")).toBe(S.def);
    expect(parseStoredWidth(S, "-300")).toBe(S.def);
    expect(parseStoredWidth(S, "3e2")).toBe(S.def);
    expect(parseStoredWidth(S, "")).toBe(S.def);
    expect(parseStoredWidth(S, "10")).toBe(S.min);
    expect(parseStoredWidth(S, "99999")).toBe(S.max);
    expect(parseStoredWidth(S, "350")).toBe(350);
    expect(parseStoredWidth(PANEL_SPEC, "600")).toBe(600);
  });
  it("o estado aberto/fechado: só 1 e 0 valem", () => {
    expect(parseStoredFlag("1", false)).toBe(true);
    expect(parseStoredFlag("0", true)).toBe(false);
    expect(parseStoredFlag(null, true)).toBe(true);
    expect(parseStoredFlag("sim", false)).toBe(false);
  });
});
