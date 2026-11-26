import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  advanceReveal,
  BASE_CPS,
  CATCHUP_S,
  FadeSink,
  MAX_CHUNK,
  revealRate,
} from "./live-fade.js";
import { Markdown } from "./markdown.js";

describe("o texto ao vivo esmaece", () => {
  it("separa o pedaço novo do que já estava, contando só o texto desenhado", () => {
    const sink = new FadeSink([
      { id: 1, start: 0, at: 0 },
      { id: 2, start: 5, at: 0 },
    ]);
    expect(sink.wrap("abcdefgh")).toEqual([
      { id: "f1-0", text: "abcde" },
      { id: "f2-1", text: "fgh" },
    ]);
    expect(sink.total).toBe(8);
  });

  it("sem esmaecer o markdown não ganha elemento nenhum", () => {
    const { container } = render(<Markdown text="oi **você**" />);
    expect(container.querySelector(".ui-live-in")).toBeNull();
  });

  it("com esmaecer o texto fica igual e o pedaço novo tem o próprio elemento", () => {
    const fade = new FadeSink([{ id: 1, start: 3, at: 0 }]);
    const { container } = render(<Markdown text="oi **você**" fade={fade} />);
    expect(container.textContent).toBe("oi você");
    expect(container.querySelectorAll(".ui-live-in").length).toBeGreaterThan(0);
  });
});

describe("o ritmo da revelação do texto ao vivo", () => {
  /** Simulates the frame loop (60 fps) and returns the seconds until everything is shown. */
  function secondsToCatchUp(text: string): number {
    let count = 0;
    let carry = 0;
    let t = 0;
    while (count < text.length && t < 30) {
      carry = Math.min(MAX_CHUNK, carry + (revealRate(text.length - count) * (1000 / 60)) / 1000);
      const whole = Math.floor(carry);
      if (whole >= 1) {
        carry -= whole;
        const next = advanceReveal(text, count, whole);
        expect(next - count).toBeLessThanOrEqual(MAX_CHUNK + 8); // a grapheme may run a little over
        count = next;
      }
      t += 1 / 60;
    }
    return t;
  }

  it("sem fila anda no ritmo base; com fila vai mais rápido", () => {
    expect(revealRate(1)).toBe(BASE_CPS);
    expect(revealRate(10 * BASE_CPS * CATCHUP_S)).toBeCloseTo(10 * BASE_CPS, 5);
  });

  it("uma fila grande é alcançada em poucas vezes o alvo, bem abaixo do ritmo base", () => {
    const text = "a".repeat(600);
    const seconds = secondsToCatchUp(text);
    expect(seconds).toBeLessThan(3); // 600 characters, at most MAX_CHUNK a frame
    expect(seconds).toBeLessThan(text.length / BASE_CPS / 2);
  });

  it("nunca corta um par substituto nem um grafema no meio", () => {
    const text = "oi 😀👍🏽 e á com acento 🇧🇷 fim ".repeat(8);
    let count = 0;
    const cuts = new Set<number>();
    while (count < text.length) {
      count = advanceReveal(text, count, 1);
      cuts.add(count);
      const code = text.charCodeAt(count - 1);
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false); // never ends on a high surrogate
    }
    expect(count).toBe(text.length);
    // The emoji with a skin tone and the flag are each revealed whole.
    expect(cuts.has(text.indexOf("👍") + 2)).toBe(false);
    expect(cuts.has(text.indexOf("🇧") + 2)).toBe(false);
  });
});
